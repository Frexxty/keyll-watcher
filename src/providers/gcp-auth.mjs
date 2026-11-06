/**
 * Google access tokens for a watcher running outside Google Cloud, from the file GOOGLE_APPLICATION_CREDENTIALS
 * points to. Three kinds of file are supported, all with Node's standard library only:
 *
 *   external_account  Workload identity federation: no long-lived secret. The watcher trades a token from
 *                     your own identity provider (a file or a URL, for example a Kubernetes service account
 *                     token or an OIDC token from your IdP) for a Google token, then impersonates the
 *                     keyll-watcher service account. The recommended way to run on-prem.
 *   service_account   A service account key. Works anywhere, but it's a long-lived secret, and many
 *                     organisations block creating them.
 *   authorized_user   Your own `gcloud auth application-default login`. For trying things out.
 *
 * Inside Google Cloud (Cloud Run, GKE with Workload Identity, a VM), leave GOOGLE_APPLICATION_CREDENTIALS
 * unset and the metadata server is used instead.
 */
import { createSign } from "node:crypto";
import fs from "node:fs";

export const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

async function post(url, { form, json, headers = {} }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : { "Content-Type": "application/json" }), ...headers },
    body: form ? new URLSearchParams(form).toString() : JSON.stringify(json),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url.split("?")[0]} returned ${response.status}: ${data.error_description || data.error?.message || data.error || "no detail"}`);
  return data;
}

const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** A signed JWT assertion for the OAuth 2.0 JWT bearer grant (RFC 7523). */
export function serviceAccountAssertion(creds, now = Math.floor(Date.now() / 1000)) {
  const header = b64url({ alg: "RS256", typ: "JWT", ...(creds.private_key_id ? { kid: creds.private_key_id } : {}) });
  const claims = b64url({ iss: creds.client_email, scope: SCOPE, aud: creds.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(creds.private_key).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

async function subjectToken(source) {
  const format = source.format || { type: "text" };
  let raw;
  if (source.file) raw = fs.readFileSync(source.file, "utf8");
  else if (source.url) {
    const response = await fetch(source.url, { headers: source.headers || {}, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Couldn't read the subject token from ${source.url}: ${response.status}`);
    raw = await response.text();
  } else if (source.environment_id?.startsWith("aws")) {
    throw new Error("AWS-sourced workload identity isn't supported yet. Use a file- or URL-sourced credential configuration.");
  } else {
    throw new Error("Unsupported credential_source: use file or url");
  }
  if (format.type === "json") {
    const value = JSON.parse(raw)[format.subject_token_field_name];
    if (!value) throw new Error(`Subject token field ${format.subject_token_field_name} is missing`);
    return value;
  }
  return raw.trim();
}

/** Returns a function that yields { value, expires } (ms), cached by the caller. */
export function tokenSourceFromFile(path) {
  const creds = JSON.parse(fs.readFileSync(path, "utf8"));
  const expiresIn = (seconds) => Date.now() + Number(seconds || 3600) * 1000;

  if (creds.type === "service_account") {
    if (!creds.client_email || !creds.private_key) throw new Error(`${path} is missing client_email or private_key`);
    return {
      projectId: creds.project_id || "",
      async token() {
        const data = await post(creds.token_uri || "https://oauth2.googleapis.com/token", {
          form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(creds) },
        });
        return { value: data.access_token, expires: expiresIn(data.expires_in) };
      },
    };
  }

  if (creds.type === "external_account") {
    if (!creds.token_url || !creds.audience || !creds.subject_token_type || !creds.credential_source) throw new Error(`${path} is not a complete external_account configuration`);
    return {
      projectId: "",
      async token() {
        const sts = await post(creds.token_url, {
          form: {
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            audience: creds.audience,
            scope: SCOPE,
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            subject_token_type: creds.subject_token_type,
            subject_token: await subjectToken(creds.credential_source),
          },
        });
        if (!creds.service_account_impersonation_url) return { value: sts.access_token, expires: expiresIn(sts.expires_in) };
        const impersonated = await post(creds.service_account_impersonation_url, {
          json: { scope: [SCOPE], lifetime: "3600s" },
          headers: { Authorization: `Bearer ${sts.access_token}` },
        });
        return { value: impersonated.accessToken, expires: Date.parse(impersonated.expireTime) || expiresIn(3600) };
      },
    };
  }

  if (creds.type === "authorized_user") {
    return {
      projectId: creds.quota_project_id || "",
      async token() {
        const data = await post(creds.token_uri || "https://oauth2.googleapis.com/token", {
          form: { grant_type: "refresh_token", client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token },
        });
        return { value: data.access_token, expires: expiresIn(data.expires_in) };
      },
    };
  }

  throw new Error(`Unsupported credentials type ${creds.type} in ${path}`);
}

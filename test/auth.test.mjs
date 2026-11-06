/** Running outside Google Cloud: each kind of credentials file, against the emulator's token endpoints. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createGcpProvider } from "../src/providers/gcp.mjs";
import { startEmulator } from "./helpers.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyll-auth-"));
let EMU = "";
let emulator;

before(async () => {
  emulator = await startEmulator("gcp");
  EMU = emulator.url;
});
after(() => emulator.stop());

const write = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};
const register = (body) => fetch(`${EMU}/_emulator/credentials`, { method: "POST", body: JSON.stringify(body) });
const provider = (credentialsFile, env = {}) =>
  createGcpProvider(loadConfig({ GOOGLE_APPLICATION_CREDENTIALS: credentialsFile, KEYLL_GCP_MONITORING_URL: EMU, KEYLL_GCP_APIKEYS_URL: EMU, KEYLL_GCP_METADATA_URL: "http://127.0.0.1:1", ...env }));

test("a service account key file signs a JWT and gets a token", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const email = "keyll-watcher@keyll-e2e.iam.gserviceaccount.com";
  await register({ serviceAccount: email, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) });
  const file = write("sa.json", { type: "service_account", project_id: "keyll-e2e", private_key_id: "k1", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), client_email: email, token_uri: `${EMU}/token` });
  const keys = await provider(file).listKeys();
  assert.equal(keys.length, 5);
});

test("a key signed by someone else is refused", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const file = write("forged.json", { type: "service_account", project_id: "keyll-e2e", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), client_email: "keyll-watcher@keyll-e2e.iam.gserviceaccount.com", token_uri: `${EMU}/token` });
  await assert.rejects(provider(file).listKeys(), /Invalid JWT Signature/);
});

test("workload identity federation: a file-sourced token, exchanged and then impersonated", async () => {
  await register({ subjectToken: "oidc-token-from-your-idp" });
  const tokenFile = write("oidc-token", "oidc-token-from-your-idp\n");
  const file = write("wif.json", {
    type: "external_account",
    audience: "//iam.googleapis.com/projects/424242424242/locations/global/workloadIdentityPools/onprem/providers/idp",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: `${EMU}/v1/token`,
    service_account_impersonation_url: `${EMU}/v1/projects/-/serviceAccounts/keyll-watcher@keyll-e2e.iam.gserviceaccount.com:generateAccessToken`,
    credential_source: { file: tokenFile },
  });
  const keys = await provider(file, { GCP_PROJECT: "keyll-e2e" }).listKeys();
  assert.equal(keys.length, 5);
  write("oidc-token", "a-token-the-pool-doesnt-trust");
  await assert.rejects(provider(file, { GCP_PROJECT: "keyll-e2e" }).listKeys(), /subject token is not valid/);
});

test("a credentials file without a project asks for GCP_PROJECT instead of waiting on a metadata server", async () => {
  const file = write("wif2.json", { type: "external_account", audience: "x", subject_token_type: "x", token_url: `${EMU}/v1/token`, credential_source: { file: "/nope" } });
  await assert.rejects(provider(file).listKeys(), /Set GCP_PROJECT/);
});

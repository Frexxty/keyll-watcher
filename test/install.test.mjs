/**
 * Runs install.sh against a stub gcloud that records its arguments, to check the exact commands it would
 * run and the permissions it grants. It doesn't prove they work on Google Cloud; only a real project does.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = `kw_${"a".repeat(43)}`;

function runInstall(args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyll-install-"));
  const log = path.join(dir, "calls.log");
  // "describe" fails (nothing exists yet); everything else succeeds.
  fs.writeFileSync(path.join(dir, "gcloud"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\nif [[ " $* " == *" describe "* ]]; then exit 1; fi\nif [[ "$*" == "config get-value account" ]]; then echo owner@example.com; fi\ncat > /dev/null\n`, { mode: 0o755 });
  const output = execFileSync("bash", [path.join(here, "..", "install.sh"), ...args], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, KEYLL_TOKEN: TOKEN, ...env },
    input: "",
    encoding: "utf8",
  });
  return { output, calls: fs.readFileSync(log, "utf8").trim().split("\n") };
}

const ARGS = ["--project", "my-app-prod", "--region", "europe-west1", "--keyll-url", "https://app.keyll.cloud", "--workspace-id", "00000000-0000-4000-8000-000000000002", "--watcher-id", "00000000-0000-4000-8000-000000000001", "--yes"];

test("install creates exactly the documented resources, with a four-permission role", () => {
  const { calls, output } = runInstall(ARGS);
  const role = calls.find((c) => c.startsWith("iam roles create keyllWatcher"));
  assert.match(role, /--permissions apikeys\.keys\.get,apikeys\.keys\.list,apikeys\.keys\.update,monitoring\.timeSeries\.list /);
  assert.ok(!calls.join("\n").includes("getKeyString"));
  assert.ok(calls.some((c) => c.startsWith("projects add-iam-policy-binding my-app-prod --member serviceAccount:keyll-watcher@my-app-prod.iam.gserviceaccount.com --role projects/my-app-prod/roles/keyllWatcher")));
  assert.ok(calls.some((c) => c.startsWith("secrets add-iam-policy-binding keyll-watcher-token --member serviceAccount:keyll-watcher@") && c.includes("roles/secretmanager.secretAccessor")));
  const deploy = calls.find((c) => c.startsWith("run jobs deploy keyll-watcher"));
  assert.match(deploy, /--service-account keyll-watcher@my-app-prod/);
  assert.match(deploy, /KEYLL_MODE=dry-run/);
  assert.match(deploy, /KEYLL_WORKSPACE_ID=00000000-0000-4000-8000-000000000002/);
  assert.match(deploy, /--set-secrets KEYLL_TOKEN=keyll-watcher-token:latest/);
  assert.match(deploy, /--source /);
  assert.ok(!deploy.includes(TOKEN), "the token must not be on a command line");
  assert.ok(calls.some((c) => c.startsWith("run jobs add-iam-policy-binding keyll-watcher") && c.includes("keyll-scheduler@") && c.includes("roles/run.invoker")));
  const schedule = calls.find((c) => c.startsWith("scheduler jobs create http keyll-watcher-every-minute"));
  assert.match(schedule, /--schedule \* \* \* \* \*/);
  assert.match(schedule, /https:\/\/run\.googleapis\.com\/v2\/projects\/my-app-prod\/locations\/europe-west1\/jobs\/keyll-watcher:run/);
  assert.ok(!calls.some((c) => /roles\/(owner|editor|serviceusage\.apiKeysAdmin)/.test(c)));
  assert.match(output, /KEYLL_MODE=enforce/);
});

test("install refuses a malformed token, a non-https Keyll URL and a missing workspace", () => {
  assert.throws(() => runInstall(ARGS, { KEYLL_TOKEN: "not-a-token" }), /watcher token/);
  assert.throws(() => runInstall(ARGS.filter((a, i) => a !== "--workspace-id" && ARGS[i - 1] !== "--workspace-id")), /--workspace-id/);
  const bad = [...ARGS];
  bad[5] = "http://app.keyll.cloud";
  assert.throws(() => runInstall(bad), /https/);
});

test("--image skips Cloud Build", () => {
  const { calls } = runInstall([...ARGS, "--image", "europe-docker.pkg.dev/x/y/watcher:0.1.0"]);
  assert.ok(!calls.some((c) => c.includes("cloudbuild.googleapis.com")));
  assert.match(calls.find((c) => c.startsWith("run jobs deploy")), /--image europe-docker\.pkg\.dev/);
});

test("on-prem with workload identity: no Cloud Run, no secret, a keyless credentials file and a private env file", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "keyll-onprem-"));
  const wif = ["--target", "onprem", "--credentials", "wif", "--out-dir", out,
    "--wif-provider", "projects/123/locations/global/workloadIdentityPools/onprem/providers/idp",
    "--wif-principal", "principal://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/onprem/subject/watcher",
    "--wif-token-file", "/var/run/keyll/token"];
  const { calls } = runInstall([...ARGS, ...wif]);
  assert.ok(!calls.some((c) => /^(run |scheduler |secrets )/.test(c)), calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("iam roles create keyllWatcher")));
  assert.ok(calls.some((c) => c.startsWith("iam service-accounts add-iam-policy-binding keyll-watcher@my-app-prod") && c.includes("roles/iam.workloadIdentityUser") && c.includes("subject/watcher")));
  assert.ok(calls.some((c) => c.startsWith("iam workload-identity-pools create-cred-config projects/123/") && c.includes("--credential-source-file /var/run/keyll/token")));
  assert.ok(!calls.some((c) => c.includes("keys create")));
  const envFile = path.join(out, "keyll-watcher.env");
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  const env = fs.readFileSync(envFile, "utf8");
  assert.match(env, new RegExp(`KEYLL_TOKEN=${TOKEN}`));
  assert.match(env, /KEYLL_MODE=dry-run/);
  assert.match(env, /KEYLL_WORKSPACE_ID=00000000-0000-4000-8000-000000000002/);
  assert.match(env, /GOOGLE_APPLICATION_CREDENTIALS=\/etc\/keyll\/credentials.json/);
});

test("on-prem with a key, and a workload identity setup missing its pieces is refused", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "keyll-onprem-"));
  const { calls } = runInstall([...ARGS, "--target", "onprem", "--credentials", "key", "--out-dir", out]);
  assert.ok(calls.some((c) => c.startsWith("iam service-accounts keys create")));
  assert.throws(() => runInstall([...ARGS, "--target", "onprem", "--credentials", "wif"]), /--wif-provider/);
});

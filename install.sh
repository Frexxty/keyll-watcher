#!/usr/bin/env bash
# Installs the Keyll watcher into one Google Cloud project.
#
#   ./install.sh --project my-app-prod --region us-central1 \
#     --keyll-url https://app.keyll.cloud --workspace-id <id> --watcher-id <id> [--public-key <key>] \
#     [--mode dry-run|enforce] [--image <image>] [--yes]
#
# --public-key adds a Keyll signing key to the ones built into src/trusted-keys.mjs. The watcher only runs
# commands signed by a trusted key, for this workspace and this watcher.
#
# To run the watcher on your own servers instead of Cloud Run, add --target onprem. The script then only
# sets up the Google side (role and service account) and writes keyll-watcher.env plus a credentials file:
#     --target onprem --credentials wif --wif-provider projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider> \
#       --wif-principal 'principal://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/subject/<subject>' \
#       --wif-token-file /var/run/secrets/your-idp-token
#     --target onprem --credentials key      (a service account key: simpler, but a long-lived secret)
# See deploy/README.md for running it with Docker, systemd or Kubernetes.
#
# What it creates, all named keyll-*, all removable with ./uninstall.sh:
#   custom role      keyllWatcher: apikeys.keys.get, apikeys.keys.list, apikeys.keys.update, monitoring.timeSeries.list
#   service account  keyll-watcher, the only identity that holds that role
#   secret           keyll-watcher-token, readable by keyll-watcher only
#   Cloud Run job    keyll-watcher, built from this directory (or --image)
#   service account  keyll-scheduler, allowed to start that one job and nothing else
#   Cloud Scheduler  keyll-watcher-every-minute, runs the job every minute
#
# The watcher token is read from KEYLL_TOKEN, --token-file, or a hidden prompt. It never appears on the command line.
set -euo pipefail

PROJECT="" REGION="us-central1" KEYLL_URL="" WORKSPACE_ID="" WATCHER_ID="" PUBLIC_KEY="" MODE="dry-run" IMAGE="" TOKEN_FILE="" YES=0
TARGET="cloud-run" CREDENTIALS="wif" WIF_PROVIDER="" WIF_PRINCIPAL="" WIF_TOKEN_FILE="" OUT_DIR="."
JOB="keyll-watcher" SA_NAME="keyll-watcher" SCHED_SA_NAME="keyll-scheduler" ROLE_ID="keyllWatcher" SECRET="keyll-watcher-token" SCHEDULE_NAME="keyll-watcher-every-minute"
PERMISSIONS="apikeys.keys.get,apikeys.keys.list,apikeys.keys.update,monitoring.timeSeries.list"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --keyll-url) KEYLL_URL="$2"; shift 2 ;;
    --watcher-id) WATCHER_ID="$2"; shift 2 ;;
    --workspace-id) WORKSPACE_ID="$2"; shift 2 ;;
    --public-key) PUBLIC_KEY="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --credentials) CREDENTIALS="$2"; shift 2 ;;
    --wif-provider) WIF_PROVIDER="$2"; shift 2 ;;
    --wif-principal) WIF_PRINCIPAL="$2"; shift 2 ;;
    --wif-token-file) WIF_TOKEN_FILE="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "Unknown option $1 (see --help)" ;;
  esac
done

command -v gcloud >/dev/null || die "gcloud isn't installed. Use Cloud Shell, or install the Google Cloud CLI."
[[ -n "$PROJECT" ]] || die "--project is required"
[[ "$KEYLL_URL" =~ ^https:// || "$KEYLL_URL" =~ ^http://(localhost|127\.0\.0\.1) ]] || die "--keyll-url must be an https URL"
[[ "$WATCHER_ID" =~ ^[0-9a-f-]{36}$ ]] || die "--watcher-id should be the ID shown in the Keyll dashboard"
[[ "$WORKSPACE_ID" =~ ^[0-9a-f-]{36}$ ]] || die "--workspace-id should be the ID in the install command from the Keyll dashboard"
[[ -z "$PUBLIC_KEY" || "$PUBLIC_KEY" =~ ^[A-Za-z0-9+/=]{40,}$ ]] || die "--public-key should be a base64 Ed25519 public key"
[[ "$MODE" == "dry-run" || "$MODE" == "enforce" ]] || die "--mode must be dry-run or enforce"
[[ "$TARGET" == "cloud-run" || "$TARGET" == "onprem" ]] || die "--target must be cloud-run or onprem"
if [[ "$TARGET" == "onprem" ]]; then
  [[ "$CREDENTIALS" == "wif" || "$CREDENTIALS" == "key" ]] || die "--credentials must be wif or key"
  if [[ "$CREDENTIALS" == "wif" ]]; then
    [[ "$WIF_PROVIDER" =~ ^projects/[0-9]+/locations/global/workloadIdentityPools/[^/]+/providers/[^/]+$ ]] || die "--wif-provider must be projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>"
    [[ "$WIF_PRINCIPAL" =~ ^principal(Set)?:// ]] || die "--wif-principal must be the principal:// (or principalSet://) identity your watcher runs as"
    [[ -n "$WIF_TOKEN_FILE" ]] || die "--wif-token-file is required: where your identity provider's token for the watcher is"
  fi
fi

SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SCHED_SA="${SCHED_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
ROLE="projects/${PROJECT}/roles/${ROLE_ID}"
G=(--project "$PROJECT" --quiet)

ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
cat <<PLAN

Keyll watcher install
  Project   $PROJECT    Region $REGION    Mode $MODE    Signed in as ${ACCOUNT:-unknown}

This will:
PLAN
if [[ "$TARGET" == "onprem" ]]; then
cat <<PLAN
  1. Enable APIs: apikeys, monitoring, iam$([[ "$CREDENTIALS" == "wif" ]] && echo ", iamcredentials, sts")
  2. Create the custom role $ROLE_ID with exactly: ${PERMISSIONS//,/, }
  3. Create the service account $SA and grant it that role on the project
  4. $([[ "$CREDENTIALS" == "wif" ]] && echo "Let $WIF_PRINCIPAL act as $SA_NAME, and write a keyless credentials file for it" || echo "Create a key for $SA_NAME (a long-lived secret: keep it safe)")
  5. Write $OUT_DIR/keyll-watcher.env and $OUT_DIR/keyll-watcher-credentials.json, readable only by you
PLAN
else
cat <<PLAN
  1. Enable APIs: apikeys, monitoring, run, cloudscheduler, secretmanager$([[ -z "$IMAGE" ]] && echo ", cloudbuild, artifactregistry")
  2. Create the custom role $ROLE_ID with exactly: ${PERMISSIONS//,/, }
  3. Create the service account $SA and grant it that role on the project
  4. Store your watcher token in the secret $SECRET, readable only by $SA_NAME
  5. $([[ -n "$IMAGE" ]] && echo "Deploy the Cloud Run job $JOB from $IMAGE" || echo "Build this directory with Cloud Build and deploy it as the Cloud Run job $JOB")
  6. Create the service account $SCHED_SA_NAME, allowed to run that job only
  7. Run the job every minute with Cloud Scheduler ($SCHEDULE_NAME)
PLAN
fi
cat <<PLAN

It doesn't read, create or delete any API key, and Keyll gets no access to your project.
PLAN

if [[ $YES -eq 0 ]]; then
  read -r -p "Go ahead? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || { echo "Nothing changed."; exit 0; }
fi

TOKEN="${KEYLL_TOKEN:-}"
[[ -n "$TOKEN_FILE" ]] && TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
if [[ -z "$TOKEN" ]]; then
  read -r -s -p "Paste the watcher token from the Keyll dashboard (hidden): " TOKEN
  echo
fi
[[ "$TOKEN" =~ ^kw_[A-Za-z0-9_-]{40,}$ ]] || die "That doesn't look like a watcher token (it starts with kw_)."

step "Enabling APIs"
if [[ "$TARGET" == "onprem" ]]; then
  APIS=(apikeys.googleapis.com monitoring.googleapis.com iam.googleapis.com)
  [[ "$CREDENTIALS" == "wif" ]] && APIS+=(iamcredentials.googleapis.com sts.googleapis.com)
else
  APIS=(apikeys.googleapis.com monitoring.googleapis.com run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com iam.googleapis.com)
  [[ -z "$IMAGE" ]] && APIS+=(cloudbuild.googleapis.com artifactregistry.googleapis.com)
fi
gcloud services enable "${APIS[@]}" "${G[@]}"

step "Custom role $ROLE_ID"
if gcloud iam roles describe "$ROLE_ID" "${G[@]}" >/dev/null 2>&1; then
  gcloud iam roles update "$ROLE_ID" --permissions "$PERMISSIONS" "${G[@]}" >/dev/null
else
  gcloud iam roles create "$ROLE_ID" --title "Keyll watcher" --stage GA \
    --description "Read per-key request counts and swap API key restrictions. No access to key strings." \
    --permissions "$PERMISSIONS" "${G[@]}" >/dev/null
fi

step "Service account $SA_NAME"
gcloud iam service-accounts describe "$SA" "${G[@]}" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --display-name "Keyll watcher" "${G[@]}"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$ROLE" --condition None --quiet >/dev/null

if [[ "$TARGET" == "onprem" ]]; then
  step "Credentials for $SA_NAME"
  mkdir -p "$OUT_DIR"
  umask 077
  CREDS_FILE="$OUT_DIR/keyll-watcher-credentials.json"
  if [[ "$CREDENTIALS" == "wif" ]]; then
    gcloud iam service-accounts add-iam-policy-binding "$SA" --member "$WIF_PRINCIPAL" --role roles/iam.workloadIdentityUser "${G[@]}" >/dev/null
    gcloud iam workload-identity-pools create-cred-config "$WIF_PROVIDER" --service-account "$SA" \
      --credential-source-file "$WIF_TOKEN_FILE" --output-file "$CREDS_FILE" --quiet
  else
    gcloud iam service-accounts keys create "$CREDS_FILE" --iam-account "$SA" "${G[@]}"
  fi
  cat > "$OUT_DIR/keyll-watcher.env" <<ENVFILE
# Keyll watcher settings for $PROJECT. Readable only by you: it holds the watcher token.
KEYLL_URL=$KEYLL_URL
KEYLL_TOKEN=$TOKEN
KEYLL_WORKSPACE_ID=$WORKSPACE_ID
KEYLL_WATCHER_ID=$WATCHER_ID
KEYLL_PUBLIC_KEYS=$PUBLIC_KEY
KEYLL_MODE=$MODE
GCP_PROJECT=$PROJECT
GOOGLE_APPLICATION_CREDENTIALS=/etc/keyll/credentials.json
ENVFILE
  unset TOKEN
  cat <<DONE

Done. The Google side is ready. Two files are in $OUT_DIR, both readable only by you:
  keyll-watcher.env                  settings and the watcher token
  keyll-watcher-credentials.json     $([[ "$CREDENTIALS" == "wif" ]] && echo "keyless credentials: it points at $WIF_TOKEN_FILE, no secret inside" || echo "the service account key: a secret, treat it like a password")

Run the watcher with Docker, systemd or Kubernetes: see deploy/README.md. With Docker:

  docker run -d --name keyll-watcher --restart unless-stopped --env-file $OUT_DIR/keyll-watcher.env \
    -v $(cd "$OUT_DIR" && pwd)/keyll-watcher-credentials.json:/etc/keyll/credentials.json:ro \
    <watcher image> node bin/keyll-watcher.mjs loop 60

It's in $MODE mode: it won't block any key. To allow blocks, set KEYLL_MODE=enforce in keyll-watcher.env and restart it.
Remove the Google side later with: ./uninstall.sh --project $PROJECT --target onprem
DONE
  exit 0
fi

step "Secret $SECRET"
if gcloud secrets describe "$SECRET" "${G[@]}" >/dev/null 2>&1; then
  printf %s "$TOKEN" | gcloud secrets versions add "$SECRET" --data-file=- "${G[@]}" >/dev/null
else
  printf %s "$TOKEN" | gcloud secrets create "$SECRET" --replication-policy automatic --data-file=- "${G[@]}" >/dev/null
fi
gcloud secrets add-iam-policy-binding "$SECRET" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor "${G[@]}" >/dev/null
unset TOKEN

step "Cloud Run job $JOB"
ENV_VARS="KEYLL_URL=${KEYLL_URL},KEYLL_WORKSPACE_ID=${WORKSPACE_ID},KEYLL_WATCHER_ID=${WATCHER_ID},KEYLL_MODE=${MODE},GCP_PROJECT=${PROJECT}"
[[ -n "$PUBLIC_KEY" ]] && ENV_VARS="${ENV_VARS},KEYLL_PUBLIC_KEYS=${PUBLIC_KEY}"
DEPLOY=(gcloud run jobs deploy "$JOB" --region "$REGION" --service-account "$SA" --set-env-vars "$ENV_VARS"
  --set-secrets "KEYLL_TOKEN=${SECRET}:latest" --task-timeout 55s --max-retries 0 --tasks 1 --memory 256Mi --cpu 1 "${G[@]}")
if [[ -n "$IMAGE" ]]; then
  "${DEPLOY[@]}" --image "$IMAGE"
elif ! "${DEPLOY[@]}" --source "$HERE"; then
  NUMBER="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
  cat >&2 <<HELP

The build failed. In projects created after mid-2024, Cloud Build runs as the Compute Engine default service
account, which needs the Cloud Run Builder role first. If you're happy to grant it, run this and then re-run
the install:

  gcloud projects add-iam-policy-binding $PROJECT \\
    --member serviceAccount:${NUMBER}-compute@developer.gserviceaccount.com --role roles/run.builder
HELP
  exit 1
fi

step "Scheduler identity $SCHED_SA_NAME"
gcloud iam service-accounts describe "$SCHED_SA" "${G[@]}" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SCHED_SA_NAME" --display-name "Keyll watcher scheduler" "${G[@]}"
gcloud run jobs add-iam-policy-binding "$JOB" --region "$REGION" --member "serviceAccount:$SCHED_SA" --role roles/run.invoker "${G[@]}" >/dev/null

step "Every-minute schedule"
URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
SCHED=(--location "$REGION" --schedule "* * * * *" --uri "$URI" --http-method POST --oauth-service-account-email "$SCHED_SA" "${G[@]}")
if gcloud scheduler jobs describe "$SCHEDULE_NAME" --location "$REGION" "${G[@]}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$SCHEDULE_NAME" "${SCHED[@]}" >/dev/null
else
  gcloud scheduler jobs create http "$SCHEDULE_NAME" "${SCHED[@]}" >/dev/null
fi
gcloud run jobs execute "$JOB" --region "$REGION" "${G[@]}" >/dev/null || true

cat <<DONE

Done. The watcher runs every minute and the Keyll dashboard shows its first heartbeat within a minute or two.
It's in $MODE mode.$([[ "$MODE" == "dry-run" ]] && printf '%s' " It won't block any key. When you're ready:

  gcloud run jobs update $JOB --project $PROJECT --region $REGION --update-env-vars KEYLL_MODE=enforce")

Logs: gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="$JOB"' --project $PROJECT --limit 20
Remove everything: ./uninstall.sh --project $PROJECT --region $REGION
DONE

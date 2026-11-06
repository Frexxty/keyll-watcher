#!/usr/bin/env bash
# Removes everything install.sh created. Run it with an owner account:
#   ./uninstall.sh --project my-app-prod --region us-central1 [--yes]
#
# It first lists any key Keyll still has blocked. Restore those before uninstalling, or they stay blocked:
#   GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) GCP_PROJECT=my-app-prod node bin/keyll-watcher.mjs restore <key>
set -euo pipefail

PROJECT="" REGION="us-central1" YES=0
JOB="keyll-watcher" SA_NAME="keyll-watcher" SCHED_SA_NAME="keyll-scheduler" ROLE_ID="keyllWatcher" SECRET="keyll-watcher-token" SCHEDULE_NAME="keyll-watcher-every-minute"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --target) shift 2 ;; # the same cleanup works for both; on-prem simply has no job, schedule or secret
    --yes|-y) YES=1; shift ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
done
[[ -n "$PROJECT" ]] || { echo "--project is required" >&2; exit 1; }
G=(--project "$PROJECT" --quiet)
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SCHED_SA="${SCHED_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

BLOCKED="$(gcloud services api-keys list --project "$PROJECT" --format 'value(displayName,annotations)' 2>/dev/null | grep 'keyll.cloud/incident' || true)"
if [[ -n "$BLOCKED" ]]; then
  echo "These keys are still blocked by Keyll and will stay blocked after uninstalling:"
  echo "$BLOCKED" | cut -f1 | sed 's/^/  /'
  echo
fi

echo "This removes the scheduler job, the Cloud Run job $JOB, the secret $SECRET, the service accounts"
echo "$SA_NAME and $SCHED_SA_NAME, and the custom role $ROLE_ID from $PROJECT."
if [[ $YES -eq 0 ]]; then
  read -r -p "Go ahead? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || { echo "Nothing changed."; exit 0; }
fi

gcloud scheduler jobs delete "$SCHEDULE_NAME" --location "$REGION" "${G[@]}" 2>/dev/null || true
gcloud run jobs delete "$JOB" --region "$REGION" "${G[@]}" 2>/dev/null || true
gcloud secrets delete "$SECRET" "${G[@]}" 2>/dev/null || true
gcloud projects remove-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "projects/${PROJECT}/roles/${ROLE_ID}" --condition None --quiet >/dev/null 2>&1 || true
# Deleting the service account also invalidates any key or federated access granted for on-prem watchers.
gcloud iam service-accounts delete "$SA" "${G[@]}" 2>/dev/null || true
gcloud iam service-accounts delete "$SCHED_SA" "${G[@]}" 2>/dev/null || true
gcloud iam roles delete "$ROLE_ID" "${G[@]}" >/dev/null 2>&1 || true
echo "Removed. (Google keeps a deleted custom role for 7 days before purging it. Cloud Build's source bucket and"
echo "the cloud-run-source-deploy Artifact Registry repository stay; delete them by hand if you don't use them.)"

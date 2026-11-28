#!/usr/bin/env bash
# One review-only GCP build + on-demand scan. Never deploys or runs a DB Job.
set -Eeuo pipefail
umask 077
REPO='yoshihisahagisaka/atlib-msp-customer-portal'
BRANCH='chore/secure-guard-app-base-digest-20261128'
PROJECT='msp-zabbix'
REGION='asia-northeast1'
BASE='sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5'
LOCK='31ebf3b7e5afb4f83d7e33815cfe14625afd3da4e281dbfebd08079ba62fe591'
HEAD="$1"
stop() { echo "[STOP] $*" >&2; exit 1; }
[[ "$HEAD" =~ ^[a-f0-9]{40}$ ]] || stop 'Supply reviewed 40-character PR18 HEAD'
for tool in gh git gcloud jq tar sha256sum; do
  command -v "$tool" >/dev/null || stop "Missing $tool"
done
gh auth status >/dev/null || stop 'GitHub auth unavailable'
[[ "$(gcloud config get-value project 2>/dev/null)" == "$PROJECT" ]] || stop 'Wrong active GCP project'
services="$(gcloud services list --enabled --project="$PROJECT" --format='value(config.name)')"
for api in cloudbuild.googleapis.com artifactregistry.googleapis.com ondemandscanning.googleapis.com; do
  grep -Fxq "$api" <<< "$services" || stop "API not enabled: $api"
done
fmt="$(gcloud artifacts repositories describe cloud-run-source-deploy --project="$PROJECT" \
  --location="$REGION" --format='value(format)')"
[[ "$fmt" == DOCKER ]] || stop 'Review target is not an existing Docker repository'
ROOT="$REGION-docker.pkg.dev/$PROJECT/cloud-run-source-deploy/secure-guard-app-review"
TAG="$ROOT:pr18-$HEAD"
if gcloud artifacts docker images describe "$TAG" --project="$PROJECT" \
  --format='value(image_summary.digest)' >/dev/null 2>&1; then
  stop "Review tag already exists; no overwrite: $TAG"
fi

WORK="$(mktemp -d)"
ART="$HOME/sg-app-gcp-review-$HEAD"
[[ ! -e "$ART" ]] || stop "Evidence directory exists; no automatic retry: $ART"
mkdir -m 700 "$ART"
cleanup() {
  rc=$?
  trap - EXIT
  rm -rf "$WORK"
  if (( rc != 0 )); then echo "[STOP] Inspect $ART before any manual retry" >&2; fi
  exit "$rc"
}
trap cleanup EXIT

mkdir "$WORK/src"
gh repo clone "$REPO" "$WORK/repo" -- --single-branch --depth 1 --branch "$BRANCH" --quiet
[[ "$(git -C "$WORK/repo" rev-parse HEAD)" == "$HEAD" ]] || stop 'GitHub HEAD drift'
[[ -z "$(git -C "$WORK/repo" status --porcelain)" ]] || stop 'Unclean clone'
# Require exact HEAD CI successes before any paid GCP operation.
runs="$(gh api "repos/$REPO/actions/runs?branch=$BRANCH&per_page=30")"
pass="$(jq -r --arg head "$HEAD" \
  '[.workflow_runs[] | select(.head_sha==$head and .conclusion=="success")] | length' <<< "$runs")"
(( pass >= 2 )) || stop "Expected 2 successful CI runs on exact HEAD, got $pass"
# Only committed source enters the Build; never upload .git or local files.
git -C "$WORK/repo" archive "$HEAD" | tar -xf - -C "$WORK/src"
for name in Dockerfile package-lock.json cloudbuild.secure-guard-app-review.yaml; do
  [[ -s "$WORK/src/$name" ]] || stop "Missing reviewed source: $name"
done
echo "$LOCK  $WORK/src/package-lock.json" | sha256sum -c -
count="$(grep -cF "FROM node:24-alpine@$BASE" "$WORK/src/Dockerfile")"
[[ "$count" == 2 ]] || stop 'Both Dockerfile stages must use the approved immutable base'

# Mutation boundary: one Cloud Build and one scan; only a NEW review image tag.
echo "=== Cloud Build (review image only) ==="
gcloud --quiet builds submit "$WORK/src" --project="$PROJECT" --region="$REGION" \
  --config="$WORK/src/cloudbuild.secure-guard-app-review.yaml" \
  --substitutions="_IMAGE=$TAG,_SOURCE_REVISION=$HEAD" \
  --timeout=900s --suppress-logs --format=json > "$ART/build-submit.json"
id="$(jq -r '.id // empty' "$ART/build-submit.json")"
[[ "$id" =~ ^[a-f0-9-]{36}$ ]] || stop 'Build ID unavailable; inspect Cloud Build before retry'
gcloud builds describe "$id" --project="$PROJECT" --region="$REGION" \
  --format=json > "$ART/build-verified.json"
jq -e '.status=="SUCCESS"' "$ART/build-verified.json" >/dev/null || stop 'Cloud Build not SUCCESS'
gcloud artifacts docker images describe "$TAG" --project="$PROJECT" \
  --format=json > "$ART/image.json"
digest="$(jq -r '.image_summary.digest // empty' "$ART/image.json")"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || stop 'Registry immutable digest missing'
jq -e --arg digest "$digest" \
  'any(.results.images[]?; .digest==$digest)' "$ART/build-verified.json" >/dev/null ||
  stop 'Image digest disagrees with completed Cloud Build'
IMAGE="$ROOT@$digest"

echo "=== On-demand Artifact Analysis (OS + npm, no exclusions) ==="
scan="$(gcloud artifacts docker images scan "$IMAGE" --project="$PROJECT" \
  --remote --location=asia --format='value(response.scan)')"
[[ "$scan" == projects/$PROJECT/locations/asia/scans/* ]] || stop 'Scan response invalid'
gcloud artifacts docker images list-vulnerabilities "$scan" --project="$PROJECT" \
  --format=json > "$ART/scan.json"
jq -e 'type=="array" and all(.[]; .kind=="VULNERABILITY" and (.vulnerability|type=="object"))' \
  "$ART/scan.json" >/dev/null || stop 'Invalid scan result shape'
read -r critical high unknown total < <(jq -r '
  [ .[] | (.vulnerability.effectiveSeverity // .vulnerability.severity // "UNKNOWN") ] as $s
  | [ ([$s[]|select(.=="CRITICAL")]|length),
      ([$s[]|select(.=="HIGH")]|length),
      ([$s[]|select(.!="CRITICAL" and .!="HIGH" and .!="MEDIUM" and .!="LOW" and .!="MINIMAL" and .!="NEGLIGIBLE")]|length),
      ($s|length) ] | @tsv
' "$ART/scan.json")
jq -n --arg head "$HEAD" --arg build "$id" --arg image "$IMAGE" --arg scan "$scan" \
  --argjson critical "$critical" --argjson high "$high" --argjson unknown "$unknown" \
  --argjson total "$total" \
  '{sourceCommit:$head,buildId:$build,image:$image,scan:$scan,critical:$critical,high:$high,unknown:$unknown,totalOccurrences:$total}' \
  > "$ART/result.json"
cat "$ART/result.json"
[[ "$critical" == 0 && "$high" == 0 && "$unknown" == 0 ]] ||
  stop 'Artifact Analysis C0/H0 gate is STOP'
echo 'SECURE_GUARD_APP_GCP_IMAGE_GATE=PASS_REVIEW_ONLY'
echo 'SECURE_GUARD_GATE_S3=STOP_MIGRATION_IMAGE_OPENSSL'
echo 'SECURE_GUARD_PRODUCTION=NO_GO'
echo "EVIDENCE=$ART/result.json"

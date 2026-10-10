#!/usr/bin/env bash
# One-time Google Cloud setup for the Orient orchestrator. Safe to re-run.
# Run it yourself after `gcloud auth login`. It prints the values to store as GitHub variables.
# No secret values are read or written here: secrets are added to Secret Manager separately.
#
#   PROJECT_ID=my-project REGION=europe-west1 ./infra/gcp/setup.sh
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
GITHUB_REPO="${GITHUB_REPO:-tungsten-united/orient-frontend}"
REPO_NAME="orient"
RUNTIME_SA="orient-orchestrator"
DEPLOY_SA="orient-deployer"
POOL="github"
PROVIDER="github-oidc"

# New service accounts take a few seconds to become visible to IAM, so bindings are retried.
retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge 8 ]; then echo "Failed after $n attempts: $*" >&2; return 1; fi
    echo "  waiting for IAM to catch up (attempt $n)..."
    sleep 5
  done
}

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "Enabling APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  logging.googleapis.com

echo "Artifact Registry repository..."
gcloud artifacts repositories describe "$REPO_NAME" --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker --location "$REGION" \
    --description="Orient container images"

echo "Service accounts..."
for sa in "$RUNTIME_SA" "$DEPLOY_SA"; do
  gcloud iam service-accounts describe "$sa@$PROJECT_ID.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$sa" --display-name="$sa"
done
RUNTIME_EMAIL="$RUNTIME_SA@$PROJECT_ID.iam.gserviceaccount.com"
DEPLOY_EMAIL="$DEPLOY_SA@$PROJECT_ID.iam.gserviceaccount.com"

echo "Runtime permissions (read secrets, write logs)..."
for role in roles/secretmanager.secretAccessor roles/logging.logWriter; do
  retry gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$RUNTIME_EMAIL" --role="$role" --condition=None >/dev/null
done

echo "Deployer permissions (push images, deploy Cloud Run)..."
for role in roles/run.admin roles/artifactregistry.writer; do
  retry gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$DEPLOY_EMAIL" --role="$role" --condition=None >/dev/null
done
retry gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_EMAIL" \
  --member="serviceAccount:$DEPLOY_EMAIL" --role="roles/iam.serviceAccountUser" >/dev/null

echo "Workload Identity Federation for GitHub Actions (no long-lived keys)..."
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub"
gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --workload-identity-pool="$POOL" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --workload-identity-pool="$POOL" --location=global \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='$GITHUB_REPO'"
retry gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_EMAIL" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GITHUB_REPO" >/dev/null

cat <<EOF

Done. Store these as GitHub repository VARIABLES (they are identifiers, not secrets):

  GCP_PROJECT_ID                 = $PROJECT_ID
  GCP_REGION                     = $REGION
  GCP_WORKLOAD_IDENTITY_PROVIDER = projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER
  GCP_DEPLOYER_SA                = $DEPLOY_EMAIL
  GCP_RUNTIME_SA                 = $RUNTIME_EMAIL

Add secrets to Secret Manager yourself, for example:
  printf '%s' "\$VALUE" | gcloud secrets create JEV_API_KEY --data-file=-
EOF

#!/usr/bin/env bash
# Deploy Smooth Journey to your AWS account. Run it in AWS CloudShell from the repo folder:
#   ./deploy.sh                      # without AI (built-in rules), good for a first test
#   ./deploy.sh <bedrock-model-id>   # with an AI model on Amazon Bedrock (we use Amazon Nova Lite)
# Optional second argument: stack name (default: smooth-journey).
# After the first deploy, run ./setup-demo.sh once to create the demo accounts.
set -euo pipefail
cd "$(dirname "$0")"

MODEL_ID="${1:-none}"
STACK="${2:-smooth-journey}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
if [ -z "$REGION" ]; then echo "No AWS region set. Run: export AWS_REGION=ap-southeast-1 (or your region)"; exit 1; fi

if ! command -v sam >/dev/null 2>&1; then
  echo "Installing the AWS SAM CLI (one time)..."
  pip3 install --user --quiet aws-sam-cli
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "==> Deploying stack '$STACK' to $REGION (model: $MODEL_ID). The first run takes about 5-10 minutes."
sam deploy \
  --template-file template.yaml \
  --stack-name "$STACK" \
  --region "$REGION" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides "ModelId=$MODEL_ID" \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET="$(out BucketName)"
DIST="$(out DistributionId)"
URL="$(out SiteUrl)"
CLIENT_ID="$(out UserPoolClientId)"

# Settings the browser needs (all public values; no secrets).
DEMO_PASSWORD=""
[ -f .demo-password ] && DEMO_PASSWORD="$(cat .demo-password)"
cat > frontend/config.js <<EOF
window.SJ_CONFIG = { region: "$REGION", clientId: "$CLIENT_ID", demoPassword: "$DEMO_PASSWORD" };
EOF

echo "==> Uploading the website"
aws s3 sync frontend "s3://$BUCKET" --delete --region "$REGION" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" >/dev/null

echo
echo "Done. Your app: $URL"
echo "  Three-phone demo: $URL/demo.html"
echo "  Check the API:    curl -s $URL/api/health"
[ -f .demo-password ] || echo "  Next (once): ./setup-demo.sh   to create the demo accounts"
echo "(A brand-new CloudFront site can take a few minutes before the link answers.)"

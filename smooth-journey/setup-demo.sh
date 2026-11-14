#!/usr/bin/env bash
# Creates the five demo accounts and the demo trip (Mrs Chan, CX 255 to London), then shows them
# as one-tap logins on the welcome screen. Safe to run again: it resets the demo data.
#   ./setup-demo.sh                 # password: SmoothDemo2026
#   ./setup-demo.sh 'YourPassw0rd'  # at least 8 characters with upper case, lower case and a number
set -euo pipefail
cd "$(dirname "$0")"

PASSWORD="${1:-SmoothDemo2026}"
STACK="${2:-smooth-journey}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
POOL="$(out UserPoolId)"
FN="$(out FunctionName)"

make_user() {   # email, display name, group  -> prints the user's id
  local email="$1" name="$2" group="$3"
  aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL" --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true Name=name,Value="$name" \
    --message-action SUPPRESS >/dev/null 2>&1 || true
  aws cognito-idp admin-set-user-password --region "$REGION" --user-pool-id "$POOL" --username "$email" \
    --password "$PASSWORD" --permanent
  aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$POOL" --username "$email" --group-name "$group"
  aws cognito-idp admin-get-user --region "$REGION" --user-pool-id "$POOL" --username "$email" \
    --query "UserAttributes[?Name=='sub'].Value" --output text
}

echo "==> Creating demo accounts"
P=$(make_user mrs.chan@example.com "Mrs Chan" passenger)
C=$(make_user mei@example.com "Mei" carer)
S=$(make_user staff@example.com "Alex Wong" staff)
W=$(make_user crew@example.com "Daniel Yip" crew)
V=$(make_user supervisor@example.com "Priya Shah" supervisor)

echo "==> Loading the demo trip"
PAYLOAD=$(cat <<EOF
{"admin":"seed","users":{"passenger":{"sub":"$P","name":"Mrs Chan"},"carer":{"sub":"$C","name":"Mei"},"staff":[{"sub":"$S","name":"Alex Wong"}],"crew":{"sub":"$W","name":"Daniel Yip"},"supervisor":{"sub":"$V","name":"Priya Shah"}}}
EOF
)
aws lambda invoke --region "$REGION" --function-name "$FN" --cli-binary-format raw-in-base64-out \
  --payload "$PAYLOAD" /tmp/sj-seed.json >/dev/null
cat /tmp/sj-seed.json; echo

echo "$PASSWORD" > .demo-password
BUCKET="$(out BucketName)"; DIST="$(out DistributionId)"; CLIENT_ID="$(out UserPoolClientId)"
cat > frontend/config.js <<EOF
window.SJ_CONFIG = { region: "$REGION", clientId: "$CLIENT_ID", demoPassword: "$PASSWORD" };
EOF
aws s3 cp frontend/config.js "s3://$BUCKET/config.js" --region "$REGION" --cache-control "no-cache" >/dev/null
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/config.js" >/dev/null

echo
echo "Demo accounts (password: $PASSWORD):"
echo "  Passenger   mrs.chan@example.com"
echo "  Carer       mei@example.com"
echo "  Staff       staff@example.com"
echo "  Crew        crew@example.com"
echo "  Supervisor  supervisor@example.com"
echo "They also appear as one-tap buttons on the welcome screen."

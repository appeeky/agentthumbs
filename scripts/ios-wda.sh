#!/usr/bin/env bash
# Builds WebDriverAgent, starts it on a USB-connected iPhone and forwards port 8100.
#
#   scripts/ios-wda.sh <device-udid> <team-id> [bundle-id]
#
# Needs Xcode, Developer Mode on the iPhone, a signing team and iproxy
# (brew install libimobiledevice). WebDriverAgent is cloned to ~/.agentthumbs/WebDriverAgent.
set -euo pipefail

UDID="${1:?usage: ios-wda.sh <device-udid> <team-id> [bundle-id]}"
TEAM="${2:?usage: ios-wda.sh <device-udid> <team-id> [bundle-id]}"
BUNDLE="${3:-com.agentthumbs.WebDriverAgentRunner}"
HOME_DIR="${AGENTTHUMBS_HOME:-$HOME/.agentthumbs}"
WDA="$HOME_DIR/WebDriverAgent"
BUILD="$HOME_DIR/wda-build"
PORT="${AGENTTHUMBS_WDA_PORT:-8100}"

if [ ! -d "$WDA" ]; then
  git clone --depth 1 https://github.com/appium/WebDriverAgent.git "$WDA"
fi

if ! ls "$BUILD"/Build/Products/*.xctestrun >/dev/null 2>&1; then
  echo "Building WebDriverAgent (first run only)..."
  xcodebuild build-for-testing \
    -project "$WDA/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner \
    -destination "id=$UDID" -derivedDataPath "$BUILD" -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" \
    | grep -E "error:|BUILD|TEST BUILD" || true
fi

XCTESTRUN=$(ls "$BUILD"/Build/Products/*.xctestrun | head -1)
echo "Starting WebDriverAgent on $UDID and forwarding localhost:$PORT..."
iproxy "$PORT" 8100 -u "$UDID" >/dev/null 2>&1 &
IPROXY=$!
trap 'kill $IPROXY 2>/dev/null' EXIT

xcodebuild test-without-building -xctestrun "$XCTESTRUN" -destination "id=$UDID" 2>&1 \
  | grep --line-buffered -E "ServerURLHere|error:|Test Suite .* (started|failed)"

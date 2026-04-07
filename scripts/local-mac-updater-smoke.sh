#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  scripts/local-mac-updater-smoke.sh <older_version>

Example:
  scripts/local-mac-updater-smoke.sh 0.1.4

What it does:
  1. copies bluedoor-desktop into /tmp/bluedoor-desktop-updater-test
  2. rewrites package.json version to the older version you pass in
  3. installs dependencies under Node 20
  4. builds an arm64-only packaged mac app
  5. opens that packaged app
  6. tails ~/.bluedoor/desktop.log so you can watch updater events

Use this when the public GitHub Release is newer than the version you pass in.
For example, if GitHub Releases currently has 0.1.5 live, pass 0.1.4 here.
EOF
  exit 1
fi

OLDER_VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="/tmp/bluedoor-desktop-updater-test"
LOG_FILE="${HOME}/.bluedoor/desktop.log"
APP_PATH="${TMP_DIR}/dist/mac-arm64/bluedoor.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This helper is macOS-only."
  exit 1
fi

if [[ ! -f "${HOME}/.nvm/nvm.sh" ]]; then
  echo "nvm is required at ${HOME}/.nvm/nvm.sh"
  exit 1
fi

FREE_KB="$(df -k /tmp | awk 'NR==2 {print $4}')"
REQUIRED_KB=$((5 * 1024 * 1024))
if (( FREE_KB < REQUIRED_KB )); then
  echo "Not enough free disk space in /tmp."
  echo "Need about 5 GiB free for the arm64 updater smoke test."
  df -h /tmp
  exit 1
fi

echo "Preparing disposable test tree at ${TMP_DIR}"
rm -rf "${TMP_DIR}"
mkdir -p "${TMP_DIR}"
rsync -a --delete --exclude '.git' --exclude 'dist' "${SOURCE_DIR}/" "${TMP_DIR}/"

echo "Rewriting package version to ${OLDER_VERSION}"
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const version = process.argv[2];
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
  pkg.version = version;
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
' "${TMP_DIR}/package.json" "${OLDER_VERSION}"

source "${HOME}/.nvm/nvm.sh"
nvm use 20 >/dev/null

echo "Installing dependencies with Node $(node -v)"
cd "${TMP_DIR}"
rm -rf node_modules dist
npm install

echo "Building packaged arm64 app"
npx electron-builder --config electron-builder.config.js --mac dmg zip --arm64

if [[ ! -d "${APP_PATH}" ]]; then
  echo "Expected app not found at ${APP_PATH}"
  exit 1
fi

echo "Clearing previous desktop log"
rm -f "${LOG_FILE}"

echo "Launching ${APP_PATH}"
pkill -f '/Applications/bluedoor.app' || true
pkill -f "${APP_PATH}" || true
open "${APP_PATH}"

cat <<EOF

Updater smoke test is running.

Packaged app:
  ${APP_PATH}

Log file:
  ${LOG_FILE}

Expected log sequence:
  Binary updater: starting background check
  Binary updater: checking for updates (app v${OLDER_VERSION})
  Binary updater: update available ${OLDER_VERSION} -> <newer version>

If the native update dialog appears, click:
  1. Download Update
  2. Restart and Install

Useful manual checks:
  tail -f "${LOG_FILE}"
  grep 'Binary updater:' "${LOG_FILE}"

Optional AppleScript click attempts:
  osascript -e 'tell application "System Events" to tell process "bluedoor" to click button "Download Update" of window 1'
  osascript -e 'tell application "System Events" to tell process "bluedoor" to click button "Restart and Install" of window 1'
EOF

echo "Waiting for desktop log to appear..."
for _ in $(seq 1 60); do
  if [[ -f "${LOG_FILE}" ]]; then
    exec tail -f "${LOG_FILE}"
  fi
  sleep 1
done

echo "Desktop log did not appear within 60 seconds: ${LOG_FILE}"
exit 1

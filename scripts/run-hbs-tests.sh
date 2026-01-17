#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HBS_REPO="${HBS_REPO:-"$SCRIPT_DIR/.."}"
ST_REPO="${ST_REPO:-"$HBS_REPO/../SillyTavern"}"
BRANCH="release"
ST_PORT="${ST_PORT:-}"

if [ ! -d "$ST_REPO/.git" ]; then
    echo "SillyTavern repo not found at $ST_REPO" >&2
    exit 1
fi

if [ ! -f "$HBS_REPO/manifest.json" ]; then
    echo "HBS extension manifest not found at $HBS_REPO/manifest.json" >&2
    exit 1
fi

if [ -z "$ST_PORT" ]; then
    ST_PORT=$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")
fi
ST_BASE_URL="http://127.0.0.1:${ST_PORT}"

echo "Resetting SillyTavern repo at $ST_REPO to origin/$BRANCH"
git -C "$ST_REPO" fetch --all --prune
git -C "$ST_REPO" checkout "$BRANCH"
git -C "$ST_REPO" reset --hard "origin/$BRANCH"
git -C "$ST_REPO" clean -fdx

echo "Installing SillyTavern dependencies"
cd "$ST_REPO"
npm ci

echo "Installing test dependencies"
cd "$ST_REPO/tests"
npm ci
npm install --no-save jest-environment-jsdom yaml

echo "Syncing HBS extension"
rm -rf "$ST_REPO/public/scripts/extensions/third-party/hbs"
mkdir -p "$ST_REPO/public/scripts/extensions/third-party/hbs"
cp "$HBS_REPO/index.js" "$HBS_REPO/manifest.json" "$HBS_REPO/style.css" "$HBS_REPO/bucket-manager.js" "$ST_REPO/public/scripts/extensions/third-party/hbs/"

echo "Syncing HBS tests"
rm -rf "$ST_REPO/tests/hbs"
cp -R "$HBS_REPO/tests/hbs" "$ST_REPO/tests/hbs"

echo "Running Jest unit tests (HBS only)"
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json hbs

if [ "${RUN_E2E:-0}" = "1" ]; then
    ST_LOG="$ST_REPO/tests/hbs/st-server.log"

    echo "Starting SillyTavern for Playwright..."
    mkdir -p "$(dirname "$ST_LOG")"
    (cd "$ST_REPO" && node server.js --disableCsrf --port "$ST_PORT" --browserLaunchEnabled false > "$ST_LOG" 2>&1) &
    ST_SERVER_PID=$!

    cleanup() {
        if [ -n "${ST_SERVER_PID:-}" ]; then
            kill "$ST_SERVER_PID" >/dev/null 2>&1 || true
            wait "$ST_SERVER_PID" >/dev/null 2>&1 || true
        fi
    }
    trap cleanup EXIT

    server_ready=false
    for _ in $(seq 1 60); do
        if node -e "fetch('${ST_BASE_URL}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
            server_ready=true
            break
        fi
        sleep 1
    done

    if [ "$server_ready" != "true" ]; then
        echo "SillyTavern did not start in time. Tail of server log:"
        tail -n 200 "$ST_LOG" || true
        exit 1
    fi

    echo "Running Playwright E2E tests (HBS only)"
    HBS_BASE_URL="$ST_BASE_URL" npx playwright test --config hbs/playwright.config.js
else
    echo "Skipping Playwright. Set RUN_E2E=1 to enable."
fi

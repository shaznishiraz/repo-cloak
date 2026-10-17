#!/bin/sh
# Install development tools and the browser test engine.
# On Linux/WSL, use --with-deps to install Chromium system dependencies too.
set -eu
cd "$(dirname "$0")/.."

npm ci
npm ci --prefix e2e
cd e2e
E2E_TELEMETRY_DISABLED=1 npx --no-install e2e-web install chromium "$@"

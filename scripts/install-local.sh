#!/bin/sh
# Build this checkout and install it as the global repo-cloak and cloak commands.
# The install is a link: after code changes, rebuild (npm run build) or keep
# npm run dev running; no reinstall is needed.
#   ./scripts/install-local.sh               build and link
#   ./scripts/install-local.sh --uninstall   remove the global commands
set -eu
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--uninstall" ]; then
  npm uninstall -g repo-cloak-cli
  echo "Removed the global repo-cloak and cloak commands."
  exit 0
fi

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi
npm run build

# Replace any earlier global install (a published version or an old link).
npm uninstall -g repo-cloak-cli >/dev/null 2>&1 || true
npm link

bin="$(npm prefix -g)/bin"
if ! command -v repo-cloak >/dev/null 2>&1; then
  echo "Linked, but $bin is not on your PATH. Add it, then open a new terminal." >&2
  exit 1
fi
echo "Installed repo-cloak $(repo-cloak --version) from $(pwd)"
echo "Try: repo-cloak --help"

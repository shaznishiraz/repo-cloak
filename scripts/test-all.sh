#!/bin/sh
# Run all local release checks, including dashboard browser tests.
set -eu
cd "$(dirname "$0")/.."

./scripts/check.sh
./scripts/test-browser.sh

#!/bin/sh
# Run dashboard browser tests against a disposable fixture.
set -eu
cd "$(dirname "$0")/.."

./node_modules/.bin/tsc --project e2e/tsconfig.json --noEmit
npm run test:browser

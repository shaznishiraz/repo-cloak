#!/bin/sh
# Check types, style, backend coverage, and the built package.
set -eu
cd "$(dirname "$0")/.."

npm run typecheck
npm run lint
npm run test:coverage
npm run build
npm run test:package

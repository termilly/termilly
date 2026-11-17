#!/bin/sh
# Run in the OptiPlex checkout. This script never copies or pushes source.
set -eu
cd "$(dirname "$0")/.."
dotnet build src/Termilly.Linux -c Debug
npm run e2e

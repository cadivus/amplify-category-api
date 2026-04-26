#!/usr/bin/env bash
# Rebuild amplify-category-api and overlay the output into the globally installed
# @aws-amplify/cli-internal so the `amplify` binary picks up our changes.
# Run this after every edit to amplify-category-api/src/**
set -euo pipefail

export PATH=/home/jonasgre/.local/share/mise/installs/node/22.22.1/bin:$PATH

FORK=/workplace/jonasgre/AmplifyCliDatastoreDisable/amplify-category-api
INSTALLED=/local/home/jonasgre/.local/share/mise/installs/node/22.22.1/lib/node_modules/@aws-amplify/cli-internal/node_modules/@aws-amplify/amplify-category-api

cd "$FORK/packages/amplify-category-api"
echo "▶ Building amplify-category-api…"
yarn build

echo "▶ Overlaying lib/ into $INSTALLED/lib/"
rm -rf "$INSTALLED/lib"
cp -r "$FORK/packages/amplify-category-api/lib" "$INSTALLED/lib"

echo "✅ Done. amplify binary will now use the modified amplify-category-api."

#!/usr/bin/env bash
# Sync this checkout's dist/ into an installed dsh-caduceus package and align
# the deployed package.json version with the repository version.
#
# Usage:
#   CADUCEUS_DEPLOY_TARGET=/path/to/profile scripts/deploy.sh
#
# The default target is the current user's web profile. This script never
# touches services; restarting dsh remains a host-side decision.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${CADUCEUS_DEPLOY_TARGET:-$HOME/.dsh/profiles/web}"
VERSION="$(node -p "require('$ROOT/package.json').version")"

if [[ ! -d "$TARGET" ]]; then
  echo "deploy: target not found: $TARGET" >&2
  exit 1
fi

PKG_DIR="$(node -e "
  const path = require('node:path');
  try {
    process.stdout.write(path.dirname(require.resolve('dsh-caduceus/package.json', { paths: [process.argv[1]] })));
  } catch {
    process.exit(1);
  }
" "$TARGET")" || {
  echo "deploy: dsh-caduceus is not installed under $TARGET" >&2
  exit 1
}

if [[ ! -d "$ROOT/dist" ]]; then
  echo "deploy: dist/ missing; run npm run build first" >&2
  exit 1
fi

echo "deploy: syncing $ROOT/dist -> $PKG_DIR/dist"
rm -rf "$PKG_DIR/dist"
cp -a "$ROOT/dist" "$PKG_DIR/dist"

echo "deploy: setting $PKG_DIR/package.json version=$VERSION"
node -e "
  const fs = require('node:fs');
  const file = process.argv[1];
  const version = process.argv[2];
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
" "$PKG_DIR/package.json" "$VERSION"

echo "deploy: done (dsh-caduceus@$VERSION). Restart dsh from the host side when ready."

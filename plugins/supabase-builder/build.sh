#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
rm -rf dist
mkdir -p dist
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/supabase-builder"
cp -R .claude-plugin "$TMPDIR/supabase-builder/"
cp -R skills "$TMPDIR/supabase-builder/"
cp LICENSE.md "$TMPDIR/supabase-builder/"
cd "$TMPDIR"
zip -r supabase-builder.zip supabase-builder/ -x "*.DS_Store" > /dev/null
mv supabase-builder.zip "$SCRIPT_DIR/dist/"
rm -rf "$TMPDIR"
echo "Built: dist/supabase-builder.zip"

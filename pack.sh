#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="feishu_cc"
VERSION=$(date +%Y%m%d)
OUTPUT="$SCRIPT_DIR/${PROJECT_NAME}_${VERSION}.zip"

cd "$SCRIPT_DIR"

echo "📦 打包 $PROJECT_NAME ..."

zip -r "$OUTPUT" . \
  --exclude "*.git*" \
  --exclude ".claude/*" \
  --exclude "node_modules/*" \
  --exclude "dist/*" \
  --exclude "logs/*" \
  --exclude ".env" \
  --exclude ".bot.pid" \
  --exclude "*.zip" \
  --exclude "pack.sh" \
  --exclude "CLAUDE.md" \
  --exclude ".DS_Store" \
  --exclude "feishu_files/*"

echo "✅ 打包完成：$OUTPUT"

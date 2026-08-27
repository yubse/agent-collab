#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
OUTPUT_DIR=${AI_STUDIO_BUILD_DIR:-"$REPO_DIR/connector/dist"}
OUTPUT_FILE="$OUTPUT_DIR/aistudio-connector"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required to build the standalone Helper." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
cd "$REPO_DIR"
bun build --compile connector/src/index.ts --outfile "$OUTPUT_FILE"
chmod 755 "$OUTPUT_FILE"
echo "Standalone Helper: $OUTPUT_FILE"

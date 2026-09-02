#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
OUTPUT_DIR=${AI_STUDIO_BUILD_DIR:-"$REPO_DIR/connector/dist"}
mkdir -p "$OUTPUT_DIR"
cd "$REPO_DIR"
bun build --compile connector/src/speech/index.ts --outfile "$OUTPUT_DIR/aistudio-speech"
chmod 755 "$OUTPUT_DIR/aistudio-speech"
echo "Standalone Speech Service: $OUTPUT_DIR/aistudio-speech"

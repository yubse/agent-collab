#!/bin/sh
set -eu
LOG_DIR="$HOME/Library/Application Support/AIStudio/logs"
mkdir -p "$LOG_DIR"
for log_file in "$LOG_DIR/speech-service.stdout.log" "$LOG_DIR/speech-service.stderr.log"; do
  if [ -f "$log_file" ] && [ "$(/usr/bin/stat -f '%z' "$log_file")" -gt 1048576 ]; then
    /usr/bin/tail -c 524288 "$log_file" > "$log_file.trim"
    /bin/mv -f "$log_file.trim" "$log_file"
  fi
done
exec "/Library/Application Support/AIStudio/speech/aistudio-speech"

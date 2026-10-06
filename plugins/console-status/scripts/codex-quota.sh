#!/bin/sh
# Prints the latest locally recorded Codex rate-limit event as one JSON line (macOS / Linux).
# This script only reads session rollout files and performs no network requests.
# Usage: codex-quota.sh [sessions-root]

root=${1:-"$HOME/.codex/sessions"}
[ -d "$root" ] || exit 0

# Newest files first by modification time. GNU stat is tried first: GNU `stat -f` prints
# file-system status to stdout, which would mix into the list; BSD `stat -c` fails silently.
newest() {
  find "$1" -type f -name 'rollout-*.jsonl' -exec stat -c '%Y %n' {} + 2>/dev/null \
    || find "$1" -type f -name 'rollout-*.jsonl' -exec stat -f '%m %N' {} + 2>/dev/null
}

month="$root/$(date +%Y/%m)"
for dir in "$month" "$root"; do
  [ -d "$dir" ] || continue
  files=$(newest "$dir" | sort -rn | head -n 5 | cut -d' ' -f2-)
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    line=$(grep -E '"rate_limits"[[:space:]]*:[[:space:]]*\{' "$file" 2>/dev/null | tail -n 1)
    if [ -n "$line" ]; then
      printf '%s\n' "$line"
      exit 0
    fi
  done <<EOF
$files
EOF
done

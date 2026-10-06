#!/bin/sh
# Read-only Codex broker preflight (macOS / Linux).
# Prints one line beginning with OK, STALE, or UNKNOWN. It never stops a process.
# Usage: codex-preflight.sh [--companion-script <path>] [--state-dir <dir>]...
#
# A broker is STALE when the `codex app-server` it spawned started before the installed
# Codex CLI was last replaced (brew/npm upgrade), so it still runs the old binary.

script=''
state_dirs=''
while [ $# -gt 0 ]; do
  case $1 in
    --companion-script) script=${2-} ;;
    --state-dir) state_dirs="$state_dirs
${2-}" ;;
    *) shift; continue ;;
  esac
  [ $# -ge 2 ] && shift 2 || shift
done

if [ -z "$script" ]; then
  companion='UNKNOWN(unconfigured)'
elif [ -f "$script" ]; then
  companion='OK'
else
  companion='MISSING'
fi

# GUI-launched hosts often miss the Homebrew prefixes.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
bin=$(command -v codex 2>/dev/null)
if [ -z "$bin" ]; then
  echo "UNKNOWN codex=unavailable companion=$companion"
  exit 0
fi

# Follow the symlink chain to the real entry point (npm: .../@openai/codex/bin/codex.js).
target=$bin
while [ -L "$target" ]; do
  link=$(readlink "$target")
  case $link in
    /*) target=$link ;;
    *) target=$(dirname "$target")/$link ;;
  esac
done

pkg="$(dirname "$(dirname "$target")")/package.json"
version=''
if [ -f "$pkg" ]; then
  version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -n 1)
  stamp_file=$pkg
else
  stamp_file=$target
fi
[ -n "$version" ] || version=$("$bin" --version 2>/dev/null | sed -n 's/.* \([0-9][0-9.]*[^ ]*\)$/\1/p' | head -n 1)
[ -n "$version" ] || version='unknown'

# Inode change time is set by the install itself; package tarballs fix mtime to 1985.
installed=$(stat -f %c "$stamp_file" 2>/dev/null || stat -c %Z "$stamp_file" 2>/dev/null)
processes=$(ps -axo pid=,ppid=,etime=,command= 2>/dev/null)
if [ -z "$installed" ] || [ -z "$processes" ]; then
  echo "UNKNOWN codex=$version companion=$companion process-scan=unavailable"
  exit 0
fi

stale=$(printf '%s\n' "$processes" | awk -v now="$(date +%s)" -v installed="$installed" '
  function secs(t,   d, n, p, i, s) {
    d = 0
    if (index(t, "-")) { d = substr(t, 1, index(t, "-") - 1); t = substr(t, index(t, "-") + 1) }
    n = split(t, p, ":"); s = 0
    for (i = 1; i <= n; i++) s = s * 60 + p[i]
    return d * 86400 + s
  }
  {
    pid = $1; parent[pid] = $2; age[pid] = secs($3)
    cmd = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+[^ \t]+[ \t]+/, "", cmd)
    command[pid] = cmd
    order[++count] = pid
  }
  END {
    for (i = 1; i <= count; i++) {
      pid = order[i]; cmd = command[pid]
      if (cmd ~ /app-server-broker\.mjs/ || cmd !~ /(^|\/)codex(\.js)?[ \t].*app-server/) continue
      if (now - age[pid] + 1 >= installed) continue
      # app-server <- (node shim) <- companion broker
      up = parent[pid]
      for (depth = 0; depth < 3 && (up in command); depth++) {
        if (command[up] ~ /app-server-broker\.mjs/) { found[up] = 1; break }
        up = parent[up]
      }
    }
    for (pid in found) print pid
  }' | sort -n)

if [ -z "$stale" ]; then
  echo "OK codex=$version companion=$companion"
  exit 0
fi

# Map broker PIDs to workspaces through the companion state files (<slug>-<16 hex>/broker.json).
owners=$(printf '%s\n' "$state_dirs" | while IFS= read -r dir; do
  [ -n "$dir" ] && [ -d "$dir" ] || continue
  find "$dir" -type f -name broker.json 2>/dev/null | while IFS= read -r file; do
    workspace=$(basename "$(dirname "$file")" | sed 's/-[0-9a-f]\{16\}$//')
    grep -o '"pid"[[:space:]]*:[[:space:]]*[0-9]*' "$file" 2>/dev/null | sed 's/[^0-9]//g' | while IFS= read -r pid; do
      echo "$pid $workspace"
    done
  done
done)

summary=''
for pid in $stale; do
  workspace=$(printf '%s\n' "$owners" | awk -v pid="$pid" '$1 == pid { sub(/^[0-9]+ /, ""); print; exit }')
  summary="$summary $pid(${workspace:-unknown})"
done

echo "STALE codex=$version companion=$companion brokers=${summary# }"

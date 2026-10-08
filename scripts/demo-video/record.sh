#!/bin/sh
# Re-records docs/demo.mp4, docs/demo.gif and docs/screenshot.png from a real Claude Code session.
# Needs: claude, tmux, node with a global playwright, Chromium, ffmpeg, the DejaVu Sans Mono and
# WenQuanYi Zen Hei fonts. Claude Code runs in a throwaway HOME with a dummy API key: /console demo
# never calls the model. Usage: sh scripts/demo-video/record.sh   (from the repository root)
set -e
repo=$(pwd)
work=$(mktemp -d)
mkdir -p "$work/home/console" "$work/out"
cat > "$work/home/.claude.json" <<JSON
{ "hasCompletedOnboarding": true, "theme": "dark",
  "customApiKeyResponses": { "approved": ["sk-ant-dummy"], "rejected": [] },
  "projects": { "$work/home/console": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } } }
JSON
cat > "$work/run.sh" <<RUN
#!/bin/sh
cd "$work/home/console"
exec env -i HOME="$work/home" PATH="$PATH" TERM=xterm-256color COLORTERM=truecolor LANG=C.UTF-8 DISABLE_AUTOUPDATER=1 ANTHROPIC_API_KEY=sk-ant-dummy claude --plugin-dir "$repo/plugins/console-status"
RUN
chmod +x "$work/run.sh"
tmux kill-session -t rec 2>/dev/null || true
tmux new-session -d -s rec -x 150 -y 50 "$work/run.sh; sleep 900"
sleep 9
node "$repo/scripts/demo-video/record.mjs" "$repo/scripts/demo-video/storyboard.mjs" "$work/capture.json"
tmux kill-session -t rec
node "$repo/scripts/demo-video/render.mjs" "$work/capture.json" "$work/out" --gif-width 1000
cp "$work/out/demo.mp4" "$work/out/demo.gif" "$repo/docs/"
ffmpeg -loglevel error -y -ss 19 -i "$work/out/demo.mp4" -frames:v 1 "$repo/docs/screenshot.png"
echo "docs/demo.mp4, docs/demo.gif, docs/screenshot.png updated (work files in $work)"

#!/usr/bin/env bash
# publish-digest.sh <slug> <title>
#
# Reads plain-text digest on stdin, writes it as an HTML page under
# digests/<slug>/<YYYY-MM-DD>.html, rebuilds digests/index.html,
# commits, pushes to origin/main, and prints the GitHub Pages URL.

set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SLUG="${1:?usage: publish-digest.sh <slug> <title>}"
TITLE="${2:?usage: publish-digest.sh <slug> <title>}"

REPO="/Users/ronnieag/Documents/myagent/EnglishTool"
PAGES_BASE="https://agweipeng.github.io/EnglishTool"
DATE="$(date +%F)"
DIGEST_DIR="$REPO/digests/$SLUG"
DIGEST_FILE="$DIGEST_DIR/$DATE.html"
URL="$PAGES_BASE/digests/$SLUG/$DATE.html"

mkdir -p "$DIGEST_DIR"
printf '%s\n' "$TITLE" > "$DIGEST_DIR/title.txt"

BODY_ESC="$(python3 -c 'import sys,html;print(html.escape(sys.stdin.read()),end="")')"

cat > "$DIGEST_FILE" <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TITLE} — ${DATE}</title>
<style>
  body{max-width:780px;margin:2em auto;padding:0 1em;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222}
  h1{font-size:1.6em;margin:0 0 .25em}
  .meta{color:#888;margin-bottom:1.5em}
  a{color:#06f}
  pre{white-space:pre-wrap;word-wrap:break-word;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f7f7f8;padding:1em;border-radius:6px}
  hr{border:0;border-top:1px solid #eee;margin:2em 0}
</style>
</head>
<body>
<p><a href="../">← all digests</a></p>
<h1>${TITLE}</h1>
<div class="meta">${DATE}</div>
<hr>
<pre>${BODY_ESC}</pre>
</body>
</html>
HTML

INDEX="$REPO/digests/index.html"
{
  cat <<'HEAD'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Digests</title>
<style>
  body{max-width:780px;margin:2em auto;padding:0 1em;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222}
  h1{font-size:1.8em}
  h2{margin-top:1.5em;border-bottom:1px solid #eee;padding-bottom:.25em}
  ul{padding-left:0;list-style:none}
  li{margin:.25em 0}
  a{color:#06f;text-decoration:none}
  a:hover{text-decoration:underline}
  .date{color:#888;font-variant-numeric:tabular-nums;margin-right:.75em;display:inline-block;min-width:6.5em}
</style>
</head>
<body>
<p><a href="../">← back to EnglishTool</a></p>
<h1>Daily Digests</h1>
HEAD

  for d in "$REPO/digests/"*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    if [ -f "$d/title.txt" ]; then
      title="$(cat "$d/title.txt")"
    else
      title="$name"
    fi
    files="$(find "$d" -maxdepth 1 -name '*.html' -type f 2>/dev/null | sort -r || true)"
    [ -z "$files" ] && continue
    printf '<h2>%s</h2>\n<ul>\n' "$title"
    while IFS= read -r f; do
      base="$(basename "$f" .html)"
      printf '<li><span class="date">%s</span><a href="%s/%s.html">view</a></li>\n' "$base" "$name" "$base"
    done <<< "$files"
    printf '</ul>\n'
  done

  cat <<'TAIL'
</body>
</html>
TAIL
} > "$INDEX"

cd "$REPO"
git pull --rebase --autostash --quiet origin main >/dev/null 2>&1 || true
git add "digests/$SLUG/$DATE.html" "digests/$SLUG/title.txt" "digests/index.html"
if ! git diff --cached --quiet; then
  git commit -m "digest($SLUG): $DATE" --quiet
  git push --quiet origin main
fi

printf '%s\n' "$URL"

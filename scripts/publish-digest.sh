#!/usr/bin/env bash
# publish-digest.sh <slug> <title>
#
# Reads plain-text digest on stdin, writes it as an HTML page under
# digests/<slug>/<YYYY-MM-DD>.html, commits, pushes to origin/main, and
# prints the GitHub Pages URL.
#
# digests/index.html is not touched here: the Build Digest Index workflow
# (.github/workflows/fix-digest-links.yml) rebuilds it on every push under
# digests/. Writing it here too made the two copies conflict on pull.

set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SLUG="${1:?usage: publish-digest.sh <slug> <title>}"
TITLE="${2:?usage: publish-digest.sh <slug> <title>}"

# The slug becomes a folder name: only lowercase letters, digits and dashes, so it can't leave digests/
if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "publish-digest.sh: invalid slug '$SLUG' (use a-z, 0-9 and -)" >&2
  exit 1
fi
# Pages share the app's origin, so text from the digest generator must never become HTML
html_escape() { python3 -c 'import sys,html;print(html.escape(sys.stdin.read()),end="")'; }
TITLE_ESC="$(printf '%s' "$TITLE" | html_escape)"

REPO="/Users/ronnieag/Documents/myagent/EnglishTool"
PAGES_BASE="https://agweipeng.github.io/EnglishTool"
DATE="$(date +%F)"
DIGEST_DIR="$REPO/digests/$SLUG"
DIGEST_FILE="$DIGEST_DIR/$DATE.html"
URL="$PAGES_BASE/digests/$SLUG/$DATE.html"

# Pull before writing anything, so the pull never has to merge our new files.
# A failed pull stops the script (set -e) rather than publishing a half-merged tree.
# Git's messages go to stderr: stdout carries only the URL printed at the end.
cd "$REPO"
# The commit is pushed to main, so it must be made on main; on another branch it would never be
# published (the URL would 404) and the pull would rebase that branch instead
if [ "$(git rev-parse --abbrev-ref HEAD)" != main ]; then
  echo "publish-digest: switch $REPO to the main branch first" >&2
  exit 1
fi
git pull --rebase --autostash --quiet origin main >&2

mkdir -p "$DIGEST_DIR"
printf '%s\n' "$TITLE" > "$DIGEST_DIR/title.txt"

BODY_ESC="$(python3 -c 'import sys,html;print(html.escape(sys.stdin.read()),end="")')"

cat > "$DIGEST_FILE" <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TITLE_ESC} — ${DATE}</title>
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
<h1>${TITLE_ESC}</h1>
<div class="meta">${DATE}</div>
<hr>
<pre>${BODY_ESC}</pre>
</body>
</html>
HTML

git add -- "digests/$SLUG/$DATE.html" "digests/$SLUG/title.txt"
# Commit only this digest's files, never anything else that happened to be staged
if ! git diff --cached --quiet -- "digests/$SLUG/$DATE.html" "digests/$SLUG/title.txt"; then
  git commit -m "digest($SLUG): $DATE" --quiet -- "digests/$SLUG/$DATE.html" "digests/$SLUG/title.txt"
  git push --quiet origin main >&2
fi

printf '%s\n' "$URL"

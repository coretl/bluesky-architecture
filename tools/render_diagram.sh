#!/bin/sh
# Render a mermaid diagram to PNG so it can actually be looked at.
#
# Sphinx embeds mermaid for client-side rendering and never validates it, so a
# broken or badly-laid-out diagram builds clean and fails only in a browser.
# Three rounds of blind layout correction were lost to that before this existed.
#
#   tools/render_diagram.sh diagram.mmd out.png
#
# Takes a bare mermaid body (no ```{mermaid} fence). Note this sends the
# diagram to a public service; fine for architecture diagrams, not for anything
# sensitive.
set -e
[ $# -eq 2 ] || { echo "usage: $0 <file.mmd> <out.png>" >&2; exit 2; }
B=$(base64 -w0 "$1" | tr '+/' '-_')
code=$(curl -sS -o "$2" -w "%{http_code}" "https://mermaid.ink/img/$B?type=png&bgColor=white")
[ "$code" = "200" ] || { echo "mermaid.ink returned $code - check the syntax" >&2; exit 1; }
echo "wrote $2"

#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
node_path=$(command -v node 2>/dev/null)
if [ -z "$node_path" ] || ! "$node_path" -e 'const [m,n]=process.versions.node.split(".").map(Number);process.exit(m>22||(m===22&&n>=13)?0:1)' >/dev/null 2>&1; then
  node_path=""
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ] && "$candidate" -e 'const [m,n]=process.versions.node.split(".").map(Number);process.exit(m>22||(m===22&&n>=13)?0:1)' >/dev/null 2>&1; then
      node_path=$candidate
      break
    fi
  done
fi
result=1
if [ -z "$node_path" ]; then
  echo "Node.js is not installed or could not be found."
  echo "Install Node.js 22.13 or newer: https://nodejs.org/en/download"
  echo "Then reopen this launcher. Nothing was configured."
else
  "$node_path" ./connect.mjs "$@"
  result=$?
fi
echo ""
printf "Press Enter to close. "
read -r answer
exit "$result"

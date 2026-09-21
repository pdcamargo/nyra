#!/usr/bin/env bash
#
# Raster an artboard from a .nyui.json and print the PNG path.
#
# A wrapper so the command works from any directory: the pipeline is TypeScript
# in packages/design, so it needs this repo's vite-node and this repo's cwd. That
# is exactly why this is a dev affordance and not the shipping shape — shipping
# means bundling the renderer into the app's Resources.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve paths against the CALLER's directory before cd-ing into the repo.
# Without this a relative argument silently resolves against the repo root, and
# the error says "no such file" about a path the caller never typed.
declare -a ARGS=()
for a in "$@"; do
  if [[ "$a" == --* || "$a" != */* && "$a" != *.json ]]; then
    ARGS+=("$a")
  elif [[ -e "$a" ]]; then
    ARGS+=("$(cd "$(dirname "$a")" && pwd)/$(basename "$a")")
  else
    ARGS+=("$a")
  fi
done

cd "$REPO"
exec node_modules/.bin/vite-node packages/design/scripts/raster.mts "${ARGS[@]}"

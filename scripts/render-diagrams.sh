#!/usr/bin/env bash
# Renders the diagrams in docs/diagrams/*.d2 to SVG, once per palette:
# <name>.svg (light) and <name>-dark.svg (dark), embedded in the README with <picture>.
# Needs D2 (https://d2lang.com) at the pinned version on PATH, or its path in D2.
set -euo pipefail

D2_VERSION="v0.9.0"
d2="${D2:-d2}"
dir="$(cd "$(dirname "$0")/../docs/diagrams" && pwd)"

if ! command -v "$d2" >/dev/null 2>&1; then
  echo "D2 not found: install $D2_VERSION from https://github.com/d2lang/d2/releases or set D2" >&2
  exit 1
fi
version="$("$d2" --version)"
if [ "$version" != "$D2_VERSION" ]; then
  echo "D2 $D2_VERSION needed, found $version" >&2
  exit 1
fi

for source in "$dir"/*.d2; do
  name="$(basename "$source" .d2)"
  case "$name" in palette-*) continue ;; esac
  for palette in light dark; do
    out="$dir/$name.svg"
    [ "$palette" = dark ] && out="$dir/$name-dark.svg"
    cat "$dir/palette-$palette.d2" "$source" | "$d2" - "$out"
  done
done

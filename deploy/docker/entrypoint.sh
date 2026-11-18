#!/bin/sh
# Seeds the persistent release directory from the image and starts the Sofia launcher.
# Releases installed later by the Update Center live in the same volume and are kept across container restarts;
# a newer image (docker compose pull) moves current.json forward, an older image never moves it back.
set -eu
ROOT="${SOFIA_INSTALL_ROOT:-/opt/sofia}"
PKG="$(ls /opt/sofia-image/sofia-*.tar.gz | head -n 1)"
VER="$(basename "$PKG" .tar.gz | sed 's/^sofia-//')"
mkdir -p "$ROOT/releases" "$ROOT/data" "$ROOT/backups" "$ROOT/config"
if [ ! -f "$ROOT/releases/$VER/server/main.js" ]; then
  mkdir -p "$ROOT/releases/.seed-$VER"
  tar -xzf "$PKG" -C "$ROOT/releases/.seed-$VER"
  rm -rf "$ROOT/releases/$VER"
  mv "$ROOT/releases/.seed-$VER" "$ROOT/releases/$VER"
fi
CUR="$(node -e "try{process.stdout.write(require('$ROOT/current.json').version)}catch(e){}")"
NEWER="$(node -e "const a='$VER'.split('.').map(Number),b=('$CUR'||'0.0.0').split('.').map(Number);process.stdout.write(String((a[0]-b[0])||(a[1]-b[1])||(a[2]-b[2])))")"
if [ -z "$CUR" ] || [ "$NEWER" -gt 0 ]; then
  printf '{"version":"%s","previous":"%s"}\n' "$VER" "$CUR" > "$ROOT/current.json.tmp.$$"
  mv "$ROOT/current.json.tmp.$$" "$ROOT/current.json"
fi
if [ -n "${SOFIA_UPDATE_PUBLIC_KEY_FILE:-}" ] && [ -f "$SOFIA_UPDATE_PUBLIC_KEY_FILE" ]; then
  cp "$SOFIA_UPDATE_PUBLIC_KEY_FILE" "$ROOT/config/update-public-key.pem"
fi
# A stable path for administration: docker compose exec api node /opt/sofia/launcher.mjs cli <command>
cp "$ROOT/releases/$VER/launcher.mjs" "$ROOT/launcher.mjs.tmp.$$" && mv "$ROOT/launcher.mjs.tmp.$$" "$ROOT/launcher.mjs"
exec node "$ROOT/launcher.mjs" "$@"

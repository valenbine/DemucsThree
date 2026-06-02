#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$ROOT_DIR/.runtime/tools"
VAMP_DIR="$ROOT_DIR/.runtime/vamp"
SONIC_DIR="$TOOLS_DIR/sonic-annotator-1.7.0-linux64-static"
SONIC_APP="$SONIC_DIR/squashfs-root/usr/bin/sonic-annotator"
PACK_APP="$TOOLS_DIR/vamp-plugin-pack-installer-2.0"
PACK_ROOT="$TOOLS_DIR/squashfs-root"

mkdir -p "$TOOLS_DIR" "$VAMP_DIR"

if [ ! -x "$SONIC_APP" ]; then
  curl --fail --location \
    --output "$TOOLS_DIR/sonic-annotator-1.7.0-linux64-static.tar.gz" \
    https://github.com/sonic-visualiser/sonic-annotator/releases/download/sonic-annotator-1.7/sonic-annotator-1.7.0-linux64-static.tar.gz
  tar -xzf "$TOOLS_DIR/sonic-annotator-1.7.0-linux64-static.tar.gz" -C "$TOOLS_DIR"
  "$SONIC_DIR/sonic-annotator" --appimage-extract >/dev/null
fi

if [ ! -f "$VAMP_DIR/nnls-chroma.so" ]; then
  curl --fail --location \
    --output "$PACK_APP" \
    https://github.com/vamp-plugins/vamp-plugin-pack/releases/download/v2.0/vamp-plugin-pack-installer-2.0
  chmod +x "$PACK_APP"

  if [ ! -d "$PACK_ROOT" ]; then
    (cd "$TOOLS_DIR" && "$PACK_APP" --appimage-extract >/dev/null)
  fi

  python3 - "$PACK_ROOT/usr/bin/vamp-plugin-pack-installer" "$VAMP_DIR/nnls-chroma.so" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
data = source.read_bytes()
offsets = []
start = 0

while True:
    offset = data.find(b"\x7fELF", start)
    if offset < 0:
        break
    offsets.append(offset)
    start = offset + 1

for index, offset in enumerate(offsets[1:], 1):
    end = offsets[index + 1] if index + 1 < len(offsets) else len(data)
    candidate = data[offset:end]
    if b"Chordino" in candidate and b"nnls-chroma/chromamethods.cpp" in candidate:
        target.write_bytes(candidate)
        break
else:
    raise SystemExit("Could not locate nnls-chroma plugin in Vamp Plugin Pack")
PY
fi

SONIC_LIB_DIR="$SONIC_DIR/squashfs-root/usr/lib"
LD_LIBRARY_PATH="$SONIC_LIB_DIR:${LD_LIBRARY_PATH:-}" VAMP_PATH="$VAMP_DIR" "$SONIC_APP" -l | grep -q "vamp:nnls-chroma:chordino:simplechord"

printf 'Chordino / NNLS-Chroma is ready.\n'
printf 'SONIC_ANNOTATOR=%s\n' "$SONIC_APP"
printf 'VAMP_PATH=%s\n' "$VAMP_DIR"

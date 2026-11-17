#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_EXE="${TUFFT_PYTHON_EXECUTABLE:-python3}"
SIDECAR_DIR="$PROJECT_ROOT/src-tauri/binaries"
ENTRY_POINT="$PROJECT_ROOT/python/sidecar/sidecar_entry.py"
WORK_PATH="$PROJECT_ROOT/build/pyinstaller"

mkdir -p "$SIDECAR_DIR"

FFMPEG_EXE="$("$PYTHON_EXE" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
if [[ ! -f "$FFMPEG_EXE" ]]; then
  echo "imageio-ffmpeg did not return an existing executable: $FFMPEG_EXE" >&2
  exit 1
fi

"$PYTHON_EXE" -m PyInstaller \
  --noconfirm \
  --clean \
  --onedir \
  --contents-directory _internal \
  --name tufft-sidecar \
  --exclude-module cv2 \
  --exclude-module PySide6 \
  --exclude-module PyQt6 \
  --exclude-module IPython \
  --exclude-module notebook \
  --exclude-module matplotlib \
  --exclude-module pandas \
  --exclude-module openpyxl \
  --exclude-module xarray \
  --exclude-module h5py \
  --exclude-module tkinter \
  --add-binary "$FFMPEG_EXE:." \
  --distpath "$SIDECAR_DIR" \
  --workpath "$WORK_PATH" \
  --specpath "$WORK_PATH" \
  "$ENTRY_POINT"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) TARGET_SUFFIX="aarch64-apple-darwin" ;;
  x86_64) TARGET_SUFFIX="x86_64-apple-darwin" ;;
  *) TARGET_SUFFIX="$ARCH-apple-darwin" ;;
esac

test -d "$SIDECAR_DIR/tufft-sidecar/_internal"
# Tauri's macOS config relocates these contents to Contents/Frameworks for the bootloader.
cp "$SIDECAR_DIR/tufft-sidecar/tufft-sidecar" "$SIDECAR_DIR/tufft-sidecar-$TARGET_SUFFIX"

echo "Built sidecar:"
echo "  $SIDECAR_DIR/tufft-sidecar/tufft-sidecar"
echo "  $SIDECAR_DIR/tufft-sidecar-$TARGET_SUFFIX"

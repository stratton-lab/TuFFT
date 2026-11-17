from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import threading
from typing import Any, BinaryIO

import imageio_ffmpeg


FFMPEG_TIMEOUT_SECONDS = 20
MAX_FIRST_FRAME_BYTES = 64 * 1024 * 1024
MAX_LOOP_BYTES = 32 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
LOOP_FRAME_COUNT = 90
PLAYBACK_FPS = 30


def _run_ffmpeg(arguments: list[str], output_limit: int) -> bytes:
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error",
        "-nostdin", "-max_alloc", "268435456", "-threads", "1",
        "-filter_threads", "1", *arguments,
    ]
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    stdout = bytearray()
    stderr = bytearray()
    overflow = threading.Event()

    def read_bounded(stream: BinaryIO, destination: bytearray, limit: int) -> None:
        with stream:
            while chunk := stream.read(65536):
                if len(destination) + len(chunk) > limit:
                    overflow.set()
                    process.kill()
                    return
                destination.extend(chunk)

    assert process.stdout is not None and process.stderr is not None
    readers = [
        threading.Thread(target=read_bounded, args=(process.stdout, stdout, output_limit), daemon=True),
        threading.Thread(target=read_bounded, args=(process.stderr, stderr, MAX_STDERR_BYTES), daemon=True),
    ]
    for reader in readers:
        reader.start()
    try:
        process.wait(timeout=FFMPEG_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.wait()
        raise ValueError(f"FFmpeg preview timed out after {FFMPEG_TIMEOUT_SECONDS} seconds") from exc
    finally:
        for reader in readers:
            reader.join()
    if overflow.is_set():
        raise ValueError("FFmpeg preview exceeded its output size limit")
    if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"FFmpeg preview failed: {message or f'exit code {process.returncode}'}")
    if not stdout:
        raise ValueError("No frames could be decoded from the video")
    return bytes(stdout)


def _video_path(video_path: Path) -> Path:
    path = Path(video_path).resolve()
    if not path.is_file():
        raise ValueError(f"Video file does not exist: {path}")
    return path


def first_frame_preview(video_path: Path, max_display_size: int = 900) -> dict[str, Any]:
    # Keep the original frame and coordinate system; only the UI scales its display.
    if max_display_size <= 0:
        raise ValueError("max_display_size must be greater than zero")
    path = _video_path(video_path)
    png = _run_ffmpeg([
        "-noautorotate", "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
        "-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgb24", "-threads", "1",
        "-f", "image2pipe", "pipe:1",
    ], MAX_FIRST_FRAME_BYTES)
    if len(png) < 33 or png[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
        raise ValueError("FFmpeg did not return a valid PNG first frame")
    width, height = struct.unpack(">II", png[16:24])
    if not width or not height:
        raise ValueError("FFmpeg returned an empty first frame")
    data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    return {
        "video_path": str(path),
        "width": width,
        "height": height,
        "display_width": width,
        "display_height": height,
        "image_data_url": data_url,
        "loop_data_url": "",
        "source_fps_metadata": 0,
        "decoder": "imageio-ffmpeg",
    }


def video_loop_preview(video_path: Path) -> dict[str, Any]:
    path = _video_path(video_path)
    # Rebase by frame index before rate conversion, including for 2000 FPS captures.
    filters = (
        f"trim=end_frame={LOOP_FRAME_COUNT},settb=AVTB,setpts=N/({PLAYBACK_FPS}*TB),"
        f"fps={PLAYBACK_FPS},"
        "scale=w='min(900,iw)':h='min(900,ih)':force_original_aspect_ratio=decrease,setsar=1"
    )
    webp = _run_ffmpeg([
        "-noautorotate", "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
        "-vf", filters, "-frames:v", str(LOOP_FRAME_COUNT), "-r", str(PLAYBACK_FPS),
        "-c:v", "libwebp_anim", "-lossless", "0", "-quality", "75",
        "-compression_level", "2", "-threads", "1", "-loop", "0",
        "-f", "webp", "pipe:1",
    ], MAX_LOOP_BYTES)
    if len(webp) < 12 or webp[:4] != b"RIFF" or webp[8:12] != b"WEBP":
        raise ValueError("FFmpeg did not return a valid WebP loop")
    return {
        "video_path": str(path),
        "loop_data_url": "data:image/webp;base64," + base64.b64encode(webp).decode("ascii"),
        "playback_fps": PLAYBACK_FPS,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate bounded FFmpeg media previews.")
    parser.add_argument("command", choices=("first-frame", "video-loop"))
    parser.add_argument("--video", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        payload = first_frame_preview(args.video) if args.command == "first-frame" else video_loop_preview(args.video)
        sys.stdout.write(json.dumps(payload, ensure_ascii=True, allow_nan=False) + "\n")
        return 0
    except Exception as exc:
        sys.stderr.write(f"Preview failed: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

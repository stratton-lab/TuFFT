from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

import cv2


def main() -> int:
    parser = argparse.ArgumentParser(description="Decode a bounded number of frames without retaining them.")
    parser.add_argument("video", type=Path)
    parser.add_argument("--frames", type=int, default=100)
    parser.add_argument(
        "--backend",
        choices=("opencv", "imageio"),
        default="opencv",
        help="Decoder to probe. Use imageio when OpenCV exits at the native-code level.",
    )
    parser.add_argument(
        "--allow-more-than-100",
        action="store_true",
        help="Explicitly allow a probe longer than the project's safe default.",
    )
    args = parser.parse_args()

    if args.frames <= 0:
        parser.error("--frames must be positive")
    if args.frames > 100 and not args.allow_more_than_100:
        parser.error("Refusing to decode more than 100 frames without --allow-more-than-100")
    if not args.video.is_file():
        parser.error(f"Video does not exist: {args.video}")

    started = time.perf_counter()
    if args.backend == "opencv":
        decoded, shape, reported_frame_count = _probe_opencv(args.video, args.frames)
    else:
        decoded, shape, reported_frame_count = _probe_imageio(args.video, args.frames)

    result = {
        "video": str(args.video.resolve()),
        "backend": args.backend,
        "requested_frames": args.frames,
        "decoded_frames": decoded,
        "last_frame_shape": shape,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "stream_frame_count_reported": reported_frame_count,
    }
    print(json.dumps(result, ensure_ascii=True))
    return 0 if decoded == args.frames else 1


def _probe_opencv(video: Path, frame_limit: int) -> tuple[int, list[int] | None, int | None]:
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError(f"OpenCV could not open video: {video}")

    reported_frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    decoded = 0
    shape = None
    try:
        while decoded < frame_limit:
            ok, frame = capture.read()
            if not ok:
                break
            decoded += 1
            shape = list(frame.shape)
            del frame
    finally:
        capture.release()
    return decoded, shape, reported_frame_count


def _probe_imageio(video: Path, frame_limit: int) -> tuple[int, list[int] | None, int | None]:
    import imageio.v2 as imageio

    reader = imageio.get_reader(str(video))
    decoded = 0
    shape = None
    reported_frame_count = None
    try:
        metadata = reader.get_meta_data()
        raw_count = metadata.get("nframes")
        if isinstance(raw_count, (int, float)) and raw_count != float("inf"):
            reported_frame_count = int(raw_count)
        for frame in reader:
            decoded += 1
            shape = list(frame.shape)
            del frame
            if decoded >= frame_limit:
                break
    finally:
        reader.close()
    return decoded, shape, reported_frame_count


if __name__ == "__main__":
    raise SystemExit(main())

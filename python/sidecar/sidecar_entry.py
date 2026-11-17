from __future__ import annotations

import multiprocessing
from pathlib import Path
import os
import sys


SIDECAR_DIRECTORY = Path(__file__).resolve().parent
if str(SIDECAR_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIRECTORY))


def main(argv: list[str] | None = None) -> int:
    _configure_frozen_runtime()
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in {"first-frame", "video-loop"}:
        from media_preview import main as media_main

        return media_main(args)
    if args and args[0] == "fft":
        from preview import main as preview_main

        return preview_main(args)

    from cilia_sidecar.cli import main as cli_main

    return cli_main(args)


def _configure_frozen_runtime() -> None:
    bundle_dir = Path(getattr(sys, "_MEIPASS", SIDECAR_DIRECTORY))
    for ffmpeg in sorted(bundle_dir.glob("ffmpeg*")):
        if ffmpeg.is_file() and (os.name != "nt" or ffmpeg.suffix.lower() == ".exe"):
            os.environ.setdefault("IMAGEIO_FFMPEG_EXE", str(ffmpeg))
            break


if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(main())

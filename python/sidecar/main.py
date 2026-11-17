from __future__ import annotations

from pathlib import Path
import sys


SIDECAR_DIRECTORY = Path(__file__).resolve().parent
if str(SIDECAR_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIRECTORY))

from cilia_sidecar.cli import main


if __name__ == "__main__":
    raise SystemExit(main())

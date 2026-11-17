from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import unittest


SIDECAR_DIRECTORY = Path(__file__).resolve().parents[2] / "python" / "sidecar"
sys.path.insert(0, str(SIDECAR_DIRECTORY))

from cilia_sidecar.events import EventEmitter


class EventEmitterTests(unittest.TestCase):
    def test_emits_strict_newline_delimited_json(self) -> None:
        stream = io.StringIO()
        emitter = EventEmitter(stream, "job-1")

        emitter.emit("progress", fraction=float("nan"), path=Path("preview.png"))
        payload = json.loads(stream.getvalue())

        self.assertEqual(payload["event"], "progress")
        self.assertEqual(payload["job_id"], "job-1")
        self.assertIsNone(payload["fraction"])
        self.assertEqual(payload["path"], "preview.png")
        self.assertTrue(stream.getvalue().endswith("\n"))


if __name__ == "__main__":
    unittest.main()

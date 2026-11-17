from __future__ import annotations

import base64
from contextlib import redirect_stderr, redirect_stdout
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image


SIDECAR_DIRECTORY = Path(__file__).resolve().parents[2] / "python" / "sidecar"
sys.path.insert(0, str(SIDECAR_DIRECTORY))

import media_preview
import sidecar_entry


def webp_chunks(data: bytes):
    offset = 12
    while offset + 8 <= len(data):
        tag, size = struct.unpack_from("<4sI", data, offset)
        yield tag, data[offset + 8:offset + 8 + size]
        offset += 8 + size + (size % 2)


class MediaPreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.high_fps = cls.make_video("high fps.avi", fps=2000, frames=110)
        cls.low_fps = cls.make_video("low fps.avi", fps=2, frames=7)
        cls.large = cls.make_video("large.avi", fps=30, frames=3, width=1200, height=600)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    @classmethod
    def make_video(cls, name: str, *, fps: int, frames: int, width: int = 64, height: int = 32) -> Path:
        path = cls.root / name
        command = [
            media_preview.imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error",
            "-nostdin", "-f", "lavfi", "-i",
            f"nullsrc=s={width}x{height}:r={fps},geq=lum='16+mod(37*N,220)':cb=128:cr=128",
            "-frames:v", str(frames), "-c:v", "ffv1", "-y", str(path),
        ]
        subprocess.run(command, check=True, stdin=subprocess.DEVNULL, capture_output=True, timeout=20,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        return path

    def test_first_frame_is_original_png_with_source_dimensions(self) -> None:
        result = media_preview.first_frame_preview(self.large, max_display_size=100)
        self.assertEqual(result["video_path"], str(self.large.resolve()))
        self.assertEqual((result["width"], result["height"]), (1200, 600))
        self.assertEqual((result["display_width"], result["display_height"]), (1200, 600))
        self.assertEqual(result["decoder"], "imageio-ffmpeg")
        self.assertEqual(result["loop_data_url"], "")
        self.assertEqual(result["source_fps_metadata"], 0)
        self.assertTrue(result["image_data_url"].startswith("data:image/png;base64,"))
        with Image.open(BytesIO(base64.b64decode(result["image_data_url"].split(",", 1)[1]))) as image:
            self.assertEqual(image.size, (1200, 600))
            self.assertLess(image.convert("RGB").getpixel((0, 0))[0], 5)

    def assert_loop(self, video: Path, expected_frames: int, expected_size: tuple[int, int]) -> None:
        result = media_preview.video_loop_preview(video)
        self.assertEqual(set(result), {"video_path", "loop_data_url", "playback_fps"})
        self.assertEqual(result["playback_fps"], 30)
        self.assertEqual(result["video_path"], str(video.resolve()))
        self.assertTrue(result["loop_data_url"].startswith("data:image/webp;base64,"))
        webp = base64.b64decode(result["loop_data_url"].split(",", 1)[1])
        chunks = list(webp_chunks(webp))
        animation = next(data for tag, data in chunks if tag == b"ANIM")
        self.assertEqual(struct.unpack_from("<H", animation, 4)[0], 0)
        durations = [int.from_bytes(data[12:15], "little") for tag, data in chunks if tag == b"ANMF"]
        self.assertEqual(len(durations), expected_frames)
        self.assertTrue(all(32 <= duration <= 34 for duration in durations), durations)
        self.assertAlmostEqual(sum(durations), expected_frames * 1000 / 30, delta=2)
        with Image.open(BytesIO(webp)) as image:
            self.assertEqual(image.size, expected_size)
            self.assertEqual(image.n_frames, expected_frames)
            values = []
            for index in range(image.n_frames):
                image.seek(index)
                values.append(image.convert("RGB").getpixel((0, 0))[0])
            # Widely separated intensities avoid lossy WebP coalescing near-identical frames.
            for index, value in enumerate(values):
                self.assertAlmostEqual(value, ((37 * index) % 220) * 255 / 219, delta=5,
                                       msg=f"source frame {index}")

    def test_high_fps_uses_first_90_consecutive_frames_at_30fps(self) -> None:
        self.assert_loop(self.high_fps, 90, (64, 32))

    def test_short_low_fps_video_keeps_all_frames_at_30fps(self) -> None:
        self.assert_loop(self.low_fps, 7, (64, 32))

    def test_loop_scales_down_preserving_aspect_ratio(self) -> None:
        self.assert_loop(self.large, 3, (900, 450))

    def test_output_limits_are_enforced(self) -> None:
        with patch.object(media_preview, "MAX_FIRST_FRAME_BYTES", 10):
            with self.assertRaisesRegex(ValueError, "output size limit"):
                media_preview.first_frame_preview(self.high_fps)
        with patch.object(media_preview, "MAX_LOOP_BYTES", 10):
            with self.assertRaisesRegex(ValueError, "output size limit"):
                media_preview.video_loop_preview(self.high_fps)

    def test_timeout_kills_and_reaps_ffmpeg(self) -> None:
        with patch.object(media_preview, "FFMPEG_TIMEOUT_SECONDS", 0):
            with self.assertRaisesRegex(ValueError, "timed out"):
                media_preview.first_frame_preview(self.high_fps)

    def test_invalid_video_errors_without_stdout(self) -> None:
        for path in (self.root / "missing.avi", Path(__file__)):
            with self.subTest(path=path):
                stdout, stderr = StringIO(), StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    status = media_preview.main(["first-frame", "--video", str(path)])
                self.assertEqual(status, 1)
                self.assertEqual(stdout.getvalue(), "")
                self.assertIn("Preview failed:", stderr.getvalue())

    def test_first_frame_rejects_invalid_png(self) -> None:
        with patch.object(media_preview, "_run_ffmpeg", return_value=b"not png"):
            with self.assertRaisesRegex(ValueError, "valid PNG"):
                media_preview.first_frame_preview(self.high_fps)

    def test_sidecar_dispatches_media_before_scientific_imports(self) -> None:
        for command in ("first-frame", "video-loop"):
            stdout = StringIO()
            with patch.dict(sys.modules, {"preview": None, "cilia_sidecar.cli": None}), redirect_stdout(stdout):
                status = sidecar_entry.main([command, "--video", str(self.high_fps)])
            self.assertEqual(status, 0)
            self.assertIn("video_path", json.loads(stdout.getvalue()))

    def test_cli_entry_points_do_not_import_scientific_stack(self) -> None:
        guard = (
            "import pathlib,runpy,sys; "
            "sys.modules.update(dict.fromkeys(['numpy','scipy','skimage','imageio','PIL'])); "
            "script=sys.argv.pop(1); "
            "sys.path.insert(0,str(pathlib.Path(script).parent)); "
            "runpy.run_path(script,run_name='__main__')"
        )
        for script in ("media_preview.py", "sidecar_entry.py", "preview.py"):
            for command in ("first-frame", "video-loop"):
                with self.subTest(script=script, command=command):
                    result = subprocess.run(
                        [sys.executable, "-c", guard, str(SIDECAR_DIRECTORY / script), command,
                         "--video", str(self.high_fps)],
                        capture_output=True, timeout=25, check=False,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                    self.assertEqual(json.loads(result.stdout)["video_path"], str(self.high_fps.resolve()))

    def test_frozen_runtime_uses_ffmpeg_from_internal_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / "_internal"
            bundle.mkdir()
            ffmpeg = bundle / ("ffmpeg-test.exe" if os.name == "nt" else "ffmpeg-test")
            ffmpeg.touch()
            with patch.object(sys, "_MEIPASS", str(bundle), create=True), patch.dict(os.environ):
                os.environ.pop("IMAGEIO_FFMPEG_EXE", None)
                sidecar_entry._configure_frozen_runtime()
                self.assertEqual(os.environ["IMAGEIO_FFMPEG_EXE"], str(ffmpeg))


if __name__ == "__main__":
    unittest.main()

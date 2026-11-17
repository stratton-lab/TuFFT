from __future__ import annotations

import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import imageio.v2 as imageio
import numpy as np


SIDECAR_DIRECTORY = Path(__file__).resolve().parents[2] / "python" / "sidecar"


@unittest.skipUnless((os.cpu_count() or 1) >= 4, "Four logical CPUs are required for the CLI parallel integration test.")
class CliWorkerTests(unittest.TestCase):
    def test_four_worker_batches_match_sequential_results_in_both_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            y, x = np.mgrid[:64, :64]
            signal = (x - 32) ** 2 + (y - 32) ** 2 < 9 ** 2
            videos = []
            for index, frequency in enumerate((12, 16, 20, 24)):
                video = root / f"sample-{index}.avi"
                frames = []
                for frame_index in range(32):
                    frame = np.full((64, 64), 25, dtype=np.float32)
                    frame[signal] = 120 + 70 * np.sin(2 * np.pi * frequency * frame_index / 128)
                    frames.append(frame.astype(np.uint8))
                imageio.mimsave(video, frames, format="FFMPEG", fps=128, codec="ffv1")
                videos.append(str(video))

            for mode in ("in_vitro", "ex_vivo"):
                with self.subTest(mode=mode):
                    results = [self.run_batch(root, videos, mode, workers) for workers in (1, 4)]
                    self.assertEqual(results[0], results[1])
                    if mode == "in_vitro":
                        self.assertTrue(all(int(row["tuft_count"]) > 0 for row in results[0]))
                    else:
                        self.assertTrue(all(int(row["foreground_area_px"]) > 0 for row in results[0]))

    def run_batch(self, root: Path, videos: list[str], mode: str, workers: int) -> list[dict[str, str]]:
        params = {
            "FPS": 128,
            "N_FRAMES": 32,
            "ROI_MODE": "full",
            "REMOVE_DOUBLING": False,
            "PLOT_GAUSSIAN_EVIDENCE": False,
        }
        if mode == "in_vitro":
            params.update({
                "MIN_TUFT_AREA": 20,
                "FLAT_POST_PRUNE_MIN_AREA": 20,
                "PLOT_RAW_FFT": False,
                "PLOT_RAW_PHASE": False,
                "PLOT_TUFT_LABELS": False,
                "PLOT_TUFT_PIXEL_CBF": False,
                "PLOT_TUFT_DOMINANT_CBF": False,
                "PLOT_TUFT_DOMINANT_CBF_WITH_AXIS": False,
                "PLOT_TUFT_PHASE_AXIS": False,
                "PLOT_TUFT_AXIS_COHERENCE": False,
            })
        else:
            params.update({
                "EX_VIVO_DESPECKLE_MIN_AREA": 20,
                "PLOT_EX_VIVO_ORIGINAL": False,
                "PLOT_EX_VIVO_CBF": False,
                "PLOT_EX_VIVO_PHASE": False,
            })
        job_id = f"{mode}-{workers}-workers"
        config = {
            "schema_version": 1,
            "job_id": job_id,
            "analysis_type": mode,
            "input_videos": videos,
            "output_root": str(root / "output"),
            "pipeline_params": params,
            "continue_after_error": True,
            "max_workers": workers,
        }
        config_path = root / f"{job_id}.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        env = os.environ.copy()
        env["PYTHONPATH"] = str(SIDECAR_DIRECTORY) + os.pathsep + env.get("PYTHONPATH", "")
        completed = subprocess.run(
            [sys.executable, "-m", "cilia_sidecar.cli", "--config", str(config_path)],
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-4000:])
        job_directory = root / "output" / job_id
        manifest = json.loads((job_directory / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["status"], "completed", manifest["errors"])
        self.assertEqual(manifest["max_workers"], workers)
        self.assertEqual(len(manifest["videos"]), 4)
        events = [json.loads(line) for line in completed.stdout.splitlines()]
        parallel_events = [event for event in events if event.get("stage") == "parallel_batch"]
        self.assertEqual([event["worker_count"] for event in parallel_events], [4] if workers == 4 else [])
        self.assertFalse(list(job_directory.rglob(".tufft_frames_*.bin")))
        with (job_directory / "batch_summary.csv").open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        # Undefined scientific values can be represented as NaN or empty CSV cells.
        rows = [{key: "" if value.lower() == "nan" else value for key, value in row.items()} for row in rows]
        return sorted(rows, key=lambda row: row["video_file"])


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path
import sys

import imageio.v2 as imageio
import numpy as np

SIDECAR_DIRECTORY = Path(__file__).resolve().parents[2] / "python" / "sidecar"
sys.path.insert(0, str(SIDECAR_DIRECTORY))

from cilia_sidecar.ex_vivo_pipeline import (
    EX_VIVO_SUMMARY_COLUMNS,
    build_ex_vivo_params,
    process_one_ex_vivo_video,
)
from cilia_sidecar.final_pipeline import build_pipeline_params, process_one_video, tuft_label_rgb


class ExVivoPipelineTests(unittest.TestCase):
    def test_full_frame_ex_vivo_pipeline_writes_summary_and_plots(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "synthetic.avi"
            frames = []
            y, x = np.mgrid[:32, :32]
            roi_signal = ((x - 16) ** 2 + (y - 16) ** 2) < 9 ** 2
            for index in range(24):
                frame = np.full((32, 32), 25, dtype=np.float32)
                frame[roi_signal] = 120 + 70 * np.sin(2 * np.pi * index / 6)
                frames.append(np.clip(frame, 0, 255).astype(np.uint8))
            imageio.mimsave(video, frames, fps=120)

            params = build_ex_vivo_params({
                "FPS": 120,
                "N_FRAMES": "all",
                "ROI_MODE": "full",
                "BAND_LO": 10,
                "BAND_HI": 30,
                "SNR_THRESH_DB": 0,
                "EX_VIVO_DESPECKLE_MIN_AREA": 5,
                "OUTPUT_DPI": 120,
            })
            selected_columns = ["video_file", "tag", "status", "error", "roi_area_px"]
            summary, tuft_rows = process_one_ex_vivo_video(
                video,
                root / "out",
                params,
                summary_output_columns=selected_columns,
            )

            self.assertEqual(tuft_rows, [])
            self.assertEqual(summary["status"], "OK")
            self.assertEqual(summary["frames_processed"], 24)
            self.assertGreater(summary["roi_area_px"], 0)
            self.assertGreater(summary["foreground_area_px"], 0)
            self.assertIn("joint_dominant_cbf_hz", EX_VIVO_SUMMARY_COLUMNS)
            video_dir = root / "out" / "synthetic"
            summary_path = video_dir / "synthetic__ex_vivo_summary.csv"
            self.assertTrue(summary_path.is_file())
            with summary_path.open(newline="", encoding="utf-8") as source:
                self.assertEqual(next(csv.reader(source)), selected_columns)
            self.assertTrue((video_dir / "01_original_roi_frame.png").is_file())
            self.assertTrue((video_dir / "02_ex_vivo_cbf_hz.png").is_file())
            self.assertTrue((video_dir / "03_ex_vivo_phase.png").is_file())
            self.assertEqual(list(video_dir.glob(".tufft_frames_*.bin")), [])

    def test_in_vitro_pipeline_accepts_all_frames_and_cleans_temporary_storage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "synthetic.avi"
            y, x = np.mgrid[:32, :32]
            signal = ((x - 16) ** 2 + (y - 16) ** 2) < 7 ** 2
            frames = []
            for index in range(20):
                frame = np.full((32, 32), 25, dtype=np.float32)
                frame[signal] = 120 + 70 * np.sin(2 * np.pi * index / 5)
                frames.append(np.clip(frame, 0, 255).astype(np.uint8))
            imageio.mimsave(video, frames, fps=100)

            params = build_pipeline_params({
                "FPS": 100,
                "N_FRAMES": "all",
                "ROI_MODE": "full",
                "BAND_LO": 5,
                "BAND_HI": 30,
                "SNR_THRESH_DB": 0,
                "MIN_TUFT_AREA": 5,
                "FLAT_POST_PRUNE_MIN_AREA": 5,
                "COMPUTE_TUFT_STATS": False,
                "COMPUTE_METACHRONAL_AXIS": False,
                "SAVE_BATCH_SUMMARY": False,
                "SAVE_TUFT_TABLE": False,
                "PLOT_RAW_FFT": False,
                "PLOT_RAW_PHASE": False,
                "PLOT_GAUSSIAN_EVIDENCE": False,
                "PLOT_TUFT_LABELS": False,
                "PLOT_TUFT_PIXEL_CBF": False,
                "PLOT_TUFT_DOMINANT_CBF": False,
                "PLOT_TUFT_DOMINANT_CBF_WITH_AXIS": False,
                "PLOT_TUFT_PHASE_AXIS": False,
                "PLOT_TUFT_AXIS_COHERENCE": False,
            })
            summary, rows = process_one_video(video, root / "out", params)

            self.assertEqual(summary["status"], "OK")
            self.assertEqual(summary["frames_processed"], 20)
            self.assertEqual(rows, [])
            self.assertEqual(list((root / "out" / "synthetic").glob(".tufft_frames_*.bin")), [])

    def test_tuft_label_plot_renderer_colours_tufts_and_draws_numbers(self) -> None:
        labels = np.zeros((48, 48), dtype=np.int32)
        labels[8:22, 7:21] = 1
        labels[25:42, 28:44] = 2
        rows = [
            {"tuft_id": 1, "centroid_x": 14.0, "centroid_y": 14.5},
            {"tuft_id": 2, "centroid_x": 36.0, "centroid_y": 33.0},
        ]

        image = tuft_label_rgb(labels, rows)

        self.assertEqual(image.shape, (48, 48, 3))
        self.assertTrue(np.array_equal(image[0, 0], np.array([255, 255, 255], dtype=np.uint8)))
        self.assertGreater(np.unique(image[labels > 0].reshape(-1, 3), axis=0).shape[0], 2)
        self.assertTrue(np.any(np.all(image == np.array([0, 0, 0], dtype=np.uint8), axis=2)))


if __name__ == "__main__":
    unittest.main()

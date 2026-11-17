from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest


SIDECAR_DIRECTORY = Path(__file__).resolve().parents[2] / "python" / "sidecar"
sys.path.insert(0, str(SIDECAR_DIRECTORY))

from cilia_sidecar.config import JobConfig, JobConfigError
from cilia_sidecar.final_pipeline import build_pipeline_params
from cilia_sidecar.ex_vivo_pipeline import build_ex_vivo_params


class JobConfigTests(unittest.TestCase):
    def test_raw_plot_range_defaults_to_band_in_both_modes_and_preserves_overrides(self) -> None:
        for builder in (build_pipeline_params, build_ex_vivo_params):
            with self.subTest(builder=builder.__name__):
                params = builder({"BAND_LO": 10.0, "BAND_HI": 45.0})
                self.assertEqual((params.RAW_FREQUENCY_MIN_HZ, params.RAW_FREQUENCY_MAX_HZ), (10.0, 45.0))
                params = builder({"BAND_LO": 10.0, "BAND_HI": 45.0, "RAW_FREQUENCY_MIN_HZ": 0.0, "RAW_FREQUENCY_MAX_HZ": 80.0})
                self.assertEqual((params.RAW_FREQUENCY_MIN_HZ, params.RAW_FREQUENCY_MAX_HZ), (0.0, 80.0))

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.video = self.root / "sample.avi"
        self.video.touch()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def payload(self) -> dict:
        return {
            "schema_version": 1,
            "job_id": "test-job",
            "analysis_type": "in_vitro",
            "input_videos": [self.video.name],
            "output_root": "output",
            "pipeline_params": {"N_FRAMES": 100},
        }

    def test_resolves_relative_paths_against_config_directory(self) -> None:
        config_path = self.root / "job.json"
        config_path.write_text(json.dumps(self.payload()), encoding="utf-8")

        config = JobConfig.from_file(config_path)

        self.assertEqual(config.input_videos, (self.video.resolve(),))
        self.assertEqual(config.output_root, (self.root / "output").resolve())
        self.assertEqual(config.pipeline_params["FPS"], 500.0)
        self.assertEqual(config.pipeline_params["N_FRAMES"], 100)

    def test_accepts_all_frames_selection(self) -> None:
        payload = self.payload()
        payload["pipeline_params"]["N_FRAMES"] = "all"

        config = JobConfig.from_dict(payload, base_directory=self.root)

        self.assertEqual(config.pipeline_params["N_FRAMES"], "all")

    def test_ex_vivo_uses_mode_specific_defaults(self) -> None:
        payload = self.payload()
        payload["analysis_type"] = "ex_vivo"
        payload["pipeline_params"] = {}

        config = JobConfig.from_dict(payload, base_directory=self.root)

        self.assertEqual(config.pipeline_params["FPS"], 2000.0)
        self.assertEqual(config.pipeline_params["ROI_MODE"], "full")

    def test_accepts_configurable_fft_chunk_maximum(self) -> None:
        payload = self.payload()
        payload["pipeline_params"]["FFT_CHUNK_PIXELS"] = 16384

        config = JobConfig.from_dict(payload, base_directory=self.root)

        self.assertEqual(config.pipeline_params["FFT_CHUNK_PIXELS"], 16384)

    def test_rejects_unsafe_fft_chunk_maximum(self) -> None:
        for value in (255, 32769, 1024.5, True):
            with self.subTest(value=value):
                payload = self.payload()
                payload["pipeline_params"]["FFT_CHUNK_PIXELS"] = value
                with self.assertRaisesRegex(JobConfigError, "FFT_CHUNK_PIXELS"):
                    JobConfig.from_dict(payload, base_directory=self.root)

    def test_rejects_invalid_or_non_positive_frame_count_types(self) -> None:
        for value in (0, -1, 3.5, True):
            with self.subTest(value=value):
                payload = self.payload()
                payload["pipeline_params"]["N_FRAMES"] = value
                with self.assertRaises(JobConfigError):
                    JobConfig.from_dict(payload, base_directory=self.root)

    def test_rejects_null_frame_count_and_keeps_safe_default_when_omitted(self) -> None:
        payload = self.payload()
        payload["pipeline_params"] = {"N_FRAMES": None}
        with self.assertRaises(JobConfigError):
            JobConfig.from_dict(payload, base_directory=self.root)

        payload["pipeline_params"] = {}
        self.assertEqual(
            JobConfig.from_dict(payload, base_directory=self.root).pipeline_params["N_FRAMES"],
            100,
        )

    def test_rejects_frequency_bound_above_nyquist(self) -> None:
        payload = self.payload()
        payload["pipeline_params"].update({"FPS": 100, "BAND_LO": 5, "BAND_HI": 60})

        with self.assertRaisesRegex(JobConfigError, "Nyquist"):
            JobConfig.from_dict(payload, base_directory=self.root)

    def test_rejects_frame_settings_without_cilia_band_fft_bin(self) -> None:
        payload = self.payload()
        payload["pipeline_params"].update({"FPS": 500, "N_FRAMES": 6})

        with self.assertRaisesRegex(JobConfigError, "5-80 Hz"):
            JobConfig.from_dict(payload, base_directory=self.root)

    def test_rejects_interactive_roi_mode(self) -> None:
        payload = self.payload()
        payload["pipeline_params"]["ROI_MODE"] = "custom"

        with self.assertRaisesRegex(JobConfigError, "not supported by sidecar v1"):
            JobConfig.from_dict(payload, base_directory=self.root)

    def test_rejects_unknown_top_level_fields(self) -> None:
        payload = self.payload()
        payload["typo"] = True

        with self.assertRaisesRegex(JobConfigError, "Unknown configuration field"):
            JobConfig.from_dict(payload, base_directory=self.root)

    def test_accepts_positive_worker_count(self) -> None:
        payload = self.payload()
        payload["max_workers"] = 2

        config = JobConfig.from_dict(payload, base_directory=self.root)

        self.assertEqual(config.max_workers, 2)

    def test_rejects_invalid_worker_count(self) -> None:
        for value in (0, -1, 1.5, True, "2"):
            with self.subTest(value=value):
                payload = self.payload()
                payload["max_workers"] = value
                with self.assertRaises(JobConfigError):
                    JobConfig.from_dict(payload, base_directory=self.root)


if __name__ == "__main__":
    unittest.main()

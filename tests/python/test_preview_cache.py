from __future__ import annotations

from dataclasses import asdict, replace
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import imageio.v2 as imageio
import numpy as np

SIDECAR_DIRECTORY = Path(__file__).resolve().parents[2] / "python" / "sidecar"
sys.path.insert(0, str(SIDECAR_DIRECTORY))

import preview
from cilia_sidecar import final_pipeline as final
from cilia_sidecar import ex_vivo_pipeline as ex_vivo
from cilia_sidecar import preview_cache
from cilia_sidecar.preview_cache import close_preview, load_preview


class PreviewCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.video = self.root / "sample.avi"
        y, x = np.mgrid[:64, :64]
        signal = (x - 32) ** 2 + (y - 32) ** 2 < 10**2
        frames = []
        for index in range(48):
            frame = np.full((64, 64), 25, dtype=np.float32)
            frame[signal] = (120 + 70 * np.sin(2 * np.pi * 16 * index / 128 + x[signal] * 0.2))
            frames.append(frame.astype(np.uint8))
        imageio.mimsave(self.video, frames, format="FFMPEG", fps=128, codec="ffv1")
        self.environment = patch.dict(os.environ, {"TUFFT_PREVIEW_CACHE_DIR": str(self.root / "cache")})
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def params(self, mode: str):
        shared = {"FPS": 128, "N_FRAMES": 32, "ROI_MODE": "full", "REMOVE_DOUBLING": False}
        if mode == "ex_vivo":
            return ex_vivo.build_ex_vivo_params({**shared, "EX_VIVO_DESPECKLE_MIN_AREA": 20})
        return final.build_pipeline_params({**shared, "MIN_TUFT_AREA": 20, "FLAT_POST_PRUNE_MIN_AREA": 20})

    def prepare(self, params, mode: str, *, full: bool = True):
        options = {key: value for key, value in asdict(params).items() if hasattr(final.FinalPipelineParams(), key)}
        options.pop("ROI_POLYGONS", None)
        if mode == "ex_vivo":
            options["EX_VIVO_DESPECKLE_MIN_AREA"] = params.EX_VIVO_DESPECKLE_MIN_AREA
        options.update(PREVIEW_ANALYSIS_MODE=mode, PREVIEW_TUFTS=full and mode == "in_vitro", PREVIEW_PHASE=full and mode == "in_vitro", PREVIEW_FILTER=full and mode == "ex_vivo")
        polygons = (params.ROI_POLYGONS or {}).get(str(self.video), []) if mode == "ex_vivo" else params.ROI_POLYGONS
        return preview.fft_preview(
            self.video, fps=float(params.FPS), frame_count=params.N_FRAMES, roi_mode=params.ROI_MODE,
            radius=getattr(params, "RADIUS", None), square_width=getattr(params, "SQUARE_WIDTH", None),
            use_hann=params.USE_HANN, band_low=params.BAND_LO, band_high=params.BAND_HI,
            snr_threshold_db=params.SNR_THRESH_DB, remove_doubling=params.REMOVE_DOUBLING,
            half_power_ratio_threshold=params.HALF_POWER_RATIO_THRESH, use_spatial_consensus=params.USE_SPATIAL_CONSENSUS,
            neighbor_radius=2, spatial_tolerance_fraction=params.SPATIAL_TOL_FRAC,
            use_autocorrelation_fallback=params.USE_AUTOCORR_FALLBACK, pipeline_params=options, roi_polygons=polygons,
        )

    def assert_same_outputs(self, first: Path, second: Path) -> None:
        files = sorted(path.relative_to(first) for path in first.rglob("*") if path.is_file())
        self.assertEqual(files, sorted(path.relative_to(second) for path in second.rglob("*") if path.is_file()))
        for relative in files:
            self.assertEqual((first / relative).read_bytes(), (second / relative).read_bytes(), str(relative))

    def test_complete_in_vitro_preview_exports_without_repeating_analysis(self) -> None:
        params = self.params("in_vitro")
        self.prepare(params, "in_vitro")
        with patch.object(final, "open_gray_frames_disk_backed", side_effect=AssertionError("Video decoded again")), \
                patch.object(final, "compute_fft_features", side_effect=AssertionError("FFT repeated")), \
                patch.object(final, "build_foreground_stages", side_effect=AssertionError("Filtering repeated")), \
                patch.object(final, "build_tuft_labels", side_effect=AssertionError("Segmentation repeated")), \
                patch.object(final, "compute_tuft_metrics", side_effect=AssertionError("Metrics repeated")):
            summary, rows = final.process_one_video(self.video, self.root / "cached", params)
        self.assertGreater(summary["tuft_count"], 0)
        self.assertTrue(rows)
        with patch.dict(os.environ, {"TUFFT_PREVIEW_CACHE_DIR": ""}):
            final.process_one_video(self.video, self.root / "fresh", params)
        self.assert_same_outputs(self.root / "cached", self.root / "fresh")

    def test_complete_custom_ex_vivo_preview_exports_without_repeating_analysis(self) -> None:
        polygons = [[{"x": 15, "y": 15}, {"x": 50, "y": 15}, {"x": 50, "y": 50}, {"x": 15, "y": 50}]]
        params = replace(self.params("ex_vivo"), ROI_MODE="custom", ROI_POLYGONS={str(self.video): polygons})
        self.prepare(params, "ex_vivo")
        with patch.object(ex_vivo, "open_gray_frames_disk_backed", side_effect=AssertionError("Video decoded again")), \
                patch.object(ex_vivo, "compute_ex_vivo_fft_features", side_effect=AssertionError("FFT repeated")), \
                patch.object(ex_vivo, "ex_vivo_foreground_mask", side_effect=AssertionError("Filtering repeated")), \
                patch.object(ex_vivo, "ex_vivo_summary", side_effect=AssertionError("Summary repeated")):
            summary, _ = ex_vivo.process_one_ex_vivo_video(self.video, self.root / "cached", params)
        self.assertGreater(summary["foreground_area_px"], 0)
        with patch.dict(os.environ, {"TUFFT_PREVIEW_CACHE_DIR": ""}):
            ex_vivo.process_one_ex_vivo_video(self.video, self.root / "fresh", params)
        self.assert_same_outputs(self.root / "cached", self.root / "fresh")

    def test_partial_preview_reuses_fft_and_computes_missing_steps(self) -> None:
        params = self.params("in_vitro")
        self.prepare(params, "in_vitro", full=False)
        with patch.object(final, "compute_fft_features", side_effect=AssertionError("FFT repeated")), \
                patch.object(final, "compute_tuft_metrics", wraps=final.compute_tuft_metrics) as metrics:
            final.process_one_video(self.video, self.root / "output", params)
        self.assertEqual(metrics.call_count, 1)

    def test_changed_output_computations_match_fresh_results(self) -> None:
        params = self.params("in_vitro")
        self.prepare(params, "in_vitro")
        without_axis = replace(params, COMPUTE_METACHRONAL_AXIS=False)
        final.process_one_video(self.video, self.root / "cached", without_axis)
        with patch.dict(os.environ, {"TUFFT_PREVIEW_CACHE_DIR": ""}):
            final.process_one_video(self.video, self.root / "fresh", without_axis)
        self.assert_same_outputs(self.root / "cached", self.root / "fresh")
        self.prepare(without_axis, "in_vitro")
        with patch.object(final, "compute_tuft_metrics", side_effect=AssertionError("Spectra repeated")):
            final.process_one_video(self.video, self.root / "axis-cached", params)
        with patch.dict(os.environ, {"TUFFT_PREVIEW_CACHE_DIR": ""}):
            final.process_one_video(self.video, self.root / "axis-fresh", params)
        self.assert_same_outputs(self.root / "axis-cached", self.root / "axis-fresh")

    def test_output_changes_reuse_results_but_scientific_changes_invalidate_them(self) -> None:
        params = self.params("in_vitro")
        self.prepare(params, "in_vitro")
        for changed in (replace(params, OUTPUT_DPI=150), replace(params, RAW_FREQUENCY_COLORMAP="magma")):
            cached = load_preview(self.video, changed, "in_vitro")
            try:
                self.assertTrue(cached["analysis"]["metrics_ready"])
            finally:
                close_preview(cached)
        for changed in (replace(params, BAND_LO=10), replace(params, MIN_TUFT_AREA=30), replace(params, PHASE_TENSOR_SMOOTH_SIGMA=2)):
            cached = load_preview(self.video, changed, "in_vitro")
            try:
                self.assertIsNotNone(cached)
                self.assertIsNone(cached["analysis"])
            finally:
                close_preview(cached)
        for changed in (replace(params, N_FRAMES=48), replace(params, N_FRAMES="all"), replace(params, FPS=100), replace(params, ROI_MODE="circle", RADIUS=20)):
            self.assertIsNone(load_preview(self.video, changed, "in_vitro"))
        stat = self.video.stat()
        os.utime(self.video, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        self.assertIsNone(load_preview(self.video, params, "in_vitro"))

    def test_repeated_previews_reuse_fft_and_do_not_downgrade_completed_results(self) -> None:
        params = self.params("in_vitro")
        self.prepare(params, "in_vitro")
        with patch.object(preview, "_load_gray_frames_bounded", side_effect=AssertionError("Decode repeated")), \
                patch.object(preview, "compute_fft_features", side_effect=AssertionError("FFT repeated")):
            self.prepare(params, "in_vitro", full=False)
        cached = load_preview(self.video, params, "in_vitro")
        try:
            self.assertTrue(cached["analysis"]["metrics_ready"])
        finally:
            close_preview(cached)

    def test_band_edits_after_complete_preview_restore_pixels_and_match_fresh_runs(self) -> None:
        for mode in ("in_vitro", "ex_vivo"):
            with self.subTest(mode=mode):
                params = self.params(mode)
                original = self.prepare(params, mode)
                self.assertGreater(original["cleanup_retained_pixels"], 0)
                changed = replace(params, BAND_LO=24, BAND_HI=40)
                with patch.object(preview, "_load_gray_frames_bounded", side_effect=AssertionError("Video decoded again")), \
                        patch.object(preview, "compute_fft_features", side_effect=AssertionError("FFT repeated")), \
                        patch.object(preview, "compute_ex_vivo_fft_features", side_effect=AssertionError("FFT repeated")):
                    narrowed = self.prepare(changed, mode)
                    restored = self.prepare(params, mode)
                self.assertLess(narrowed["cleanup_retained_pixels"], original["cleanup_retained_pixels"])
                self.assertEqual(restored, original)
                with patch.dict(os.environ, {"TUFFT_PREVIEW_CACHE_DIR": ""}):
                    self.assertEqual(narrowed, self.prepare(changed, mode))
                    self.assertEqual(restored, self.prepare(params, mode))
                process = final.process_one_video if mode == "in_vitro" else ex_vivo.process_one_ex_vivo_video
                process(self.video, self.root / (mode + "-cached"), params)
                with patch.dict(os.environ, {"TUFFT_PREVIEW_CACHE_DIR": ""}):
                    process(self.video, self.root / (mode + "-fresh"), params)
                self.assert_same_outputs(self.root / (mode + "-cached"), self.root / (mode + "-fresh"))

    def test_final_run_after_band_edit_without_another_preview_matches_fresh(self) -> None:
        for mode in ("in_vitro", "ex_vivo"):
            with self.subTest(mode=mode):
                params = self.params(mode)
                self.prepare(params, mode)
                changed = replace(params, BAND_LO=24, BAND_HI=40)
                process = final.process_one_video if mode == "in_vitro" else ex_vivo.process_one_ex_vivo_video
                with patch.object(final, "compute_fft_features", side_effect=AssertionError("FFT repeated")), \
                        patch.object(ex_vivo, "compute_ex_vivo_fft_features", side_effect=AssertionError("FFT repeated")):
                    process(self.video, self.root / (mode + "-cached"), changed)
                with patch.dict(os.environ, {"TUFFT_PREVIEW_CACHE_DIR": ""}):
                    process(self.video, self.root / (mode + "-fresh"), changed)
                self.assert_same_outputs(self.root / (mode + "-cached"), self.root / (mode + "-fresh"))

    def test_corrupt_and_incomplete_caches_fall_back_safely(self) -> None:
        params = self.params("in_vitro")
        self.prepare(params, "in_vitro")
        directory = next((self.root / "cache" / "v1").iterdir())
        (directory / "analysis.npz").write_bytes(b"interrupted")
        cached = load_preview(self.video, params, "in_vitro")
        try:
            self.assertIsNotNone(cached)
            self.assertIsNone(cached["analysis"])
        finally:
            close_preview(cached)
        (directory / "features.npz").write_bytes(b"interrupted")
        self.assertIsNone(load_preview(self.video, params, "in_vitro"))

    def test_frames_are_memory_mapped_and_closed_after_use(self) -> None:
        params = self.params("in_vitro")
        self.prepare(params, "in_vitro")
        cached = load_preview(self.video, params, "in_vitro")
        self.assertIsInstance(cached["frames"], np.memmap)
        mapped = cached["frames"]._mmap
        close_preview(cached)
        self.assertTrue(mapped.closed)

    def test_expired_and_over_budget_results_are_not_reused(self) -> None:
        params = self.params("in_vitro")
        with patch.object(preview_cache, "MAX_CACHE_BYTES", 1):
            self.prepare(params, "in_vitro")
        self.assertIsNone(load_preview(self.video, params, "in_vitro"))
        self.prepare(params, "in_vitro")
        directory = next((self.root / "cache" / "v1").iterdir())
        expired = directory.stat().st_mtime - preview_cache.MAX_CACHE_AGE_SECONDS - 1
        os.utime(directory, (expired, expired))
        self.assertIsNone(load_preview(self.video, params, "in_vitro"))

    def test_cache_write_failure_does_not_fail_the_preview(self) -> None:
        with patch.object(preview_cache.np, "save", side_effect=OSError("Disk full")):
            result = self.prepare(self.params("in_vitro"), "in_vitro")
        self.assertEqual(result["decoded_frames"], 32)
        self.assertFalse(list((self.root / "cache").rglob(".partial-*")))


if __name__ == "__main__":
    unittest.main()

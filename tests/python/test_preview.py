from __future__ import annotations

from pathlib import Path
import base64
from io import BytesIO
import sys
import tempfile
import unittest
from unittest.mock import patch

import imageio.v2 as imageio
import numpy as np
from PIL import Image


SIDECAR_DIRECTORY = Path(__file__).resolve().parents[2] / "python" / "sidecar"
sys.path.insert(0, str(SIDECAR_DIRECTORY))

import preview
from cilia_sidecar.final_pipeline import (
    fft_chunk_pixels,
    frame_intensity_scale,
    load_gray_frames_bounded,
    normalized_trace_chunk,
    open_gray_frames_disk_backed,
)


class FakeReader:
    def __init__(self, frames):
        self.frames = frames
        self.yielded = 0
        self.closed = False

    def get_meta_data(self):
        return {"fps": 20.0}

    def get_next_data(self):
        if self.yielded >= len(self.frames):
            raise StopIteration
        frame = self.frames[self.yielded]
        self.yielded += 1
        return frame

    def __iter__(self):
        for frame in self.frames:
            self.yielded += 1
            yield frame

    def close(self):
        self.closed = True


class PreviewTests(unittest.TestCase):
    def test_first_frame_preview_decodes_only_one_frame(self) -> None:
        reader = FakeReader([np.full((8, 8, 3), index, dtype=np.uint8) for index in range(10)])
        with patch.object(preview.imageio, "get_reader", return_value=reader):
            result = preview.first_frame_preview(Path("sample.avi"))

        self.assertEqual(result["width"], 8)
        self.assertEqual(result["height"], 8)
        self.assertEqual(reader.yielded, 1)
        self.assertTrue(reader.closed)
        self.assertEqual(result["image_data_url"], result["loop_data_url"])

    def test_bounded_loader_decodes_exactly_requested_frames(self) -> None:
        reader = FakeReader([np.full((8, 8, 3), index, dtype=np.uint8) for index in range(10)])
        with patch.object(preview.imageio, "get_reader", return_value=reader):
            video = preview._load_gray_frames_bounded(Path("sample.avi"), 4)

        self.assertEqual(video.shape, (4, 8, 8))
        self.assertEqual(video.dtype, np.uint8)
        self.assertEqual(reader.yielded, 4)
        self.assertTrue(reader.closed)

    def test_generated_common_video_formats_decode(self) -> None:
        frames = [np.full((16, 16, 3), index * 20, dtype=np.uint8) for index in range(6)]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for extension in (".avi", ".mp4", ".mov", ".mkv"):
                video_path = root / f"sample{extension}"
                imageio.mimsave(video_path, frames, fps=20, macro_block_size=1)
                decoded = load_gray_frames_bounded(video_path, 4)
                self.assertEqual(decoded.shape, (4, 16, 16), extension)
                self.assertEqual(decoded.dtype, np.uint8, extension)

    def test_bounded_loader_preserves_16_bit_grayscale_precision(self) -> None:
        reader = FakeReader([np.full((8, 8), index * 1000, dtype=np.uint16) for index in range(6)])
        with patch("cilia_sidecar.final_pipeline.imageio.get_reader", return_value=reader):
            video = load_gray_frames_bounded(Path("sample.avi"), 4)

        self.assertEqual(video.shape, (4, 8, 8))
        self.assertEqual(video.dtype, np.uint16)
        self.assertEqual(int(video[-1, 0, 0]), 3000)
        scale = frame_intensity_scale(video)
        normalized = normalized_trace_chunk(video.reshape(4, -1), np.array([0]), scale)
        self.assertAlmostEqual(float(normalized[-1, 0]), 3000 / 65535)

    def test_disk_backed_loader_reads_all_frames_and_removes_temporary_file(self) -> None:
        reader = FakeReader([np.full((8, 8), index * 1000, dtype=np.uint16) for index in range(7)])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch("cilia_sidecar.final_pipeline.imageio.get_reader", return_value=reader):
                with open_gray_frames_disk_backed(Path("sample.avi"), "all", root) as video:
                    self.assertIsInstance(video, np.memmap)
                    self.assertEqual(video.shape, (7, 8, 8))
                    self.assertEqual(video.dtype, np.uint16)
                    self.assertEqual(int(video[-1, 0, 0]), 6000)
                    self.assertEqual(len(list(root.glob(".tufft_frames_*.bin"))), 1)
            self.assertEqual(list(root.glob(".tufft_frames_*.bin")), [])

        self.assertEqual(reader.yielded, 7)
        self.assertTrue(reader.closed)

    def test_disk_backed_loader_stops_at_numeric_frame_limit(self) -> None:
        reader = FakeReader([np.full((8, 8, 3), index, dtype=np.uint8) for index in range(10)])
        with tempfile.TemporaryDirectory() as temp:
            with patch("cilia_sidecar.final_pipeline.imageio.get_reader", return_value=reader):
                with open_gray_frames_disk_backed(Path("sample.avi"), 4, Path(temp)) as video:
                    self.assertEqual(video.shape, (4, 8, 8))

        self.assertEqual(reader.yielded, 4)
        self.assertTrue(reader.closed)

    def test_disk_backed_loader_cleans_temporary_file_when_decoder_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch("cilia_sidecar.final_pipeline.imageio.get_reader", side_effect=RuntimeError("decode failed")):
                with self.assertRaisesRegex(RuntimeError, "decode failed"):
                    with open_gray_frames_disk_backed(Path("sample.avi"), "all", root):
                        pass
            self.assertEqual(list(root.glob(".tufft_frames_*.bin")), [])

    def test_fft_chunk_size_shrinks_for_longer_videos(self) -> None:
        self.assertEqual(fft_chunk_pixels(100), 8192)
        self.assertEqual(fft_chunk_pixels(100, 4096), 4096)
        self.assertEqual(fft_chunk_pixels(100, 16384), 16384)
        self.assertEqual(fft_chunk_pixels(100, 32768), 30000)
        self.assertEqual(fft_chunk_pixels(500, 32768), 6000)
        self.assertLess(fft_chunk_pixels(5000), 8192)
        self.assertGreaterEqual(fft_chunk_pixels(5000), 256)
        self.assertEqual(fft_chunk_pixels(10_000_000), 1)

    def test_circle_roi_cannot_extend_beyond_centered_frame(self) -> None:
        with self.assertRaisesRegex(ValueError, "exceeds"):
            preview._roi_mask(100, 80, "circle", 41, None)

    def test_square_roi_uses_requested_centered_width(self) -> None:
        roi = preview._roi_mask(12, 10, "square", None, 6)
        self.assertEqual(int(roi.sum()), 36)
        self.assertTrue(np.all(roi[3:9, 2:8]))

    def test_fft_preview_reports_detected_dimensions_and_nyquist(self) -> None:
        frame_count = 20
        fps = 100.0
        time = np.arange(frame_count) / fps
        values = ((np.sin(2 * np.pi * 10 * time) + 1) * 100).astype(np.uint8)
        frames = [np.full((16, 16, 3), value, dtype=np.uint8) for value in values]
        reader = FakeReader(frames)
        with patch.object(preview.imageio, "get_reader", return_value=reader):
            result = preview.fft_preview(
                Path("sample.avi"),
                fps=fps,
                frame_count=frame_count,
                roi_mode="full",
                radius=None,
                square_width=None,
                use_hann=True,
                band_low=5.0,
                band_high=40.0,
                snr_threshold_db=7.0,
                remove_doubling=False,
                half_power_ratio_threshold=0.6,
                use_spatial_consensus=True,
                neighbor_radius=2,
                spatial_tolerance_fraction=0.25,
                use_autocorrelation_fallback=True,
                pipeline_params={"DO_TUFT_DETECTION": False},
            )

        self.assertEqual(result["decoded_frames"], frame_count)
        self.assertEqual((result["width"], result["height"]), (16, 16))
        self.assertEqual(result["nyquist_hz"], 50.0)
        self.assertTrue(result["large_region_heatmap_data_url"].startswith("data:image/png;base64,"))
        self.assertTrue(result["cleanup_heatmap_data_url"].startswith("data:image/png;base64,"))
        self.assertTrue(result["band_mask_overlay_data_url"].startswith("data:image/png;base64,"))
        self.assertTrue(result["snr_mask_overlay_data_url"].startswith("data:image/png;base64,"))
        self.assertTrue(result["pixel_phase_heatmap_data_url"].startswith("data:image/png;base64,"))
        self.assertTrue(result["despeckle1_mask_overlay_data_url"].startswith("data:image/png;base64,"))
        peak_index = int(np.argmax(result["mean_power_normalized"][1:])) + 1
        self.assertAlmostEqual(result["frequencies_hz"][peak_index], 10.0)

    def test_preview_params_accept_manual_evidence_threshold(self) -> None:
        params = preview._final_params_from_preview(
            fps=100.0,
            frame_count=20,
            roi_mode="full",
            radius=None,
            square_width=None,
            roi_polygons=None,
            use_hann=True,
            band_low=5.0,
            band_high=40.0,
            snr_threshold_db=7.0,
            remove_doubling=True,
            half_power_ratio_threshold=0.6,
            use_spatial_consensus=True,
            spatial_tolerance_fraction=0.25,
            use_autocorrelation_fallback=True,
            pipeline_params={
                "EVIDENCE_THRESHOLD_MODE": "manual",
                "EVIDENCE_MANUAL_THRESHOLD": 0.35,
                "EVIDENCE_OTSU_COEFFICIENT": 0.9,
                "EVIDENCE_GAUSSIAN_SIGMA": 3.0,
                "FFT_CHUNK_PIXELS": 16384,
            },
        )

        self.assertEqual(params.EVIDENCE_THRESHOLD_MODE, "manual")
        self.assertAlmostEqual(params.EVIDENCE_MANUAL_THRESHOLD, 0.35)
        self.assertEqual(params.FFT_CHUNK_PIXELS, 16384)

    def test_frequency_heatmap_uses_white_for_filtered_roi_and_gray_outside_roi(self) -> None:
        values = np.array([[10.0, 20.0], [30.0, 40.0]], dtype=np.float32)
        roi = np.array([[True, True], [False, False]])
        visible = np.array([[True, False], [False, False]])
        data_url = preview._heatmap_data_url(values, visible, roi, 0.0, 50.0)
        image = np.asarray(Image.open(BytesIO(base64.b64decode(data_url.split(",", 1)[1]))))

        self.assertTrue(np.array_equal(image[0, 1], np.array([255, 255, 255], dtype=np.uint8)))
        self.assertTrue(np.array_equal(image[1, 0], np.array([28, 35, 40], dtype=np.uint8)))

    def test_ex_vivo_preview_stages_apply_despeckle_threshold(self) -> None:
        roi = np.ones((12, 12), dtype=bool)
        island_mask = np.zeros((12, 12), dtype=bool)
        island_mask[2:4, 2:4] = True
        island_mask[8:10, 8:10] = True
        frequency = np.full((12, 12), 100.0, dtype=np.float32)
        frequency[island_mask] = 10.0
        high = np.where(island_mask, 1.0, 0.0).astype(np.float32)
        low = np.where(island_mask, 0.0, 1.0).astype(np.float32)
        features = {
            "roi": roi,
            "dominant_global_corrected": frequency,
            "global_snr_db": np.where(island_mask, 12.0, 0.0).astype(np.float32),
            "global_peak_concentration": high,
            "spectral_entropy": low,
            "autocorrelation_peak": high,
            "band_to_outside_db": high,
            "temporal_variance": high,
        }
        params = preview.FinalPipelineParams()
        params.BAND_LO = 5.0
        params.BAND_HI = 20.0
        params.SNR_THRESH_DB = 7.0
        params.EVIDENCE_GAUSSIAN_SIGMA = 0.0
        params.EVIDENCE_OTSU_COEFFICIENT = 0.9

        keep_small = preview._ex_vivo_preview_stages(features, params, {"EX_VIVO_DESPECKLE_MIN_AREA": 4})
        remove_small = preview._ex_vivo_preview_stages(features, params, {"EX_VIVO_DESPECKLE_MIN_AREA": 5})

        self.assertEqual(int(keep_small["bandpass"].sum()), 8)
        self.assertEqual(int(keep_small["post_flat_despeckle"].sum()), 8)
        self.assertEqual(int(remove_small["bandpass"].sum()), 8)
        self.assertEqual(int(remove_small["post_flat_despeckle"].sum()), 0)


if __name__ == "__main__":
    unittest.main()

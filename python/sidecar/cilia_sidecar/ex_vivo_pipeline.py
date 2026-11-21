from __future__ import annotations

from dataclasses import dataclass, fields
import json
from pathlib import Path
from typing import Any, Callable

import numpy as np
from PIL import Image, ImageDraw
from scipy import fft

from .preview_cache import close_preview, load_preview

from .final_pipeline import (
    FinalPipelineParams,
    append_csv_rows,
    composite_evidence,
    compute_fft_features,
    evidence_threshold,
    fft_chunk_pixels,
    frame_intensity_scale,
    fwhm_hz,
    masked_gaussian,
    normalized_trace_chunk,
    otsu_threshold,
    phase_rgb,
    remove_small_labels_from_mask,
    scalar_rgb,
    save_plot,
    selected_columns,
    weighted_std_hz,
    write_csv,
    normalize_frame_count_selection,
    open_gray_frames_disk_backed,
    _safe_tag,
)


@dataclass
class ExVivoPipelineParams:
    FPS: float = 2000.0
    N_FRAMES: int | str = 100
    ROI_MODE: str = "full"
    ROI_POLYGONS: dict[str, list[list[dict[str, float]]]] | None = None
    BAND_LO: float = 5.0
    BAND_HI: float = 60.0
    USE_HANN: bool = True
    FFT_CHUNK_PIXELS: int = 8192
    REMOVE_DOUBLING: bool = True
    HALF_POWER_RATIO_THRESH: float = 0.6
    USE_SPATIAL_CONSENSUS: bool = True
    SPATIAL_TOL_FRAC: float = 0.25
    USE_AUTOCORR_FALLBACK: bool = True
    SNR_THRESH_DB: float | None = 7.0
    EVIDENCE_GAUSSIAN_SIGMA: float = 3.0
    EVIDENCE_THRESHOLD_MODE: str = "otsu"
    EVIDENCE_MANUAL_THRESHOLD: float = 0.5
    EVIDENCE_OTSU_COEFFICIENT: float = 0.9
    EX_VIVO_DESPECKLE_MIN_AREA: int = 150
    SAVE_BATCH_SUMMARY: bool = True
    PLOT_GAUSSIAN_EVIDENCE: bool = False
    PLOT_EX_VIVO_ORIGINAL: bool = True
    PLOT_EX_VIVO_CBF: bool = True
    PLOT_EX_VIVO_PHASE: bool = True
    OUTPUT_DPI: int = 600
    RAW_FREQUENCY_MIN_HZ: float = 5.0
    RAW_FREQUENCY_MAX_HZ: float = 60.0
    RAW_FREQUENCY_COLORMAP: str = "viridis"


EX_VIVO_SUMMARY_COLUMNS = [
    "video_file",
    "tag",
    "status",
    "error",
    "roi_area_px",
    "foreground_area_px",
    "joint_dominant_cbf_hz",
    "joint_peak_fwhm_hz",
    "pixel_dominant_cbf_mean_hz",
    "pixel_dominant_cbf_std_hz",
]


ProgressCallback = Callable[[str, str], None]


def build_ex_vivo_params(overrides: dict[str, Any]) -> ExVivoPipelineParams:
    allowed = {field.name for field in fields(ExVivoPipelineParams)}
    ignored = {"H_EXPECT", "W_EXPECT", "RADIUS", "SQUARE_WIDTH", "SAVE_TUFT_SPECTRA"}
    filtered = {key: value for key, value in overrides.items() if key in allowed}
    unknown = sorted(set(overrides) - allowed - ignored)
    if unknown:
        raise ValueError(f"Unknown ex-vivo workflow parameter(s): {', '.join(unknown)}")
    params = ExVivoPipelineParams()
    for name, value in filtered.items():
        setattr(params, name, value)
    if "RAW_FREQUENCY_MIN_HZ" not in filtered:
        params.RAW_FREQUENCY_MIN_HZ = float(params.BAND_LO)
    if "RAW_FREQUENCY_MAX_HZ" not in filtered:
        params.RAW_FREQUENCY_MAX_HZ = float(params.BAND_HI)
    if str(params.ROI_MODE).lower() not in {"full", "custom"}:
        raise ValueError("Ex-vivo ROI_MODE must be 'full' or 'custom'.")
    normalize_frame_count_selection(params.N_FRAMES)
    if isinstance(params.FFT_CHUNK_PIXELS, bool) or not isinstance(params.FFT_CHUNK_PIXELS, int) or not 256 <= params.FFT_CHUNK_PIXELS <= 32768:
        raise ValueError("FFT_CHUNK_PIXELS must be a whole number from 256 to 32768.")
    return params


def serializable_ex_vivo_params(params: ExVivoPipelineParams) -> dict[str, Any]:
    return {field.name: getattr(params, field.name) for field in fields(params)}


def process_one_ex_vivo_video(
    video_path: Path,
    output_root: Path,
    params: ExVivoPipelineParams,
    *,
    progress_callback: ProgressCallback | None = None,
    summary_output_columns: list[str] | None = None,
    output_tag: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    tag = output_tag or _safe_tag(video_path)
    video_dir = output_root / tag
    video_dir.mkdir(parents=True, exist_ok=True)
    cached = load_preview(video_path, params, "ex_vivo")
    if cached is not None:
        try:
            _stage(progress_callback, "load_video", "Loading saved preview results")
            return _process_loaded_ex_vivo_video(
                video_path, video_dir, tag, cached["frames"], params,
                progress_callback, summary_output_columns, cached,
            )
        finally:
            close_preview(cached)
    selection = normalize_frame_count_selection(params.N_FRAMES)
    frame_description = "all video frames" if selection is None else f"up to {selection} video frames"
    _stage(progress_callback, "load_video", f"Decoding {frame_description} to temporary disk storage")
    with open_gray_frames_disk_backed(video_path, params.N_FRAMES, video_dir) as frames:
        return _process_loaded_ex_vivo_video(
            video_path,
            video_dir,
            tag,
            frames,
            params,
            progress_callback,
            summary_output_columns,
        )


def _process_loaded_ex_vivo_video(
    video_path: Path,
    video_dir: Path,
    tag: str,
    frames: np.ndarray,
    params: ExVivoPipelineParams,
    progress_callback: ProgressCallback | None,
    summary_output_columns: list[str] | None,
    cached: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    roi = roi_mask_for_video(video_path, frames.shape[1:], params)
    save_roi_records(video_dir, tag, roi, params, video_path)

    state = cached["analysis"] if cached else None
    _stage(progress_callback, "fft", "Reusing preview FFT and frequency correction" if cached else "Running per-pixel FFT and frequency correction")
    features = cached["features"] if cached else compute_ex_vivo_fft_features(video_path, frames, params)

    _stage(progress_callback, "foreground", "Building Gaussian evidence foreground and bandpass mask")
    foreground = state["stages"]["post_flat_despeckle"] if state else ex_vivo_foreground_mask(features, params)
    reuse_summary = state is not None and state.get("summary_ready", False)
    _stage(progress_callback, "summary", "Reusing preview ROI-level CBF summary" if reuse_summary else "Computing ROI-level CBF summary")
    if reuse_summary:
        summary, phase_map = dict(state["summary"]), state["summary_phase_map"]
        summary.update(video_file=str(video_path), tag=tag)
    else:
        summary, phase_map = ex_vivo_summary(video_path, tag, frames, features, foreground, params)
    summary["frames_processed"] = int(frames.shape[0])
    if params.SAVE_BATCH_SUMMARY:
        write_csv(
            video_dir / f"{tag}__ex_vivo_summary.csv",
            [summary],
            EX_VIVO_SUMMARY_COLUMNS if summary_output_columns is None else summary_output_columns,
        )
    _stage(progress_callback, "plots", "Rendering selected ex-vivo plots")
    make_ex_vivo_plots(video_dir, tag, frames, features, foreground, phase_map, params)
    return summary, []


def compute_ex_vivo_fft_features(video_path: Path, frames: np.ndarray, params: ExVivoPipelineParams) -> dict[str, np.ndarray]:
    features = compute_fft_features(frames, final_params_from_ex_vivo(params))
    roi = roi_mask_for_video(video_path, frames.shape[1:], params)
    features["roi"] = roi
    for name in ("dominant_global_corrected", "raw_phase_at_dominant", "global_snr_db"):
        features[name] = np.where(roi, features[name], np.nan)
    return features


def final_params_from_ex_vivo(params: ExVivoPipelineParams) -> FinalPipelineParams:
    final = FinalPipelineParams()
    final.FPS = float(params.FPS)
    final.N_FRAMES = params.N_FRAMES
    final.ROI_MODE = "full"
    final.BAND_LO = float(params.BAND_LO)
    final.BAND_HI = float(params.BAND_HI)
    final.USE_HANN = bool(params.USE_HANN)
    final.FFT_CHUNK_PIXELS = int(params.FFT_CHUNK_PIXELS)
    final.REMOVE_DOUBLING = bool(params.REMOVE_DOUBLING)
    final.HALF_POWER_RATIO_THRESH = float(params.HALF_POWER_RATIO_THRESH)
    final.USE_SPATIAL_CONSENSUS = bool(params.USE_SPATIAL_CONSENSUS)
    final.SPATIAL_TOL_FRAC = float(params.SPATIAL_TOL_FRAC)
    final.USE_AUTOCORR_FALLBACK = bool(params.USE_AUTOCORR_FALLBACK)
    final.SNR_THRESH_DB = params.SNR_THRESH_DB
    final.OUTPUT_DPI = int(params.OUTPUT_DPI)
    final.RAW_FREQUENCY_MIN_HZ = float(params.RAW_FREQUENCY_MIN_HZ)
    final.RAW_FREQUENCY_MAX_HZ = float(params.RAW_FREQUENCY_MAX_HZ)
    final.RAW_FREQUENCY_COLORMAP = str(params.RAW_FREQUENCY_COLORMAP)
    return final


def ex_vivo_foreground_mask(features: dict[str, np.ndarray], params: ExVivoPipelineParams) -> np.ndarray:
    roi = features["roi"].astype(bool)
    frequency = features["dominant_global_corrected"]
    evidence_raw = composite_evidence(features)
    smooth = masked_gaussian(evidence_raw, roi, float(params.EVIDENCE_GAUSSIAN_SIGMA))
    threshold = evidence_threshold(smooth, roi, params, otsu_threshold(smooth, roi))
    evidence = (smooth >= threshold) & roi
    band = roi & np.isfinite(frequency) & (frequency >= float(params.BAND_LO)) & (frequency <= float(params.BAND_HI))
    snr = roi if params.SNR_THRESH_DB is None else (features["global_snr_db"] >= float(params.SNR_THRESH_DB))
    return remove_small_labels_from_mask(evidence & band & snr, int(params.EX_VIVO_DESPECKLE_MIN_AREA))


def ex_vivo_summary(
    video_path: Path,
    tag: str,
    frames: np.ndarray,
    features: dict[str, np.ndarray],
    foreground: np.ndarray,
    params: ExVivoPipelineParams,
) -> tuple[dict[str, Any], np.ndarray]:
    frequencies, power = joint_power_spectrum(frames, foreground, params)
    band = (frequencies >= float(params.BAND_LO)) & (frequencies <= float(params.BAND_HI))
    band_freq = frequencies[band]
    band_power = power[band]
    if band_power.size and float(np.max(band_power)) > 0:
        peak_index = int(np.argmax(band_power))
        dominant = float(band_freq[peak_index])
        fwhm = fwhm_hz(band_freq, band_power, peak_index)
        peak_global_index = int(np.flatnonzero(band)[peak_index])
        phase_map = phase_map_at_index(frames, foreground, peak_global_index, params)
    else:
        dominant = fwhm = float("nan")
        phase_map = np.full(foreground.shape, np.nan, dtype=np.float32)
    pixel_values = features["dominant_global_corrected"][foreground]
    pixel_values = pixel_values[np.isfinite(pixel_values)]
    summary = {
        "video_file": str(video_path),
        "tag": tag,
        "status": "OK",
        "error": "",
        "roi_area_px": int(np.sum(features["roi"])),
        "foreground_area_px": int(np.sum(foreground)),
        "joint_dominant_cbf_hz": dominant,
        "joint_peak_fwhm_hz": fwhm,
        "pixel_dominant_cbf_mean_hz": float(np.mean(pixel_values)) if pixel_values.size else float("nan"),
        "pixel_dominant_cbf_std_hz": float(np.std(pixel_values)) if pixel_values.size else float("nan"),
    }
    return summary, phase_map


def joint_power_spectrum(frames: np.ndarray, mask: np.ndarray, params: ExVivoPipelineParams) -> tuple[np.ndarray, np.ndarray]:
    frame_count = frames.shape[0]
    frequencies = fft.rfftfreq(frame_count, d=1.0 / float(params.FPS)).astype(np.float32)[1:]
    indices = np.flatnonzero(mask.ravel())
    power_sum = np.zeros(frequencies.size, dtype=np.float64)
    if indices.size == 0:
        return frequencies, power_sum
    flat_frames = frames.reshape(frame_count, -1)
    intensity_scale = frame_intensity_scale(frames)
    window = np.hanning(frame_count).astype(np.float32)[:, None] if params.USE_HANN else None
    chunk_size = fft_chunk_pixels(frame_count, int(params.FFT_CHUNK_PIXELS))
    for start in range(0, indices.size, chunk_size):
        chunk = indices[start : start + chunk_size]
        traces = normalized_trace_chunk(flat_frames, chunk, intensity_scale)
        traces -= traces.mean(axis=0, keepdims=True)
        transformed = fft.rfft(traces * window, axis=0, workers=1) if window is not None else fft.rfft(traces, axis=0, workers=1)
        power_sum += np.sum(np.abs(transformed[1:]) ** 2, axis=1)
    _ = weighted_std_hz(frequencies, power_sum)
    return frequencies, power_sum


def phase_map_at_index(frames: np.ndarray, mask: np.ndarray, peak_index: int, params: ExVivoPipelineParams) -> np.ndarray:
    output = np.full(mask.shape, np.nan, dtype=np.float32)
    indices = np.flatnonzero(mask.ravel())
    if indices.size == 0:
        return output
    frame_count = frames.shape[0]
    flat_frames = frames.reshape(frame_count, -1)
    intensity_scale = frame_intensity_scale(frames)
    flat_output = output.ravel()
    window = np.hanning(frame_count).astype(np.float32)[:, None] if params.USE_HANN else None
    chunk_size = fft_chunk_pixels(frame_count, int(params.FFT_CHUNK_PIXELS))
    for start in range(0, indices.size, chunk_size):
        chunk = indices[start : start + chunk_size]
        traces = normalized_trace_chunk(flat_frames, chunk, intensity_scale)
        traces -= traces.mean(axis=0, keepdims=True)
        transformed = fft.rfft(traces * window, axis=0, workers=1) if window is not None else fft.rfft(traces, axis=0, workers=1)
        flat_output[chunk] = np.angle(transformed[1:][peak_index]).astype(np.float32)
    return output


def roi_mask_for_video(video_path: Path, shape: tuple[int, int], params: ExVivoPipelineParams) -> np.ndarray:
    height, width = shape
    if str(params.ROI_MODE).lower() == "full":
        return np.ones((height, width), dtype=bool)
    polygons_by_video = params.ROI_POLYGONS or {}
    polygons = polygons_by_video.get(str(video_path)) or polygons_by_video.get(video_path.as_posix()) or polygons_by_video.get(video_path.name) or []
    if not polygons:
        raise ValueError(f"No custom ROI polygons were provided for {video_path}")
    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    for polygon in polygons:
        points = [(float(point["x"]), float(point["y"])) for point in polygon if "x" in point and "y" in point]
        if len(points) >= 3:
            draw.polygon(points, fill=255)
    mask = np.asarray(image, dtype=np.uint8) > 0
    if not np.any(mask):
        raise ValueError(f"Custom ROI for {video_path} is empty.")
    return mask


def save_roi_records(video_dir: Path, tag: str, roi: np.ndarray, params: ExVivoPipelineParams, video_path: Path) -> None:
    record = {
        "video_file": str(video_path),
        "roi_mode": params.ROI_MODE,
        "polygons": (params.ROI_POLYGONS or {}).get(str(video_path), []),
        "roi_area_px": int(np.sum(roi)),
    }
    (video_dir / f"{tag}__roi.json").write_text(json.dumps(record, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    Image.fromarray(np.where(roi, 255, 0).astype(np.uint8), mode="L").save(video_dir / f"{tag}__roi_mask.png")


def make_ex_vivo_plots(
    out_dir: Path,
    tag: str,
    frames: np.ndarray,
    features: dict[str, np.ndarray],
    foreground: np.ndarray,
    phase_map: np.ndarray,
    params: ExVivoPipelineParams,
) -> None:
    final_params = final_params_from_ex_vivo(params)
    roi = features["roi"].astype(bool)
    if params.PLOT_EX_VIVO_ORIGINAL:
        save_plot(out_dir / "01_original_roi_frame.png", f"{tag} - original ROI frame", original_roi_rgb(frames[0], roi), final_params)
    if params.PLOT_GAUSSIAN_EVIDENCE:
        evidence_raw = composite_evidence(features)
        smooth = masked_gaussian(evidence_raw, roi, float(params.EVIDENCE_GAUSSIAN_SIGMA))
        save_plot(out_dir / "01a_gaussian_evidence_heatmap.png", f"{tag} - Gaussian evidence for background thresholding", scalar_rgb(smooth, roi, 0.0, 1.0, "magma"), final_params, colorbar=("Gaussian evidence", 0.0, 1.0), colorbar_cmap="magma")
    if params.PLOT_EX_VIVO_CBF:
        save_plot(out_dir / "02_ex_vivo_cbf_hz.png", f"{tag} - ex-vivo filtered CBF", scalar_rgb(features["dominant_global_corrected"], foreground, float(params.BAND_LO), float(params.BAND_HI)), final_params, colorbar=("CBF, Hz", float(params.BAND_LO), float(params.BAND_HI)))
    if params.PLOT_EX_VIVO_PHASE:
        save_plot(out_dir / "03_ex_vivo_phase.png", f"{tag} - ex-vivo filtered phase", phase_rgb(phase_map, foreground), final_params, phasebar="phase at ROI peak, radians")


def original_roi_rgb(frame: np.ndarray, roi: np.ndarray) -> np.ndarray:
    gray = np.asarray(frame, dtype=np.float32)
    if gray.ndim == 3:
        gray = gray[..., 0]
    normalized = np.clip(gray, 0, 255).astype(np.uint8)
    rgb = np.stack([normalized, normalized, normalized], axis=-1)
    rgb[~roi] = np.array([255, 255, 255], dtype=np.uint8)
    return rgb


def ex_vivo_selected_columns(selected: tuple[str, ...] | None) -> list[str]:
    return selected_columns(selected, EX_VIVO_SUMMARY_COLUMNS, required=("video_file", "tag", "status", "error"))


def append_ex_vivo_rows(path: Path, columns: list[str], rows: list[dict[str, Any]]) -> None:
    append_csv_rows(path, columns, rows)


def _stage(callback: ProgressCallback | None, stage: str, message: str) -> None:
    if callback:
        callback(stage, message)

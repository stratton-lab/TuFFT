from __future__ import annotations

import argparse
import base64
from dataclasses import fields
from io import BytesIO
import json
from itertools import islice
from pathlib import Path
import sys
from typing import Any

# Direct script media requests must dispatch before importing the scientific stack.
if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] in {"first-frame", "video-loop"}:
    from media_preview import main as media_main

    raise SystemExit(media_main(sys.argv[1:]))

import imageio.v2 as imageio
import numpy as np
from PIL import Image

from cilia_sidecar.preview_cache import close_preview, load_preview, save_preview, source_stamp
from cilia_sidecar.ex_vivo_pipeline import (
    ExVivoPipelineParams,
    build_ex_vivo_params,
    compute_ex_vivo_fft_features,
    ex_vivo_summary,
    joint_power_spectrum,
)

from cilia_sidecar.final_pipeline import (
    FinalPipelineParams,
    VIDEO_EXTENSIONS,
    VIDEO_EXTENSIONS_DISPLAY,
    as_gray_frame,
    axis_coherence_rgb,
    build_foreground_stages,
    build_repaired_clusters,
    build_tuft_labels,
    composite_evidence,
    compute_fft_features,
    compute_tuft_metrics,
    colormap_rgb,
    draw_tensor_axis_lines,
    evidence_threshold,
    masked_gaussian,
    otsu_threshold,
    remove_small_labels_from_mask,
    restored_tuft_metrics,
    hsv_to_rgb,
)


MAX_PREVIEW_FRAMES = 100


def first_frame_preview(video_path: Path, max_display_size: int = 900) -> dict[str, Any]:
    reader = imageio.get_reader(str(video_path), format="FFMPEG")
    try:
        metadata = reader.get_meta_data()
        frame = reader.get_next_data()
    except StopIteration as exc:
        raise ValueError(f"No frames could be decoded from {video_path}") from exc
    finally:
        reader.close()

    rgb = _as_rgb_uint8(frame)
    height, width = rgb.shape[:2]
    image = Image.fromarray(rgb, mode="RGB")
    image.thumbnail((max_display_size, max_display_size), Image.Resampling.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=88, optimize=True)
    source_fps = float(metadata.get("fps") or 10.0)
    image_data_url = "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    return {
        "video_path": str(video_path.resolve()),
        "width": width,
        "height": height,
        "display_width": image.width,
        "display_height": image.height,
        "image_data_url": image_data_url,
        "loop_data_url": image_data_url,
        "source_fps_metadata": source_fps,
        "decoder": "imageio-ffmpeg",
    }


def fft_preview(
    video_path: Path,
    *,
    fps: float,
    frame_count: int,
    roi_mode: str,
    radius: int | None,
    square_width: int | None,
    use_hann: bool,
    band_low: float,
    band_high: float,
    snr_threshold_db: float | None,
    remove_doubling: bool,
    half_power_ratio_threshold: float,
    use_spatial_consensus: bool,
    neighbor_radius: int,
    spatial_tolerance_fraction: float,
    use_autocorrelation_fallback: bool,
    pipeline_params: dict[str, Any] | None,
    roi_polygons: list[list[dict[str, float]]] | None = None,
) -> dict[str, Any]:
    if not (1 <= frame_count <= MAX_PREVIEW_FRAMES):
        raise ValueError(f"frame_count must be between 1 and {MAX_PREVIEW_FRAMES}")
    if fps <= 0:
        raise ValueError("fps must be greater than zero")
    if band_low < 0 or band_high <= band_low or band_high > fps / 2.0:
        raise ValueError(f"CBF band must satisfy 0 <= low < high <= {fps / 2.0:g} Hz")

    final_params = _final_params_from_preview(
        fps=fps,
        frame_count=frame_count,
        roi_mode=roi_mode,
        radius=radius,
        square_width=square_width,
        roi_polygons=roi_polygons,
        use_hann=use_hann,
        band_low=band_low,
        band_high=band_high,
        snr_threshold_db=snr_threshold_db,
        remove_doubling=remove_doubling,
        half_power_ratio_threshold=half_power_ratio_threshold,
        use_spatial_consensus=use_spatial_consensus,
        spatial_tolerance_fraction=spatial_tolerance_fraction,
        use_autocorrelation_fallback=use_autocorrelation_fallback,
        pipeline_params=pipeline_params or {},
    )
    options = pipeline_params or {}
    mode = options.get("PREVIEW_ANALYSIS_MODE", "in_vitro")
    cache_params = _ex_vivo_params_from_preview(video_path, final_params, options) if mode == "ex_vivo" else final_params
    cached = load_preview(video_path, cache_params, mode)
    try:
        return _fft_preview_payload(video_path, final_params, cache_params, options, cached, neighbor_radius)
    finally:
        close_preview(cached)


def _ex_vivo_params_from_preview(video_path: Path, params: FinalPipelineParams, options: dict[str, Any]) -> ExVivoPipelineParams:
    values = {field.name: getattr(params, field.name) for field in fields(ExVivoPipelineParams) if hasattr(params, field.name)}
    values["ROI_POLYGONS"] = {str(video_path): params.ROI_POLYGONS or []}
    values["EX_VIVO_DESPECKLE_MIN_AREA"] = options.get("EX_VIVO_DESPECKLE_MIN_AREA", 150)
    return build_ex_vivo_params(values)


def _fft_preview_payload(
    video_path: Path,
    final_params: FinalPipelineParams,
    cache_params: FinalPipelineParams | ExVivoPipelineParams,
    pipeline_params: dict[str, Any],
    cached: dict[str, Any] | None,
    neighbor_radius: int,
) -> dict[str, Any]:
    fps, frame_count = final_params.FPS, final_params.N_FRAMES
    roi_mode, radius, square_width = final_params.ROI_MODE, final_params.RADIUS, final_params.SQUARE_WIDTH
    band_low, band_high = final_params.BAND_LO, final_params.BAND_HI
    snr_threshold_db, use_hann = final_params.SNR_THRESH_DB, final_params.USE_HANN
    remove_doubling = final_params.REMOVE_DOUBLING
    half_power_ratio_threshold = final_params.HALF_POWER_RATIO_THRESH
    use_spatial_consensus = final_params.USE_SPATIAL_CONSENSUS
    spatial_tolerance_fraction = final_params.SPATIAL_TOL_FRAC
    use_autocorrelation_fallback = final_params.USE_AUTOCORR_FALLBACK
    is_ex_vivo_preview = pipeline_params.get("PREVIEW_ANALYSIS_MODE") == "ex_vivo"
    mode = "ex_vivo" if is_ex_vivo_preview else "in_vitro"
    original_source = source_stamp(video_path)
    video = cached["frames"] if cached else _load_gray_frames_bounded(video_path, frame_count)
    features = cached["features"] if cached else (
        compute_ex_vivo_fft_features(video_path, video, cache_params)
        if is_ex_vivo_preview else compute_fft_features(video, final_params)
    )
    state = cached["analysis"] if cached else None
    decoded_frames, height, width = video.shape
    roi = features["roi"].astype(bool)
    if is_ex_vivo_preview and not np.all(roi) and "preview_mean_power_spectrum" not in features:
        _, power = joint_power_spectrum(video, roi, cache_params)
        features["preview_mean_power_spectrum"] = power / max(1, int(np.sum(roi)))
    dominant_map = features["dominant_global_corrected"]
    snr_map = features["global_snr_db"]
    stages = state["stages"] if state else (
        _ex_vivo_preview_stages(features, final_params, pipeline_params or {})
        if is_ex_vivo_preview
        else build_foreground_stages(features, final_params)
    )
    band_mask = stages["snr"].astype(bool) if is_ex_vivo_preview else stages["bandpass"].astype(bool)
    snr_mask = stages["snr"].astype(bool)
    cleanup_mask = stages["post_flat_despeckle"].astype(bool)
    cluster_labels = np.zeros((height, width), dtype=np.int32)
    tuft_labels = np.zeros((height, width), dtype=np.int32)
    tuft_phase_map = np.full((height, width), np.nan, dtype=np.float32)
    tuft_rows: list[dict[str, Any]] = []
    include_tufts = not is_ex_vivo_preview and bool((pipeline_params or {}).get("PREVIEW_TUFTS", False))
    include_phase = bool((pipeline_params or {}).get("PREVIEW_PHASE", False))
    if include_tufts:
        if state and state.get("tufts_ready", False):
            cluster_labels, tuft_labels = state["cluster_labels"], state["tuft_labels"]
        else:
            cluster_labels = build_repaired_clusters(cleanup_mask, dominant_map, final_params)
            tuft_labels = build_tuft_labels(cluster_labels, final_params)
    if include_phase:
        if state and state.get("metrics_ready", False):
            tuft_rows, tuft_phase_map = restored_tuft_metrics(state, tuft_labels, final_params)
        elif np.any(tuft_labels > 0):
            tuft_rows, tuft_phase_map = compute_tuft_metrics(video_path, video, features, tuft_labels, final_params)
    checkpoint = dict(state or {})
    checkpoint["stages"] = stages
    if include_tufts:
        checkpoint.update(tufts_ready=True, cluster_labels=cluster_labels, tuft_labels=tuft_labels)
    if include_phase and include_tufts:
        checkpoint.update(metrics_ready=True, tensor_ready=bool(final_params.COMPUTE_METACHRONAL_AXIS), tuft_rows=tuft_rows, tuft_phase_map=tuft_phase_map)
    if is_ex_vivo_preview and pipeline_params.get("PREVIEW_FILTER") and not checkpoint.get("summary_ready", False):
        summary, summary_phase = ex_vivo_summary(video_path, "preview", video, features, cleanup_mask, cache_params)
        checkpoint.update(summary_ready=True, summary=summary, summary_phase_map=summary_phase)
    save_preview(video_path, cache_params, mode, video, features, checkpoint, expected_source=original_source)
    frequencies = np.concatenate(([0.0], features["frequencies_non_dc"].astype(np.float64)))
    mean_power_non_dc = features.get("preview_mean_power_spectrum", features["mean_power_spectrum"]).astype(np.float64)
    mean_power = np.concatenate(([0.0], mean_power_non_dc))
    normalization = float(np.max(mean_power[1:])) if mean_power.size > 1 else float(np.max(mean_power))
    if normalization > 0:
        mean_power /= normalization
    histogram_edges = np.linspace(0.0, fps / 2.0, 81, dtype=np.float64)
    dominant_counts, _ = np.histogram(dominant_map[np.isfinite(dominant_map)], bins=histogram_edges)
    halved = features["frequency_halved"].astype(bool)

    return {
        "video_path": str(video_path.resolve()),
        "decoder": "imageio-ffmpeg",
        "requested_frames": frame_count,
        "decoded_frames": decoded_frames,
        "width": width,
        "height": height,
        "fps": fps,
        "nyquist_hz": fps / 2.0,
        "frequency_resolution_hz": fps / decoded_frames,
        "roi_mode": roi_mode,
        "radius": radius if roi_mode == "circle" else None,
        "square_width": square_width if roi_mode == "square" else None,
        "roi_pixel_count": int(np.sum(roi)),
        "frequencies_hz": frequencies.tolist(),
        "mean_power_normalized": mean_power.tolist(),
        "dominant_histogram_edges_hz": histogram_edges.tolist(),
        "dominant_histogram_counts": dominant_counts.tolist(),
        "gaussian_evidence_heatmap_data_url": _evidence_data_url(stages["gaussian_evidence"], roi),
        "evidence_threshold": float(np.asarray(stages["evidence_threshold"]).item()),
        "otsu_threshold": float(np.asarray(stages["otsu_threshold"]).item()),
        "fft_heatmap_data_url": _heatmap_data_url(dominant_map, roi, roi, 0.0, fps / 2.0),
        "band_heatmap_data_url": _heatmap_data_url(dominant_map, band_mask, roi, band_low, band_high),
        "snr_heatmap_data_url": _heatmap_data_url(dominant_map, snr_mask, roi, band_low, band_high),
        "band_mask_overlay_data_url": _mask_overlay_data_url(band_mask, roi),
        "snr_mask_overlay_data_url": _mask_overlay_data_url(snr_mask, roi),
        "cleanup_mask_overlay_data_url": _mask_overlay_data_url(cleanup_mask, roi),
        "large_region_mask_overlay_data_url": _mask_overlay_data_url(stages["evidence_mask"].astype(bool), roi),
        "despeckle1_mask_overlay_data_url": _mask_overlay_data_url(stages["despeckle_1"].astype(bool), roi),
        "watershed_mask_overlay_data_url": _mask_overlay_data_url(cluster_labels > 0 if include_tufts else cleanup_mask, roi),
        "despeckle2_mask_overlay_data_url": _mask_overlay_data_url(cleanup_mask, roi),
        "cleanup_heatmap_data_url": _heatmap_data_url(dominant_map, cleanup_mask, roi, band_low, band_high),
        "large_region_heatmap_data_url": _heatmap_data_url(dominant_map, stages["evidence_mask"].astype(bool), roi, band_low, band_high),
        "despeckle1_heatmap_data_url": _heatmap_data_url(dominant_map, stages["despeckle_1"].astype(bool), roi, band_low, band_high),
        "watershed_heatmap_data_url": _heatmap_data_url(dominant_map, cluster_labels > 0 if include_tufts else cleanup_mask, roi, band_low, band_high),
        "despeckle2_heatmap_data_url": _heatmap_data_url(dominant_map, cleanup_mask, roi, band_low, band_high),
        "tuft_heatmap_data_url": _label_data_url(tuft_labels),
        "pixel_phase_heatmap_data_url": _phase_data_url(features["raw_phase_at_dominant"]),
        "pixel_phase_band_data_url": _phase_data_url(np.where(band_mask, features["raw_phase_at_dominant"], np.nan)),
        "pixel_phase_masked_data_url": _phase_data_url(np.where(cleanup_mask, features["raw_phase_at_dominant"], np.nan)),
        "phase_heatmap_data_url": _phase_data_url(tuft_phase_map),
        "phase_axis_overlay_data_url": _phase_axis_data_url(tuft_labels, tuft_rows, final_params),
        "band_retained_pixels": int(np.sum(band_mask)),
        "snr_retained_pixels": int(np.sum(snr_mask)),
        "cleanup_retained_pixels": int(np.sum(cleanup_mask)),
        "tuft_count": int(np.max(tuft_labels)),
        "dedoubled_pixels": int(np.sum(halved)),
        "band_low": band_low,
        "band_high": band_high,
        "snr_threshold_db": snr_threshold_db,
        "remove_doubling": remove_doubling,
        "half_power_ratio_threshold": half_power_ratio_threshold,
        "use_spatial_consensus": use_spatial_consensus,
        "neighbor_radius": neighbor_radius,
        "spatial_tolerance_fraction": spatial_tolerance_fraction,
        "use_autocorrelation_fallback": use_autocorrelation_fallback,
        "use_hann": use_hann,
    }


def _ex_vivo_preview_stages(
    features: dict[str, np.ndarray],
    params: FinalPipelineParams,
    pipeline_params: dict[str, Any],
) -> dict[str, np.ndarray]:
    roi = features["roi"].astype(bool)
    frequency = features["dominant_global_corrected"]
    raw_evidence = composite_evidence(features)
    smooth = masked_gaussian(raw_evidence, roi, float(params.EVIDENCE_GAUSSIAN_SIGMA))
    otsu = otsu_threshold(smooth, roi)
    threshold = evidence_threshold(smooth, roi, params, otsu)
    evidence = (smooth >= threshold) & roi
    bandpass = evidence & (frequency >= float(params.BAND_LO)) & (frequency <= float(params.BAND_HI))
    snr_mask = bandpass if params.SNR_THRESH_DB is None else bandpass & (features["global_snr_db"] >= float(params.SNR_THRESH_DB))
    despeckle_min_area = int(pipeline_params.get("EX_VIVO_DESPECKLE_MIN_AREA", params.MIN_TUFT_AREA))
    cleanup = remove_small_labels_from_mask(snr_mask, despeckle_min_area)
    return {
        "raw_evidence": raw_evidence,
        "gaussian_evidence": smooth,
        "evidence_mask": evidence,
        "bandpass": bandpass,
        "snr": snr_mask,
        "despeckle_1": cleanup,
        "flat_removed": np.zeros(roi.shape, dtype=bool),
        "flat_pruned": cleanup,
        "post_flat_despeckle": cleanup,
        "otsu_threshold": np.array(otsu, dtype=np.float32),
        "evidence_threshold": np.array(threshold, dtype=np.float32),
    }


def _final_params_from_preview(
    *,
    fps: float,
    frame_count: int,
    roi_mode: str,
    radius: int | None,
    square_width: int | None,
    roi_polygons: list[list[dict[str, float]]] | None,
    use_hann: bool,
    band_low: float,
    band_high: float,
    snr_threshold_db: float | None,
    remove_doubling: bool,
    half_power_ratio_threshold: float,
    use_spatial_consensus: bool,
    spatial_tolerance_fraction: float,
    use_autocorrelation_fallback: bool,
    pipeline_params: dict[str, Any],
) -> FinalPipelineParams:
    params = FinalPipelineParams()
    params.FPS = fps
    params.N_FRAMES = frame_count
    params.ROI_MODE = roi_mode
    params.RADIUS = radius
    params.SQUARE_WIDTH = square_width
    params.ROI_POLYGONS = roi_polygons
    params.USE_HANN = use_hann
    params.BAND_LO = band_low
    params.BAND_HI = band_high
    params.SNR_THRESH_DB = snr_threshold_db
    params.REMOVE_DOUBLING = remove_doubling
    params.HALF_POWER_RATIO_THRESH = half_power_ratio_threshold
    params.USE_SPATIAL_CONSENSUS = use_spatial_consensus
    params.SPATIAL_TOL_FRAC = spatial_tolerance_fraction
    params.USE_AUTOCORR_FALLBACK = use_autocorrelation_fallback
    for name, value in pipeline_params.items():
        if name.startswith("PREVIEW_"):
            continue
        if name in {"DO_TUFT_DETECTION", "DO_PHASE_ANALYSIS", "EX_VIVO_DESPECKLE_MIN_AREA"}:
            continue
        if not hasattr(params, name):
            raise ValueError(f"Unknown preview pipeline parameter: {name}")
        setattr(params, name, value)
    return params


def _heatmap_data_url(
    values: np.ndarray,
    visible_mask: np.ndarray,
    roi_mask: np.ndarray,
    minimum: float,
    maximum: float,
) -> str:
    scale = max(float(maximum) - float(minimum), 1e-6)
    normalized = np.clip((np.nan_to_num(values, nan=minimum) - minimum) / scale, 0.0, 1.0)
    colored = _colormap_rgb(normalized, "viridis")
    colored[roi_mask & ~visible_mask] = np.array([255, 255, 255], dtype=np.uint8)
    colored[~roi_mask] = np.array([28, 35, 40], dtype=np.uint8)
    image = Image.fromarray(colored, mode="RGB")
    image.thumbnail((900, 900), Image.Resampling.NEAREST)
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _evidence_data_url(values: np.ndarray, roi_mask: np.ndarray) -> str:
    normalized = np.clip(np.nan_to_num(values, nan=0.0), 0.0, 1.0)
    colored = _colormap_rgb(normalized, "magma")
    colored[~roi_mask] = np.array([255, 255, 255], dtype=np.uint8)
    image = Image.fromarray(colored, mode="RGB")
    image.thumbnail((900, 900), Image.Resampling.NEAREST)
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _label_data_url(labels: np.ndarray) -> str | None:
    if not np.any(labels > 0):
        return None
    normalized = np.zeros(labels.shape, dtype=np.uint8)
    positive = labels > 0
    normalized[positive] = ((labels[positive] * 47) % 254 + 1).astype(np.uint8)
    colored = _colormap_rgb(normalized.astype(np.float32) / 255.0, "turbo")
    colored[~positive] = np.array([255, 255, 255], dtype=np.uint8)
    return _rgb_png_data_url(colored)


def _mask_overlay_data_url(visible_mask: np.ndarray, roi_mask: np.ndarray) -> str:
    rgba = np.zeros((*visible_mask.shape, 4), dtype=np.uint8)
    rgba[roi_mask & ~visible_mask] = np.array([12, 18, 22, 190], dtype=np.uint8)
    rgba[~roi_mask] = np.array([12, 18, 22, 220], dtype=np.uint8)
    image = Image.fromarray(rgba, mode="RGBA")
    image.thumbnail((900, 900), Image.Resampling.NEAREST)
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _phase_data_url(phase_map: np.ndarray) -> str | None:
    visible = np.isfinite(phase_map)
    if not np.any(visible):
        return None
    return _rgb_png_data_url(_phase_rgb_array(phase_map))


def _phase_axis_data_url(labels: np.ndarray, rows: list[dict[str, Any]], params: FinalPipelineParams) -> str | None:
    if not np.any(labels > 0) or not rows:
        return None
    return _rgb_png_data_url(draw_tensor_axis_lines(axis_coherence_rgb(labels, rows), rows, params))


def _phase_rgb_array(phase_map: np.ndarray) -> np.ndarray:
    visible = np.isfinite(phase_map)
    normalized = np.mod((np.nan_to_num(phase_map) + np.pi) / (2.0 * np.pi), 1.0)
    colored = _colormap_rgb(normalized, "hsv")
    colored[~visible] = np.array([255, 255, 255], dtype=np.uint8)
    return colored


def _rgb_png_data_url(rgb: np.ndarray) -> str:
    image = Image.fromarray(rgb, mode="RGB")
    image.thumbnail((900, 900), Image.Resampling.NEAREST)
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _load_gray_frames_bounded(video_path: Path, frame_count: int) -> np.ndarray:
    reader = imageio.get_reader(str(video_path), format="FFMPEG")
    frames: list[np.ndarray] = []
    try:
        for frame in islice(reader, frame_count):
            frames.append(as_gray_frame(frame))
    finally:
        reader.close()
    if not frames:
        raise ValueError(f"No frames could be decoded from {video_path}")
    return np.stack(frames, axis=0)


def _as_rgb_uint8(frame: np.ndarray) -> np.ndarray:
    array = np.asarray(frame)
    if array.ndim == 2:
        return np.repeat(_normalize_display_uint8(array)[..., None], 3, axis=2)
    if array.ndim == 3 and array.shape[2] == 1:
        return np.repeat(_normalize_display_uint8(array[..., 0])[..., None], 3, axis=2)
    if array.ndim == 3 and array.shape[2] >= 3:
        return _normalize_display_uint8(array[..., :3])
    raise ValueError(f"Unsupported decoded frame shape: {array.shape}")


def _colormap_rgb(normalized: np.ndarray, name: str) -> np.ndarray:
    clipped = np.clip(normalized, 0.0, 1.0)
    if name == "hsv":
        flat = clipped.reshape(-1)
        return hsv_to_rgb(flat, np.full(flat.shape, 0.95), np.full(flat.shape, 0.95)).reshape((*clipped.shape, 3))
    return colormap_rgb(clipped, name)


def _normalize_display_uint8(array: np.ndarray) -> np.ndarray:
    values = np.asarray(array)
    if values.dtype == np.uint8:
        return values
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return np.zeros(values.shape, dtype=np.uint8)
    low = float(np.min(finite))
    high = float(np.max(finite))
    if high <= low:
        return np.zeros(values.shape, dtype=np.uint8)
    return np.round(np.clip((values.astype(np.float32) - low) / (high - low), 0.0, 1.0) * 255.0).astype(np.uint8)


def _roi_mask(
    height: int,
    width: int,
    roi_mode: str,
    radius: int | None,
    square_width: int | None,
) -> np.ndarray:
    if roi_mode == "full":
        return np.ones((height, width), dtype=bool)
    if roi_mode == "square":
        if square_width is None or square_width <= 0 or square_width > min(height, width):
            raise ValueError(f"Square width must be between 1 and {min(height, width)} pixels")
        roi = np.zeros((height, width), dtype=bool)
        y0 = (height - square_width) // 2
        x0 = (width - square_width) // 2
        roi[y0 : y0 + square_width, x0 : x0 + square_width] = True
        return roi
    if roi_mode != "circle":
        raise ValueError(f"Unsupported preview ROI mode: {roi_mode}")
    if radius is None or radius <= 0:
        raise ValueError("A positive radius is required for a circular ROI")
    if radius > min(height, width) // 2:
        raise ValueError(
            f"Circle radius {radius} exceeds the centered-frame maximum of {min(height, width) // 2} pixels"
        )
    y, x = np.ogrid[:height, :width]
    return (x - width // 2) ** 2 + (y - height // 2) ** 2 <= radius**2


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate bounded lightweight video setup previews.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    first = subparsers.add_parser("first-frame")
    first.add_argument("--video", required=True, type=Path)

    fft = subparsers.add_parser("fft")
    fft.add_argument("--video", required=True, type=Path)
    fft.add_argument("--fps", required=True, type=float)
    fft.add_argument("--frames", required=True, type=int)
    fft.add_argument("--roi-mode", required=True, choices=("circle", "square", "full", "custom"))
    fft.add_argument("--radius", type=int)
    fft.add_argument("--square-width", type=int)
    fft.add_argument("--roi-polygons-json", default="[]")
    fft.add_argument("--use-hann", action=argparse.BooleanOptionalAction, default=True)
    fft.add_argument("--band-low", required=True, type=float)
    fft.add_argument("--band-high", required=True, type=float)
    fft.add_argument("--snr-threshold-db", type=float)
    fft.add_argument("--remove-doubling", action=argparse.BooleanOptionalAction, default=True)
    fft.add_argument("--half-power-ratio-threshold", type=float, default=0.6)
    fft.add_argument("--use-spatial-consensus", action=argparse.BooleanOptionalAction, default=True)
    fft.add_argument("--neighbor-radius", type=int, default=2)
    fft.add_argument("--spatial-tolerance-fraction", type=float, default=0.25)
    fft.add_argument("--use-autocorrelation-fallback", action=argparse.BooleanOptionalAction, default=True)
    fft.add_argument("--pipeline-params-json", default="{}")
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] in {"first-frame", "video-loop"}:
        from media_preview import main as media_main

        return media_main(arguments)
    args = _build_parser().parse_args(arguments)
    try:
        if not args.video.is_file() or args.video.suffix.lower() not in VIDEO_EXTENSIONS:
            raise ValueError(f"Supported video file does not exist: {args.video} (accepted: {VIDEO_EXTENSIONS_DISPLAY})")
        if args.command == "first-frame":
            payload = first_frame_preview(args.video)
        else:
            payload = fft_preview(
                args.video,
                fps=args.fps,
                frame_count=args.frames,
                roi_mode=args.roi_mode,
                radius=args.radius,
                square_width=args.square_width,
                roi_polygons=json.loads(args.roi_polygons_json),
                use_hann=args.use_hann,
                band_low=args.band_low,
                band_high=args.band_high,
                snr_threshold_db=args.snr_threshold_db,
                remove_doubling=args.remove_doubling,
                half_power_ratio_threshold=args.half_power_ratio_threshold,
                use_spatial_consensus=args.use_spatial_consensus,
                neighbor_radius=args.neighbor_radius,
                spatial_tolerance_fraction=args.spatial_tolerance_fraction,
                use_autocorrelation_fallback=args.use_autocorrelation_fallback,
                pipeline_params=json.loads(args.pipeline_params_json),
            )
        sys.stdout.write(json.dumps(payload, ensure_ascii=True, allow_nan=False) + "\n")
        return 0
    except Exception as exc:
        sys.stderr.write(f"Preview failed: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

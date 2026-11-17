from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, fields
import csv
from itertools import islice
from pathlib import Path
import tempfile
from typing import Any, Callable

import imageio.v2 as imageio
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import fft, ndimage
from skimage.feature import peak_local_max
from skimage.segmentation import watershed


STRUCTURE_4 = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)
STRUCTURE_8 = np.ones((3, 3), dtype=bool)
DEFAULT_FFT_CHUNK_PIXELS = 8192
MAX_FFT_CHUNK_TEMP_BYTES = 96_000_000
VIDEO_EXTENSIONS = (".avi", ".mp4", ".mov", ".m4v", ".mkv", ".wmv", ".mpg", ".mpeg")
VIDEO_EXTENSIONS_DISPLAY = ", ".join(VIDEO_EXTENSIONS)


@dataclass
class FinalPipelineParams:
    FPS: float = 500.0
    N_FRAMES: int | str = 100
    ROI_MODE: str = "circle"
    RADIUS: int | None = 440
    SQUARE_WIDTH: int | None = 880
    ROI_POLYGONS: list[list[dict[str, float]]] | None = None
    BAND_LO: float = 5.0
    BAND_HI: float = 60.0
    USE_HANN: bool = True
    FFT_CHUNK_PIXELS: int = DEFAULT_FFT_CHUNK_PIXELS
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
    MIN_TUFT_AREA: int = 150
    MAX_TUFT_SIZE: int = 800
    FREQUENCY_CLUSTER_BIN_HZ: float = 15.0
    CLUSTER_GAP_CLOSING_ITERS: int = 4
    CLUSTER_HOLE_FILL_MAX_AREA: int = 100
    FLAT_LARGE_COMPONENT_AREA: int = 8000
    FLAT_TOL_HZ: float = 5.0
    FLAT_UNIFORM_SUBREGION_MIN_AREA: int = 4000
    FLAT_POST_PRUNE_MIN_AREA: int = 150
    WATERSHED_MIN_PEAK_DISTANCE_PX: int = 8
    WATERSHED_MIN_PEAK_RADIUS_PX: float = 4.0
    WATERSHED_DISTANCE_SIGMA: float = 1.0
    WATERSHED_MAX_RECURSIVE_SPLITS: int = 10
    PHASE_TENSOR_SMOOTH_SIGMA: float = 1.0
    COMPUTE_METACHRONAL_AXIS: bool = True
    COMPUTE_TUFT_STATS: bool = True
    KNN_NEIGHBORS: tuple[int, ...] = (5, 10)
    CBF_SIMILARITY_SCALE_HZ: float = 5.0
    PLOT_RAW_FFT: bool = True
    PLOT_RAW_PHASE: bool = True
    PLOT_GAUSSIAN_EVIDENCE: bool = False
    PLOT_TUFT_LABELS: bool = True
    PLOT_TUFT_PIXEL_CBF: bool = True
    PLOT_TUFT_DOMINANT_CBF: bool = True
    PLOT_TUFT_DOMINANT_CBF_WITH_AXIS: bool = True
    PLOT_TUFT_PHASE_AXIS: bool = True
    PLOT_TUFT_AXIS_COHERENCE: bool = True
    SAVE_BATCH_SUMMARY: bool = True
    SAVE_TUFT_TABLE: bool = True
    OUTPUT_DPI: int = 600
    RAW_FREQUENCY_MIN_HZ: float = 5.0
    RAW_FREQUENCY_MAX_HZ: float = 60.0
    RAW_FREQUENCY_COLORMAP: str = "viridis"
    AXIS_LINE_MIN_WIDTH_PX: int = 1
    AXIS_LINE_MAX_WIDTH_PX: int = 5


SUMMARY_COLUMNS = [
    "video_file",
    "tag",
    "status",
    "error",
    "tuft_count",
    "tuft_area_mean_px",
    "tuft_area_std_px",
    "pixel_mean_cbf_mean_hz",
    "pixel_mean_cbf_std_hz",
    "joint_peak_cbf_mean_hz",
    "joint_peak_cbf_std_hz",
    "tensor_axis_circular_mean_deg",
    "tensor_axis_circular_std_deg",
    "tensor_coherence_mean",
    "tensor_coherence_std",
]

KNN_SUMMARY_SUFFIXES = [
    "cbf_mean_abs_diff_hz",
    "cbf_std_abs_diff_hz",
    "cbf_exp_similarity",
    "angle_mean_axial_agreement",
    "angle_std_axial_agreement",
    "angle_coherence_weighted_axial_agreement",
]

TUFT_COLUMNS = [
    "video_file",
    "tag",
    "tuft_id",
    "centroid_x",
    "centroid_y",
    "area_px",
    "joint_spectral_cbf_hz",
    "joint_peak_fwhm_hz",
    "joint_power_weighted_std_hz",
    "pixel_dominant_cbf_mean_hz",
    "pixel_dominant_cbf_std_hz",
    "phase_tensor_axis_deg",
    "phase_tensor_coherence",
]


ProgressCallback = Callable[[str, str], None]
IGNORED_COMPATIBILITY_PARAMS = {"H_EXPECT", "W_EXPECT", "SAVE_TUFT_SPECTRA"}


def build_pipeline_params(overrides: dict[str, Any]) -> FinalPipelineParams:
    allowed = {field.name for field in fields(FinalPipelineParams)}
    filtered = {key: value for key, value in overrides.items() if key not in IGNORED_COMPATIBILITY_PARAMS}
    unknown = sorted(set(filtered) - allowed)
    if unknown:
        raise ValueError(f"Unknown final workflow parameter(s): {', '.join(unknown)}")
    params = FinalPipelineParams()
    for name, value in filtered.items():
        if name == "KNN_NEIGHBORS" and isinstance(value, list):
            value = tuple(int(item) for item in value)
        setattr(params, name, value)
    if "RAW_FREQUENCY_MIN_HZ" not in filtered:
        params.RAW_FREQUENCY_MIN_HZ = float(params.BAND_LO)
    if "RAW_FREQUENCY_MAX_HZ" not in filtered:
        params.RAW_FREQUENCY_MAX_HZ = float(params.BAND_HI)
    if any(int(item) <= 0 for item in params.KNN_NEIGHBORS):
        raise ValueError("KNN_NEIGHBORS must contain positive integers.")
    if isinstance(params.FFT_CHUNK_PIXELS, bool) or not isinstance(params.FFT_CHUNK_PIXELS, int) or not 256 <= params.FFT_CHUNK_PIXELS <= 32768:
        raise ValueError("FFT_CHUNK_PIXELS must be a whole number from 256 to 32768.")
    normalize_frame_count_selection(params.N_FRAMES)
    return params


def serializable_pipeline_params(params: FinalPipelineParams) -> dict[str, Any]:
    result = {field.name: getattr(params, field.name) for field in fields(params)}
    result["KNN_NEIGHBORS"] = list(params.KNN_NEIGHBORS)
    return result


def summary_columns_for_params(params: FinalPipelineParams) -> list[str]:
    columns = list(SUMMARY_COLUMNS)
    for k_value in params.KNN_NEIGHBORS:
        prefix = f"knn{int(k_value)}"
        columns.extend(f"{prefix}_{suffix}" for suffix in KNN_SUMMARY_SUFFIXES)
    return list(dict.fromkeys(columns))


def process_one_video(
    video_path: Path,
    output_root: Path,
    params: FinalPipelineParams,
    *,
    progress_callback: ProgressCallback | None = None,
    summary_output_columns: list[str] | None = None,
    tuft_output_columns: list[str] | None = None,
    output_tag: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    tag = output_tag or _safe_tag(video_path)
    video_dir = output_root / tag
    video_dir.mkdir(parents=True, exist_ok=True)
    selection = normalize_frame_count_selection(params.N_FRAMES)
    frame_description = "all video frames" if selection is None else f"up to {selection} video frames"
    _stage(progress_callback, "load_video", f"Decoding {frame_description} to temporary disk storage")
    with open_gray_frames_disk_backed(video_path, params.N_FRAMES, video_dir) as frames:
        return _process_loaded_video(
            video_path,
            video_dir,
            tag,
            frames,
            params,
            progress_callback,
            summary_output_columns,
            tuft_output_columns,
        )


def _process_loaded_video(
    video_path: Path,
    video_dir: Path,
    tag: str,
    frames: np.ndarray,
    params: FinalPipelineParams,
    progress_callback: ProgressCallback | None,
    summary_output_columns: list[str] | None,
    tuft_output_columns: list[str] | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    _stage(progress_callback, "fft", "Running per-pixel FFT and frequency correction")
    features = compute_fft_features(frames, params)
    _stage(progress_callback, "foreground", "Building Gaussian evidence foreground")
    stages = build_foreground_stages(features, params)
    _stage(progress_callback, "tuft_segmentation", "Building repaired frequency clusters and watershed tufts")
    cluster_labels = build_repaired_clusters(stages["post_flat_despeckle"], features["dominant_global_corrected"], params)
    tuft_labels = build_tuft_labels(cluster_labels, params)

    rows: list[dict[str, Any]] = []
    phase_map = np.full(tuft_labels.shape, np.nan, dtype=np.float32)
    raw_phase = features["raw_phase_at_dominant"]
    if params.COMPUTE_TUFT_STATS or params.COMPUTE_METACHRONAL_AXIS:
        _stage(progress_callback, "tuft_metrics", "Computing per-tuft CBF and phase tensor metrics")
        rows, phase_map = compute_tuft_metrics(video_path, frames, features, tuft_labels, params)
    summary = video_summary(video_path, tag, rows, params)
    summary["video_file"] = str(video_path)
    summary["tag"] = tag
    summary["status"] = "OK"
    summary["error"] = ""
    summary["frames_processed"] = int(frames.shape[0])
    for row in rows:
        row["video_file"] = str(video_path)
        row["tag"] = tag

    if rows and params.SAVE_TUFT_TABLE:
        columns = TUFT_COLUMNS if tuft_output_columns is None else tuft_output_columns
        write_csv(video_dir / f"{tag}__tuft_table.csv", rows, columns)
    if params.SAVE_BATCH_SUMMARY:
        write_csv(
            video_dir / f"{tag}__video_summary.csv",
            [summary],
            summary_columns_for_params(params) if summary_output_columns is None else summary_output_columns,
        )
    _stage(progress_callback, "plots", "Rendering selected diagnostic plots")
    make_plots(video_dir, video_path, features, stages, tuft_labels, rows, phase_map, raw_phase, params)
    return summary, rows


def normalize_frame_count_selection(value: int | str) -> int | None:
    if isinstance(value, str) and value.lower() == "all":
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 4:
        raise ValueError("N_FRAMES must be 'all' or a whole number of at least four.")
    return value


@contextmanager
def open_gray_frames_disk_backed(
    video_path: Path,
    frame_count: int | str,
    temporary_directory: Path,
):
    """Decode sequentially and expose the frame stack without retaining it in RAM."""
    limit = normalize_frame_count_selection(frame_count)
    temporary_directory.mkdir(parents=True, exist_ok=True)
    temporary_file = tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=".tufft_frames_",
        suffix=".bin",
        dir=temporary_directory,
        delete=False,
    )
    temporary_path = Path(temporary_file.name)
    reader = None
    decoded_count = 0
    frame_shape: tuple[int, int] | None = None
    frame_dtype: np.dtype | None = None
    mapped: np.memmap | None = None
    try:
        reader = imageio.get_reader(str(video_path), format="FFMPEG")
        source = reader if limit is None else islice(reader, limit)
        with temporary_file:
            for decoded in source:
                gray = np.ascontiguousarray(as_gray_frame(decoded))
                if frame_shape is None:
                    frame_shape = gray.shape
                    frame_dtype = gray.dtype
                elif gray.shape != frame_shape:
                    raise ValueError(
                        f"Decoded frame dimensions changed from {frame_shape} to {gray.shape}: {video_path}"
                    )
                if gray.dtype != frame_dtype:
                    gray = gray.astype(frame_dtype, copy=False)
                temporary_file.write(gray.tobytes(order="C"))
                decoded_count += 1
        if decoded_count < 4 or frame_shape is None or frame_dtype is None:
            raise ValueError(f"At least four frames are required: {video_path}")
        mapped = np.memmap(
            temporary_path,
            dtype=frame_dtype,
            mode="r",
            shape=(decoded_count, *frame_shape),
        )
        yield mapped
    finally:
        if reader is not None:
            reader.close()
        if not temporary_file.closed:
            temporary_file.close()
        if mapped is not None:
            mapped._mmap.close()
        temporary_path.unlink(missing_ok=True)


def load_gray_frames_bounded(video_path: Path, frame_count: int) -> np.ndarray:
    if frame_count < 4:
        raise ValueError("At least four frames are required for the desktop workflow.")
    reader = imageio.get_reader(str(video_path), format="FFMPEG")
    frames: list[np.ndarray] = []
    try:
        for frame in islice(reader, frame_count):
            frames.append(as_gray_frame(frame))
    finally:
        reader.close()
    if len(frames) < 4:
        raise ValueError(f"At least four frames are required: {video_path}")
    return np.stack(frames, axis=0)


def roi_mask(shape: tuple[int, int], params: FinalPipelineParams) -> np.ndarray:
    height, width = shape
    mode = str(params.ROI_MODE).lower()
    if mode == "full":
        return np.ones((height, width), dtype=bool)
    if mode == "custom":
        polygons = params.ROI_POLYGONS or []
        if not polygons:
            raise ValueError("Custom ROI mode requires at least one polygon.")
        image = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(image)
        for polygon in polygons:
            points = [(float(point["x"]), float(point["y"])) for point in polygon if "x" in point and "y" in point]
            if len(points) >= 3:
                draw.polygon(points, fill=255)
        mask = np.asarray(image, dtype=np.uint8) > 0
        if not np.any(mask):
            raise ValueError("The custom ROI polygons produce an empty mask.")
        return mask
    if mode == "square":
        square_width = int(params.SQUARE_WIDTH or 0)
        if square_width <= 0 or square_width > min(height, width):
            raise ValueError(f"Square width must be between 1 and {min(height, width)} pixels.")
        mask = np.zeros((height, width), dtype=bool)
        y0 = (height - square_width) // 2
        x0 = (width - square_width) // 2
        mask[y0 : y0 + square_width, x0 : x0 + square_width] = True
        return mask
    if mode != "circle":
        raise ValueError(f"Unsupported ROI mode: {params.ROI_MODE!r}")
    radius = int(params.RADIUS or 0)
    if radius <= 0 or radius > min(height, width) // 2:
        raise ValueError(f"Circle radius must be between 1 and {min(height, width) // 2} pixels.")
    yy, xx = np.ogrid[:height, :width]
    return (xx - (width - 1) / 2.0) ** 2 + (yy - (height - 1) / 2.0) ** 2 <= radius**2


def compute_fft_features(frames: np.ndarray, params: FinalPipelineParams) -> dict[str, np.ndarray]:
    frame_count, height, width = frames.shape
    roi = roi_mask((height, width), params)
    indices = np.flatnonzero(roi.ravel())
    flat_frames = frames.reshape(frame_count, -1)
    intensity_scale = frame_intensity_scale(frames)
    freqs = fft.rfftfreq(frame_count, d=1.0 / float(params.FPS)).astype(np.float32)
    positive = freqs > 0
    pos_freqs = freqs[positive]
    pos_indices = np.flatnonzero(positive)
    cilia_band = positive & (freqs >= 5.0) & (freqs <= 80.0)
    cilia_indices = np.flatnonzero(cilia_band)
    if cilia_indices.size == 0:
        raise ValueError(
            "The selected frame rate and frame count provide no non-DC FFT bins in the internal 5-80 Hz cilia evidence band. Increase the frame count or use a higher frame-rate video."
        )
    collected = {name: np.full(height * width, np.nan, dtype=np.float32) for name in (
        "temporal_variance", "dominant_global", "dominant_band", "global_snr_db",
        "global_peak_concentration", "spectral_entropy", "autocorrelation_peak",
        "autocorrelation_frequency", "band_to_outside_db", "half_peak_ratio",
        "raw_phase_at_dominant", "raw_phase_at_half",
    )}
    half_candidate = np.zeros(height * width, dtype=bool)
    power_sum = np.zeros(pos_freqs.shape, dtype=np.float64)
    window = np.hanning(frame_count).astype(np.float32)[:, None] if params.USE_HANN else None
    chunk_size = fft_chunk_pixels(frame_count, int(params.FFT_CHUNK_PIXELS))
    for start in range(0, indices.size, chunk_size):
        chunk = indices[start : start + chunk_size]
        traces = normalized_trace_chunk(flat_frames, chunk, intensity_scale)
        traces -= traces.mean(axis=0, keepdims=True)
        temporal_variance = np.mean(traces * traces, axis=0)
        transformed = fft.rfft(traces * window, axis=0, workers=1) if window is not None else fft.rfft(traces, axis=0, workers=1)
        magnitude = np.abs(transformed).astype(np.float32)
        power = magnitude * magnitude
        positive_power = power[positive]
        power_sum += positive_power.sum(axis=1, dtype=np.float64)
        total_power = positive_power.sum(axis=0) + np.finfo(np.float32).tiny
        columns = np.arange(chunk.size)
        global_indices = pos_indices[np.argmax(positive_power, axis=0)]
        band_power = power[cilia_band]
        band_indices = cilia_indices[np.argmax(band_power, axis=0)]
        global_peak = power[global_indices, columns]
        median_power = np.median(positive_power, axis=0)
        summed_band_power = band_power.sum(axis=0)
        outside_power = np.maximum(total_power - summed_band_power, np.finfo(np.float32).tiny)
        probabilities = positive_power / total_power
        entropy = -np.sum(probabilities * np.log(probabilities + np.finfo(np.float32).tiny), axis=0)
        entropy /= np.log(max(2, positive_power.shape[0]))
        autocorrelation = fft.irfft(power, n=frame_count, axis=0, workers=1)
        autocorrelation /= np.maximum(autocorrelation[0:1], np.finfo(np.float32).tiny)
        lag_min = max(1, int(np.floor(float(params.FPS) / 80.0)))
        lag_max = min(frame_count - 1, int(np.ceil(float(params.FPS) / 5.0)))
        periodic = autocorrelation[lag_min : lag_max + 1]
        periodic_lags = lag_min + np.argmax(periodic, axis=0)
        half_indices = np.maximum(1, global_indices // 2)
        peak_window = _windowed(magnitude, global_indices, columns)
        half_window = _windowed(magnitude, half_indices, columns)
        half_ratio = half_window / np.maximum(peak_window, np.finfo(np.float32).tiny)
        collected["temporal_variance"][chunk] = temporal_variance
        collected["dominant_global"][chunk] = freqs[global_indices]
        collected["dominant_band"][chunk] = freqs[band_indices]
        collected["global_snr_db"][chunk] = 10.0 * (np.log10(global_peak + 1e-12) - np.log10(median_power + 1e-12))
        collected["global_peak_concentration"][chunk] = _peak_concentration(power, global_indices, total_power)
        collected["spectral_entropy"][chunk] = entropy
        collected["autocorrelation_peak"][chunk] = np.max(periodic, axis=0)
        collected["autocorrelation_frequency"][chunk] = float(params.FPS) / periodic_lags.astype(np.float32)
        collected["band_to_outside_db"][chunk] = 10.0 * (np.log10(summed_band_power + 1e-12) - np.log10(outside_power + 1e-12))
        collected["half_peak_ratio"][chunk] = half_ratio
        collected["raw_phase_at_dominant"][chunk] = np.angle(transformed[global_indices, columns]).astype(np.float32)
        collected["raw_phase_at_half"][chunk] = np.angle(transformed[half_indices, columns]).astype(np.float32)
        half_candidate[chunk] = half_ratio >= float(params.HALF_POWER_RATIO_THRESH)

    maps = {name: values.reshape(height, width) for name, values in collected.items()}
    corrected, halved = correct_frequency_doubling(maps, roi, params)
    maps["dominant_global_corrected"] = corrected
    maps["frequency_halved"] = halved
    raw_phase = np.where(halved, maps["raw_phase_at_half"], maps["raw_phase_at_dominant"])
    raw_phase[~roi] = np.nan
    maps["raw_phase_at_dominant"] = raw_phase.astype(np.float32)
    maps["roi"] = roi
    maps["frequencies_non_dc"] = pos_freqs
    maps["mean_power_spectrum"] = (power_sum / max(1, indices.size)).astype(np.float32)
    maps["representative_frame"] = frames[0]
    return maps


def correct_frequency_doubling(maps: dict[str, np.ndarray], roi: np.ndarray, params: FinalPipelineParams) -> tuple[np.ndarray, np.ndarray]:
    raw = maps["dominant_global"]
    candidate = roi & (maps["half_peak_ratio"] >= float(params.HALF_POWER_RATIO_THRESH))
    if bool(params.USE_SPATIAL_CONSENSUS):
        filled = np.where(roi, raw, 0.0).astype(np.float32)
        median = ndimage.median_filter(filled, size=5, mode="nearest")
        tolerance = float(params.SPATIAL_TOL_FRAC) * np.maximum(1.0, median)
        candidate &= np.abs(raw - 2.0 * median) <= tolerance
    corrected = raw.copy()
    corrected[candidate] *= 0.5
    if bool(params.USE_AUTOCORR_FALLBACK):
        autocorr = maps["autocorrelation_frequency"]
        keep_halved = np.abs(autocorr - corrected) <= 0.15 * np.maximum(1.0, autocorr)
        prefer_raw = np.abs(autocorr - raw) < np.abs(autocorr - corrected)
        revert = candidate & prefer_raw & ~keep_halved
        corrected[revert] = raw[revert]
        candidate[revert] = False
    corrected[~roi] = np.nan
    return corrected.astype(np.float32), candidate


def build_foreground_stages(features: dict[str, np.ndarray], params: FinalPipelineParams) -> dict[str, np.ndarray]:
    roi = features["roi"].astype(bool)
    frequency = features["dominant_global_corrected"]
    raw_evidence = composite_evidence(features)
    smooth = masked_gaussian(raw_evidence, roi, float(params.EVIDENCE_GAUSSIAN_SIGMA))
    otsu = otsu_threshold(smooth, roi)
    threshold = evidence_threshold(smooth, roi, params, otsu)
    evidence = (smooth >= threshold) & roi
    bandpass = evidence & (frequency >= float(params.BAND_LO)) & (frequency <= float(params.BAND_HI))
    snr_mask = bandpass if params.SNR_THRESH_DB is None else bandpass & (features["global_snr_db"] >= float(params.SNR_THRESH_DB))
    despeckled = remove_small_labels_from_mask(snr_mask, int(params.MIN_TUFT_AREA))
    flat_pruned, flat_removed = flat_frequency_prune(despeckled, frequency, params)
    post_flat = remove_small_labels_from_mask(flat_pruned, int(params.FLAT_POST_PRUNE_MIN_AREA))
    return {
        "raw_evidence": raw_evidence,
        "gaussian_evidence": smooth,
        "evidence_mask": evidence,
        "bandpass": bandpass,
        "snr": snr_mask,
        "despeckle_1": despeckled,
        "flat_removed": flat_removed,
        "flat_pruned": flat_pruned,
        "post_flat_despeckle": post_flat,
        "otsu_threshold": np.array(otsu, dtype=np.float32),
        "evidence_threshold": np.array(threshold, dtype=np.float32),
    }


def composite_evidence(features: dict[str, np.ndarray]) -> np.ndarray:
    roi = features["roi"].astype(bool)
    specs = [
        ("global_snr_db", 0.25, False),
        ("global_peak_concentration", 0.20, False),
        ("spectral_entropy", 0.20, True),
        ("autocorrelation_peak", 0.15, False),
        ("band_to_outside_db", 0.12, False),
        ("temporal_variance", 0.08, False),
    ]
    output = np.zeros(roi.shape, dtype=np.float32)
    total = 0.0
    for name, weight, invert in specs:
        output += float(weight) * robust_unit(features[name], roi, invert=invert)
        total += float(weight)
    output /= max(total, 1e-6)
    output[~roi] = 0.0
    return output.astype(np.float32)


def evidence_threshold(smooth: np.ndarray, roi: np.ndarray, params: FinalPipelineParams, otsu: float | None = None) -> float:
    mode = str(getattr(params, "EVIDENCE_THRESHOLD_MODE", "otsu")).lower()
    if mode == "manual":
        return float(np.clip(float(params.EVIDENCE_MANUAL_THRESHOLD), 0.0, 1.0))
    if mode != "otsu":
        raise ValueError("EVIDENCE_THRESHOLD_MODE must be 'otsu' or 'manual'.")
    if otsu is None:
        otsu = otsu_threshold(smooth, roi)
    return float(np.clip(float(params.EVIDENCE_OTSU_COEFFICIENT) * float(otsu), 0.0, 1.0))


def build_repaired_clusters(mask: np.ndarray, frequency: np.ndarray, params: FinalPipelineParams) -> np.ndarray:
    raw = frequency_bin_clusters(mask, frequency, float(params.FREQUENCY_CLUSTER_BIN_HZ), int(params.MIN_TUFT_AREA))
    closed = unique_repair(raw, mask, lambda component: close_component(component, int(params.CLUSTER_GAP_CLOSING_ITERS)))
    filled = unique_repair(closed, mask, lambda component: fill_holes_limited(component, int(params.CLUSTER_HOLE_FILL_MAX_AREA)))
    return relabel(filled)


def build_tuft_labels(cluster_labels: np.ndarray, params: FinalPipelineParams) -> np.ndarray:
    masks: list[np.ndarray] = []
    for label_id in np.unique(cluster_labels):
        if int(label_id) == 0:
            continue
        component = cluster_labels == int(label_id)
        children = recursive_split(component, params)
        masks.extend(children)
    labels = np.zeros(cluster_labels.shape, dtype=np.int32)
    for index, mask in enumerate(masks, start=1):
        labels[mask & (labels == 0)] = index
    return remove_small_labels(labels, int(params.MIN_TUFT_AREA))


def recursive_split(mask: np.ndarray, params: FinalPipelineParams, depth: int = 0) -> list[np.ndarray]:
    if int(mask.sum()) <= int(params.MAX_TUFT_SIZE) or depth >= int(params.WATERSHED_MAX_RECURSIVE_SPLITS):
        return [mask]
    children = watershed_once(mask, params)
    if not children:
        return [mask]
    result: list[np.ndarray] = []
    for child in children:
        result.extend(recursive_split(child, params, depth + 1))
    return result


def watershed_once(mask: np.ndarray, params: FinalPipelineParams) -> list[np.ndarray] | None:
    distance = ndimage.distance_transform_edt(mask)
    sigma = float(params.WATERSHED_DISTANCE_SIGMA)
    if sigma > 0:
        distance = ndimage.gaussian_filter(distance, sigma=sigma)
    coordinates = peak_local_max(
        distance,
        labels=mask,
        min_distance=int(params.WATERSHED_MIN_PEAK_DISTANCE_PX),
        threshold_abs=float(params.WATERSHED_MIN_PEAK_RADIUS_PX),
        exclude_border=False,
    )
    if coordinates.shape[0] < 2:
        return None
    markers = np.zeros(mask.shape, dtype=np.int32)
    for index, (y, x) in enumerate(coordinates, start=1):
        markers[int(y), int(x)] = index
    split = watershed(-distance, markers, mask=mask)
    children = [split == int(label_id) for label_id in np.unique(split) if int(label_id) and int(np.sum(split == int(label_id))) >= int(params.MIN_TUFT_AREA)]
    return children if len(children) >= 2 else None


def compute_tuft_metrics(
    video_path: Path,
    frames: np.ndarray,
    features: dict[str, np.ndarray],
    labels: np.ndarray,
    params: FinalPipelineParams,
) -> tuple[list[dict[str, Any]], np.ndarray]:
    if int(np.max(labels)) == 0:
        return [], np.full(labels.shape, np.nan, dtype=np.float32)
    frame_count = frames.shape[0]
    frequencies = fft.rfftfreq(frame_count, d=1.0 / float(params.FPS)).astype(np.float32)[1:]
    tuft_indices = np.flatnonzero(labels.ravel() > 0)
    tuft_ids = labels.ravel()[tuft_indices].astype(np.int32)
    power_by_tuft = np.zeros((int(np.max(labels)) + 1, frequencies.size), dtype=np.float64)
    flat_frames = frames.reshape(frame_count, -1)
    intensity_scale = frame_intensity_scale(frames)
    window = np.hanning(frame_count).astype(np.float32)[:, None] if params.USE_HANN else None
    chunk_size = fft_chunk_pixels(frame_count, int(params.FFT_CHUNK_PIXELS))
    for start in range(0, tuft_indices.size, chunk_size):
        indices = tuft_indices[start : start + chunk_size]
        ids = tuft_ids[start : start + chunk_size]
        traces = normalized_trace_chunk(flat_frames, indices, intensity_scale)
        traces -= traces.mean(axis=0, keepdims=True)
        transformed = fft.rfft(traces * window, axis=0, workers=1) if window is not None else fft.rfft(traces, axis=0, workers=1)
        power = np.abs(transformed[1:]) ** 2
        for label_id in np.unique(ids):
            power_by_tuft[int(label_id)] += power[:, ids == int(label_id)].sum(axis=1)
    band = (frequencies >= float(params.BAND_LO)) & (frequencies <= float(params.BAND_HI))
    band_freq = frequencies[band]
    dominant = features["dominant_global_corrected"]
    peak_indices: dict[int, int] = {}
    rows: list[dict[str, Any]] = []
    for label_id in range(1, int(np.max(labels)) + 1):
        mask = labels == label_id
        if not np.any(mask):
            continue
        ys, xs = np.nonzero(mask)
        power = power_by_tuft[label_id, band]
        if power.size and float(np.max(power)) > 0:
            peak_band_index = int(np.argmax(power))
            non_dc_peak_index = int(np.flatnonzero(band)[peak_band_index])
            peak_indices[label_id] = non_dc_peak_index
            joint_cbf = float(band_freq[peak_band_index])
            fwhm = fwhm_hz(band_freq, power, peak_band_index)
            weighted_std = weighted_std_hz(band_freq, power)
        else:
            joint_cbf = fwhm = weighted_std = float("nan")
        values = dominant[mask]
        values = values[np.isfinite(values)]
        rows.append({
            "tuft_id": int(label_id),
            "centroid_x": float(np.mean(xs)),
            "centroid_y": float(np.mean(ys)),
            "area_px": int(mask.sum()),
            "joint_spectral_cbf_hz": joint_cbf,
            "joint_peak_fwhm_hz": fwhm,
            "joint_power_weighted_std_hz": weighted_std,
            "pixel_dominant_cbf_mean_hz": float(np.mean(values)) if values.size else float("nan"),
            "pixel_dominant_cbf_std_hz": float(np.std(values)) if values.size else float("nan"),
            "phase_tensor_axis_deg": float("nan"),
            "phase_tensor_coherence": float("nan"),
        })
    phase_map = phase_map_at_tuft_peaks(labels, peak_indices, frames, tuft_indices, tuft_ids, params)
    if params.COMPUTE_METACHRONAL_AXIS:
        add_tensor_metrics(rows, labels, phase_map, params)
    return rows, phase_map


def phase_map_at_tuft_peaks(labels: np.ndarray, peak_indices: dict[int, int], frames: np.ndarray, tuft_indices: np.ndarray, tuft_ids: np.ndarray, params: FinalPipelineParams) -> np.ndarray:
    phase_map = np.full(labels.shape, np.nan, dtype=np.float32)
    flat_phase = phase_map.ravel()
    frame_count = frames.shape[0]
    flat_frames = frames.reshape(frame_count, -1)
    intensity_scale = frame_intensity_scale(frames)
    window = np.hanning(frame_count).astype(np.float32)[:, None] if params.USE_HANN else None
    chunk_size = fft_chunk_pixels(frame_count, int(params.FFT_CHUNK_PIXELS))
    for start in range(0, tuft_indices.size, chunk_size):
        indices = tuft_indices[start : start + chunk_size]
        ids = tuft_ids[start : start + chunk_size]
        peak_for_pixel = np.array([peak_indices.get(int(label_id), -1) for label_id in ids], dtype=np.int32)
        valid = peak_for_pixel >= 0
        if not np.any(valid):
            continue
        traces = normalized_trace_chunk(flat_frames, indices, intensity_scale)
        traces -= traces.mean(axis=0, keepdims=True)
        transformed = fft.rfft(traces * window, axis=0, workers=1) if window is not None else fft.rfft(traces, axis=0, workers=1)
        selected = transformed[1:][peak_for_pixel[valid], np.flatnonzero(valid)]
        flat_phase[indices[valid]] = np.angle(selected).astype(np.float32)
    return phase_map


def add_tensor_metrics(rows: list[dict[str, Any]], labels: np.ndarray, phase_map: np.ndarray, params: FinalPipelineParams) -> None:
    for row in rows:
        label_id = int(row["tuft_id"])
        mask = labels == label_id
        ys, xs = np.nonzero(mask)
        if ys.size < 3:
            row["phase_tensor_axis_deg"] = float("nan")
            row["phase_tensor_coherence"] = 0.0
            continue
        y0, y1 = max(0, int(ys.min()) - 3), min(labels.shape[0], int(ys.max()) + 4)
        x0, x1 = max(0, int(xs.min()) - 3), min(labels.shape[1], int(xs.max()) + 4)
        tensor = tensor_direction(phase_map[y0:y1, x0:x1], mask[y0:y1, x0:x1], float(params.PHASE_TENSOR_SMOOTH_SIGMA))
        row["phase_tensor_axis_deg"] = tensor["axis_deg"]
        row["phase_tensor_coherence"] = tensor["coherence"]


def tensor_direction(phase_crop: np.ndarray, mask: np.ndarray, sigma: float) -> dict[str, float]:
    valid = mask & np.isfinite(phase_crop)
    z = np.zeros(phase_crop.shape, dtype=np.complex64)
    z[valid] = np.exp(1j * phase_crop[valid])
    weight = valid.astype(np.float32)
    real = ndimage.gaussian_filter(z.real, sigma=sigma)
    imag = ndimage.gaussian_filter(z.imag, sigma=sigma)
    smooth_weight = ndimage.gaussian_filter(weight, sigma=sigma)
    smoothed = np.divide(real + 1j * imag, np.maximum(smooth_weight, 1e-6), out=np.zeros_like(z), where=smooth_weight > 1e-6)
    magnitude = np.abs(smoothed)
    z = np.divide(smoothed, np.maximum(magnitude, 1e-6), out=np.zeros_like(smoothed), where=magnitude > 1e-6)
    dz_dy, dz_dx = np.gradient(z)
    gx = np.imag(np.conj(z) * dz_dx)
    gy = np.imag(np.conj(z) * dz_dy)
    keep = valid & (np.hypot(gx, gy) > 1e-6)
    if int(keep.sum()) < 3:
        return {"axis_deg": float("nan"), "coherence": 0.0}
    vx = gx[keep].astype(np.float64)
    vy = gy[keep].astype(np.float64)
    jxx = float(np.sum(vx * vx))
    jxy = float(np.sum(vx * vy))
    jyy = float(np.sum(vy * vy))
    angle = 0.5 * float(np.arctan2(2.0 * jxy, jxx - jyy))
    trace = jxx + jyy
    delta = float(np.sqrt((jxx - jyy) ** 2 + 4.0 * jxy * jxy))
    return {"axis_deg": float((np.degrees(angle) + 180.0) % 180.0), "coherence": float(np.clip(delta / max(trace, 1e-6), 0.0, 1.0))}


def video_summary(video_path: Path, tag: str, rows: list[dict[str, Any]], params: FinalPipelineParams) -> dict[str, Any]:
    area = np.array([row["area_px"] for row in rows], dtype=np.float32)
    cbf_mean = np.array([row["pixel_dominant_cbf_mean_hz"] for row in rows], dtype=np.float32)
    cbf_joint = np.array([row["joint_spectral_cbf_hz"] for row in rows], dtype=np.float32)
    angle = np.array([row["phase_tensor_axis_deg"] for row in rows], dtype=np.float32)
    coherence = np.array([row["phase_tensor_coherence"] for row in rows], dtype=np.float32)
    angle_mean, angle_std = axis_circular_summary(angle)
    summary: dict[str, Any] = {
        "tuft_count": int(len(rows)),
        "tuft_area_mean_px": float(np.nanmean(area)) if area.size else float("nan"),
        "tuft_area_std_px": float(np.nanstd(area)) if area.size else float("nan"),
        "pixel_mean_cbf_mean_hz": float(np.nanmean(cbf_mean)) if cbf_mean.size else float("nan"),
        "pixel_mean_cbf_std_hz": float(np.nanstd(cbf_mean)) if cbf_mean.size else float("nan"),
        "joint_peak_cbf_mean_hz": float(np.nanmean(cbf_joint)) if cbf_joint.size else float("nan"),
        "joint_peak_cbf_std_hz": float(np.nanstd(cbf_joint)) if cbf_joint.size else float("nan"),
        "tensor_axis_circular_mean_deg": angle_mean,
        "tensor_axis_circular_std_deg": angle_std,
        "tensor_coherence_mean": float(np.nanmean(coherence)) if coherence.size else float("nan"),
        "tensor_coherence_std": float(np.nanstd(coherence)) if coherence.size else float("nan"),
    }
    summary.update(spatial_neighbor_metrics(rows, params))
    return summary


def make_plots(out_dir: Path, video_path: Path, features: dict[str, np.ndarray], stages: dict[str, np.ndarray], labels: np.ndarray, rows: list[dict[str, Any]], phase_map: np.ndarray, raw_phase: np.ndarray, params: FinalPipelineParams) -> None:
    tag = _safe_tag(video_path)
    roi = features["roi"].astype(bool)
    frequency = features["dominant_global_corrected"]
    tuft_mask = labels > 0
    if params.PLOT_RAW_FFT:
        save_plot(out_dir / "01_raw_fft_cbf_full_roi.png", f"{tag} - raw dominant FFT CBF, full ROI", scalar_rgb(frequency, roi, params.RAW_FREQUENCY_MIN_HZ, params.RAW_FREQUENCY_MAX_HZ, params.RAW_FREQUENCY_COLORMAP), params, colorbar=("CBF, Hz", params.RAW_FREQUENCY_MIN_HZ, params.RAW_FREQUENCY_MAX_HZ), colorbar_cmap=params.RAW_FREQUENCY_COLORMAP)
    if params.PLOT_RAW_PHASE:
        save_plot(out_dir / "02_raw_phase_full_roi.png", f"{tag} - raw phase at each pixel's dominant frequency, full ROI", phase_rgb(raw_phase, roi), params, phasebar="phase, radians")
    if params.PLOT_GAUSSIAN_EVIDENCE:
        save_plot(out_dir / "02a_gaussian_evidence_heatmap.png", f"{tag} - Gaussian evidence for background thresholding", scalar_rgb(stages["gaussian_evidence"], roi, 0.0, 1.0, "magma"), params, colorbar=("Gaussian evidence", 0.0, 1.0), colorbar_cmap="magma")
    if params.PLOT_TUFT_LABELS:
        save_plot(out_dir / "03a_final_tuft_labels.png", f"{tag} - final tuft labels", tuft_label_rgb(labels, rows), params)
    if params.PLOT_TUFT_PIXEL_CBF:
        save_plot(out_dir / "03_final_tuft_pixel_cbf.png", f"{tag} - final tuft mask, per-pixel CBF", scalar_rgb(frequency, tuft_mask, params.BAND_LO, params.BAND_HI), params, colorbar=("CBF, Hz", params.BAND_LO, params.BAND_HI))
    mean_cbf_map = tuft_value_map(labels, rows, "pixel_dominant_cbf_mean_hz")
    mean_cbf_rgb = scalar_rgb(mean_cbf_map, tuft_mask, params.BAND_LO, params.BAND_HI)
    if params.PLOT_TUFT_DOMINANT_CBF:
        save_plot(out_dir / "04_final_tuft_mean_cbf.png", f"{tag} - final tuft mask, tuft mean CBF", mean_cbf_rgb, params, colorbar=("tuft mean CBF, Hz", params.BAND_LO, params.BAND_HI))
    if params.PLOT_TUFT_DOMINANT_CBF_WITH_AXIS:
        save_plot(out_dir / "04b_final_tuft_mean_cbf_tensor_axes.png", f"{tag} - tuft mean CBF with tensor axes", draw_tensor_axis_lines(mean_cbf_rgb, rows, params), params, colorbar=("tuft mean CBF, Hz", params.BAND_LO, params.BAND_HI), line_legend=True, line_legend_rows=rows)
    if params.PLOT_TUFT_PHASE_AXIS:
        save_plot(out_dir / "05_final_tuft_phase_tensor_axes.png", f"{tag} - final tuft phase with tensor axes", draw_tensor_axis_lines(phase_rgb(phase_map, tuft_mask), rows, params), params, phasebar="phase at tuft peak, radians", line_legend=True, line_legend_rows=rows)
    if params.PLOT_TUFT_AXIS_COHERENCE:
        axis_rgb = axis_coherence_rgb(labels, rows)
        save_plot(out_dir / "06_final_tuft_axis_angle_coherence.png", f"{tag} - tensor axis angle and coherence", draw_tensor_axis_lines(axis_rgb, rows, params), params, semicircle=True, opacity_legend=True, line_legend=True, line_legend_rows=rows)


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def append_csv_rows(path: Path, columns: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    exists = path.exists()
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        if not exists:
            writer.writeheader()
        writer.writerows(rows)


def selected_columns(selected: tuple[str, ...] | None, available: list[str], required: tuple[str, ...]) -> list[str]:
    requested = list(selected) if selected is not None else [column for column in available if column not in required]
    unknown = sorted(set(requested) - set(available))
    if unknown:
        raise ValueError(f"Unknown output columns: {', '.join(unknown)}")
    return [column for column in available if column in required or column in requested]


def _stage(callback: ProgressCallback | None, stage: str, message: str) -> None:
    if callback:
        callback(stage, message)


def as_gray_frame(frame: np.ndarray) -> np.ndarray:
    array = np.asarray(frame)
    if array.ndim == 2:
        gray = array
    elif array.ndim == 3 and array.shape[2] == 1:
        gray = array[..., 0]
    elif array.ndim == 3 and array.shape[2] >= 3:
        if np.array_equal(array[..., 0], array[..., 1]) and np.array_equal(array[..., 0], array[..., 2]):
            gray = array[..., 0]
        else:
            rgb = array[..., :3].astype(np.float32, copy=False)
            gray = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    else:
        raise ValueError(f"Unsupported decoded frame shape: {array.shape}")
    return _preserve_gray_dtype(gray, array.dtype)


def _preserve_gray_dtype(values: np.ndarray, source_dtype: np.dtype) -> np.ndarray:
    array = np.asarray(values)
    if np.issubdtype(array.dtype, np.unsignedinteger) and array.dtype.itemsize <= 2:
        return array
    if np.issubdtype(source_dtype, np.unsignedinteger) and np.dtype(source_dtype).itemsize <= 2:
        info = np.iinfo(source_dtype)
        return np.rint(np.clip(array, 0, info.max)).astype(source_dtype)
    return array.astype(np.float32, copy=False)


def frame_intensity_scale(frames: np.ndarray) -> float:
    if np.issubdtype(frames.dtype, np.unsignedinteger):
        return float(np.iinfo(frames.dtype).max)
    if np.issubdtype(frames.dtype, np.signedinteger):
        info = np.iinfo(frames.dtype)
        return float(max(abs(info.min), abs(info.max)))
    maximum = 0.0
    for start in range(0, frames.shape[0], 64):
        chunk = np.asarray(frames[start : start + 64])
        finite = chunk[np.isfinite(chunk)]
        if finite.size:
            maximum = max(maximum, float(np.max(np.abs(finite))))
    return maximum if maximum > 1.0 else 1.0


def normalized_trace_chunk(flat_frames: np.ndarray, indices: np.ndarray, intensity_scale: float) -> np.ndarray:
    return flat_frames[:, indices].astype(np.float32) / max(float(intensity_scale), np.finfo(np.float32).tiny)


def fft_chunk_pixels(frame_count: int, requested_max: int = DEFAULT_FFT_CHUNK_PIXELS) -> int:
    bytes_per_pixel = max(1, int(frame_count)) * 32
    return max(1, min(int(requested_max), MAX_FFT_CHUNK_TEMP_BYTES // bytes_per_pixel))


def _windowed(magnitude: np.ndarray, indices: np.ndarray, columns: np.ndarray) -> np.ndarray:
    return magnitude[np.maximum(indices - 1, 0), columns] + magnitude[indices, columns] + magnitude[np.minimum(indices + 1, magnitude.shape[0] - 1), columns]


def _peak_concentration(power: np.ndarray, indices: np.ndarray, total_power: np.ndarray) -> np.ndarray:
    columns = np.arange(power.shape[1])
    concentrated = power[np.maximum(indices - 1, 1), columns] + power[indices, columns] + power[np.minimum(indices + 1, power.shape[0] - 1), columns]
    return concentrated / np.maximum(total_power, np.finfo(np.float32).tiny)


def robust_unit(values: np.ndarray, roi: np.ndarray, invert: bool = False) -> np.ndarray:
    valid = values[roi & np.isfinite(values)]
    if valid.size == 0:
        return np.zeros(values.shape, dtype=np.float32)
    lower, upper = np.percentile(valid, [5.0, 95.0])
    if upper <= lower:
        return np.zeros(values.shape, dtype=np.float32)
    scaled = np.clip((np.nan_to_num(values, nan=lower) - lower) / (upper - lower), 0.0, 1.0)
    if invert:
        scaled = 1.0 - scaled
    scaled[~roi] = 0.0
    return scaled.astype(np.float32)


def masked_gaussian(values: np.ndarray, roi: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        output = values.copy()
        output[~roi] = 0.0
        return output.astype(np.float32)
    numerator = ndimage.gaussian_filter(values * roi, sigma=sigma)
    denominator = ndimage.gaussian_filter(roi.astype(np.float32), sigma=sigma)
    output = np.divide(numerator, np.maximum(denominator, 1e-6), out=np.zeros_like(numerator), where=denominator > 1e-6)
    output[~roi] = 0.0
    return output.astype(np.float32)


def otsu_threshold(values: np.ndarray, roi: np.ndarray, bins: int = 256) -> float:
    data = values[roi & np.isfinite(values)]
    counts, edges = np.histogram(data, bins=bins, range=(0.0, 1.0))
    probabilities = counts.astype(np.float64) / max(1, counts.sum())
    centers = (edges[:-1] + edges[1:]) / 2.0
    cw = np.cumsum(probabilities)
    cm = np.cumsum(probabilities * centers)
    gm = cm[-1]
    denom = cw * (1.0 - cw)
    between = np.divide((gm * cw - cm) ** 2, denom, out=np.zeros_like(denom), where=denom > 0)
    return float(centers[int(np.argmax(between))])


def remove_small_labels_from_mask(mask: np.ndarray, minimum_area: int) -> np.ndarray:
    labels, count = ndimage.label(mask, structure=STRUCTURE_8)
    output = mask.copy()
    for label_id in range(1, count + 1):
        region = labels == label_id
        if int(region.sum()) < int(minimum_area):
            output[region] = False
    return output


def flat_frequency_prune(mask: np.ndarray, frequency: np.ndarray, params: FinalPipelineParams) -> tuple[np.ndarray, np.ndarray]:
    labels, count = ndimage.label(mask, structure=STRUCTURE_8)
    output = mask.copy()
    removed = np.zeros_like(mask)
    for label_id in range(1, count + 1):
        component = labels == label_id
        if int(component.sum()) < int(params.FLAT_LARGE_COMPONENT_AREA):
            continue
        values = np.sort(frequency[component & np.isfinite(frequency)])
        if values.size == 0:
            continue
        best_start = best_stop = 0
        stop = 0
        for start, lower in enumerate(values):
            stop = max(stop, start + 1)
            while stop < values.size and values[stop] - lower <= float(params.FLAT_TOL_HZ):
                stop += 1
            if stop - start > best_stop - best_start:
                best_start, best_stop = start, stop
        if best_stop - best_start < int(params.FLAT_UNIFORM_SUBREGION_MIN_AREA):
            continue
        lower = float(values[best_start])
        upper = float(values[best_stop - 1])
        window = component & (frequency >= lower) & (frequency <= upper)
        sublabels, subcount = ndimage.label(window, structure=STRUCTURE_4)
        for sublabel in range(1, subcount + 1):
            subregion = sublabels == sublabel
            if int(subregion.sum()) >= int(params.FLAT_UNIFORM_SUBREGION_MIN_AREA):
                output[subregion] = False
                removed[subregion] = True
    return output, removed


def frequency_bin_clusters(mask: np.ndarray, frequency: np.ndarray, bin_width_hz: float, minimum_area: int) -> np.ndarray:
    labels_out = np.zeros(mask.shape, dtype=np.int32)
    valid = mask & np.isfinite(frequency)
    if not np.any(valid):
        return labels_out
    bins = bin_width_hz * np.floor(frequency / bin_width_hz)
    min_bin = np.floor(np.nanmin(frequency[valid]) / bin_width_hz) * bin_width_hz
    max_bin = np.ceil(np.nanmax(frequency[valid]) / bin_width_hz) * bin_width_hz
    next_label = 0
    for bin_low in np.arange(min_bin, max_bin + bin_width_hz, bin_width_hz):
        sublabels, subcount = ndimage.label(valid & (bins == bin_low), structure=STRUCTURE_8)
        for sublabel in range(1, subcount + 1):
            region = sublabels == sublabel
            if int(region.sum()) >= int(minimum_area):
                next_label += 1
                labels_out[region] = next_label
    return labels_out


def unique_repair(labels: np.ndarray, support_mask: np.ndarray, repair_one: Callable[[np.ndarray], np.ndarray]) -> np.ndarray:
    proposals = np.zeros_like(labels, dtype=np.int32)
    claim_count = np.zeros_like(labels, dtype=np.uint16)
    for label_id in np.unique(labels):
        if int(label_id) == 0:
            continue
        candidate = repair_one(labels == int(label_id))
        additions = candidate & support_mask & (labels == 0)
        claim_count[additions] += 1
        proposals[additions] = int(label_id)
    repaired = labels.copy()
    unique = (claim_count == 1) & (labels == 0)
    repaired[unique] = proposals[unique]
    return repaired


def close_component(component: np.ndarray, iterations: int) -> np.ndarray:
    if not np.any(component):
        return component.copy()
    ys, xs = np.nonzero(component)
    pad = int(iterations) + 3
    y0, y1 = max(0, int(ys.min()) - pad), min(component.shape[0], int(ys.max()) + pad + 1)
    x0, x1 = max(0, int(xs.min()) - pad), min(component.shape[1], int(xs.max()) + pad + 1)
    repaired = np.zeros_like(component)
    repaired[y0:y1, x0:x1] = ndimage.binary_closing(component[y0:y1, x0:x1], structure=STRUCTURE_8, iterations=max(1, int(iterations)))
    return repaired


def fill_holes_limited(component: np.ndarray, max_hole_area: int) -> np.ndarray:
    inverse = ~component
    labels, count = ndimage.label(inverse, structure=STRUCTURE_8)
    repaired = component.copy()
    border_labels = set(int(value) for value in np.unique(np.concatenate((labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]))))
    for label_id in range(1, count + 1):
        if label_id in border_labels:
            continue
        hole = labels == label_id
        if int(hole.sum()) <= int(max_hole_area):
            repaired[hole] = True
    return repaired


def relabel(labels: np.ndarray) -> np.ndarray:
    output = np.zeros_like(labels, dtype=np.int32)
    next_label = 0
    for label_id in np.unique(labels):
        if int(label_id) == 0:
            continue
        next_label += 1
        output[labels == int(label_id)] = next_label
    return output


def remove_small_labels(labels: np.ndarray, minimum_area: int) -> np.ndarray:
    output = labels.copy()
    for label_id in np.unique(labels):
        if int(label_id) and int(np.sum(labels == int(label_id))) < int(minimum_area):
            output[labels == int(label_id)] = 0
    return relabel(output)


def fwhm_hz(frequencies: np.ndarray, power: np.ndarray, peak_index: int) -> float:
    half = 0.5 * float(power[peak_index])
    left = peak_index
    while left > 0 and power[left - 1] >= half:
        left -= 1
    right = peak_index
    while right + 1 < power.size and power[right + 1] >= half:
        right += 1
    return float(frequencies[right] - frequencies[left])


def weighted_std_hz(frequencies: np.ndarray, power: np.ndarray) -> float:
    total = float(np.sum(power))
    if total <= 0:
        return float("nan")
    mean = float(np.sum(frequencies * power) / total)
    return float(np.sqrt(max(0.0, np.sum(((frequencies - mean) ** 2) * power) / total)))


def axis_circular_summary(angles_deg: np.ndarray) -> tuple[float, float]:
    angles = angles_deg[np.isfinite(angles_deg)]
    if angles.size == 0:
        return float("nan"), float("nan")
    doubled = np.radians(2.0 * angles)
    resultant = np.mean(np.exp(1j * doubled))
    mean_axis = (0.5 * np.degrees(np.angle(resultant)) + 180.0) % 180.0
    r = abs(resultant)
    circular_std = 0.5 * np.degrees(np.sqrt(max(0.0, -2.0 * np.log(max(r, 1e-9)))))
    return float(mean_axis), float(circular_std)


def axial_agreement(angle_a: float, angle_b: float) -> float:
    if not np.isfinite(angle_a) or not np.isfinite(angle_b):
        return float("nan")
    return float(np.cos(2.0 * np.radians(angle_a - angle_b)))


def spatial_neighbor_metrics(rows: list[dict[str, Any]], params: FinalPipelineParams) -> dict[str, float]:
    metrics: dict[str, float] = {}
    if len(rows) < 2:
        return metrics
    xy = np.array([[row["centroid_x"], row["centroid_y"]] for row in rows], dtype=np.float32)
    cbf = np.array([row["pixel_dominant_cbf_mean_hz"] for row in rows], dtype=np.float32)
    angle = np.array([row["phase_tensor_axis_deg"] for row in rows], dtype=np.float32)
    coherence = np.array([row["phase_tensor_coherence"] for row in rows], dtype=np.float32)
    distances = np.linalg.norm(xy[:, None, :] - xy[None, :, :], axis=2)
    np.fill_diagonal(distances, np.inf)
    for k_value in params.KNN_NEIGHBORS:
        k = min(int(k_value), len(rows) - 1)
        neighbors = np.argsort(distances, axis=1)[:, :k]
        cbf_diffs: list[float] = []
        cbf_similarities: list[float] = []
        angle_agreements: list[float] = []
        weighted_sum = 0.0
        weight_sum = 0.0
        for idx in range(len(rows)):
            for neighbor in neighbors[idx]:
                if np.isfinite(cbf[idx]) and np.isfinite(cbf[neighbor]):
                    diff = abs(float(cbf[idx] - cbf[neighbor]))
                    cbf_diffs.append(diff)
                    cbf_similarities.append(float(np.exp(-diff / max(float(params.CBF_SIMILARITY_SCALE_HZ), 1e-6))))
                agree = axial_agreement(float(angle[idx]), float(angle[neighbor]))
                if np.isfinite(agree):
                    angle_agreements.append(agree)
                    weight = max(0.0, float(coherence[idx])) * max(0.0, float(coherence[neighbor]))
                    weighted_sum += weight * agree
                    weight_sum += weight
        prefix = f"knn{k_value}"
        metrics[f"{prefix}_cbf_mean_abs_diff_hz"] = float(np.mean(cbf_diffs)) if cbf_diffs else float("nan")
        metrics[f"{prefix}_cbf_std_abs_diff_hz"] = float(np.std(cbf_diffs)) if cbf_diffs else float("nan")
        metrics[f"{prefix}_cbf_exp_similarity"] = float(np.mean(cbf_similarities)) if cbf_similarities else float("nan")
        metrics[f"{prefix}_angle_mean_axial_agreement"] = float(np.mean(angle_agreements)) if angle_agreements else float("nan")
        metrics[f"{prefix}_angle_std_axial_agreement"] = float(np.std(angle_agreements)) if angle_agreements else float("nan")
        metrics[f"{prefix}_angle_coherence_weighted_axial_agreement"] = float(weighted_sum / weight_sum) if weight_sum > 0 else float("nan")
    return metrics


def hsv_to_rgb(h: np.ndarray, s: np.ndarray, v: np.ndarray) -> np.ndarray:
    i = np.floor(h * 6.0).astype(np.int32)
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    i_mod = i % 6
    rgb = np.zeros((h.size, 3), dtype=np.float32)
    choices = [(v, t, p), (q, v, p), (p, q, v), (p, q, v), (t, p, v), (v, p, q)]
    choices[2] = (p, v, t)
    choices[3] = (p, q, v)
    for idx, (r, g, b) in enumerate(choices):
        mask = i_mod == idx
        rgb[mask, 0] = r[mask]
        rgb[mask, 1] = g[mask]
        rgb[mask, 2] = b[mask]
    return np.clip(255 * rgb, 0, 255).astype(np.uint8)


def viridis_like(unit: np.ndarray) -> np.ndarray:
    anchors = np.array([[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]], dtype=np.float32)
    return interpolate_palette(unit, anchors)


def colormap_rgb(unit: np.ndarray, name: str) -> np.ndarray:
    palettes = {
        "viridis": np.array([[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]], dtype=np.float32),
        "turbo": np.array([[48, 18, 59], [50, 97, 206], [31, 176, 167], [146, 217, 65], [245, 176, 32], [180, 4, 38]], dtype=np.float32),
        "magma": np.array([[0, 0, 4], [74, 16, 110], [181, 54, 122], [251, 136, 97], [252, 253, 191]], dtype=np.float32),
        "plasma": np.array([[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 149, 64], [240, 249, 33]], dtype=np.float32),
        "gray": np.array([[0, 0, 0], [255, 255, 255]], dtype=np.float32),
    }
    return interpolate_palette(unit, palettes.get(str(name).lower(), palettes["viridis"]))


def interpolate_palette(unit: np.ndarray, anchors: np.ndarray) -> np.ndarray:
    unit = np.clip(unit, 0.0, 1.0)
    scaled = unit * (len(anchors) - 1)
    lower = np.floor(scaled).astype(np.int32)
    upper = np.clip(lower + 1, 0, len(anchors) - 1)
    frac = (scaled - lower)[..., None]
    return ((1.0 - frac) * anchors[lower] + frac * anchors[upper]).astype(np.uint8)


def scalar_rgb(values: np.ndarray, valid: np.ndarray, vmin: float, vmax: float, colormap: str = "viridis") -> np.ndarray:
    output = np.full((*values.shape, 3), 255, dtype=np.uint8)
    finite = valid & np.isfinite(values)
    if np.any(finite):
        unit = np.nan_to_num((values - float(vmin)) / max(float(vmax) - float(vmin), 1e-6), nan=0.0, posinf=1.0, neginf=0.0)
        output[finite] = colormap_rgb(unit[finite], colormap)
    return output


def phase_rgb(phase: np.ndarray, valid: np.ndarray) -> np.ndarray:
    output = np.full((*phase.shape, 3), 255, dtype=np.uint8)
    finite = valid & np.isfinite(phase)
    if np.any(finite):
        hue = (phase[finite] + np.pi) / (2.0 * np.pi)
        output[finite] = hsv_to_rgb(hue, np.full(hue.shape, 0.95), np.full(hue.shape, 0.95))
    return output


def tuft_label_rgb(labels: np.ndarray, rows: list[dict[str, Any]]) -> np.ndarray:
    output = np.full((*labels.shape, 3), 255, dtype=np.uint8)
    for label_id in np.unique(labels):
        label_int = int(label_id)
        if label_int <= 0:
            continue
        hue = ((label_int * 0.61803398875) % 1.0)
        color = hsv_to_rgb(np.array([hue], dtype=np.float32), np.array([0.62], dtype=np.float32), np.array([0.92], dtype=np.float32))[0]
        output[labels == label_int] = color
    image = Image.fromarray(output)
    draw = ImageDraw.Draw(image)
    font = tuft_label_font(labels.shape)
    row_lookup = {int(row["tuft_id"]): row for row in rows if "tuft_id" in row}
    for label_id in np.unique(labels):
        label_int = int(label_id)
        if label_int <= 0:
            continue
        row = row_lookup.get(label_int)
        if row is not None and np.isfinite(float(row.get("centroid_x", float("nan")))) and np.isfinite(float(row.get("centroid_y", float("nan")))):
            x = float(row["centroid_x"])
            y = float(row["centroid_y"])
        else:
            ys, xs = np.nonzero(labels == label_int)
            if xs.size == 0:
                continue
            x = float(np.mean(xs))
            y = float(np.mean(ys))
        text = str(label_int)
        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        draw.text((x - text_width / 2.0, y - text_height / 2.0), text, fill=(0, 0, 0), font=font, stroke_width=1, stroke_fill=(255, 255, 255))
    return np.array(image)


def tuft_label_font(shape: tuple[int, int]) -> ImageFont.ImageFont:
    size = max(12, min(32, int(round(min(shape) / 27))))
    return plot_font(size, bold=True)


def axis_color(angle_deg: float) -> np.ndarray:
    return hsv_to_rgb(np.array([(angle_deg % 180.0) / 180.0], dtype=np.float32), np.array([0.9], dtype=np.float32), np.array([0.92], dtype=np.float32))[0]


def axis_coherence_rgb(labels: np.ndarray, rows: list[dict[str, Any]]) -> np.ndarray:
    output = np.full((*labels.shape, 3), 255, dtype=np.uint8)
    for row in rows:
        angle = float(row.get("phase_tensor_axis_deg", float("nan")))
        if not np.isfinite(angle):
            continue
        coherence = float(row.get("phase_tensor_coherence", 0.0))
        color = axis_color(angle).astype(np.float32)
        alpha = np.clip(coherence, 0.0, 1.0)
        output[labels == int(row["tuft_id"])] = (alpha * color + (1.0 - alpha) * 255.0).astype(np.uint8)
    return output


def tuft_value_map(labels: np.ndarray, rows: list[dict[str, Any]], key: str) -> np.ndarray:
    output = np.full(labels.shape, np.nan, dtype=np.float32)
    for row in rows:
        value = float(row.get(key, float("nan")))
        if np.isfinite(value):
            output[labels == int(row["tuft_id"])] = value
    return output


def draw_tensor_axis_lines(image_rgb: np.ndarray, rows: list[dict[str, Any]], params: FinalPipelineParams) -> np.ndarray:
    image = Image.fromarray(image_rgb.copy())
    draw = ImageDraw.Draw(image)
    for row in rows:
        angle = float(row.get("phase_tensor_axis_deg", float("nan")))
        coherence = float(row.get("phase_tensor_coherence", 0.0))
        if not np.isfinite(angle) or coherence <= 0.05:
            continue
        length = max(10.0, min(48.0, 0.65 * np.sqrt(float(row["area_px"]))))
        theta = np.radians(angle)
        dx = 0.5 * length * np.cos(theta)
        dy = 0.5 * length * np.sin(theta)
        width = int(params.AXIS_LINE_MIN_WIDTH_PX + round(np.clip(coherence, 0.0, 1.0) * (params.AXIS_LINE_MAX_WIDTH_PX - params.AXIS_LINE_MIN_WIDTH_PX)))
        x = float(row["centroid_x"])
        y = float(row["centroid_y"])
        draw.line((x - dx, y - dy, x + dx, y + dy), fill=(0, 0, 0), width=max(1, width))
    return np.array(image)


def save_plot(path: Path, title: str, image_rgb: np.ndarray, params: FinalPipelineParams, colorbar: tuple[str, float, float] | None = None, phasebar: str | None = None, semicircle: bool = False, opacity_legend: bool = False, line_legend: bool = False, colorbar_cmap: str = "viridis", line_legend_rows: list[dict[str, Any]] | None = None) -> None:
    margin = 32
    top = 66
    height, width = image_rgb.shape[:2]
    title_font = plot_font(24, bold=True)
    right_pad = 420 if (colorbar or phasebar or semicircle or opacity_legend or line_legend) else 0
    legend_height = 0
    if colorbar:
        legend_height += min(height, 420) + 70
    if phasebar:
        legend_height += min(height, 420) + 70
    if semicircle:
        legend_height += 168
    if opacity_legend:
        legend_height += 70
    if line_legend:
        legend_height += 145
    title_box = title_font.getbbox(title)
    title_width = title_box[2] - title_box[0]
    canvas_width = max(margin * 2 + width + right_pad, margin * 2 + title_width)
    content_height = max(height, legend_height)
    canvas = Image.new("RGB", (canvas_width, margin * 2 + top + content_height), "white")
    draw = ImageDraw.Draw(canvas)
    draw.text((margin, margin), title, fill=(15, 23, 42), font=title_font)
    canvas.paste(Image.fromarray(image_rgb), (margin, margin + top))
    legend_x = margin + width + 26
    legend_y = margin + top
    if colorbar:
        draw_vertical_colorbar(draw, legend_x, legend_y, min(height, 420), colorbar[0], colorbar[1], colorbar[2], colorbar_cmap)
        legend_y += min(height, 420) + 70
    if phasebar:
        draw_phase_colorbar(draw, legend_x, legend_y, min(height, 420), phasebar)
        legend_y += min(height, 420) + 70
    if semicircle:
        draw_semicircle_legend(draw, legend_x, legend_y, 82)
        legend_y += 168
    if opacity_legend:
        draw_opacity_legend(draw, legend_x, legend_y)
        legend_y += 70
    if line_legend:
        draw_line_legend(draw, legend_x, legend_y, params, line_legend_rows or [])
    canvas.save(path, dpi=(int(params.OUTPUT_DPI), int(params.OUTPUT_DPI)))


def draw_vertical_colorbar(draw: ImageDraw.ImageDraw, x: int, y: int, height: int, label: str, vmin: float, vmax: float, colormap: str = "viridis") -> None:
    font = plot_font(18)
    for offset in range(height):
        color = tuple(int(v) for v in colormap_rgb(np.array([1.0 - offset / max(1, height - 1)], dtype=np.float32), colormap)[0])
        draw.line((x, y + offset, x + 34, y + offset), fill=color)
    draw.rectangle((x, y, x + 34, y + height), outline=(40, 48, 60), width=2)
    draw.text((x + 46, y - 8), f"{vmax:g}", fill=(20, 28, 40), font=font)
    draw.text((x + 46, y + height - 14), f"{vmin:g}", fill=(20, 28, 40), font=font)
    draw.text((x, y + height + 14), label, fill=(20, 28, 40), font=font)


def draw_phase_colorbar(draw: ImageDraw.ImageDraw, x: int, y: int, height: int, label: str) -> None:
    font = plot_font(18)
    for offset in range(height):
        phase = np.pi - 2.0 * np.pi * offset / max(1, height - 1)
        color = tuple(int(v) for v in phase_rgb(np.array([[phase]], dtype=np.float32), np.array([[True]]))[0, 0])
        draw.line((x, y + offset, x + 34, y + offset), fill=color)
    draw.rectangle((x, y, x + 34, y + height), outline=(40, 48, 60), width=2)
    draw.text((x + 46, y - 8), "pi", fill=(20, 28, 40), font=font)
    draw.text((x + 46, y + height - 14), "-pi", fill=(20, 28, 40), font=font)
    draw.text((x, y + height + 14), label, fill=(20, 28, 40), font=font)


def draw_semicircle_legend(draw: ImageDraw.ImageDraw, x: int, y: int, radius: int) -> None:
    font = plot_font(18)
    center = (x + radius, y + radius)
    for angle in np.linspace(0.0, 180.0, 181):
        color = tuple(int(v) for v in axis_color(float(angle)))
        theta = np.radians(180.0 - angle)
        draw.line((center[0] + int((radius - 22) * np.cos(theta)), center[1] - int((radius - 22) * np.sin(theta)), center[0] + int(radius * np.cos(theta)), center[1] - int(radius * np.sin(theta))), fill=color, width=3)
    draw.text((x, y + radius + 8), "180", fill=(20, 28, 40), font=font)
    draw.text((x + radius - 6, y - 16), "90", fill=(20, 28, 40), font=font)
    draw.text((x + 2 * radius - 16, y + radius + 8), "0", fill=(20, 28, 40), font=font)
    draw.text((x, y + radius + 30), "tensor axis angle, degrees", fill=(20, 28, 40), font=font)


def draw_opacity_legend(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    font = plot_font(18)
    base = np.array([40.0, 110.0, 220.0])
    for offset in range(150):
        alpha = offset / 149.0
        color = tuple(int(v) for v in (alpha * base + (1.0 - alpha) * 255.0))
        draw.line((x + offset, y, x + offset, y + 16), fill=color)
    draw.rectangle((x, y, x + 150, y + 16), outline=(40, 48, 60), width=1)
    draw.text((x, y + 24), "0", fill=(20, 28, 40), font=font)
    draw.text((x + 134, y + 24), "1", fill=(20, 28, 40), font=font)
    draw.text((x, y + 42), "opacity = tensor coherence", fill=(20, 28, 40), font=font)


def draw_line_legend(draw: ImageDraw.ImageDraw, x: int, y: int, params: FinalPipelineParams, rows: list[dict[str, Any]]) -> None:
    del rows
    font = plot_font(17)
    label_font = plot_font(18, bold=True)
    draw.text((x, y), "Black line indicates metachronal axis", fill=(20, 28, 40), font=label_font)
    for index, coherence in enumerate((0.0, 0.5, 1.0)):
        line_y = y + 42 + index * 38
        width = int(params.AXIS_LINE_MIN_WIDTH_PX + round(coherence * (params.AXIS_LINE_MAX_WIDTH_PX - params.AXIS_LINE_MIN_WIDTH_PX)))
        draw.line((x, line_y, x + 92, line_y), fill=(0, 0, 0), width=max(1, width))
        draw.text((x + 112, line_y - 11), f"coherence {coherence:.1f}", fill=(20, 28, 40), font=font)


def plot_font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    names = ("arialbd.ttf", "DejaVuSans-Bold.ttf") if bold else ("arial.ttf", "DejaVuSans.ttf")
    for name in names:
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _safe_tag(path: Path) -> str:
    stem = path.stem.strip() or "video"
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in stem)[:80]

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
from typing import Any, Mapping

from .final_pipeline import VIDEO_EXTENSIONS, VIDEO_EXTENSIONS_DISPLAY

SCHEMA_VERSION = 1
IN_VITRO_PIPELINE_DEFAULTS: dict[str, Any] = {
    "FPS": 500.0,
    "N_FRAMES": 100,
    "H_EXPECT": None,
    "W_EXPECT": None,
    "ROI_MODE": "circle",
    "RADIUS": 440,
    "SQUARE_WIDTH": 880,
    "SAVE_TUFT_SPECTRA": False,
}
EX_VIVO_PIPELINE_DEFAULTS: dict[str, Any] = {
    **IN_VITRO_PIPELINE_DEFAULTS,
    "FPS": 2000.0,
    "ROI_MODE": "full",
}

_JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_TOP_LEVEL_FIELDS = {
    "schema_version",
    "job_id",
    "analysis_type",
    "input_videos",
    "output_root",
    "pipeline_params",
    "roi_mask_path",
    "video_backend",
    "continue_after_error",
    "max_workers",
    "summary_columns",
    "tuft_columns",
}


class JobConfigError(ValueError):
    """Raised when a sidecar job configuration is invalid."""


@dataclass(frozen=True)
class JobConfig:
    schema_version: int
    job_id: str
    analysis_type: str
    input_videos: tuple[Path, ...]
    output_root: Path
    pipeline_params: dict[str, Any]
    summary_columns: tuple[str, ...] | None = None
    tuft_columns: tuple[str, ...] | None = None
    roi_mask_path: Path | None = None
    video_backend: str = "imageio"
    continue_after_error: bool = True
    max_workers: int = 1

    @property
    def job_directory(self) -> Path:
        return self.output_root / self.job_id

    @classmethod
    def from_file(cls, path: str | Path, *, validate_paths: bool = True) -> "JobConfig":
        config_path = Path(path)
        try:
            payload = json.loads(config_path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError as exc:
            raise JobConfigError(f"Configuration file does not exist: {config_path}") from exc
        except json.JSONDecodeError as exc:
            raise JobConfigError(
                f"Configuration is not valid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}"
            ) from exc

        if not isinstance(payload, dict):
            raise JobConfigError("Configuration root must be a JSON object.")
        return cls.from_dict(payload, base_directory=config_path.parent, validate_paths=validate_paths)

    @classmethod
    def from_dict(
        cls,
        payload: Mapping[str, Any],
        *,
        base_directory: str | Path | None = None,
        validate_paths: bool = True,
    ) -> "JobConfig":
        unknown = sorted(set(payload) - _TOP_LEVEL_FIELDS)
        if unknown:
            raise JobConfigError(f"Unknown configuration field(s): {', '.join(unknown)}")

        schema_version = payload.get("schema_version")
        if schema_version != SCHEMA_VERSION:
            raise JobConfigError(
                f"Unsupported schema_version {schema_version!r}; expected {SCHEMA_VERSION}."
            )

        job_id = payload.get("job_id")
        if not isinstance(job_id, str) or not _JOB_ID_PATTERN.fullmatch(job_id):
            raise JobConfigError(
                "job_id must be 1-64 characters and contain only letters, numbers, '.', '_' or '-'."
            )

        analysis_type = payload.get("analysis_type", "in_vitro")
        if analysis_type not in {"in_vitro", "ex_vivo"}:
            raise JobConfigError(
                "Only analysis_type='in_vitro' or 'ex_vivo' is supported by sidecar schema v1."
            )

        base = Path(base_directory).resolve() if base_directory is not None else Path.cwd()

        raw_videos = payload.get("input_videos")
        if not isinstance(raw_videos, list) or not raw_videos:
            raise JobConfigError("input_videos must be a non-empty array of supported video file paths.")
        if not all(isinstance(item, str) and item.strip() for item in raw_videos):
            raise JobConfigError("Every input_videos entry must be a non-empty string path.")
        input_videos = tuple(_resolve_path(item, base) for item in raw_videos)
        for video in input_videos:
            if video.suffix.lower() not in VIDEO_EXTENSIONS:
                raise JobConfigError(f"Unsupported video extension for schema v1: {video}. Accepted formats: {VIDEO_EXTENSIONS_DISPLAY}")
            if validate_paths and not video.is_file():
                raise JobConfigError(f"Input video does not exist: {video}")

        raw_output = payload.get("output_root")
        if not isinstance(raw_output, str) or not raw_output.strip():
            raise JobConfigError("output_root must be a non-empty directory path.")
        output_root = _resolve_path(raw_output, base)
        if validate_paths and output_root.exists() and not output_root.is_dir():
            raise JobConfigError(f"output_root is not a directory: {output_root}")

        raw_params = payload.get("pipeline_params", {})
        if not isinstance(raw_params, dict):
            raise JobConfigError("pipeline_params must be a JSON object.")
        if "FIXED_ROI_MASK" in raw_params:
            raise JobConfigError(
                "FIXED_ROI_MASK cannot be embedded in JSON; use roi_mask_path instead."
            )
        defaults = EX_VIVO_PIPELINE_DEFAULTS if analysis_type == "ex_vivo" else IN_VITRO_PIPELINE_DEFAULTS
        pipeline_params = {**defaults, **raw_params}
        _validate_pipeline_basics(pipeline_params)

        raw_roi_mask = payload.get("roi_mask_path")
        roi_mask_path = None
        if raw_roi_mask is not None:
            if not isinstance(raw_roi_mask, str) or not raw_roi_mask.strip():
                raise JobConfigError("roi_mask_path must be a non-empty path when provided.")
            roi_mask_path = _resolve_path(raw_roi_mask, base)
            if validate_paths and not roi_mask_path.is_file():
                raise JobConfigError(f"ROI mask does not exist: {roi_mask_path}")

        roi_mode = str(pipeline_params.get("ROI_MODE", "circle")).lower()
        if analysis_type == "in_vitro" and roi_mode in {"custom", "dir"}:
            raise JobConfigError(
                f"ROI_MODE={roi_mode!r} requires an interactive or batch preparation flow and is not supported by sidecar v1."
            )
        if analysis_type == "ex_vivo" and roi_mode not in {"full", "custom"}:
            raise JobConfigError("Ex-vivo analysis supports ROI_MODE='full' or ROI_MODE='custom'.")
        if roi_mode == "fixed" and roi_mask_path is None:
            raise JobConfigError("ROI_MODE='fixed' requires roi_mask_path.")
        if roi_mask_path is not None:
            pipeline_params["ROI_MODE"] = "fixed"

        video_backend = payload.get("video_backend", "imageio")
        if video_backend != "imageio":
            raise JobConfigError("video_backend is fixed to 'imageio' in sidecar schema v1.")

        continue_after_error = payload.get("continue_after_error", True)
        if not isinstance(continue_after_error, bool):
            raise JobConfigError("continue_after_error must be true or false.")

        max_workers = payload.get("max_workers", 1)
        if not isinstance(max_workers, int) or isinstance(max_workers, bool) or max_workers < 1:
            raise JobConfigError("max_workers must be a positive whole number.")
        max_reasonable_workers = max(1, (os.cpu_count() or 1) * 2)
        if max_workers > max_reasonable_workers:
            raise JobConfigError(
                f"max_workers={max_workers} is too high for this machine; use {max_reasonable_workers} or fewer."
            )

        summary_columns = _read_column_list(payload, "summary_columns")
        tuft_columns = _read_column_list(payload, "tuft_columns")

        return cls(
            schema_version=SCHEMA_VERSION,
            job_id=job_id,
            analysis_type=analysis_type,
            input_videos=input_videos,
            output_root=output_root,
            pipeline_params=pipeline_params,
            summary_columns=summary_columns,
            tuft_columns=tuft_columns,
            roi_mask_path=roi_mask_path,
            video_backend=video_backend,
            continue_after_error=continue_after_error,
            max_workers=max_workers,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "job_id": self.job_id,
            "analysis_type": self.analysis_type,
            "input_videos": [str(path) for path in self.input_videos],
            "output_root": str(self.output_root),
            "pipeline_params": dict(self.pipeline_params),
            "roi_mask_path": str(self.roi_mask_path) if self.roi_mask_path else None,
            "video_backend": self.video_backend,
            "continue_after_error": self.continue_after_error,
            "max_workers": self.max_workers,
            "summary_columns": list(self.summary_columns) if self.summary_columns is not None else None,
            "tuft_columns": list(self.tuft_columns) if self.tuft_columns is not None else None,
        }


def _read_column_list(payload: Mapping[str, Any], name: str) -> tuple[str, ...] | None:
    if name not in payload:
        return None
    value = payload[name]
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise JobConfigError(f"{name} must be an array of non-empty column names.")
    return tuple(dict.fromkeys(value))


def _resolve_path(value: str, base_directory: Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base_directory / path
    return path.resolve()


def _validate_pipeline_basics(params: Mapping[str, Any]) -> None:
    fps = params.get("FPS")
    if not isinstance(fps, (int, float)) or isinstance(fps, bool) or fps <= 0:
        raise JobConfigError("pipeline_params.FPS must be a positive number.")

    n_frames = params.get("N_FRAMES")
    all_frames = isinstance(n_frames, str) and n_frames.lower() == "all"
    if not all_frames and (
        not isinstance(n_frames, int)
        or isinstance(n_frames, bool)
        or n_frames < 4
    ):
        raise JobConfigError("pipeline_params.N_FRAMES must be 'all' or a whole number of at least 4.")
    if not all_frames and not _has_fft_bin_in_range(float(fps), int(n_frames), 5.0, 80.0):
        raise JobConfigError(
            "pipeline_params.FPS and pipeline_params.N_FRAMES must provide at least one FFT bin in the internal 5-80 Hz cilia evidence band."
        )

    chunk_pixels = params.get("FFT_CHUNK_PIXELS", 8192)
    if isinstance(chunk_pixels, bool) or not isinstance(chunk_pixels, int) or not 256 <= chunk_pixels <= 32768:
        raise JobConfigError("pipeline_params.FFT_CHUNK_PIXELS must be a whole number from 256 to 32768.")

    band_lo = params.get("BAND_LO")
    band_hi = params.get("BAND_HI")
    if band_lo is not None and band_hi is not None:
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in (band_lo, band_hi)):
            raise JobConfigError("BAND_LO and BAND_HI must be numbers.")
        if band_lo < 0 or band_hi <= band_lo:
            raise JobConfigError("BAND_HI must be greater than BAND_LO, and BAND_LO cannot be negative.")
        fps = float(params["FPS"])
        if band_hi > fps / 2.0:
            raise JobConfigError(
                f"BAND_HI cannot exceed the Nyquist limit of {fps / 2.0:g} Hz for FPS={fps:g}."
            )

    threshold_mode = str(params.get("EVIDENCE_THRESHOLD_MODE", "otsu")).lower()
    if threshold_mode not in {"otsu", "manual"}:
        raise JobConfigError("pipeline_params.EVIDENCE_THRESHOLD_MODE must be 'otsu' or 'manual'.")
    manual_threshold = params.get("EVIDENCE_MANUAL_THRESHOLD", 0.5)
    if not isinstance(manual_threshold, (int, float)) or isinstance(manual_threshold, bool) or not 0 <= manual_threshold <= 1:
        raise JobConfigError("pipeline_params.EVIDENCE_MANUAL_THRESHOLD must be between 0 and 1.")
    otsu_coefficient = params.get("EVIDENCE_OTSU_COEFFICIENT", 0.9)
    if not isinstance(otsu_coefficient, (int, float)) or isinstance(otsu_coefficient, bool) or otsu_coefficient < 0:
        raise JobConfigError("pipeline_params.EVIDENCE_OTSU_COEFFICIENT must be a non-negative number.")

    roi_mode = str(params.get("ROI_MODE", "circle")).lower()
    if roi_mode not in {"circle", "square", "full", "fixed", "custom", "dir"}:
        raise JobConfigError(f"Unsupported pipeline_params.ROI_MODE: {roi_mode!r}")
    radius = params.get("RADIUS")
    if roi_mode == "circle" and (
        not isinstance(radius, int) or isinstance(radius, bool) or radius <= 0
    ):
        raise JobConfigError("pipeline_params.RADIUS must be a positive integer for a circular ROI.")
    square_width = params.get("SQUARE_WIDTH")
    if roi_mode == "square" and (
        not isinstance(square_width, int) or isinstance(square_width, bool) or square_width <= 0
    ):
        raise JobConfigError("pipeline_params.SQUARE_WIDTH must be a positive integer for a square ROI.")


def _has_fft_bin_in_range(fps: float, frame_count: int, low_hz: float, high_hz: float) -> bool:
    if fps <= 0 or frame_count < 2:
        return False
    spacing = fps / frame_count
    upper = min(high_hz, fps / 2.0)
    first_bin = int(math.ceil(low_hz / spacing))
    last_bin = int(math.floor(upper / spacing))
    return max(1, first_bin) <= last_bin

"""Bounded disk checkpoints shared by short-lived preview and analysis processes."""

from __future__ import annotations

from dataclasses import asdict
from functools import lru_cache
import hashlib
from importlib.metadata import PackageNotFoundError, version
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
import uuid
from zipfile import BadZipFile
from typing import Any

import numpy as np


CACHE_VERSION = 1
MAX_CACHE_BYTES = 512 * 1024**2
MAX_CACHE_ENTRIES = 2
MAX_CACHE_AGE_SECONDS = 24 * 3600
FFT_FIELDS = (
    "FPS", "N_FRAMES", "USE_HANN", "FFT_CHUNK_PIXELS", "REMOVE_DOUBLING",
    "HALF_POWER_RATIO_THRESH", "USE_SPATIAL_CONSENSUS", "SPATIAL_TOL_FRAC",
    "USE_AUTOCORR_FALLBACK",
)
FILTER_FIELDS = (
    "BAND_LO", "BAND_HI", "SNR_THRESH_DB", "EVIDENCE_GAUSSIAN_SIGMA",
    "EVIDENCE_THRESHOLD_MODE", "EVIDENCE_MANUAL_THRESHOLD", "EVIDENCE_OTSU_COEFFICIENT",
)
TUFT_FIELDS = (
    "MIN_TUFT_AREA", "MAX_TUFT_SIZE", "FREQUENCY_CLUSTER_BIN_HZ",
    "CLUSTER_GAP_CLOSING_ITERS", "CLUSTER_HOLE_FILL_MAX_AREA",
    "FLAT_LARGE_COMPONENT_AREA", "FLAT_TOL_HZ", "FLAT_UNIFORM_SUBREGION_MIN_AREA",
    "FLAT_POST_PRUNE_MIN_AREA", "WATERSHED_MIN_PEAK_DISTANCE_PX",
    "WATERSHED_MIN_PEAK_RADIUS_PX", "WATERSHED_DISTANCE_SIGMA",
    "WATERSHED_MAX_RECURSIVE_SPLITS", "PHASE_TENSOR_SMOOTH_SIGMA",
)


def _root() -> Path | None:
    value = os.environ.get("TUFFT_PREVIEW_CACHE_DIR")
    return Path(value).resolve() / f"v{CACHE_VERSION}" if value else None


@lru_cache(maxsize=1)
def _implementation_stamp() -> list[Any]:
    paths = [Path(sys.executable)] if getattr(sys, "frozen", False) else [
        Path(__file__).with_name("final_pipeline.py"),
        Path(__file__).with_name("ex_vivo_pipeline.py"),
        Path(__file__).parent.parent / "preview.py",
        Path(__file__),
    ]
    result = [(path.name, path.stat().st_size, path.stat().st_mtime_ns) for path in paths]
    for package in ("numpy", "scipy", "scikit-image", "imageio", "imageio-ffmpeg"):
        try:
            result.append((package, version(package)))
        except PackageNotFoundError:
            pass
    return result


def source_stamp(video: Path) -> tuple[int, int, int] | None:
    try:
        stat = video.stat()
        return stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
    except OSError:
        return None


def _digest(value: Any) -> str:
    def canonical(item: Any) -> Any:
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, dict):
            return {key: canonical(entry) for key, entry in item.items()}
        if isinstance(item, (list, tuple)):
            return [canonical(entry) for entry in item]
        return item

    return hashlib.sha256(json.dumps(canonical(value), sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _keys(video: Path, params: Any, mode: str) -> tuple[str, str] | None:
    values = asdict(params)
    # A capped setup preview cannot substitute for a longer or All-frames FFT.
    if not isinstance(values["N_FRAMES"], int) or not 4 <= values["N_FRAMES"] <= 100:
        return None
    source = video.resolve()
    stat = source.stat()
    roi = {"ROI_MODE": values["ROI_MODE"]}
    if values["ROI_MODE"] == "circle":
        roi["RADIUS"] = values["RADIUS"]
    elif values["ROI_MODE"] == "square":
        roi["SQUARE_WIDTH"] = values["SQUARE_WIDTH"]
    elif values["ROI_MODE"] == "custom":
        polygons = values.get("ROI_POLYGONS") or []
        if isinstance(polygons, dict):
            polygons = polygons.get(str(video)) or polygons.get(video.as_posix()) or polygons.get(video.name) or []
        roi["ROI_POLYGONS"] = polygons
    fft = _digest({
        "version": CACHE_VERSION,
        "implementation": _implementation_stamp(),
        "mode": mode,
        "source": [os.path.normcase(str(source)), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns],
        "roi": roi,
        "parameters": {name: values[name] for name in FFT_FIELDS},
    })
    fields = FILTER_FIELDS + (("EX_VIVO_DESPECKLE_MIN_AREA",) if mode == "ex_vivo" else TUFT_FIELDS)
    return fft, _digest({name: values[name] for name in fields})


def load_preview(video: Path, params: Any, mode: str) -> dict[str, Any] | None:
    root = _root()
    if root is None:
        return None
    frames = None
    try:
        keys = _keys(video, params, mode)
        if keys is None:
            return None
        directory = root / keys[0]
        if time.time() - directory.stat().st_mtime > MAX_CACHE_AGE_SECONDS:
            return None
        with np.load(directory / "features.npz", allow_pickle=False) as archive:
            metadata = json.loads(str(archive["_metadata"].item()))
            if metadata["fft_key"] != keys[0]:
                return None
            features = {name: archive[name] for name in archive.files if name != "_metadata"}
        frames = np.load(directory / "frames.npy", mmap_mode="r", allow_pickle=False)
        if frames.ndim != 3 or frames.shape[0] < 4 or frames.shape != tuple(metadata["frame_shape"]) or frames.shape[1:] != features["roi"].shape:
            raise ValueError("Invalid preview frame dimensions")
        snapshot = {"frames": frames, "features": features, "analysis": None}
        try:
            with np.load(directory / "analysis.npz", allow_pickle=False) as archive:
                state = json.loads(str(archive["_metadata"].item()))
                if state["analysis_key"] == keys[1] and state["fft_key"] == keys[0]:
                    analysis = {
                        **state,
                        "stages": {name[7:]: archive[name] for name in archive.files if name.startswith("stage__")},
                        **{name: archive[name] for name in archive.files if name not in {"_metadata"} and not name.startswith("stage__")},
                    }
                    required = ["tuft_labels", "cluster_labels"] if state.get("tufts_ready") else []
                    required += ["tuft_phase_map"] if state.get("metrics_ready") else []
                    required += ["summary_phase_map"] if state.get("summary_ready") else []
                    if not analysis["stages"] or any(analysis[name].shape != frames.shape[1:] for name in required):
                        raise ValueError("Invalid preview analysis dimensions")
                    snapshot["analysis"] = analysis
        except (OSError, ValueError, KeyError, EOFError, BadZipFile):
            pass
        os.utime(directory, None)
        return snapshot
    except (OSError, ValueError, KeyError, EOFError, BadZipFile):
        if frames is not None and hasattr(frames, "_mmap"):
            frames._mmap.close()
        return None


def close_preview(snapshot: dict[str, Any] | None) -> None:
    if snapshot is not None:
        snapshot["frames"]._mmap.close()


def save_preview(video: Path, params: Any, mode: str, frames: np.ndarray, features: dict[str, np.ndarray], analysis: dict[str, Any], *, expected_source: tuple[int, int, int] | None = None) -> None:
    root = _root()
    if root is None:
        return
    temporary = None
    archive_temporary = None
    try:
        if expected_source is not None and source_stamp(video) != expected_source:
            return
        keys = _keys(video, params, mode)
        total_bytes = frames.nbytes + sum(value.nbytes for value in features.values())
        total_bytes += sum(value.nbytes for value in analysis.values() if isinstance(value, np.ndarray))
        total_bytes += sum(value.nbytes for value in analysis.get("stages", {}).values())
        if keys is None or total_bytes > MAX_CACHE_BYTES:
            return
        root.mkdir(parents=True, exist_ok=True)
        prune_cache(root, keep=keys[0])
        directory = root / keys[0]
        if not directory.exists():
            temporary = root / f".partial-{uuid.uuid4().hex}"
            temporary.mkdir()
            np.save(temporary / "frames.npy", frames, allow_pickle=False)
            np.savez(temporary / "features.npz", **features, _metadata=np.array(json.dumps({"fft_key": keys[0], "frame_shape": frames.shape})))
            try:
                temporary.rename(directory)
                temporary = None
            except FileExistsError:
                pass
        state = {name: value for name, value in analysis.items() if name != "stages" and not isinstance(value, np.ndarray)}
        state.update(fft_key=keys[0], analysis_key=keys[1])
        arrays = {name: value for name, value in analysis.items() if isinstance(value, np.ndarray)}
        arrays.update({f"stage__{name}": value for name, value in analysis.get("stages", {}).items()})
        archive_temporary = directory / f".analysis-{uuid.uuid4().hex}.npz"
        np.savez(archive_temporary, **arrays, _metadata=np.array(json.dumps(state, default=_json_number)))
        os.replace(archive_temporary, directory / "analysis.npz")
        os.utime(directory, None)
        prune_cache(root, keep=keys[0])
    except (OSError, ValueError) as exc:
        # Cache failures never prevent a scientifically valid preview or run.
        print(f"Preview results could not be cached: {exc}", file=sys.stderr)
    finally:
        if temporary is not None:
            _remove_owned_directory(root, temporary)
        if archive_temporary is not None:
            try:
                archive_temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _json_number(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(f"Unsupported cache value: {type(value).__name__}")


def _remove_owned_directory(root: Path, directory: Path) -> None:
    resolved = directory.resolve()
    if resolved.parent == root.resolve() and not directory.is_symlink():
        shutil.rmtree(resolved, ignore_errors=True)


def prune_cache(root: Path, *, keep: str) -> None:
    now = time.time()
    entries = []
    for directory in root.iterdir():
        if not directory.is_dir() or directory.is_symlink():
            continue
        if not re.fullmatch(r"[0-9a-f]{64}|\.partial-[0-9a-f]{32}", directory.name):
            continue
        modified = directory.stat().st_mtime
        size = sum(path.stat().st_size for path in directory.iterdir() if path.is_file())
        entries.append((directory, modified, size))
    entries.sort(key=lambda item: item[1], reverse=True)
    retained, size = 0, 0
    for directory, modified, entry_size in entries:
        expired = now - modified > MAX_CACHE_AGE_SECONDS
        over_limit = retained >= MAX_CACHE_ENTRIES or size + entry_size > MAX_CACHE_BYTES
        partial = directory.name.startswith(".partial-")
        if directory.name != keep and (expired or over_limit or partial and now - modified > 3600):
            _remove_owned_directory(root, directory)
        else:
            retained += 1
            size += entry_size

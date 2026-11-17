from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor, as_completed
from collections import Counter
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import traceback
from types import ModuleType
from typing import Any, TextIO

from . import __version__
from .config import JobConfig
from .events import EventEmitter, _json_safe
from .ex_vivo_pipeline import (
    build_ex_vivo_params,
    ex_vivo_selected_columns,
    process_one_ex_vivo_video,
    serializable_ex_vivo_params,
)
from .final_pipeline import (
    TUFT_COLUMNS,
    append_csv_rows,
    build_pipeline_params,
    process_one_video,
    selected_columns,
    serializable_pipeline_params,
    summary_columns_for_params,
    _safe_tag,
)


class JobCancelled(Exception):
    pass


class _LogTee:
    def __init__(self, *streams: TextIO):
        self._streams = streams

    def write(self, value: str) -> int:
        for stream in self._streams:
            stream.write(value)
            stream.flush()
        return len(value)

    def flush(self) -> None:
        for stream in self._streams:
            stream.flush()


def run_job(
    config: JobConfig,
    emitter: EventEmitter,
    *,
    pipeline: ModuleType | Any | None = None,
    stderr: TextIO | None = None,
) -> dict[str, Any]:
    stderr = stderr or sys.stderr
    job_directory = config.job_directory
    if job_directory.exists() and any(job_directory.iterdir()):
        raise FileExistsError(
            f"Job directory already exists and is not empty: {job_directory}. Use a new job_id."
        )
    job_directory.mkdir(parents=True, exist_ok=True)
    logs_directory = job_directory / "logs"
    logs_directory.mkdir(exist_ok=True)

    parameters_path = job_directory / "parameters.json"
    manifest_path = job_directory / "manifest.json"
    log_path = logs_directory / "sidecar.log"

    started_at = _utc_now()
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "job_id": config.job_id,
        "analysis_type": config.analysis_type,
        "status": "running",
        "started_at": started_at,
        "completed_at": None,
        "input_videos": [str(path) for path in config.input_videos],
        "job_directory": str(job_directory),
        "parameters_file": str(parameters_path),
        "warnings": [],
        "errors": [],
        "max_workers": config.max_workers,
        "videos": [],
        "artifacts": [],
        "versions": {"sidecar": __version__, "algorithm": "tufft-analysis-v1"},
    }
    _write_json_atomic(manifest_path, manifest)

    emitter.emit(
        "started",
        analysis_type=config.analysis_type,
        video_count=len(config.input_videos),
        max_workers=config.max_workers,
        job_directory=str(job_directory),
    )

    try:
        with log_path.open("a", encoding="utf-8") as log_file:
            tee = _LogTee(stderr, log_file)
            with redirect_stdout(tee):
                params = None
                ex_vivo_params = None
                if config.analysis_type == "ex_vivo":
                    ex_vivo_params = build_ex_vivo_params(config.pipeline_params)
                    summary_columns = ex_vivo_selected_columns(config.summary_columns)
                    tuft_columns = []
                else:
                    params = build_pipeline_params(config.pipeline_params)
                    available_summary_columns = summary_columns_for_params(params)
                    summary_columns = selected_columns(
                        config.summary_columns,
                        available_summary_columns,
                        required=("video_file", "tag", "status", "error"),
                    )
                    tuft_columns = selected_columns(
                        config.tuft_columns,
                        TUFT_COLUMNS,
                        required=("video_file", "tag", "tuft_id"),
                    )
                    if config.roi_mask_path is not None:
                        raise ValueError("Fixed ROI masks are not supported by the new desktop tuft workflow yet.")

                effective_parameters = config.to_dict()
                effective_parameters["pipeline_params"] = serializable_ex_vivo_params(ex_vivo_params) if ex_vivo_params else serializable_pipeline_params(params)
                _write_json_atomic(parameters_path, effective_parameters)

                summary_csv = job_directory / "batch_summary.csv"
                batch_tuft_csv = job_directory / "batch_tuft_table.csv"
                save_batch_summary = bool(ex_vivo_params.SAVE_BATCH_SUMMARY) if ex_vivo_params else bool(params.SAVE_BATCH_SUMMARY)
                save_tuft_table = False if ex_vivo_params else bool(params.SAVE_TUFT_TABLE)

                total = len(config.input_videos)
                worker_count = _effective_worker_count(config.max_workers, total, config.continue_after_error)
                manifest["max_workers"] = worker_count
                _write_json_atomic(manifest_path, manifest)
                if worker_count == 1:
                    _run_videos_sequential(
                        config=config,
                        emitter=emitter,
                        tee=tee,
                        job_directory=job_directory,
                        manifest=manifest,
                        manifest_path=manifest_path,
                        params=params,
                        ex_vivo_params=ex_vivo_params,
                        summary_csv=summary_csv,
                        batch_tuft_csv=batch_tuft_csv,
                        summary_columns=summary_columns,
                        tuft_columns=tuft_columns,
                        save_batch_summary=save_batch_summary,
                        save_tuft_table=save_tuft_table,
                    )
                else:
                    _run_videos_parallel(
                        config=config,
                        emitter=emitter,
                        tee=tee,
                        job_directory=job_directory,
                        manifest=manifest,
                        manifest_path=manifest_path,
                        worker_count=worker_count,
                        summary_csv=summary_csv,
                        batch_tuft_csv=batch_tuft_csv,
                        summary_columns=summary_columns,
                        tuft_columns=tuft_columns,
                        save_batch_summary=save_batch_summary,
                        save_tuft_table=save_tuft_table,
                    )

        failed = sum(item["status"] == "failed" for item in manifest["videos"])
        completed = sum(item["status"] == "completed" for item in manifest["videos"])
        manifest["status"] = "completed_with_errors" if failed else "completed"
        manifest["completed_at"] = _utc_now()
        manifest["summary"] = {
            "requested_videos": len(config.input_videos),
            "completed_videos": completed,
            "failed_videos": failed,
        }
        _write_json_atomic(manifest_path, manifest)
        emitter.emit(
            "completed",
            status=manifest["status"],
            completed_videos=completed,
            failed_videos=failed,
            manifest_path=str(manifest_path),
        )
        return manifest
    except JobCancelled:
        manifest["status"] = "cancelled"
        manifest["completed_at"] = _utc_now()
        _write_json_atomic(manifest_path, manifest)
        emitter.emit("cancelled", message="Analysis was cancelled.", manifest_path=str(manifest_path))
        raise
    except Exception as exc:
        manifest["status"] = "failed"
        manifest["completed_at"] = _utc_now()
        manifest["errors"].append({"scope": "job", "message": str(exc) or type(exc).__name__})
        _write_json_atomic(manifest_path, manifest)
        raise


def _artifact_paths(job_directory: Path) -> set[Path]:
    excluded = {job_directory / "manifest.json", job_directory / "parameters.json"}
    return {
        path
        for path in job_directory.rglob("*")
        if path.is_file() and path not in excluded and "logs" not in path.relative_to(job_directory).parts
    }


def _run_videos_sequential(
    *,
    config: JobConfig,
    emitter: EventEmitter,
    tee: TextIO,
    job_directory: Path,
    manifest: dict[str, Any],
    manifest_path: Path,
    params: Any | None,
    ex_vivo_params: Any | None,
    summary_csv: Path,
    batch_tuft_csv: Path,
    summary_columns: list[str],
    tuft_columns: list[str],
    save_batch_summary: bool,
    save_tuft_table: bool,
) -> None:
    total = len(config.input_videos)
    output_tags = _unique_video_tags(config.input_videos)
    for index, video_path in enumerate(config.input_videos, start=1):
        output_tag = output_tags[video_path]
        summary: dict[str, Any] | None = None
        tuft_rows: list[dict[str, Any]] = []
        before = _artifact_paths(job_directory)
        video_record: dict[str, Any] = {
            "path": str(video_path),
            "status": "running",
            "started_at": _utc_now(),
            "completed_at": None,
            "summary": None,
            "error": None,
            "artifacts": [],
        }
        manifest["videos"].append(video_record)
        _write_json_atomic(manifest_path, manifest)

        emitter.emit(
            "stage",
            stage="analyze_video",
            message=f"Analyzing {video_path.name}",
            video_path=str(video_path),
            video_index=index,
            video_count=total,
            worker_count=1,
        )
        try:
            def report_stage(stage: str, message: str) -> None:
                emitter.emit(
                    "stage",
                    stage=stage,
                    message=message,
                    video_path=str(video_path),
                    video_index=index,
                    video_count=total,
                    worker_count=1,
                )

            if ex_vivo_params:
                summary, tuft_rows = process_one_ex_vivo_video(
                    video_path,
                    job_directory,
                    ex_vivo_params,
                    progress_callback=report_stage,
                    summary_output_columns=summary_columns,
                    output_tag=output_tag,
                )
            else:
                summary, tuft_rows = process_one_video(
                    video_path,
                    job_directory,
                    params,
                    progress_callback=report_stage,
                    summary_output_columns=summary_columns,
                    tuft_output_columns=tuft_columns,
                    output_tag=output_tag,
                )
            video_record["status"] = "completed"
            video_record["summary"] = _json_safe(summary)
            if save_batch_summary:
                append_csv_rows(summary_csv, summary_columns, [summary])
            if save_tuft_table and tuft_rows:
                append_csv_rows(batch_tuft_csv, tuft_columns, tuft_rows)
        except KeyboardInterrupt as exc:
            video_record["status"] = "cancelled"
            video_record["error"] = "Cancelled by user."
            raise JobCancelled from exc
        except Exception as exc:
            error_message = str(exc) or type(exc).__name__
            video_record["status"] = "failed"
            video_record["error"] = error_message
            manifest["errors"].append({"video_path": str(video_path), "message": error_message})
            if save_batch_summary:
                failed_row = {key: "" for key in summary_columns}
                failed_row["video_file"] = str(video_path)
                failed_row["status"] = "FAIL"
                failed_row["error"] = error_message
                append_csv_rows(summary_csv, summary_columns, [failed_row])
            traceback.print_exc(file=tee)
            emitter.emit(
                "error",
                scope="video",
                message=error_message,
                video_path=str(video_path),
                video_index=index,
                recoverable=config.continue_after_error,
            )
        finally:
            video_record["completed_at"] = _utc_now()
            new_artifacts = sorted(_artifact_paths(job_directory) - before)
            for artifact_path in new_artifacts:
                artifact = _describe_artifact(artifact_path, job_directory, video_path)
                video_record["artifacts"].append(artifact)
                manifest["artifacts"].append(artifact)
                emitter.emit("artifact", **artifact)
            _write_json_atomic(manifest_path, manifest)
            summary = None
            tuft_rows = []

        _emit_batch_progress(emitter, manifest, index, total)
        if video_record["status"] == "failed" and not config.continue_after_error:
            break


def _run_videos_parallel(
    *,
    config: JobConfig,
    emitter: EventEmitter,
    tee: TextIO,
    job_directory: Path,
    manifest: dict[str, Any],
    manifest_path: Path,
    worker_count: int,
    summary_csv: Path,
    batch_tuft_csv: Path,
    summary_columns: list[str],
    tuft_columns: list[str],
    save_batch_summary: bool,
    save_tuft_table: bool,
) -> None:
    total = len(config.input_videos)
    output_tags = _unique_video_tags(config.input_videos)
    emitter.emit(
        "stage",
        stage="parallel_batch",
        message=f"Running up to {worker_count} videos concurrently",
        video_count=total,
        worker_count=worker_count,
    )
    records: dict[int, dict[str, Any]] = {}
    for index, video_path in enumerate(config.input_videos, start=1):
        video_record: dict[str, Any] = {
            "path": str(video_path),
            "status": "queued",
            "started_at": None,
            "completed_at": None,
            "summary": None,
            "error": None,
            "artifacts": [],
        }
        records[index] = video_record
        manifest["videos"].append(video_record)
    _write_json_atomic(manifest_path, manifest)

    completed_count = 0
    with ProcessPoolExecutor(max_workers=worker_count) as executor:
        futures = {}
        for index, video_path in enumerate(config.input_videos, start=1):
            records[index]["status"] = "running"
            records[index]["started_at"] = _utc_now()
            emitter.emit(
                "stage",
                stage="queued_video",
                message=f"Queued {video_path.name} for parallel analysis",
                video_path=str(video_path),
                video_index=index,
                video_count=total,
                worker_count=worker_count,
            )
            future = executor.submit(
                _process_video_worker,
                config.analysis_type,
                str(video_path),
                str(job_directory),
                config.pipeline_params,
                summary_columns,
                tuft_columns,
                output_tags[video_path],
            )
            futures[future] = (index, video_path)
        _write_json_atomic(manifest_path, manifest)

        for future in as_completed(futures):
            index, video_path = futures[future]
            video_record = records[index]
            try:
                result = future.result()
                summary = result["summary"]
                tuft_rows = result["tuft_rows"]
                video_record["status"] = "completed"
                video_record["summary"] = _json_safe(summary)
                if save_batch_summary:
                    append_csv_rows(summary_csv, summary_columns, [summary])
                if save_tuft_table and tuft_rows:
                    append_csv_rows(batch_tuft_csv, tuft_columns, tuft_rows)
                for artifact_path_text in result["artifacts"]:
                    artifact_path = Path(artifact_path_text)
                    if not artifact_path.is_file():
                        continue
                    artifact = _describe_artifact(artifact_path, job_directory, video_path)
                    video_record["artifacts"].append(artifact)
                    manifest["artifacts"].append(artifact)
                    emitter.emit("artifact", **artifact)
            except Exception as exc:
                error_message = str(exc) or type(exc).__name__
                video_record["status"] = "failed"
                video_record["error"] = error_message
                manifest["errors"].append({"video_path": str(video_path), "message": error_message})
                if save_batch_summary:
                    failed_row = {key: "" for key in summary_columns}
                    failed_row["video_file"] = str(video_path)
                    failed_row["status"] = "FAIL"
                    failed_row["error"] = error_message
                    append_csv_rows(summary_csv, summary_columns, [failed_row])
                traceback.print_exc(file=tee)
                emitter.emit(
                    "error",
                    scope="video",
                    message=error_message,
                    video_path=str(video_path),
                    video_index=index,
                    recoverable=True,
                )
            finally:
                completed_count += 1
                video_record["completed_at"] = _utc_now()
                _write_json_atomic(manifest_path, manifest)

            _emit_batch_progress(emitter, manifest, completed_count, total)

    for artifact_path in sorted(_root_batch_artifacts(job_directory)):
        artifact = _describe_artifact(artifact_path, job_directory, job_directory)
        if artifact not in manifest["artifacts"]:
            manifest["artifacts"].append(artifact)
            emitter.emit("artifact", **artifact)
    _write_json_atomic(manifest_path, manifest)


def _emit_batch_progress(
    emitter: EventEmitter,
    manifest: dict[str, Any],
    completed_videos: int,
    total_videos: int,
) -> None:
    emitter.emit(
        "progress",
        completed_videos=completed_videos,
        total_videos=total_videos,
        fraction=completed_videos / total_videos,
        succeeded_videos=sum(item["status"] == "completed" for item in manifest["videos"]),
        failed_videos=sum(item["status"] == "failed" for item in manifest["videos"]),
    )


def _root_batch_artifacts(job_directory: Path) -> set[Path]:
    return {
        path
        for path in (job_directory / "batch_summary.csv", job_directory / "batch_tuft_table.csv")
        if path.is_file()
    }


def _effective_worker_count(requested: int, total_videos: int, continue_after_error: bool) -> int:
    if total_videos <= 1 or requested <= 1:
        return 1
    if not continue_after_error:
        return 1
    return max(1, min(requested, total_videos, os.cpu_count() or 1))


def _process_video_worker(
    analysis_type: str,
    video_path_text: str,
    job_directory_text: str,
    pipeline_params: dict[str, Any],
    summary_columns: list[str],
    tuft_columns: list[str],
    output_tag: str,
) -> dict[str, Any]:
    video_path = Path(video_path_text)
    job_directory = Path(job_directory_text)
    with redirect_stdout(sys.stderr):
        if analysis_type == "ex_vivo":
            params = build_ex_vivo_params(pipeline_params)
            summary, tuft_rows = process_one_ex_vivo_video(
                video_path,
                job_directory,
                params,
                summary_output_columns=summary_columns,
                output_tag=output_tag,
            )
        else:
            params = build_pipeline_params(pipeline_params)
            summary, tuft_rows = process_one_video(
                video_path,
                job_directory,
                params,
                summary_output_columns=summary_columns,
                tuft_output_columns=tuft_columns,
                output_tag=output_tag,
            )
    artifacts = sorted(_artifact_paths(job_directory / output_tag))
    return {
        "summary": _json_safe(summary),
        "tuft_rows": _json_safe(tuft_rows),
        "artifacts": [str(path) for path in artifacts],
    }


def _describe_artifact(path: Path, job_directory: Path, video_path: Path) -> dict[str, Any]:
    suffix = path.suffix.lower()
    artifact_type = {
        ".csv": "table",
        ".png": "image",
        ".jpg": "image",
        ".jpeg": "image",
        ".npy": "mask",
        ".json": "metadata",
    }.get(suffix, "file")
    return {
        "artifact_type": artifact_type,
        "path": str(path),
        "relative_path": path.relative_to(job_directory).as_posix(),
        "source_video": str(video_path),
        "size_bytes": path.stat().st_size,
    }


def _write_json_atomic(path: Path, payload: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(_json_safe(payload), indent=2, ensure_ascii=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _unique_video_tags(video_paths: tuple[Path, ...]) -> dict[Path, str]:
    bases = [_safe_tag(path) for path in video_paths]
    duplicate_bases = {base for base, count in Counter(bases).items() if count > 1}
    tags: dict[Path, str] = {}
    used: set[str] = set()
    for path, base in zip(video_paths, bases):
        tag = base
        if base in duplicate_bases:
            digest = hashlib.sha256(str(path.resolve()).casefold().encode("utf-8")).hexdigest()[:8]
            tag = f"{base[:71]}_{digest}"
        counter = 2
        candidate = tag
        while candidate in used:
            suffix = f"_{counter}"
            candidate = f"{tag[:80 - len(suffix)]}{suffix}"
            counter += 1
        used.add(candidate)
        tags[path] = candidate
    return tags

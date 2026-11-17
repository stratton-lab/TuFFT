from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .config import JobConfig, JobConfigError
from .events import EventEmitter
from .runner import JobCancelled, run_job


EXIT_SUCCESS = 0
EXIT_JOB_FAILED = 1
EXIT_CONFIG_INVALID = 2
EXIT_CANCELLED = 130


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a TuFFT analysis job from a JSON configuration.")
    parser.add_argument("--config", required=True, type=Path, help="Path to a schema v1 job JSON file.")
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate the configuration and scientific parameter names without creating a job.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = JobConfig.from_file(args.config)
    except JobConfigError as exc:
        _write_stderr(f"Configuration error: {exc}")
        return EXIT_CONFIG_INVALID

    emitter = EventEmitter(sys.stdout, config.job_id)
    try:
        if args.validate_only:
            if config.analysis_type == "ex_vivo":
                from .ex_vivo_pipeline import build_ex_vivo_params

                build_ex_vivo_params(config.pipeline_params)
            else:
                from .final_pipeline import build_pipeline_params

                build_pipeline_params(config.pipeline_params)
            sys.stdout.write(json.dumps({"valid": True, "job_id": config.job_id}) + "\n")
            sys.stdout.flush()
            return EXIT_SUCCESS

        manifest = run_job(config, emitter)
        return EXIT_SUCCESS if manifest["status"] in {"completed", "completed_with_errors"} else EXIT_JOB_FAILED
    except JobCancelled:
        return EXIT_CANCELLED
    except (JobConfigError, FileExistsError) as exc:
        emitter.emit("error", scope="job", message=str(exc), recoverable=False)
        _write_stderr(str(exc))
        return EXIT_CONFIG_INVALID
    except Exception as exc:
        emitter.emit("error", scope="job", message=str(exc) or type(exc).__name__, recoverable=False)
        _write_stderr(f"Analysis job failed: {exc}")
        return EXIT_JOB_FAILED


def _write_stderr(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


if __name__ == "__main__":
    raise SystemExit(main())

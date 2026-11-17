from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SIDECAR_DIRECTORY = Path(__file__).resolve().parents[2] / "python" / "sidecar"
sys.path.insert(0, str(SIDECAR_DIRECTORY))

from cilia_sidecar.config import JobConfig
from cilia_sidecar.events import EventEmitter
from cilia_sidecar.runner import _effective_worker_count, _unique_video_tags, run_job


def fake_process_one_video(video_path, output_path, params, progress_callback=None, **kwargs):
    del kwargs
    del params
    if progress_callback:
        progress_callback("fft", "Computing FFT")
    artifact_directory = Path(output_path) / "summary_figures"
    artifact_directory.mkdir(exist_ok=True)
    (artifact_directory / f"{Path(video_path).stem}.png").write_bytes(b"preview")
    print("final pipeline status text")
    return {
        "video_file": str(video_path),
        "tag": Path(video_path).stem,
        "status": "OK",
        "error": "",
        "tuft_count": 1,
    }, []


class SidecarRunnerTests(unittest.TestCase):
    def test_worker_count_respects_request_video_count_and_cpu_count(self) -> None:
        for requested, videos, cpus, expected in [
            (4, 8, 8, 4),
            (8, 3, 16, 3),
            (8, 10, 2, 2),
            (4, 1, 8, 1),
            (4, 8, None, 1),
        ]:
            with self.subTest(requested=requested, videos=videos, cpus=cpus):
                with patch("cilia_sidecar.runner.os.cpu_count", return_value=cpus):
                    self.assertEqual(_effective_worker_count(requested, videos, True), expected)

    def test_stop_on_first_error_uses_one_worker(self) -> None:
        with patch("cilia_sidecar.runner.os.cpu_count", return_value=8):
            self.assertEqual(_effective_worker_count(4, 8, False), 1)

    def test_writes_manifest_parameters_artifacts_and_events(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video = root / "sample.avi"
            video.touch()
            config = JobConfig.from_dict(
                {
                    "schema_version": 1,
                    "job_id": "runner-test",
                    "analysis_type": "in_vitro",
                    "input_videos": [str(video)],
                    "output_root": str(root / "output"),
                    "pipeline_params": {"N_FRAMES": 100},
                    "summary_columns": [],
                }
            )
            stdout = io.StringIO()
            stderr = io.StringIO()

            with patch("cilia_sidecar.runner.process_one_video", side_effect=fake_process_one_video) as process:
                manifest = run_job(config, EventEmitter(stdout, config.job_id), stderr=stderr)

            self.assertEqual(manifest["status"], "completed")
            self.assertEqual(manifest["videos"][0]["summary"]["tuft_count"], 1)
            self.assertEqual(len(manifest["artifacts"]), 2)
            self.assertEqual(
                {artifact["artifact_type"] for artifact in manifest["artifacts"]},
                {"image", "table"},
            )
            self.assertIn("final pipeline status text", stderr.getvalue())
            self.assertNotIn("final pipeline status text", stdout.getvalue())

            events = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(events[0]["event"], "started")
            self.assertIn("artifact", {event["event"] for event in events})
            self.assertIn(
                "fft",
                {event.get("stage") for event in events if event["event"] == "stage"},
            )
            self.assertEqual(events[-1]["event"], "completed")

            manifest_path = config.job_directory / "manifest.json"
            parameters_path = config.job_directory / "parameters.json"
            self.assertTrue(manifest_path.is_file())
            self.assertTrue(parameters_path.is_file())
            self.assertNotIn("NaN", manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(
                (config.job_directory / "batch_summary.csv").read_text(encoding="utf-8").splitlines()[0],
                "video_file,tag,status,error",
            )
            call = process.call_args
            self.assertEqual(call.kwargs["summary_output_columns"], ["video_file", "tag", "status", "error"])
            self.assertIn("tuft_id", call.kwargs["tuft_output_columns"])

    def test_duplicate_video_names_receive_distinct_output_tags(self) -> None:
        left = Path("one") / "sample.avi"
        right = Path("two") / "sample.avi"
        tags = _unique_video_tags((left, right))
        self.assertNotEqual(tags[left], tags[right])
        self.assertTrue(tags[left].startswith("sample_"))
        self.assertTrue(tags[right].startswith("sample_"))

    def test_refuses_to_overwrite_an_existing_job_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video = root / "sample.avi"
            video.touch()
            config = JobConfig.from_dict(
                {
                    "schema_version": 1,
                    "job_id": "existing-job",
                    "input_videos": [str(video)],
                    "output_root": str(root / "output"),
                }
            )
            config.job_directory.mkdir(parents=True)
            (config.job_directory / "existing.txt").write_text("keep", encoding="utf-8")

            with self.assertRaises(FileExistsError):
                run_job(config, EventEmitter(io.StringIO(), config.job_id))


if __name__ == "__main__":
    unittest.main()

# CLI Tutorial

The CLI runs the desktop's analysis engine without opening a window. Complete [Python CLI installation](INSTALLATION.md#python-cli-only) first. Commands below run from the clone's root in PowerShell using its `.venv`.

## 1. Prepare A Job

Copy and edit the in-vitro example:

```powershell
Copy-Item .\examples\in-vitro.json .\job.json
notepad .\job.json
```

Set `input_videos` to existing files and `output_root` to a writable folder. Windows paths can use forward slashes, e.g. `"D:/videos/sample.avi"`. Relative paths resolve from **the JSON file's folder**, not the current terminal directory.

The example uses 500 fps, 100 frames, a centred circle of radius 440 pixels, a 5-60 Hz band, and both CSVs. Use a smaller radius or `"ROI_MODE": "full"` if needed. Confirm FPS from acquisition information.

For ex-vivo, copy `examples/ex-vivo.json` instead: it uses 2000 fps, full-frame ROI, and no tuft segmentation. A desktop run's `parameters.json` is also a complete CLI configuration; edit input/output paths and assign a new `job_id` before reusing it.

## 2. Validate And Run

```powershell
.\.venv\Scripts\tufft-sidecar.exe --config .\job.json --validate-only
.\.venv\Scripts\tufft-sidecar.exe --config .\job.json
```

Validation checks configuration, paths, and parameter names without running video analysis. It does not prove codec compatibility or scientific suitability.

Progress is newline-delimited JSON on standard output. To save progress separately from errors:

```powershell
.\.venv\Scripts\tufft-sidecar.exe --config .\job.json 1> progress.ndjson 2> errors.log
$LASTEXITCODE
```

In activated Conda, replace the executable path with `tufft-sidecar`. The installer is for desktop use; a Python source installation provides this terminal entry point.

## 3. Inspect Results

Open `<output_root>/<job_id>/`:

- `parameters.json`: effective run configuration.
- `manifest.json`: overall/per-video status, warnings, and artifacts.
- `logs/`: processing details.
- Selected batch tables and per-video folders with CSVs/PNGs.

Use a **new `job_id` for each run**. Non-empty job folders are never overwritten. With `continue_after_error: true`, processing can finish with individual-video errors; always inspect the manifest.

Exit codes: `0` completed or completed-with-errors, `1` failed job, `2` invalid configuration/output conflict, `130` cooperative cancellation. Terminal interruption may leave partial files or an unfinished manifest; do not treat these as completed results. Desktop Stop provides guided cancellation.

## Common Changes

| Goal | JSON setting |
| --- | --- |
| All frames | `pipeline_params.N_FRAMES: "all"` |
| Acquisition rate | `pipeline_params.FPS` |
| CBF window | `pipeline_params.BAND_LO`, `BAND_HI` |
| Full frame / square | `ROI_MODE: "full"` / `"square"` with `SQUARE_WIDTH` |
| Concurrent videos | Top-level `max_workers` (start with 1) |
| CSV fields | Top-level `summary_columns`, `tuft_columns`; required identity/status fields remain |
| Disable a table | `SAVE_BATCH_SUMMARY: false` or `SAVE_TUFT_TABLE: false` in `pipeline_params` |
| PNG selection | `PLOT_*` booleans in `pipeline_params`; see exported parameters |
| Manual background cutoff | `EVIDENCE_THRESHOLD_MODE: "manual"` and `EVIDENCE_MANUAL_THRESHOLD` on the 0-1 scale |

Omitted scientific parameters use pipeline defaults. Omitted column lists include all available measurements; examples explicitly select the desktop's default fields. See the [configuration reference](contracts/job-config-v1.md) for schema details.

## Recursive Batches

`input_videos` takes file paths, not folders. Populate it while preserving the rest of your configuration:

```powershell
$job = Get-Content .\job.json -Raw | ConvertFrom-Json
$extensions = '.avi','.mp4','.mov','.m4v','.mkv','.wmv','.mpg','.mpeg'
$job.input_videos = @(Get-ChildItem 'D:\videos' -Recurse -File |
    Where-Object { $_.Extension.ToLowerInvariant() -in $extensions } |
    Select-Object -ExpandProperty FullName | Sort-Object -Unique)
$job.job_id = 'my-batch-002'
$job | ConvertTo-Json -Depth 30 | Set-Content .\job.json -Encoding UTF8
.\.venv\Scripts\tufft-sidecar.exe --config .\job.json --validate-only
```

All videos share processing settings. For custom ex-vivo ROIs, draw/save them in the desktop and reuse the run's `parameters.json`. `ROI_POLYGONS` maps source-video paths to polygon arrays; a saved single-video ROI JSON is not itself a CLI job configuration.

## Resources And Interpretation

Longer traces improve FFT bin spacing (FPS / frames), but increase decoding and temporary storage. Disk-backed frames and bounded FFT chunks avoid holding the full decoded stack in RAM. Each chunk contains complete per-pixel time-series: it does not shorten traces or pool neighbouring pixels. Concurrent workers multiply storage/memory needs.

See the [desktop tutorial](USER_MANUAL.md) for output interpretation, evidence-threshold limitations, and the modulo-180-degree metachronal axis. Keep the manifest and effective parameters with every scientific result.

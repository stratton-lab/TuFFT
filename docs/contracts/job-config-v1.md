# Job Configuration Contract v1

The desktop host starts the Python sidecar with a path to one UTF-8 JSON file. Relative paths are resolved from the configuration file's directory. Unknown top-level fields are rejected so configuration mistakes are visible.

## Required fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | integer | Must be `1`. |
| `job_id` | string | Unique 1-64 character identifier using letters, numbers, `.`, `_`, or `-`. |
| `input_videos` | string array | One or more existing supported video files: `.avi`, `.mp4`, `.mov`, `.m4v`, `.mkv`, `.wmv`, `.mpg`, or `.mpeg`. |
| `output_root` | string | Parent directory where a new `<job_id>/` directory will be created. |

## Optional fields

| Field | Default | Meaning |
| --- | --- | --- |
| `analysis_type` | `in_vitro` | Either `in_vitro` or `ex_vivo`. |
| `pipeline_params` | analysis defaults | Overrides named analysis parameter fields. |
| `roi_mask_path` | `null` | Reserved compatibility field. Fixed mask-file analysis is not supported by the current analysis runner; leave null. |
| `video_backend` | `imageio` | Recorded decoder identifier. Schema v1 accepts only `imageio`. |
| `continue_after_error` | `true` | Continue to later videos after an individual failure. |
| `max_workers` | `1` | Maximum number of videos to process concurrently. The sidecar caps this by video count and CPU count, and forces `1` when stop-on-first-error behaviour is required. |
| `summary_columns` | all available | Scientific field names to save in summary CSVs. Required identity/status fields remain. |
| `tuft_columns` | all available | Scientific field names to save in in-vitro tuft CSVs. Required video/tag/tuft identifiers remain. |

Start with the [in-vitro example](../../examples/in-vitro.json), [ex-vivo example](../../examples/ex-vivo.json), or a desktop run's `parameters.json`. The [CLI tutorial](../CLI_TUTORIAL.md) explains validation, execution, and output handling.

The sidecar applies these in-vitro defaults when values are omitted:

```json
{
  "FPS": 500.0,
  "N_FRAMES": 100,
  "FFT_CHUNK_PIXELS": 8192,
  "H_EXPECT": null,
  "W_EXPECT": null,
  "ROI_MODE": "circle",
  "RADIUS": 440,
  "SAVE_TUFT_SPECTRA": false
}
```

Ex-vivo jobs use `FPS = 2000.0` and `ROI_MODE = "full"` by default. Other shared defaults, including `N_FRAMES = 100` and `FFT_CHUNK_PIXELS = 8192`, are unchanged.

`N_FRAMES` may be a whole number of at least 4 or the string `"all"`. The latter decodes every available frame independently for each input video. FFT frequency resolution is sample rate divided by FFT size; for a numeric selection that is `FPS / N_FRAMES`, and for `"all"` the denominator is the decoded frame count of that video. More frames give finer Hz bins and more stable spectra, but increase decoding, temporary disk use, and processing time. Setup previews cap decoding at 100 frames, while final analysis honors the selected count. `BAND_HI` cannot exceed `FPS / 2`, and `BAND_LO` must be non-negative and below `BAND_HI`.

Final analysis writes decoded greyscale frames sequentially to a temporary memory-mapped file and chunks FFT work across ROI pixels. It therefore does not retain the full decoded video stack in RAM. Each concurrent worker still requires its own temporary decoded file and FFT workspace.

`FFT_CHUNK_PIXELS` is an integer from `256` to `32768` and specifies the maximum number of complete pixel time-series transformed in one batch. The effective value is also limited by an estimated `96 MB` FFT workspace divided by `N_FRAMES x 32 bytes`; thus long videos automatically use fewer pixels per chunk. This parameter affects resource use and throughput, not the scientific method. Aggregate floating-point reductions may differ at negligible rounding precision when chunk boundaries change.

For ex-vivo custom ROI analysis, polygon coordinates are supplied through `pipeline_params.ROI_POLYGONS`. The desktop app can also import saved ROI JSON records and match them to videos by saved video path.

Schema v1 fixes video decoding to imageio/FFmpeg and records that decoder choice in run metadata.

`max_workers` uses process-level parallelism across videos, not threaded processing inside a single video. The default remains `1` because each active worker owns a disk-backed frame store and FFT workspaces. Increasing it can improve throughput for large batches on machines with enough RAM and temporary disk capacity, but it should be kept conservative for long or high-resolution videos.

The sidecar refuses to overwrite a non-empty job directory. A retry must use a new job identifier, preserving previous partial results.

# Sidecar Event Contract v1

Standard output is reserved for newline-delimited JSON. Every line is one complete event object and is flushed immediately. Existing pipeline prints, warnings, and tracebacks are redirected to standard error and `logs/sidecar.log`.

All events contain:

| Field | Meaning |
| --- | --- |
| `schema_version` | Event schema version, currently `1`. |
| `event` | Event type. |
| `job_id` | Identifier supplied in the job configuration. |
| `timestamp` | UTC ISO 8601 timestamp. |

Current event types are:

- `started`: job directory and requested video count;
- `stage`: current video and coarse scientific stage;
- `progress`: completed, succeeded, and failed counts plus batch fraction;
- `artifact`: newly generated output path, type, size, and source video;
- `error`: job- or video-scoped error with recoverability;
- `completed`: final status and manifest path;
- `cancelled`: controlled interruption and manifest path.

In-vitro stage events cover loading, pixel FFT features, evidence-based foreground filtering, tuft segmentation, tuft metrics, rendering, and video completion. Ex-vivo reports its corresponding ROI/foreground stages without tuft segmentation. Batch percentage is based on completed videos; stages do not have equal computational cost.

Example:

```json
{"schema_version":1,"event":"progress","job_id":"run-001","timestamp":"2026-07-15T20:00:00Z","completed_videos":1,"total_videos":3,"fraction":0.3333333333333333,"succeeded_videos":1,"failed_videos":0}
```

Non-finite scientific values such as `NaN` and infinity are serialized as JSON `null`.

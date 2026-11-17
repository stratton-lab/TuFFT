import { CheckCircle2, FolderOpen } from "lucide-react";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { useAnalysisJob } from "../../hooks/useAnalysisJob";
import { openOutputDirectory } from "../../services/desktop";
import type { AnalysisDraft, FirstFramePreview } from "../../types/job";

interface ReviewStepProps {
  draft: AnalysisDraft;
  setDraft: Dispatch<SetStateAction<AnalysisDraft>>;
  framePreview: FirstFramePreview | null;
  job: ReturnType<typeof useAnalysisJob>;
}

export function ReviewStep({ draft, setDraft, framePreview, job }: ReviewStepProps) {
  const hardwareCores = Math.max(1, navigator.hardwareConcurrency ?? 1);
  const maxUsefulWorkers = Math.max(1, Math.min(hardwareCores, draft.inputVideos.length || 1));
  useEffect(() => {
    if (!Number.isInteger(draft.maxWorkers) || draft.maxWorkers < 1 || draft.maxWorkers > maxUsefulWorkers) {
      setDraft((current) => ({ ...current, maxWorkers: Math.max(1, Math.min(current.maxWorkers || 1, maxUsefulWorkers)) }));
    }
  }, [draft.maxWorkers, maxUsefulWorkers, setDraft]);

  const updateMaxWorkers = (value: number) => {
    const safe = Math.max(1, Math.min(maxUsefulWorkers, Math.round(value) || 1));
    setDraft((current) => ({ ...current, maxWorkers: safe }));
  };

  return (
    <div className="step-content">
      <div className="section-heading">
        <span className="eyebrow">Review</span>
        <h1>Confirm this analysis</h1>
        <p>All selected videos will run with this one recorded configuration.</p>
      </div>
      <section className="review-grid">
        <div><span>Analysis</span><strong>{draft.analysisMode === "ex_vivo" ? "Ex-vivo" : "In-vitro"}</strong></div>
        <div><span>Number of videos</span><strong>{draft.inputVideos.length}</strong></div>
        <div><span>CPU workers</span><strong>{draft.maxWorkers}</strong></div>
        <div><span>Frames</span><strong>{draft.settings.frameCount === "all" ? "All available frames" : draft.settings.frameCount} at {draft.settings.fps} fps</strong></div>
        <div><span>CBF band</span><strong>{draft.settings.bandLow}-{draft.settings.bandHigh} Hz</strong></div>
        <div><span>ROI</span><strong>{formatRoi(draft)}</strong></div>
        <div><span>Detected frame</span><strong>{framePreview ? `${framePreview.width} x ${framePreview.height}` : "Unavailable"}</strong></div>
      </section>
      <section className="panel parallel-run-settings">
        <div className="panel-title"><h2>Batch CPU usage</h2></div>
        <div className="run-worker-control">
          <label className="field">
            <span className="field-label">Number of CPU cores</span>
            <input
              type="number"
              min={1}
              max={maxUsefulWorkers}
              step={1}
              value={draft.maxWorkers}
              disabled={job.status === "running" || job.status === "starting"}
              onChange={(event) => updateMaxWorkers(Number(event.currentTarget.value))}
            />
            <small>Default 1. Increase only when the workstation has enough memory.</small>
          </label>
          <p className="run-worker-note">
            Higher values process different videos at the same time. This can speed up large batches, but each worker
            loads its own frames and FFT arrays, so RAM use rises roughly with the number of active workers.
          </p>
        </div>
      </section>
      <section className="panel review-video-paths">
        <div className="panel-title"><h2>Videos queued for analysis</h2></div>
        <div className="review-path-list">
          {draft.inputVideos.map((path) => <code key={path}>{path}</code>)}
        </div>
      </section>
      {job.status !== "idle" && (
        <section className="panel job-monitor" aria-live="polite">
          <div className="panel-heading">
            <div>
              <h2>{job.status === "completed" || job.status === "completed_with_errors" ? "Run completed" : "Current job"}</h2>
              <p>{job.message ?? job.status}</p>
            </div>
            <span className={`job-status ${job.status}`}>{job.status}</span>
          </div>
          {(job.status === "running" || job.status === "starting") && (
            <div className="current-stage">
              <span>Current video</span>
              <strong>{job.currentVideo ? fileName(job.currentVideo) : "Preparing batch"}</strong>
              {job.currentStageNumber && <span className="stage-counter">Step {job.currentStageNumber}/{job.totalStageCount}</span>}
              <small>{job.currentStageLabel ?? "Starting Python process"}</small>
            </div>
          )}
          <div className="progress-track" aria-label="Analysis progress">
            <span style={{ width: `${Math.max(job.status === "completed" || job.status === "completed_with_errors" ? 100 : 2, job.fraction * 100)}%` }} />
          </div>
          <div className="job-facts">
            <span>{Math.round(job.fraction * 100)}% batch progress</span>
            <span>{job.completedVideos}/{job.totalVideos || draft.inputVideos.length} videos complete</span>
            <span>{job.failedVideos} failed</span>
            <span>{job.artifactCount} artifacts</span>
            <span className="job-time">Elapsed {formatDuration(job.elapsedSeconds)}</span>
            <span className="job-time">ETA {job.estimatedRemainingSeconds === null ? "estimating" : formatDuration(job.estimatedRemainingSeconds)}</span>
          </div>
          {(job.status === "completed" || job.status === "completed_with_errors") && job.jobDirectory && (
            <div className="completion-action">
              <CheckCircle2 size={20} />
              <span><strong>Results are ready</strong><small>{job.jobDirectory}</small></span>
              <button className="button primary" type="button" onClick={() => void openOutputDirectory(job.jobDirectory!)}>
                <FolderOpen size={17} /> Open output folder
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function formatRoi(draft: AnalysisDraft): string {
  if (draft.analysisMode === "ex_vivo" && draft.settings.roiMode === "custom") {
    const completed = draft.inputVideos.filter((path) => (draft.roiPolygons[path] ?? []).some((polygon) => polygon.length >= 3)).length;
    return `Custom per-video polygons (${completed}/${draft.inputVideos.length})`;
  }
  if (draft.settings.roiMode === "circle") return `${draft.settings.radius}px circle`;
  if (draft.settings.roiMode === "square") return `${draft.settings.squareWidth}px square`;
  return "Full frame";
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (minutes < 60) return `${minutes}:${remainder.toString().padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return `${hours}:${minuteRemainder.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

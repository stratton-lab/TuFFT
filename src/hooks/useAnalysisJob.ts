import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { isDesktopRuntime } from "../services/desktop";
import type { JobConfigV1 } from "../types/job";

export type JobStatus = "idle" | "starting" | "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";

const VIDEO_STAGES = [
  "load_video",
  "fft",
  "foreground",
  "tuft_segmentation",
  "tuft_metrics",
  "plots",
  "video_completed",
] as const;

interface SidecarEvent {
  event: string;
  job_id: string;
  message?: string;
  stage?: string;
  status?: string;
  job_directory?: string;
  video_path?: string;
  video_count?: number;
  completed_videos?: number;
  total_videos?: number;
  fraction?: number;
  failed_videos?: number;
  relative_path?: string;
}

interface HostJobExit {
  jobId: string;
  exitCode: number | null;
  cancelled: boolean;
  success: boolean;
}

export function useAnalysisJob() {
  const [jobId, setJobId] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<JobStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [fraction, setFraction] = useState(0);
  const [artifactCount, setArtifactCount] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [jobDirectory, setJobDirectory] = useState<string | null>(null);
  const [currentVideo, setCurrentVideo] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [currentStageLabel, setCurrentStageLabel] = useState<string | null>(null);
  const [completedVideos, setCompletedVideos] = useState(0);
  const [failedVideos, setFailedVideos] = useState(0);
  const [totalVideos, setTotalVideos] = useState(0);
  const [videoStages, setVideoStages] = useState<readonly string[]>(VIDEO_STAGES);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const startInFlightRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    if (status !== "running" && status !== "starting") return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const unlisteners = Promise.all([
      listen<SidecarEvent>("sidecar-event", ({ payload }) => {
        if (!jobIdRef.current || payload.job_id !== jobIdRef.current) return;
        if (payload.event === "started") {
          setStatus("running");
          setStartedAtMs((value) => value ?? Date.now());
          setJobDirectory(payload.job_directory ?? null);
          setTotalVideos(payload.total_videos ?? payload.video_count ?? 0);
        }
        if (payload.event === "stage") {
          setMessage(payload.message ?? payload.stage ?? null);
          setCurrentVideo(payload.video_path ?? null);
          setCurrentStage(payload.stage ?? null);
          setCurrentStageLabel(payload.message ?? payload.stage ?? null);
        }
        if (payload.event === "progress" && typeof payload.fraction === "number") {
          setFraction(payload.fraction);
          setCompletedVideos(payload.completed_videos ?? 0);
          setFailedVideos(payload.failed_videos ?? 0);
          setTotalVideos(payload.total_videos ?? 0);
        }
        if (payload.event === "artifact") setArtifactCount((value) => value + 1);
        if (payload.event === "completed") {
          startInFlightRef.current = false;
          setStatus(payload.failed_videos ? "completed_with_errors" : "completed");
          setMessage(payload.failed_videos ? "Completed with video errors" : "Analysis completed");
          setFraction(1);
          setCompletedVideos(payload.completed_videos ?? 0);
          setFailedVideos(payload.failed_videos ?? 0);
        }
        if (payload.event === "cancelled") {
          startInFlightRef.current = false;
          setStatus("cancelled");
          setMessage("Analysis cancelled");
        }
        if (payload.event === "error") setMessage(payload.message ?? "Analysis error");
      }),
      listen<{ jobId: string; line: string }>("sidecar-log", ({ payload }) => {
        if (!jobIdRef.current || payload.jobId !== jobIdRef.current) return;
        setLogs((value) => [...value.slice(-198), payload.line]);
      }),
      listen<HostJobExit>("host-job-exited", ({ payload }) => {
        if (!jobIdRef.current || payload.jobId !== jobIdRef.current) return;
        if (payload.cancelled) {
          startInFlightRef.current = false;
          setStatus("cancelled");
        } else if (!payload.success) {
          startInFlightRef.current = false;
          setStatus((current) => current === "completed" || current === "completed_with_errors" ? current : "failed");
          setMessage(`Python exited with code ${payload.exitCode ?? "unknown"}`);
        }
      }),
    ]);
    return () => {
      generationRef.current += 1;
      jobIdRef.current = null;
      startInFlightRef.current = false;
      void unlisteners.then((callbacks) => callbacks.forEach((unlisten) => unlisten()));
    };
  }, []);

  const reset = () => {
    // Invalidate pending commands before clearing the visible job state.
    generationRef.current += 1;
    jobIdRef.current = null;
    startInFlightRef.current = false;
    setJobId(null);
    setStatus("idle");
    setMessage(null);
    setFraction(0);
    setArtifactCount(0);
    setLogs([]);
    setJobDirectory(null);
    setCurrentVideo(null);
    setCurrentStage(null);
    setCurrentStageLabel(null);
    setCompletedVideos(0);
    setFailedVideos(0);
    setTotalVideos(0);
    setVideoStages(VIDEO_STAGES);
    setStartedAtMs(null);
    setNowMs(Date.now());
  };

  const start = async (config: JobConfigV1) => {
    if (startInFlightRef.current) return;
    reset();
    const generation = generationRef.current;
    startInFlightRef.current = true;
    jobIdRef.current = config.job_id;
    setJobId(config.job_id);
    setStatus("starting");
    setMessage("Starting Python analysis");
    setTotalVideos(config.input_videos.length);
    setStartedAtMs(Date.now());
    const tuftStats = config.pipeline_params.COMPUTE_TUFT_STATS !== false || config.pipeline_params.COMPUTE_METACHRONAL_AXIS !== false;
    setVideoStages(VIDEO_STAGES.filter((stage) => tuftStats || stage !== "tuft_metrics"));
    try {
      await invoke<string>("start_analysis", { config });
      if (generation !== generationRef.current) return;
      setStatus((current) => current === "starting" ? "running" : current);
    } catch (error) {
      if (generation !== generationRef.current || !startInFlightRef.current) return;
      startInFlightRef.current = false;
      setStatus("failed");
      setMessage(String(error));
    }
  };

  const cancel = async () => {
    const activeJobId = jobIdRef.current;
    if (!activeJobId || !startInFlightRef.current) return;
    const generation = generationRef.current;
    try {
      await invoke("cancel_analysis", { jobId: activeJobId });
      if (generation !== generationRef.current || !startInFlightRef.current) return;
      setMessage("Stopping analysis");
    } catch (error) {
      if (generation !== generationRef.current || !startInFlightRef.current) return;
      setMessage(String(error));
    }
  };

  const stagePosition = currentStage ? videoStages.indexOf(currentStage) : -1;
  const elapsedSeconds = startedAtMs === null ? 0 : Math.max(0, Math.round((nowMs - startedAtMs) / 1000));
  const estimatedRemainingSeconds = fraction > 0.02 && (status === "running" || status === "starting")
    ? Math.max(0, Math.round(elapsedSeconds * (1 - fraction) / fraction))
    : null;

  return {
    jobId,
    status,
    message,
    fraction,
    artifactCount,
    logs,
    jobDirectory,
    currentVideo,
    currentStage,
    currentStageLabel,
    currentStageNumber: stagePosition >= 0 ? stagePosition + 1 : null,
    totalStageCount: videoStages.length,
    completedVideos,
    failedVideos,
    totalVideos,
    elapsedSeconds,
    estimatedRemainingSeconds,
    start,
    cancel,
    reset,
  };
}

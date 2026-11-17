import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { FftPreview, FirstFramePreview, PipelineSettings, RoiPolygon } from "../types/job";

export const acceptedVideoExtensions = ["avi", "mp4", "mov", "m4v", "mkv", "wmv", "mpg", "mpeg"];
export const acceptedVideoDescription = ".avi, .mp4, .mov, .m4v, .mkv, .wmv, .mpg, .mpeg";

export function isDesktopRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function selectVideoFiles(): Promise<string[]> {
  if (!isDesktopRuntime()) return [];
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Video files", extensions: acceptedVideoExtensions }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function selectOutputDirectory(): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  const selected = await open({ multiple: false, directory: true });
  return typeof selected === "string" ? selected : null;
}

export async function selectInputDirectory(): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  const selected = await open({ multiple: false, directory: true });
  return typeof selected === "string" ? selected : null;
}

export async function selectInputDirectories(): Promise<string[]> {
  if (!isDesktopRuntime()) return [];
  const selected = await open({ multiple: true, directory: true, title: "Select input folders" });
  return selected ? Array.isArray(selected) ? selected : [selected] : [];
}

export async function discoverVideoInputs(paths: string[]): Promise<string[]> {
  return invoke<string[]>("discover_video_inputs", { paths });
}

export async function discoverVideoFiles(directory: string): Promise<string[]> {
  return invoke<string[]>("discover_video_files", { root: directory });
}

export async function discoverRoiPolygons(directory: string): Promise<Record<string, RoiPolygon[]>> {
  return invoke<Record<string, RoiPolygon[]>>("discover_roi_polygons", { root: directory });
}

export async function loadFirstFramePreview(videoPath: string): Promise<FirstFramePreview> {
  return invoke<FirstFramePreview>("generate_first_frame_preview", { videoPath });
}

export async function loadVideoLoopPreview(videoPath: string): Promise<{ video_path: string; loop_data_url: string; playback_fps: number }> {
  return invoke("generate_video_loop_preview", { videoPath });
}

export async function saveRoiPolygons(videoPath: string, polygons: RoiPolygon[], outputRoot: string): Promise<string> {
  return invoke<string>("save_roi_polygons", { videoPath, polygons, outputRoot });
}

export async function loadFftPreview(
  videoPath: string,
  settings: PipelineSettings,
  roiPolygons: RoiPolygon[] | undefined,
  previewId: string,
  previewStage: "fft" | "band" | "filter" | "tufts" | "phase",
  analysisMode: "in_vitro" | "ex_vivo" = "in_vitro",
): Promise<FftPreview> {
  const includeTufts = previewStage === "tufts" || previewStage === "phase";
  const includePhase = previewStage === "phase";
  return invoke<FftPreview>("generate_fft_preview", {
    request: {
      previewId,
      videoPath,
      fps: settings.fps,
      frameCount: settings.frameCount === "all" ? 100 : Math.min(settings.frameCount, 100),
      roiMode: settings.roiMode,
      radius: settings.roiMode === "circle" ? settings.radius : null,
      squareWidth: settings.roiMode === "square" ? settings.squareWidth : null,
      roiPolygons: settings.roiMode === "custom" ? roiPolygons ?? [] : null,
      useHann: settings.useHann,
      bandLow: settings.bandLow,
      bandHigh: settings.bandHigh,
      snrThresholdDb: settings.snrThresholdDb,
      removeDoubling: settings.removeDoubling,
      halfPowerRatioThreshold: settings.halfPowerRatioThreshold,
      useSpatialConsensus: settings.useSpatialConsensus,
      neighborRadius: 2,
      spatialToleranceFraction: settings.spatialToleranceFraction,
      useAutocorrelationFallback: settings.useAutocorrelationFallback,
      pipelineParams: {
        EVIDENCE_GAUSSIAN_SIGMA: settings.evidenceGaussianSigma,
        EVIDENCE_THRESHOLD_MODE: settings.evidenceThresholdMode,
        EVIDENCE_MANUAL_THRESHOLD: settings.evidenceManualThreshold,
        EVIDENCE_OTSU_COEFFICIENT: settings.evidenceOtsuCoefficient,
        MIN_TUFT_AREA: settings.minTuftSize,
        MAX_TUFT_SIZE: settings.maxTuftSize,
        FREQUENCY_CLUSTER_BIN_HZ: settings.frequencyClusterBinHz,
        CLUSTER_GAP_CLOSING_ITERS: settings.clusterGapClosingIterations,
        CLUSTER_HOLE_FILL_MAX_AREA: settings.clusterHoleFillMaxArea,
        FLAT_LARGE_COMPONENT_AREA: settings.flatLargeComponentArea,
        FLAT_TOL_HZ: settings.flatToleranceHz,
        FLAT_UNIFORM_SUBREGION_MIN_AREA: settings.flatUniformSubregionMinArea,
        FLAT_POST_PRUNE_MIN_AREA: settings.flatPostPruneMinArea,
        WATERSHED_MIN_PEAK_DISTANCE_PX: settings.watershedMinPeakDistancePx,
        WATERSHED_MIN_PEAK_RADIUS_PX: settings.watershedMinPeakRadiusPx,
        WATERSHED_DISTANCE_SIGMA: settings.watershedDistanceSigma,
        WATERSHED_MAX_RECURSIVE_SPLITS: settings.watershedMaxRecursiveSplits,
        PHASE_TENSOR_SMOOTH_SIGMA: settings.phaseTensorSmoothSigma,
        EX_VIVO_DESPECKLE_MIN_AREA: settings.exVivoDespeckleMinArea,
        PREVIEW_ANALYSIS_MODE: analysisMode,
        PREVIEW_TUFTS: includeTufts,
        PREVIEW_PHASE: includePhase,
        FFT_CHUNK_PIXELS: settings.fftChunkPixels,
      },
    },
  });
}

export async function cancelFftPreview(previewId: string): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  return invoke<boolean>("cancel_fft_preview", { previewId });
}

export async function openOutputDirectory(path: string): Promise<void> {
  await invoke("open_output_directory", { path });
}

export async function loadSettingsFile(): Promise<unknown | null> {
  if (!isDesktopRuntime()) return null;
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Previous run parameters.json or TuFFT settings", extensions: ["json"] }],
  });
  if (typeof path !== "string") return null;
  return invoke<unknown>("read_settings_file", { path });
}

export async function saveSettingsFile(value: unknown): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  const path = await save({
    defaultPath: "tufft-settings.json",
    filters: [{ name: "TuFFT settings", extensions: ["json"] }],
  });
  if (!path) return false;
  await invoke("write_settings_file", { path, value });
  return true;
}

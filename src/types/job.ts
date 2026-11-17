export type AnalysisMode = "in_vitro" | "ex_vivo";
export type RoiMode = "circle" | "square" | "full" | "custom";
export type FrameCountSelection = number | "all";
export interface Point {
  x: number;
  y: number;
}
export type RoiPolygon = Point[];

export interface PipelineSettings {
  fps: number;
  frameCount: FrameCountSelection;
  roiMode: RoiMode;
  radius: number;
  squareWidth: number;
  bandLow: number;
  bandHigh: number;
  removeDoubling: boolean;
  halfPowerRatioThreshold: number;
  useSpatialConsensus: boolean;
  spatialToleranceFraction: number;
  useAutocorrelationFallback: boolean;
  useHann: boolean;
  fftChunkPixels: number;
  snrThresholdDb: number;
  evidenceGaussianSigma: number;
  evidenceThresholdMode: "otsu" | "manual";
  evidenceManualThreshold: number;
  evidenceOtsuCoefficient: number;
  minTuftSize: number;
  maxTuftSize: number;
  frequencyClusterBinHz: number;
  clusterGapClosingIterations: number;
  clusterHoleFillMaxArea: number;
  flatLargeComponentArea: number;
  flatToleranceHz: number;
  flatUniformSubregionMinArea: number;
  flatPostPruneMinArea: number;
  watershedMinPeakDistancePx: number;
  watershedMinPeakRadiusPx: number;
  watershedDistanceSigma: number;
  watershedMaxRecursiveSplits: number;
  phaseTensorSmoothSigma: number;
  computeMetachronalAxis: boolean;
  computeTuftStats: boolean;
  knnNeighborValues: string;
  cbfSimilarityScaleHz: number;
  plotFrequencyMin: number;
  plotFrequencyMax: number;
  rawFftColormap: string;
  outputDpi: number;
  exVivoDespeckleMinArea: number;
}

export interface OutputSelection {
  batchSummary: boolean;
  perTuftTable: boolean;
  rawFftPlot: boolean;
  rawPhasePlot: boolean;
  gaussianEvidencePlot: boolean;
  tuftLabelPlot: boolean;
  tuftPixelCbfPlot: boolean;
  tuftDominantCbfPlot: boolean;
  tuftDominantCbfAxisPlot: boolean;
  tuftPhaseAxisPlot: boolean;
  tuftAxisCoherencePlot: boolean;
  exVivoOriginalPlot: boolean;
  exVivoCbfPlot: boolean;
  exVivoPhasePlot: boolean;
  logsAndManifest: true;
  summaryColumns: string[];
  tuftColumns: string[];
}

export const CORE_SUMMARY_METRIC_COLUMNS = [
  "tuft_count", "tuft_area_mean_px", "tuft_area_std_px",
  "pixel_mean_cbf_mean_hz", "pixel_mean_cbf_std_hz",
  "joint_peak_cbf_mean_hz", "joint_peak_cbf_std_hz",
  "tensor_axis_circular_mean_deg", "tensor_axis_circular_std_deg",
  "tensor_coherence_mean", "tensor_coherence_std",
] as const;

export const KNN_SUMMARY_SUFFIXES = [
  "cbf_mean_abs_diff_hz",
  "cbf_std_abs_diff_hz",
  "cbf_exp_similarity",
  "angle_mean_axial_agreement",
  "angle_std_axial_agreement",
  "angle_coherence_weighted_axial_agreement",
] as const;

export const SUMMARY_METRIC_COLUMNS = [
  ...CORE_SUMMARY_METRIC_COLUMNS,
  "knn5_cbf_mean_abs_diff_hz", "knn5_cbf_std_abs_diff_hz", "knn5_cbf_exp_similarity",
  "knn5_angle_mean_axial_agreement", "knn5_angle_std_axial_agreement", "knn5_angle_coherence_weighted_axial_agreement",
  "knn10_cbf_mean_abs_diff_hz", "knn10_cbf_std_abs_diff_hz", "knn10_cbf_exp_similarity",
  "knn10_angle_mean_axial_agreement", "knn10_angle_std_axial_agreement", "knn10_angle_coherence_weighted_axial_agreement",
] as const;

export function parseKnnNeighborValues(value: string): number[] {
  const cleaned = value.trim();
  if (!cleaned) return [];
  const numbers = new Set<number>();
  for (const part of cleaned.split(/[,\s]+/).filter(Boolean)) {
    if (part.includes("-")) {
      const [startText, endText, extra] = part.split("-");
      if (extra !== undefined) throw new Error("Use comma-separated k values or simple ranges such as 5-10.");
      const start = Number(startText);
      const end = Number(endText);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0 || end < start) {
        throw new Error("kNN neighbor values must be positive whole numbers.");
      }
      for (let item = start; item <= end; item += 1) numbers.add(item);
    } else {
      const parsed = Number(part);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("kNN neighbor values must be positive whole numbers.");
      }
      numbers.add(parsed);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

export function knnSummaryColumns(values: string | number[]): string[] {
  const neighbors = Array.isArray(values) ? values : parseKnnNeighborValues(values);
  return neighbors.flatMap((k) => KNN_SUMMARY_SUFFIXES.map((suffix) => `knn${k}_${suffix}`));
}

export function isKnnSummaryColumn(column: string): boolean {
  return /^knn\d+_(cbf_mean_abs_diff_hz|cbf_std_abs_diff_hz|cbf_exp_similarity|angle_mean_axial_agreement|angle_std_axial_agreement|angle_coherence_weighted_axial_agreement)$/.test(column);
}

export const TUFT_METRIC_COLUMNS = [
  "centroid_x", "centroid_y", "area_px",
  "joint_spectral_cbf_hz", "joint_peak_fwhm_hz", "joint_power_weighted_std_hz",
  "pixel_dominant_cbf_mean_hz", "pixel_dominant_cbf_std_hz",
  "phase_tensor_axis_deg", "phase_tensor_coherence",
] as const;

export const EX_VIVO_SUMMARY_COLUMNS = [
  "roi_area_px",
  "foreground_area_px",
  "joint_dominant_cbf_hz",
  "joint_peak_fwhm_hz",
  "pixel_dominant_cbf_mean_hz",
  "pixel_dominant_cbf_std_hz",
] as const;

export interface AnalysisDraft {
  analysisMode: AnalysisMode;
  inputVideos: string[];
  sampleVideo: string;
  outputRoot: string;
  maxWorkers: number;
  roiPolygons: Record<string, RoiPolygon[]>;
  settings: PipelineSettings;
  outputs: OutputSelection;
}

export interface SettingsFileV1 {
  schema_version: 1;
  file_type: "tufft-settings" | "cilia-analysis-settings";
  analysis_mode: AnalysisMode;
  settings: PipelineSettings;
  outputs: OutputSelection;
}

export function toSettingsFile(draft: AnalysisDraft): SettingsFileV1 {
  return {
    schema_version: 1,
    file_type: "tufft-settings",
    analysis_mode: draft.analysisMode,
    settings: draft.settings,
    outputs: draft.outputs,
  };
}

type ParsedReusableSettings = Pick<AnalysisDraft, "analysisMode" | "settings" | "outputs"> & Partial<Pick<AnalysisDraft, "roiPolygons">>;

export function parseSettingsFile(value: unknown, expectedMode?: AnalysisMode): ParsedReusableSettings {
  if (!value || typeof value !== "object") throw new Error("Settings file root must be a JSON object.");
  const file = value as Partial<SettingsFileV1>;
  if (file.schema_version === 1 && (file.file_type === "tufft-settings" || file.file_type === "cilia-analysis-settings")) {
    return parseSavedSettingsFile(file, expectedMode);
  }
  const runParameters = value as Partial<JobConfigV1> & { pipeline_params?: Record<string, unknown> };
  if (runParameters.schema_version === 1 && typeof runParameters.analysis_type === "string" && runParameters.pipeline_params && typeof runParameters.pipeline_params === "object") {
    return parseRunParametersFile(runParameters, expectedMode);
  }
  throw new Error("This file is not a supported settings file. Select the parameters.json file from a previous TuFFT run, or a saved TuFFT settings JSON file.");
}

function parseSavedSettingsFile(file: Partial<SettingsFileV1>, expectedMode?: AnalysisMode): ParsedReusableSettings {
  if (file.analysis_mode !== "in_vitro" && file.analysis_mode !== "ex_vivo") throw new Error("Only in-vitro and ex-vivo settings are supported in this release.");
  ensureExpectedMode(file.analysis_mode, expectedMode, "settings file");
  if (!file.settings || typeof file.settings !== "object" || !file.outputs || typeof file.outputs !== "object") {
    throw new Error("Settings file is missing processing or output settings.");
  }
  validateSettingsRecord(file.settings as unknown as Record<string, unknown>);
  validateOutputsRecord(file.outputs as unknown as Record<string, unknown>);
  const outputs: OutputSelection = { ...defaultDraft.outputs, ...file.outputs, logsAndManifest: true };
  return {
    analysisMode: file.analysis_mode,
    settings: {
      ...defaultDraft.settings,
      ...file.settings,
      plotFrequencyMin: file.settings.plotFrequencyMin ?? file.settings.bandLow ?? defaultDraft.settings.bandLow,
      plotFrequencyMax: file.settings.plotFrequencyMax ?? file.settings.bandHigh ?? defaultDraft.settings.bandHigh,
    },
    outputs,
  };
}

function parseRunParametersFile(file: Partial<JobConfigV1> & { pipeline_params?: Record<string, unknown> }, expectedMode?: AnalysisMode): ParsedReusableSettings {
  const analysisMode = file.analysis_type;
  if (analysisMode !== "in_vitro" && analysisMode !== "ex_vivo") {
    throw new Error("parameters.json contains an unsupported analysis_type. Expected in_vitro or ex_vivo.");
  }
  ensureExpectedMode(analysisMode, expectedMode, "parameters.json");
  const params = file.pipeline_params ?? {};
  const outputs = outputsFromRunParameters(analysisMode, params, file.summary_columns, file.tuft_columns);
  const settings = settingsFromRunParameters(analysisMode, params);
  const roiPolygons = analysisMode === "ex_vivo" && isRecord(params.ROI_POLYGONS)
    ? normalizeRoiPolygons(params.ROI_POLYGONS)
    : undefined;
  return {
    analysisMode,
    settings,
    outputs,
    ...(roiPolygons ? { roiPolygons } : {}),
  };
}

function ensureExpectedMode(actual: AnalysisMode, expected: AnalysisMode | undefined, label: string): void {
  if (!expected || actual === expected) return;
  const actualLabel = actual === "ex_vivo" ? "ex-vivo" : "in-vitro";
  const expectedLabel = expected === "ex_vivo" ? "ex-vivo" : "in-vitro";
  throw new Error(`This ${label} is for ${actualLabel} analysis, but the current setup is ${expectedLabel}. Switch the analysis type first, then import this file.`);
}

function settingsFromRunParameters(mode: AnalysisMode, params: Record<string, unknown>): PipelineSettings {
  const settings: PipelineSettings = {
    ...defaultDraft.settings,
    fps: readNumber(params.FPS, mode === "ex_vivo" ? 2000 : defaultDraft.settings.fps),
    frameCount: readFrameCount(params.N_FRAMES, defaultDraft.settings.frameCount),
    roiMode: normalizeRoiMode(params.ROI_MODE, mode),
    radius: readInteger(params.RADIUS, defaultDraft.settings.radius),
    squareWidth: readInteger(params.SQUARE_WIDTH, defaultDraft.settings.squareWidth),
    bandLow: readNumber(params.BAND_LO, defaultDraft.settings.bandLow),
    bandHigh: readNumber(params.BAND_HI, defaultDraft.settings.bandHigh),
    removeDoubling: readBoolean(params.REMOVE_DOUBLING, defaultDraft.settings.removeDoubling),
    halfPowerRatioThreshold: readNumber(params.HALF_POWER_RATIO_THRESH, defaultDraft.settings.halfPowerRatioThreshold),
    useSpatialConsensus: readBoolean(params.USE_SPATIAL_CONSENSUS, defaultDraft.settings.useSpatialConsensus),
    spatialToleranceFraction: readNumber(params.SPATIAL_TOL_FRAC, defaultDraft.settings.spatialToleranceFraction),
    useAutocorrelationFallback: readBoolean(params.USE_AUTOCORR_FALLBACK, defaultDraft.settings.useAutocorrelationFallback),
    useHann: readBoolean(params.USE_HANN, defaultDraft.settings.useHann),
    fftChunkPixels: readInteger(params.FFT_CHUNK_PIXELS, defaultDraft.settings.fftChunkPixels),
    snrThresholdDb: readNumber(params.SNR_THRESH_DB, defaultDraft.settings.snrThresholdDb),
    evidenceGaussianSigma: readNumber(params.EVIDENCE_GAUSSIAN_SIGMA, defaultDraft.settings.evidenceGaussianSigma),
    evidenceThresholdMode: params.EVIDENCE_THRESHOLD_MODE === "manual" ? "manual" : "otsu",
    evidenceManualThreshold: readNumber(params.EVIDENCE_MANUAL_THRESHOLD, defaultDraft.settings.evidenceManualThreshold),
    evidenceOtsuCoefficient: readNumber(params.EVIDENCE_OTSU_COEFFICIENT, defaultDraft.settings.evidenceOtsuCoefficient),
    minTuftSize: readInteger(params.MIN_TUFT_AREA, defaultDraft.settings.minTuftSize),
    maxTuftSize: readInteger(params.MAX_TUFT_SIZE, defaultDraft.settings.maxTuftSize),
    frequencyClusterBinHz: readNumber(params.FREQUENCY_CLUSTER_BIN_HZ, defaultDraft.settings.frequencyClusterBinHz),
    clusterGapClosingIterations: readInteger(params.CLUSTER_GAP_CLOSING_ITERS, defaultDraft.settings.clusterGapClosingIterations),
    clusterHoleFillMaxArea: readInteger(params.CLUSTER_HOLE_FILL_MAX_AREA, defaultDraft.settings.clusterHoleFillMaxArea),
    flatLargeComponentArea: readInteger(params.FLAT_LARGE_COMPONENT_AREA, defaultDraft.settings.flatLargeComponentArea),
    flatToleranceHz: readNumber(params.FLAT_TOL_HZ, defaultDraft.settings.flatToleranceHz),
    flatUniformSubregionMinArea: readInteger(params.FLAT_UNIFORM_SUBREGION_MIN_AREA, defaultDraft.settings.flatUniformSubregionMinArea),
    flatPostPruneMinArea: readInteger(params.FLAT_POST_PRUNE_MIN_AREA, defaultDraft.settings.flatPostPruneMinArea),
    watershedMinPeakDistancePx: readInteger(params.WATERSHED_MIN_PEAK_DISTANCE_PX, defaultDraft.settings.watershedMinPeakDistancePx),
    watershedMinPeakRadiusPx: readNumber(params.WATERSHED_MIN_PEAK_RADIUS_PX, defaultDraft.settings.watershedMinPeakRadiusPx),
    watershedDistanceSigma: readNumber(params.WATERSHED_DISTANCE_SIGMA, defaultDraft.settings.watershedDistanceSigma),
    watershedMaxRecursiveSplits: readInteger(params.WATERSHED_MAX_RECURSIVE_SPLITS, defaultDraft.settings.watershedMaxRecursiveSplits),
    phaseTensorSmoothSigma: readNumber(params.PHASE_TENSOR_SMOOTH_SIGMA, defaultDraft.settings.phaseTensorSmoothSigma),
    computeMetachronalAxis: readBoolean(params.COMPUTE_METACHRONAL_AXIS, defaultDraft.settings.computeMetachronalAxis),
    computeTuftStats: readBoolean(params.COMPUTE_TUFT_STATS, defaultDraft.settings.computeTuftStats),
    knnNeighborValues: Array.isArray(params.KNN_NEIGHBORS) ? formatKnnValues(params.KNN_NEIGHBORS) : defaultDraft.settings.knnNeighborValues,
    cbfSimilarityScaleHz: readNumber(params.CBF_SIMILARITY_SCALE_HZ, defaultDraft.settings.cbfSimilarityScaleHz),
    plotFrequencyMin: readNumber(params.RAW_FREQUENCY_MIN_HZ, readNumber(params.BAND_LO, defaultDraft.settings.bandLow)),
    plotFrequencyMax: readNumber(params.RAW_FREQUENCY_MAX_HZ, readNumber(params.BAND_HI, defaultDraft.settings.bandHigh)),
    rawFftColormap: typeof params.RAW_FREQUENCY_COLORMAP === "string" ? params.RAW_FREQUENCY_COLORMAP : defaultDraft.settings.rawFftColormap,
    outputDpi: readInteger(params.OUTPUT_DPI, defaultDraft.settings.outputDpi),
    exVivoDespeckleMinArea: readInteger(params.EX_VIVO_DESPECKLE_MIN_AREA, defaultDraft.settings.exVivoDespeckleMinArea),
  };
  return settings;
}

function outputsFromRunParameters(mode: AnalysisMode, params: Record<string, unknown>, summaryColumns: unknown, tuftColumns: unknown): OutputSelection {
  const base: OutputSelection = { ...defaultDraft.outputs, logsAndManifest: true };
  const hasSummarySelection = Array.isArray(summaryColumns);
  const hasTuftSelection = Array.isArray(tuftColumns);
  const summary = sanitizeImportedColumns(summaryColumns, mode === "ex_vivo" ? EX_VIVO_SUMMARY_COLUMNS : SUMMARY_METRIC_COLUMNS, mode === "in_vitro");
  const tufts = mode === "in_vitro" ? sanitizeImportedColumns(tuftColumns, TUFT_METRIC_COLUMNS, false) : [];
  if (mode === "ex_vivo") {
    return {
      ...base,
      batchSummary: readBoolean(params.SAVE_BATCH_SUMMARY, true),
      perTuftTable: false,
      rawFftPlot: false,
      rawPhasePlot: false,
      gaussianEvidencePlot: readBoolean(params.PLOT_GAUSSIAN_EVIDENCE, false),
      tuftLabelPlot: false,
      tuftPixelCbfPlot: false,
      tuftDominantCbfPlot: false,
      tuftDominantCbfAxisPlot: false,
      tuftPhaseAxisPlot: false,
      tuftAxisCoherencePlot: false,
      exVivoOriginalPlot: readBoolean(params.PLOT_EX_VIVO_ORIGINAL, true),
      exVivoCbfPlot: readBoolean(params.PLOT_EX_VIVO_CBF, true),
      exVivoPhasePlot: readBoolean(params.PLOT_EX_VIVO_PHASE, true),
      summaryColumns: hasSummarySelection ? summary : [...EX_VIVO_SUMMARY_COLUMNS],
      tuftColumns: [],
    };
  }
  return {
    ...base,
    batchSummary: readBoolean(params.SAVE_BATCH_SUMMARY, true),
    perTuftTable: readBoolean(params.SAVE_TUFT_TABLE, true),
    rawFftPlot: readBoolean(params.PLOT_RAW_FFT, true),
    rawPhasePlot: readBoolean(params.PLOT_RAW_PHASE, true),
    gaussianEvidencePlot: readBoolean(params.PLOT_GAUSSIAN_EVIDENCE, false),
    tuftLabelPlot: readBoolean(params.PLOT_TUFT_LABELS, true),
    tuftPixelCbfPlot: readBoolean(params.PLOT_TUFT_PIXEL_CBF, true),
    tuftDominantCbfPlot: readBoolean(params.PLOT_TUFT_DOMINANT_CBF, true),
    tuftDominantCbfAxisPlot: readBoolean(params.PLOT_TUFT_DOMINANT_CBF_WITH_AXIS, true),
    tuftPhaseAxisPlot: readBoolean(params.PLOT_TUFT_PHASE_AXIS, true),
    tuftAxisCoherencePlot: readBoolean(params.PLOT_TUFT_AXIS_COHERENCE, true),
    summaryColumns: hasSummarySelection ? summary : defaultDraft.outputs.summaryColumns,
    tuftColumns: hasTuftSelection ? tufts : defaultDraft.outputs.tuftColumns,
  };
}

function sanitizeImportedColumns(value: unknown, available: readonly string[], allowDynamicKnn: boolean): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === "string"
    && item !== "video_file"
    && item !== "tag"
    && item !== "status"
    && item !== "error"
    && item !== "tuft_id"
    && (available.includes(item) || (allowDynamicKnn && isKnnSummaryColumn(item))),
  );
}

function normalizeRoiMode(value: unknown, mode: AnalysisMode): RoiMode {
  if (value === "custom" && mode === "ex_vivo") return "custom";
  if (value === "full") return "full";
  if (value === "square" && mode === "in_vitro") return "square";
  if (value === "circle" && mode === "in_vitro") return "circle";
  return mode === "ex_vivo" ? "full" : defaultDraft.settings.roiMode;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? Number(value) : fallback;
}

function readFrameCount(value: unknown, fallback: FrameCountSelection): FrameCountSelection {
  if (typeof value === "string" && value.toLowerCase() === "all") return "all";
  return Number.isInteger(value) && Number(value) >= 4 ? Number(value) : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function formatKnnValues(values: unknown[]): string {
  const parsed = values.filter((value): value is number => Number.isInteger(value) && Number(value) > 0);
  if (!parsed.length) return defaultDraft.settings.knnNeighborValues;
  return parsed.join(",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeRoiPolygons(value: Record<string, unknown>): Record<string, RoiPolygon[]> {
  const output: Record<string, RoiPolygon[]> = {};
  for (const [videoPath, polygons] of Object.entries(value)) {
    if (!Array.isArray(polygons)) continue;
    const normalized = polygons
      .filter((polygon): polygon is unknown[] => Array.isArray(polygon))
      .map((polygon) => polygon
        .filter((point): point is Record<string, unknown> => isRecord(point) && typeof point.x === "number" && typeof point.y === "number")
        .map((point) => ({ x: Number(point.x), y: Number(point.y) })))
      .filter((polygon) => polygon.length >= 3);
    if (normalized.length) output[videoPath] = normalized;
  }
  return output;
}

function validateSettingsRecord(settings: Record<string, unknown>): void {
  const defaults = defaultDraft.settings as unknown as Record<string, unknown>;
  const unknown = Object.keys(settings).filter((key) => !(key in defaults));
  if (unknown.length) throw new Error(`Settings file contains unsupported parameters: ${unknown.join(", ")}.`);
  for (const [key, value] of Object.entries(settings)) {
    if (key === "frameCount") {
      if (value !== "all" && (!Number.isInteger(value) || Number(value) < 4)) {
        throw new Error("Setting frameCount must be 'all' or a whole number of at least 4.");
      }
      continue;
    }
    if (typeof value !== typeof defaults[key]) throw new Error(`Setting ${key} has an incompatible value type.`);
  }
  if (settings.roiMode !== undefined && !["circle", "square", "full", "custom"].includes(String(settings.roiMode))) {
    throw new Error("Settings file contains an unsupported ROI mode.");
  }
}

function validateOutputsRecord(outputs: Record<string, unknown>): void {
  const defaults = defaultDraft.outputs as unknown as Record<string, unknown>;
  const unknown = Object.keys(outputs).filter((key) => !(key in defaults));
  if (unknown.length) throw new Error(`Settings file contains unsupported outputs: ${unknown.join(", ")}.`);
  for (const [key, value] of Object.entries(outputs)) {
    if (key === "summaryColumns" || key === "tuftColumns") {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`Output ${key} must be an array of column names.`);
      }
      const available: readonly string[] = key === "summaryColumns" ? [...SUMMARY_METRIC_COLUMNS, ...EX_VIVO_SUMMARY_COLUMNS] : TUFT_METRIC_COLUMNS;
      const unsupported = value.filter((item) => !available.includes(item) && !(key === "summaryColumns" && isKnnSummaryColumn(item)));
      if (unsupported.length) throw new Error(`Output ${key} contains unsupported columns: ${unsupported.join(", ")}.`);
    } else if (typeof value !== "boolean") {
      throw new Error(`Output ${key} must be true or false.`);
    }
  }
}

export interface JobConfigV1 {
  schema_version: 1;
  job_id: string;
  analysis_type: AnalysisMode;
  input_videos: string[];
  output_root: string;
  video_backend: "imageio";
  pipeline_params: Record<string, unknown>;
  continue_after_error: boolean;
  max_workers: number;
  summary_columns: string[];
  tuft_columns: string[];
}

export interface FirstFramePreview {
  video_path: string;
  width: number;
  height: number;
  display_width: number;
  display_height: number;
  image_data_url: string;
  loop_data_url: string;
  playback_fps?: number;
  source_fps_metadata: number;
  decoder: "imageio-ffmpeg";
}

export interface FftPreview {
  video_path: string;
  decoder: "imageio-ffmpeg";
  requested_frames: number;
  decoded_frames: number;
  width: number;
  height: number;
  fps: number;
  nyquist_hz: number;
  frequency_resolution_hz: number;
  roi_mode: RoiMode;
  radius: number | null;
  square_width: number | null;
  roi_pixel_count: number;
  frequencies_hz: number[];
  mean_power_normalized: number[];
  dominant_histogram_edges_hz: number[];
  dominant_histogram_counts: number[];
  gaussian_evidence_heatmap_data_url: string;
  evidence_threshold: number;
  otsu_threshold: number;
  fft_heatmap_data_url: string;
  band_heatmap_data_url: string;
  snr_heatmap_data_url: string;
  band_mask_overlay_data_url: string;
  snr_mask_overlay_data_url: string;
  cleanup_mask_overlay_data_url: string;
  large_region_mask_overlay_data_url: string;
  despeckle1_mask_overlay_data_url: string;
  watershed_mask_overlay_data_url: string;
  despeckle2_mask_overlay_data_url: string;
  cleanup_heatmap_data_url: string;
  large_region_heatmap_data_url: string;
  despeckle1_heatmap_data_url: string;
  watershed_heatmap_data_url: string;
  despeckle2_heatmap_data_url: string;
  tuft_heatmap_data_url: string | null;
  pixel_phase_heatmap_data_url: string;
  pixel_phase_band_data_url: string | null;
  pixel_phase_masked_data_url: string | null;
  phase_heatmap_data_url: string | null;
  phase_axis_overlay_data_url: string | null;
  band_retained_pixels: number;
  snr_retained_pixels: number;
  cleanup_retained_pixels: number;
  tuft_count: number;
  dedoubled_pixels: number;
  band_low: number;
  band_high: number;
  snr_threshold_db: number | null;
  remove_doubling: boolean;
  half_power_ratio_threshold: number;
  use_spatial_consensus: boolean;
  neighbor_radius: number;
  spatial_tolerance_fraction: number;
  use_autocorrelation_fallback: boolean;
  use_hann: boolean;
}

export const defaultDraft: AnalysisDraft = {
  analysisMode: "in_vitro",
  inputVideos: [],
  sampleVideo: "",
  outputRoot: "",
  maxWorkers: 1,
  roiPolygons: {},
  settings: {
    fps: 500,
    frameCount: 100,
    roiMode: "circle",
    radius: 440,
    squareWidth: 880,
    bandLow: 5,
    bandHigh: 60,
    removeDoubling: true,
    halfPowerRatioThreshold: 0.6,
    useSpatialConsensus: true,
    spatialToleranceFraction: 0.25,
    useAutocorrelationFallback: true,
    useHann: true,
    fftChunkPixels: 8192,
    snrThresholdDb: 7,
    evidenceGaussianSigma: 3,
    evidenceThresholdMode: "otsu",
    evidenceManualThreshold: 0.5,
    evidenceOtsuCoefficient: 0.9,
    minTuftSize: 150,
    maxTuftSize: 800,
    frequencyClusterBinHz: 15,
    clusterGapClosingIterations: 4,
    clusterHoleFillMaxArea: 100,
    flatLargeComponentArea: 8000,
    flatToleranceHz: 5,
    flatUniformSubregionMinArea: 4000,
    flatPostPruneMinArea: 150,
    watershedMinPeakDistancePx: 8,
    watershedMinPeakRadiusPx: 4,
    watershedDistanceSigma: 1,
    watershedMaxRecursiveSplits: 10,
    phaseTensorSmoothSigma: 1,
    computeMetachronalAxis: true,
    computeTuftStats: true,
    knnNeighborValues: "5-10",
    cbfSimilarityScaleHz: 5,
    plotFrequencyMin: 5,
    plotFrequencyMax: 60,
    rawFftColormap: "viridis",
    outputDpi: 600,
    exVivoDespeckleMinArea: 150,
  },
  outputs: {
    batchSummary: true,
    perTuftTable: true,
    rawFftPlot: true,
    rawPhasePlot: true,
    gaussianEvidencePlot: false,
    tuftLabelPlot: true,
    tuftPixelCbfPlot: true,
    tuftDominantCbfPlot: true,
    tuftDominantCbfAxisPlot: true,
    tuftPhaseAxisPlot: true,
    tuftAxisCoherencePlot: true,
    exVivoOriginalPlot: true,
    exVivoCbfPlot: true,
    exVivoPhasePlot: true,
    logsAndManifest: true,
    summaryColumns: SUMMARY_METRIC_COLUMNS.filter((column) =>
      !column.startsWith("knn")
    ),
    tuftColumns: TUFT_METRIC_COLUMNS.filter((column) =>
      column !== "joint_peak_fwhm_hz"
      && column !== "joint_power_weighted_std_hz",
    ),
  },
};

export const defaultAdvancedSettings: Pick<PipelineSettings,
  | "snrThresholdDb"
  | "evidenceGaussianSigma"
  | "evidenceThresholdMode"
  | "evidenceManualThreshold"
  | "evidenceOtsuCoefficient"
  | "removeDoubling"
  | "halfPowerRatioThreshold"
  | "useSpatialConsensus"
  | "spatialToleranceFraction"
  | "useAutocorrelationFallback"
  | "fftChunkPixels"
  | "frequencyClusterBinHz"
  | "clusterGapClosingIterations"
  | "clusterHoleFillMaxArea"
  | "flatLargeComponentArea"
  | "flatToleranceHz"
  | "flatUniformSubregionMinArea"
  | "flatPostPruneMinArea"
  | "watershedMinPeakDistancePx"
  | "watershedMinPeakRadiusPx"
  | "watershedDistanceSigma"
  | "watershedMaxRecursiveSplits"
  | "phaseTensorSmoothSigma"
  | "computeTuftStats"
  | "knnNeighborValues"
  | "cbfSimilarityScaleHz"
  | "exVivoDespeckleMinArea"
> = {
  snrThresholdDb: defaultDraft.settings.snrThresholdDb,
  evidenceGaussianSigma: defaultDraft.settings.evidenceGaussianSigma,
  evidenceThresholdMode: defaultDraft.settings.evidenceThresholdMode,
  evidenceManualThreshold: defaultDraft.settings.evidenceManualThreshold,
  evidenceOtsuCoefficient: defaultDraft.settings.evidenceOtsuCoefficient,
  removeDoubling: defaultDraft.settings.removeDoubling,
  halfPowerRatioThreshold: defaultDraft.settings.halfPowerRatioThreshold,
  useSpatialConsensus: defaultDraft.settings.useSpatialConsensus,
  spatialToleranceFraction: defaultDraft.settings.spatialToleranceFraction,
  useAutocorrelationFallback: defaultDraft.settings.useAutocorrelationFallback,
  fftChunkPixels: defaultDraft.settings.fftChunkPixels,
  frequencyClusterBinHz: defaultDraft.settings.frequencyClusterBinHz,
  clusterGapClosingIterations: defaultDraft.settings.clusterGapClosingIterations,
  clusterHoleFillMaxArea: defaultDraft.settings.clusterHoleFillMaxArea,
  flatLargeComponentArea: defaultDraft.settings.flatLargeComponentArea,
  flatToleranceHz: defaultDraft.settings.flatToleranceHz,
  flatUniformSubregionMinArea: defaultDraft.settings.flatUniformSubregionMinArea,
  flatPostPruneMinArea: defaultDraft.settings.flatPostPruneMinArea,
  watershedMinPeakDistancePx: defaultDraft.settings.watershedMinPeakDistancePx,
  watershedMinPeakRadiusPx: defaultDraft.settings.watershedMinPeakRadiusPx,
  watershedDistanceSigma: defaultDraft.settings.watershedDistanceSigma,
  watershedMaxRecursiveSplits: defaultDraft.settings.watershedMaxRecursiveSplits,
    phaseTensorSmoothSigma: defaultDraft.settings.phaseTensorSmoothSigma,
    computeTuftStats: defaultDraft.settings.computeTuftStats,
    knnNeighborValues: defaultDraft.settings.knnNeighborValues,
  cbfSimilarityScaleHz: defaultDraft.settings.cbfSimilarityScaleHz,
  exVivoDespeckleMinArea: defaultDraft.settings.exVivoDespeckleMinArea,
};

export function toJobConfig(draft: AnalysisDraft, jobId: string): JobConfigV1 {
  const settings = draft.settings;
  const outputs = draft.outputs;
  if (draft.analysisMode === "ex_vivo") {
    return {
      schema_version: 1,
      job_id: jobId,
      analysis_type: "ex_vivo",
      input_videos: draft.inputVideos,
      output_root: draft.outputRoot,
      video_backend: "imageio",
      pipeline_params: {
        FPS: settings.fps,
        N_FRAMES: settings.frameCount,
        ROI_MODE: settings.roiMode === "custom" ? "custom" : "full",
        ROI_POLYGONS: settings.roiMode === "custom" ? draft.roiPolygons : {},
        BAND_LO: settings.bandLow,
        BAND_HI: settings.bandHigh,
        USE_HANN: settings.useHann,
        FFT_CHUNK_PIXELS: settings.fftChunkPixels,
        REMOVE_DOUBLING: settings.removeDoubling,
        HALF_POWER_RATIO_THRESH: settings.halfPowerRatioThreshold,
        USE_SPATIAL_CONSENSUS: settings.useSpatialConsensus,
        SPATIAL_TOL_FRAC: settings.spatialToleranceFraction,
        USE_AUTOCORR_FALLBACK: settings.useAutocorrelationFallback,
        SNR_THRESH_DB: settings.snrThresholdDb,
        EVIDENCE_GAUSSIAN_SIGMA: settings.evidenceGaussianSigma,
        EVIDENCE_THRESHOLD_MODE: settings.evidenceThresholdMode,
        EVIDENCE_MANUAL_THRESHOLD: settings.evidenceManualThreshold,
        EVIDENCE_OTSU_COEFFICIENT: settings.evidenceOtsuCoefficient,
        EX_VIVO_DESPECKLE_MIN_AREA: settings.exVivoDespeckleMinArea,
        OUTPUT_DPI: settings.outputDpi,
        RAW_FREQUENCY_MIN_HZ: settings.plotFrequencyMin,
        RAW_FREQUENCY_MAX_HZ: settings.plotFrequencyMax,
        RAW_FREQUENCY_COLORMAP: settings.rawFftColormap,
        PLOT_GAUSSIAN_EVIDENCE: outputs.gaussianEvidencePlot,
        PLOT_EX_VIVO_ORIGINAL: outputs.exVivoOriginalPlot,
        PLOT_EX_VIVO_CBF: outputs.exVivoCbfPlot,
        PLOT_EX_VIVO_PHASE: outputs.exVivoPhasePlot,
        SAVE_BATCH_SUMMARY: outputs.batchSummary,
      },
      continue_after_error: true,
      max_workers: draft.maxWorkers,
      summary_columns: outputs.summaryColumns,
      tuft_columns: [],
    };
  }
  const selectedColumns = [...outputs.summaryColumns, ...outputs.tuftColumns];
  const needsAxisMetrics = outputs.tuftAxisCoherencePlot
    || outputs.tuftPhaseAxisPlot
    || outputs.tuftDominantCbfAxisPlot
    || selectedColumns.some((column) => column.includes("tensor") || column.includes("angle"));
  const needsTuftStats = outputs.perTuftTable
    || outputs.batchSummary
    || outputs.tuftLabelPlot
    || outputs.tuftPixelCbfPlot
    || outputs.tuftDominantCbfPlot
    || outputs.tuftDominantCbfAxisPlot
    || outputs.tuftPhaseAxisPlot
    || outputs.tuftAxisCoherencePlot
    || needsAxisMetrics;
  return {
    schema_version: 1,
    job_id: jobId,
    analysis_type: "in_vitro",
    input_videos: draft.inputVideos,
    output_root: draft.outputRoot,
    video_backend: "imageio",
    pipeline_params: {
      FPS: settings.fps,
      N_FRAMES: settings.frameCount,
      H_EXPECT: null,
      W_EXPECT: null,
      ROI_MODE: settings.roiMode,
      RADIUS: settings.roiMode === "circle" ? settings.radius : null,
      SQUARE_WIDTH: settings.roiMode === "square" ? settings.squareWidth : null,
      BAND_LO: settings.bandLow,
      BAND_HI: settings.bandHigh,
      REMOVE_DOUBLING: settings.removeDoubling,
      HALF_POWER_RATIO_THRESH: settings.halfPowerRatioThreshold,
      USE_SPATIAL_CONSENSUS: settings.useSpatialConsensus,
      SPATIAL_TOL_FRAC: settings.spatialToleranceFraction,
      USE_AUTOCORR_FALLBACK: settings.useAutocorrelationFallback,
      USE_HANN: settings.useHann,
      FFT_CHUNK_PIXELS: settings.fftChunkPixels,
      SNR_THRESH_DB: settings.snrThresholdDb,
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
      COMPUTE_METACHRONAL_AXIS: needsAxisMetrics,
      COMPUTE_TUFT_STATS: needsTuftStats,
      KNN_NEIGHBORS: parseKnnNeighborValues(settings.knnNeighborValues),
      CBF_SIMILARITY_SCALE_HZ: settings.cbfSimilarityScaleHz,
      OUTPUT_DPI: settings.outputDpi,
      RAW_FREQUENCY_MIN_HZ: settings.plotFrequencyMin,
      RAW_FREQUENCY_MAX_HZ: settings.plotFrequencyMax,
      RAW_FREQUENCY_COLORMAP: settings.rawFftColormap,
      SAVE_BATCH_SUMMARY: outputs.batchSummary,
      SAVE_TUFT_TABLE: outputs.perTuftTable,
      PLOT_RAW_FFT: outputs.rawFftPlot,
      PLOT_RAW_PHASE: outputs.rawPhasePlot,
      PLOT_GAUSSIAN_EVIDENCE: outputs.gaussianEvidencePlot,
      PLOT_TUFT_LABELS: outputs.tuftLabelPlot,
      PLOT_TUFT_PIXEL_CBF: outputs.tuftPixelCbfPlot,
      PLOT_TUFT_DOMINANT_CBF: outputs.tuftDominantCbfPlot,
      PLOT_TUFT_DOMINANT_CBF_WITH_AXIS: outputs.tuftDominantCbfAxisPlot,
      PLOT_TUFT_PHASE_AXIS: outputs.tuftPhaseAxisPlot,
      PLOT_TUFT_AXIS_COHERENCE: outputs.tuftAxisCoherencePlot,
    },
    continue_after_error: true,
    max_workers: draft.maxWorkers,
    summary_columns: outputs.summaryColumns,
    tuft_columns: outputs.tuftColumns,
  };
}

export function previewSignature(draft: AnalysisDraft): string {
  const settings = draft.settings;
  return JSON.stringify({
    video: draft.sampleVideo,
    fps: settings.fps,
    frameCount: settings.frameCount,
    roiMode: settings.roiMode,
    radius: settings.roiMode === "circle" ? settings.radius : null,
    squareWidth: settings.roiMode === "square" ? settings.squareWidth : null,
    roiPolygons: settings.roiMode === "custom" ? draft.roiPolygons[draft.sampleVideo] ?? [] : null,
    useHann: settings.useHann,
  });
}

export function analysisPreviewSignature(settings: PipelineSettings): string {
  const {
    plotFrequencyMin: _plotFrequencyMin,
    plotFrequencyMax: _plotFrequencyMax,
    rawFftColormap: _rawFftColormap,
    outputDpi: _outputDpi,
    knnNeighborValues: _knnNeighborValues,
    fftChunkPixels: _fftChunkPixels,
    ...previewSettings
  } = settings;
  return JSON.stringify(previewSettings);
}

import { parseKnnNeighborValues, type AnalysisDraft, type FirstFramePreview } from "./job";

export function validateSettingsConfiguration(
  draft: AnalysisDraft,
  framePreview: FirstFramePreview | null,
): string[] {
  const settings = draft.settings;
  const errors: string[] = [];
  if (!Number.isFinite(settings.fps) || settings.fps <= 0) {
    errors.push("Frame rate must be greater than zero.");
  }
  if (settings.frameCount !== "all" && (!Number.isInteger(settings.frameCount) || settings.frameCount < 4)) {
    errors.push("Frame count must be All or a whole number of at least 4.");
  }
  if (Number.isFinite(settings.fps) && settings.fps > 0 && typeof settings.frameCount === "number" && Number.isInteger(settings.frameCount) && settings.frameCount >= 4 && !hasFftBinInRange(settings.fps, settings.frameCount, 5, 80)) {
    errors.push("Frame rate and frame count must provide at least one FFT bin in the internal 5-80 Hz cilia evidence band.");
  }
  if (draft.analysisMode === "ex_vivo" && !["full", "custom"].includes(settings.roiMode)) {
    errors.push("Ex-vivo analysis supports full-frame or custom per-video ROIs.");
  }
  if (draft.analysisMode === "ex_vivo" && settings.roiMode === "custom") {
    const missing = draft.inputVideos.filter((path) => !(draft.roiPolygons[path] ?? []).some((polygon) => polygon.length >= 3));
    if (missing.length) errors.push(`Draw and save a custom ROI for every video (${missing.length} remaining).`);
  }
  if (settings.roiMode === "circle") {
    if (!Number.isInteger(settings.radius) || settings.radius <= 0) {
      errors.push("Circle radius must be a positive whole number.");
    }
    if (framePreview && settings.radius > Math.floor(Math.min(framePreview.width, framePreview.height) / 2)) {
      errors.push("Circle radius exceeds the centered-frame boundary.");
    }
  }
  if (settings.roiMode === "square") {
    if (!Number.isInteger(settings.squareWidth) || settings.squareWidth <= 0) {
      errors.push("Square width must be a positive whole number.");
    }
    if (framePreview && settings.squareWidth > Math.min(framePreview.width, framePreview.height)) {
      errors.push("Square width exceeds the centered-frame boundary.");
    }
  }
  if (settings.bandLow < 0 || settings.bandHigh <= settings.bandLow) {
    errors.push("The upper CBF bound must be greater than the lower bound.");
  }
  if (Number.isFinite(settings.fps) && settings.bandHigh > settings.fps / 2) {
    errors.push(`The upper CBF bound cannot exceed the ${formatNumber(settings.fps / 2)} Hz Nyquist limit.`);
  }

  requireFraction(errors, settings.halfPowerRatioThreshold, "Half-power ratio threshold");
  requireFraction(errors, settings.spatialToleranceFraction, "Spatial tolerance fraction");
  if (!Number.isInteger(settings.fftChunkPixels) || settings.fftChunkPixels < 256 || settings.fftChunkPixels > 32768) {
    errors.push("FFT pixel chunk maximum must be a whole number from 256 to 32,768.");
  }
  requirePositive(errors, settings.snrThresholdDb, "SNR threshold");
  requireNonNegative(errors, settings.evidenceGaussianSigma, "Gaussian evidence sigma");
  if (!["otsu", "manual"].includes(settings.evidenceThresholdMode)) errors.push("Evidence threshold mode must be Otsu or manual.");
  requireFraction(errors, settings.evidenceManualThreshold, "Manual evidence threshold");
  requireFraction(errors, settings.evidenceOtsuCoefficient, "Otsu coefficient");
  requirePositiveInteger(errors, settings.minTuftSize, "Minimum tuft size");
  requirePositiveInteger(errors, settings.maxTuftSize, "Maximum tuft size");
  if (settings.maxTuftSize <= settings.minTuftSize) errors.push("Maximum tuft size should be greater than minimum tuft size.");
  requirePositive(errors, settings.frequencyClusterBinHz, "Frequency clustering width");
  requirePositiveInteger(errors, settings.clusterGapClosingIterations, "Cluster gap-closing iterations");
  requirePositiveInteger(errors, settings.clusterHoleFillMaxArea, "Cluster hole-fill maximum area");
  requirePositiveInteger(errors, settings.flatLargeComponentArea, "Flat-region large component area");
  requirePositive(errors, settings.flatToleranceHz, "Flat-region frequency tolerance");
  requirePositiveInteger(errors, settings.flatUniformSubregionMinArea, "Flat-region uniform subregion minimum");
  requirePositiveInteger(errors, settings.flatPostPruneMinArea, "Post-prune despeckle minimum");
  requirePositiveInteger(errors, settings.watershedMinPeakDistancePx, "Watershed minimum peak distance");
  requirePositive(errors, settings.watershedMinPeakRadiusPx, "Watershed minimum peak radius");
  requireNonNegative(errors, settings.watershedDistanceSigma, "Watershed distance smoothing sigma");
  requirePositiveInteger(errors, settings.watershedMaxRecursiveSplits, "Maximum watershed recursive splits");
  requireNonNegative(errors, settings.phaseTensorSmoothSigma, "Phase tensor smoothing sigma");
  requirePositive(errors, settings.cbfSimilarityScaleHz, "CBF neighbor similarity scale");
  requirePositiveInteger(errors, settings.exVivoDespeckleMinArea, "Ex-vivo despeckle minimum");
  try {
    parseKnnNeighborValues(settings.knnNeighborValues);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Planar-alignment neighbour values must be valid positive whole numbers.");
  }
  return [...new Set(errors)];
}

export function validateOutputSettings(draft: AnalysisDraft): string[] {
  const settings = draft.settings;
  const errors: string[] = [];
  if (settings.plotFrequencyMin < 0 || settings.plotFrequencyMax <= settings.plotFrequencyMin) {
    errors.push("Plot frequency maximum must be greater than its non-negative minimum.");
  }
  if (!["viridis", "turbo", "magma", "plasma", "gray"].includes(settings.rawFftColormap)) {
    errors.push("Raw FFT colormap must be one of the available color scales.");
  }
  requirePositiveInteger(errors, settings.outputDpi, "Output DPI");
  return errors;
}

export function validatePreviewInputs(
  draft: AnalysisDraft,
  framePreview: FirstFramePreview | null,
): string[] {
  const errors: string[] = [];
  const settings = draft.settings;
  if (!draft.sampleVideo) errors.push("Select a representative sample video.");
  if (!Number.isFinite(settings.fps) || settings.fps <= 0) errors.push("Frame rate must be greater than zero.");
  if (settings.frameCount !== "all" && (!Number.isInteger(settings.frameCount) || settings.frameCount < 4)) {
    errors.push("Frame count must be All or a whole number of at least 4.");
  }
  if (Number.isFinite(settings.fps) && settings.fps > 0 && typeof settings.frameCount === "number" && Number.isInteger(settings.frameCount) && settings.frameCount >= 4 && !hasFftBinInRange(settings.fps, settings.frameCount, 5, 80)) {
    errors.push("Frame rate and frame count must provide at least one FFT bin in the internal 5-80 Hz cilia evidence band.");
  }
  if (draft.analysisMode === "ex_vivo") return errors;
  if (settings.roiMode === "circle") {
    if (!Number.isInteger(settings.radius) || settings.radius <= 0) errors.push("Circle radius must be positive.");
    if (framePreview && settings.radius > Math.floor(Math.min(framePreview.width, framePreview.height) / 2)) {
      errors.push("Circle radius exceeds the centered-frame boundary.");
    }
  }
  if (settings.roiMode === "square") {
    if (!Number.isInteger(settings.squareWidth) || settings.squareWidth <= 0) errors.push("Square width must be positive.");
    if (framePreview && settings.squareWidth > Math.min(framePreview.width, framePreview.height)) {
      errors.push("Square width exceeds the centered-frame boundary.");
    }
  }
  return errors;
}

function requirePositive(errors: string[], value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) errors.push(`${label} must be greater than zero.`);
}

function requireNonNegative(errors: string[], value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) errors.push(`${label} cannot be negative.`);
}

function requirePositiveInteger(errors: string[], value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) errors.push(`${label} must be a positive whole number.`);
}

function requireFraction(errors: string[], value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`${label} must be between 0 and 1.`);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

function hasFftBinInRange(fps: number, frameCount: number, lowHz: number, highHz: number): boolean {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isInteger(frameCount) || frameCount < 2) return false;
  const spacing = fps / frameCount;
  const upper = Math.min(highHz, fps / 2);
  const firstBin = Math.ceil(lowHz / spacing);
  const lastBin = Math.floor(upper / spacing);
  return Math.max(1, firstBin) <= lastBin;
}

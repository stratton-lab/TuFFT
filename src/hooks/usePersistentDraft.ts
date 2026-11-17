import { useEffect, useState } from "react";
import { EX_VIVO_SUMMARY_COLUMNS, SUMMARY_METRIC_COLUMNS, TUFT_METRIC_COLUMNS, isKnnSummaryColumn, type AnalysisDraft, defaultDraft } from "../types/job";

const storageKey = "tufft-draft-v1";

function readStoredDraft(): AnalysisDraft {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return defaultDraft;
    const parsed = JSON.parse(stored) as Partial<AnalysisDraft>;
    const summaryColumns = sanitizeColumns(parsed.outputs?.summaryColumns, [...SUMMARY_METRIC_COLUMNS, ...EX_VIVO_SUMMARY_COLUMNS], defaultDraft.outputs.summaryColumns, true);
    const tuftColumns = sanitizeColumns(parsed.outputs?.tuftColumns, TUFT_METRIC_COLUMNS, defaultDraft.outputs.tuftColumns, false);
    return {
      ...defaultDraft,
      ...parsed,
      settings: { ...defaultDraft.settings, ...parsed.settings },
      roiPolygons: parsed.roiPolygons ?? {},
      outputs: {
        batchSummary: parsed.outputs?.batchSummary ?? defaultDraft.outputs.batchSummary,
        perTuftTable: parsed.outputs?.perTuftTable ?? defaultDraft.outputs.perTuftTable,
        rawFftPlot: parsed.outputs?.rawFftPlot ?? defaultDraft.outputs.rawFftPlot,
        rawPhasePlot: parsed.outputs?.rawPhasePlot ?? defaultDraft.outputs.rawPhasePlot,
        gaussianEvidencePlot: parsed.outputs?.gaussianEvidencePlot ?? defaultDraft.outputs.gaussianEvidencePlot,
        tuftLabelPlot: parsed.outputs?.tuftLabelPlot ?? defaultDraft.outputs.tuftLabelPlot,
        tuftPixelCbfPlot: parsed.outputs?.tuftPixelCbfPlot ?? defaultDraft.outputs.tuftPixelCbfPlot,
        tuftDominantCbfPlot: parsed.outputs?.tuftDominantCbfPlot ?? defaultDraft.outputs.tuftDominantCbfPlot,
        tuftDominantCbfAxisPlot: parsed.outputs?.tuftDominantCbfAxisPlot ?? defaultDraft.outputs.tuftDominantCbfAxisPlot,
        tuftPhaseAxisPlot: parsed.outputs?.tuftPhaseAxisPlot ?? defaultDraft.outputs.tuftPhaseAxisPlot,
        tuftAxisCoherencePlot: parsed.outputs?.tuftAxisCoherencePlot ?? defaultDraft.outputs.tuftAxisCoherencePlot,
        exVivoOriginalPlot: parsed.outputs?.exVivoOriginalPlot ?? defaultDraft.outputs.exVivoOriginalPlot,
        exVivoCbfPlot: parsed.outputs?.exVivoCbfPlot ?? defaultDraft.outputs.exVivoCbfPlot,
        exVivoPhasePlot: parsed.outputs?.exVivoPhasePlot ?? defaultDraft.outputs.exVivoPhasePlot,
        logsAndManifest: true,
        summaryColumns,
        tuftColumns,
      },
    };
  } catch {
    return defaultDraft;
  }
}

function sanitizeColumns(stored: unknown, available: readonly string[], fallback: string[], allowDynamicKnn: boolean): string[] {
  if (!Array.isArray(stored)) return fallback;
  const filtered = stored.filter((value): value is string => typeof value === "string" && (available.includes(value) || (allowDynamicKnn && isKnnSummaryColumn(value))));
  return filtered.length > 1 ? filtered : fallback;
}

export function usePersistentDraft() {
  const [draft, setDraft] = useState<AnalysisDraft>(readStoredDraft);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft]);

  const resetDraft = () => {
    window.localStorage.removeItem(storageKey);
    setDraft(defaultDraft);
  };

  return { draft, setDraft, resetDraft };
}

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ArrowLeft, ArrowRight, Play, RotateCcw, Square } from "lucide-react";
import { type SetupStep, StepNavigation } from "./components/StepNavigation";
import type { PreviewStage } from "./components/AnalysisPreviewRail";
import { InputsStep } from "./components/steps/InputsStep";
import { ExVivoSettingsStep } from "./components/steps/ExVivoSettingsStep";
import { ModeStep } from "./components/steps/ModeStep";
import { OutputsStep } from "./components/steps/OutputsStep";
import { ReviewStep } from "./components/steps/ReviewStep";
import { SettingsStep } from "./components/steps/SettingsStep";
import { useAnalysisJob } from "./hooks/useAnalysisJob";
import { usePersistentDraft } from "./hooks/usePersistentDraft";
import {
  discoverVideoInputs,
  cancelFftPreview,
  isDesktopRuntime,
  loadFftPreview,
  loadFirstFramePreview,
  loadVideoLoopPreview,
  loadSettingsFile,
  selectInputDirectories,
  selectOutputDirectory,
  selectVideoFiles,
} from "./services/desktop";
import {
  type AnalysisDraft,
  type FftPreview,
  type FirstFramePreview,
  EX_VIVO_SUMMARY_COLUMNS,
  defaultDraft,
  analysisPreviewSignature,
  previewSignature,
  parseSettingsFile,
  toJobConfig,
} from "./types/job";
import { validateOutputSettings, validateSettingsConfiguration } from "./types/validation";
import { normalizeVideoPath as normalizePathKey } from "./utils/paths";
import "./styles.css";

const steps: SetupStep[] = [
  { id: "mode", label: "Analysis type" },
  { id: "inputs", label: "Videos and output" },
  { id: "settings", label: "Analysis settings" },
  { id: "outputs", label: "Outputs" },
  { id: "review", label: "Review and run" },
];

function App() {
  const { draft, setDraft, resetDraft } = usePersistentDraft();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [furthestIndex, setFurthestIndex] = useState(0);
  const [inputNotice, setInputNotice] = useState<string | null>(null);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [framePreview, setFramePreview] = useState<FirstFramePreview | null>(null);
  const [frameLoading, setFrameLoading] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [fftPreview, setFftPreview] = useState<FftPreview | null>(null);
  const [fftPreviewSignature, setFftPreviewSignature] = useState<string | null>(null);
  const [analysisPreviewSettingsSignature, setAnalysisPreviewSettingsSignature] = useState<string | null>(null);
  const [fftLoading, setFftLoading] = useState(false);
  const [fftError, setFftError] = useState<string | null>(null);
  const [settingsFileNotice, setSettingsFileNotice] = useState<string | null>(null);
  const [computedPreviewStage, setComputedPreviewStage] = useState<PreviewStage | null>(null);
  const fftPreviewIdRef = useRef<string | null>(null);
  const framePreviewRequestRef = useRef<string | null>(null);
  const loopPreviewRequestRef = useRef<string | null>(null);
  const inputRequestRef = useRef(0);
  const analysisJob = useAnalysisJob();
  const setSettingsDraft = useCallback<Dispatch<SetStateAction<AnalysisDraft>>>((action) => {
    setDraft((current) => {
      const next = typeof action === "function" ? action(current) : action;
      if (next.settings.bandLow === current.settings.bandLow && next.settings.bandHigh === current.settings.bandHigh) return next;
      // Only band edits reset the output range; downstream overrides stay independent.
      return {
        ...next,
        settings: { ...next.settings, plotFrequencyMin: next.settings.bandLow, plotFrequencyMax: next.settings.bandHigh },
      };
    });
  }, [setDraft]);

  useEffect(() => {
    if (draft.inputVideos.length === 0 && draft.sampleVideo) {
      setDraft((value) => ({ ...value, sampleVideo: "" }));
    } else if (draft.inputVideos.length > 0 && !draft.inputVideos.includes(draft.sampleVideo)) {
      setDraft((value) => ({ ...value, sampleVideo: value.inputVideos[0] }));
    }
  }, [draft.inputVideos, draft.sampleVideo, setDraft]);

  useEffect(() => {
    if (currentIndex !== 2 || !draft.sampleVideo || !isDesktopRuntime()) return;
    const sampleKey = normalizePathKey(draft.sampleVideo);
    if (framePreview && normalizePathKey(framePreview.video_path) === sampleKey) return;
    const requestId = crypto.randomUUID();
    let cancelled = false;
    framePreviewRequestRef.current = requestId;
    setFrameLoading(true);
    setFrameError(null);
    setFramePreview(null);
    void loadFirstFramePreview(draft.sampleVideo)
      .then((preview) => {
        if (!cancelled && framePreviewRequestRef.current === requestId && normalizePathKey(preview.video_path) === sampleKey) setFramePreview(preview);
      })
      .catch((error) => {
        if (!cancelled && framePreviewRequestRef.current === requestId) {
          setFramePreview(null);
          setFrameError(String(error));
        }
      })
      .finally(() => {
        if (!cancelled && framePreviewRequestRef.current === requestId) {
          framePreviewRequestRef.current = null;
          setFrameLoading(false);
        }
      });
    return () => {
      cancelled = true;
      if (framePreviewRequestRef.current === requestId) framePreviewRequestRef.current = null;
    };
  }, [currentIndex, draft.sampleVideo]);

  useEffect(() => {
    if (currentIndex !== 2 || !isDesktopRuntime() || !framePreview) return;
    if (framePreview.loop_data_url && framePreview.loop_data_url !== framePreview.image_data_url) return;
    const sampleKey = normalizePathKey(draft.sampleVideo);
    if (normalizePathKey(framePreview.video_path) !== sampleKey) return;
    const requestId = crypto.randomUUID();
    loopPreviewRequestRef.current = requestId;
    let cancelled = false;
    void loadVideoLoopPreview(draft.sampleVideo)
      .then((preview) => {
        if (cancelled || loopPreviewRequestRef.current !== requestId || normalizePathKey(preview.video_path) !== sampleKey) return;
        setFramePreview((current) => !cancelled && loopPreviewRequestRef.current === requestId
          && current && normalizePathKey(current.video_path) === sampleKey && current.image_data_url === framePreview.image_data_url
          ? { ...current, loop_data_url: preview.loop_data_url, playback_fps: preview.playback_fps }
          : current);
      })
      .catch((error) => {
        if (!cancelled && loopPreviewRequestRef.current === requestId) {
          setFrameError(`Motion preview unavailable. The still preview remains available for ROI drawing. ${String(error)}`);
        }
      });
    return () => {
      cancelled = true;
      if (loopPreviewRequestRef.current === requestId) loopPreviewRequestRef.current = null;
    };
  }, [currentIndex, draft.sampleVideo, framePreview?.video_path, framePreview?.image_data_url]);

  useEffect(() => {
    const workspace = document.querySelector(".workspace");
    workspace?.scrollTo({ top: 0, behavior: "auto" });
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [currentIndex]);

  const currentPreviewSignature = previewSignature(draft);
  const fftPreviewIsCurrent = Boolean(fftPreview && fftPreviewSignature === currentPreviewSignature);
  const outputErrors = useMemo(() => validateOutputSettings(draft), [draft]);
  const settingsConfigurationErrors = useMemo(
    () => validateSettingsConfiguration(draft, framePreview),
    [draft, framePreview],
  );
  const jobRunning = analysisJob.status === "running" || analysisJob.status === "starting";
  const stepValid = [
    draft.analysisMode === "in_vitro" || draft.analysisMode === "ex_vivo",
    draft.inputVideos.length > 0 && draft.outputRoot.length > 0,
    settingsConfigurationErrors.length === 0,
    Object.entries(draft.outputs).some(([key, enabled]) => key !== "logsAndManifest" && typeof enabled === "boolean" && enabled) && outputErrors.length === 0,
    settingsConfigurationErrors.length === 0 && outputErrors.length === 0 && Number.isInteger(draft.maxWorkers) && draft.maxWorkers >= 1,
  ];

  const updateDraft = (patch: Partial<AnalysisDraft>) => setDraft((value) => ({ ...value, ...patch }));
  const chooseAnalysisMode = (analysisMode: AnalysisDraft["analysisMode"]) => {
    setDraft((value) => ({
      ...value,
      analysisMode,
      settings: {
        ...value.settings,
        roiMode: analysisMode === "ex_vivo" ? "full" : value.settings.roiMode === "custom" ? "circle" : value.settings.roiMode,
        fps: analysisMode === "ex_vivo" ? 2000 : analysisMode === "in_vitro" && value.analysisMode === "ex_vivo" ? defaultDraft.settings.fps : value.settings.fps,
      },
      outputs: analysisMode === "ex_vivo"
        ? {
            ...value.outputs,
            batchSummary: true,
            perTuftTable: false,
            tuftLabelPlot: false,
            tuftPixelCbfPlot: false,
            tuftDominantCbfPlot: false,
            tuftDominantCbfAxisPlot: false,
            tuftPhaseAxisPlot: false,
            tuftAxisCoherencePlot: false,
            exVivoOriginalPlot: true,
            exVivoCbfPlot: true,
            exVivoPhasePlot: true,
            summaryColumns: [...EX_VIVO_SUMMARY_COLUMNS],
            tuftColumns: [],
          }
        : defaultDraft.outputs,
    }));
    setFftPreview(null);
    setComputedPreviewStage(null);
  };
  const mergeVideos = (paths: string[]) => {
    if (!paths.length) return;
    setDraft((value) => {
      const unique = new Map<string, string>();
      for (const path of [...value.inputVideos, ...paths]) {
        const key = normalizePathKey(path);
        if (!unique.has(key)) unique.set(key, path);
      }
      const merged = [...unique.values()].sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" }),
      );
      return { ...value, inputVideos: merged, sampleVideo: value.sampleVideo || merged[0] };
    });
  };

  const settingsAreDefault = JSON.stringify(draft.settings) === JSON.stringify(defaultDraft.settings);
  const settingsPreviewReady = draft.analysisMode === "ex_vivo"
    ? computedPreviewStage === "filter" && fftPreviewIsCurrent && analysisPreviewSettingsSignature === analysisPreviewSignature(draft.settings)
    : computedPreviewStage === "phase" && fftPreviewIsCurrent && analysisPreviewSettingsSignature === analysisPreviewSignature(draft.settings);
  const canContinueCurrentStep = currentIndex === 2
    ? settingsConfigurationErrors.length === 0 && !frameLoading
    : stepValid[currentIndex];

  const cancelRunningPreview = () => {
    const previewId = fftPreviewIdRef.current;
    if (!previewId) return;
    fftPreviewIdRef.current = null;
    void cancelFftPreview(previewId);
    setFftLoading(false);
  };

  const selectStep = (index: number) => {
    if (jobRunning) return;
    if (index !== currentIndex && currentIndex === 2) cancelRunningPreview();
    setCurrentIndex(index);
  };

  const next = () => {
    if (!canContinueCurrentStep) return;
    if (currentIndex === 2) cancelRunningPreview();
    const nextIndex = Math.min(currentIndex + 1, steps.length - 1);
    setCurrentIndex(nextIndex);
    setFurthestIndex((value) => Math.max(value, nextIndex));
  };

  const chooseVideos = async () => {
    const paths = await selectVideoFiles();
    if (paths.length) {
      mergeVideos(paths);
      setInputNotice(`${paths.length} video file${paths.length === 1 ? "" : "s"} added.`);
    } else if (!isDesktopRuntime()) {
      setInputNotice("Native video selection is available in the desktop window.");
    }
  };

  const addVideoInputs = async (selectPaths: () => Promise<string[]>, source: "selected folder" | "dropped item") => {
    const request = ++inputRequestRef.current;
    setDirectoryBusy(true);
    try {
      const inputs = await selectPaths();
      if (inputRequestRef.current !== request) return;
      if (!inputs.length) {
        if (!isDesktopRuntime() && source === "selected folder") setInputNotice("Recursive directory selection is available in the desktop window.");
        return;
      }
      const sourceCount = `${inputs.length} ${source}${inputs.length === 1 ? "" : "s"}`;
      setInputNotice(`Searching ${sourceCount} recursively for supported video files...`);
      const paths = await discoverVideoInputs(inputs);
      if (inputRequestRef.current !== request) return;
      mergeVideos(paths);
      setInputNotice(paths.length ? `${paths.length} video file${paths.length === 1 ? "" : "s"} found recursively across ${sourceCount}.` : `No supported video files were found across ${sourceCount}.`);
    } catch (error) {
      if (inputRequestRef.current === request) setInputNotice(String(error));
    } finally {
      if (inputRequestRef.current === request) setDirectoryBusy(false);
    }
  };

  const chooseDirectory = () => addVideoInputs(selectInputDirectories, "selected folder");
  const chooseDroppedInputs = (paths: string[]) => {
    void addVideoInputs(() => Promise.resolve(paths), "dropped item");
  };

  const chooseOutput = async () => {
    const path = await selectOutputDirectory();
    if (path) {
      updateDraft({ outputRoot: path });
      setInputNotice(null);
    } else if (!isDesktopRuntime()) {
      setInputNotice("Native folder selection is available in the desktop window.");
    }
  };

  const removeVideos = (paths: string[]) => {
    const removed = new Set(paths);
    setDraft((value) => ({ ...value, inputVideos: value.inputVideos.filter((path) => !removed.has(path)) }));
  };

  const runFftPreview = async (stage: PreviewStage) => {
    if (stage === "sample" || stage === "roi") return;
    cancelRunningPreview();
    const signature = previewSignature(draft);
    const previewId = crypto.randomUUID();
    fftPreviewIdRef.current = previewId;
    setFftLoading(true);
    setFftError(null);
    try {
      const preview = await loadFftPreview(draft.sampleVideo, draft.settings, draft.roiPolygons[draft.sampleVideo], previewId, stage, draft.analysisMode);
      if (fftPreviewIdRef.current !== previewId) return;
      setFftPreview(preview);
      setFftPreviewSignature(signature);
      setAnalysisPreviewSettingsSignature(analysisPreviewSignature(draft.settings));
      setComputedPreviewStage(stage);
    } catch (error) {
      if (fftPreviewIdRef.current === previewId) setFftError(String(error));
    } finally {
      if (fftPreviewIdRef.current === previewId) {
        fftPreviewIdRef.current = null;
        setFftLoading(false);
      }
    }
  };

  const loadReusableSettings = async () => {
    setSettingsFileNotice(null);
    try {
      const value = await loadSettingsFile();
      if (!value) return;
      const loaded = parseSettingsFile(value, draft.analysisMode);
      setDraft((current) => ({ ...current, ...loaded, roiPolygons: loaded.roiPolygons ?? current.roiPolygons }));
      setFftPreview(null);
      setFftPreviewSignature(null);
      setAnalysisPreviewSettingsSignature(null);
      setComputedPreviewStage(null);
      setSettingsFileNotice("Settings imported from parameters.json. Current video and output-folder selections were preserved; imported ROI settings apply to the current selected videos.");
    } catch (error) {
      setSettingsFileNotice(String(error));
    }
  };

  const reset = () => {
    const previewId = fftPreviewIdRef.current;
    fftPreviewIdRef.current = null;
    if (previewId) void cancelFftPreview(previewId);
    analysisJob.reset();
    framePreviewRequestRef.current = null;
    loopPreviewRequestRef.current = null;
    inputRequestRef.current += 1;
    resetDraft();
    setCurrentIndex(0);
    setFurthestIndex(0);
    setFramePreview(null);
    setFrameLoading(false);
    setFrameError(null);
    setFftPreview(null);
    setFftPreviewSignature(null);
    setAnalysisPreviewSettingsSignature(null);
    setComputedPreviewStage(null);
    setFftLoading(false);
    setFftError(null);
    setInputNotice(null);
    setDirectoryBusy(false);
    setSettingsFileNotice(null);
  };

  return (
    <div className="app-shell">
      <StepNavigation steps={steps} currentIndex={currentIndex} furthestIndex={furthestIndex} disabled={jobRunning} onSelect={selectStep} />
      <main>
        <header className="topbar">
          <button className="icon-button" type="button" title="Reset setup" disabled={jobRunning} onClick={reset}>
            <RotateCcw size={17} />
          </button>
        </header>

        <section className="workspace">
          {currentIndex === 0 && <ModeStep value={draft.analysisMode} onChange={chooseAnalysisMode} />}
          {currentIndex === 1 && (
            <InputsStep
              draft={draft}
              notice={inputNotice}
              directoryBusy={directoryBusy}
              onChooseVideos={chooseVideos}
              onChooseDirectory={chooseDirectory}
              onDropPaths={chooseDroppedInputs}
              onChooseOutput={chooseOutput}
              onRemoveVideos={removeVideos}
            />
          )}
          {currentIndex === 2 && draft.analysisMode === "in_vitro" && (
            <SettingsStep
              draft={draft}
              setDraft={setSettingsDraft}
              framePreview={framePreview}
              frameLoading={frameLoading}
              frameError={frameError}
              fftPreview={fftPreview}
              computedPreviewStage={computedPreviewStage}
              fftPreviewIsCurrent={fftPreviewIsCurrent}
              analysisPreviewIsCurrent={analysisPreviewSettingsSignature === analysisPreviewSignature(draft.settings)}
              fftLoading={fftLoading}
              fftError={fftError}
              validationErrors={settingsConfigurationErrors}
              onRunFftPreview={runFftPreview}
              settingsFileNotice={settingsFileNotice}
              onLoadSettings={() => void loadReusableSettings()}
            />
          )}
          {currentIndex === 2 && draft.analysisMode === "ex_vivo" && (
            <ExVivoSettingsStep
              draft={draft}
              setDraft={setSettingsDraft}
              framePreview={framePreview}
              frameLoading={frameLoading}
              frameError={frameError}
              validationErrors={settingsConfigurationErrors}
              fftPreview={fftPreview}
              computedPreviewStage={computedPreviewStage}
              fftPreviewIsCurrent={fftPreviewIsCurrent}
              analysisPreviewIsCurrent={analysisPreviewSettingsSignature === analysisPreviewSignature(draft.settings)}
              fftLoading={fftLoading}
              fftError={fftError}
              onRunFftPreview={runFftPreview}
              settingsFileNotice={settingsFileNotice}
              onLoadSettings={() => void loadReusableSettings()}
            />
          )}
          {currentIndex === 3 && <OutputsStep draft={draft} setDraft={setDraft} validationErrors={outputErrors} />}
          {currentIndex === 4 && <ReviewStep draft={draft} setDraft={setDraft} framePreview={framePreview} job={analysisJob} />}
        </section>

        <footer className="workflow-actions">
          <button className="button secondary" type="button" disabled={currentIndex === 0 || jobRunning} onClick={() => selectStep(Math.max(0, currentIndex - 1))}>
            <ArrowLeft size={17} /> Previous
          </button>
          {currentIndex < steps.length - 1 ? (
            <button className={`button ${currentIndex === 2 && !settingsPreviewReady ? "secondary" : "primary"} ${currentIndex === 2 && settingsPreviewReady ? "continue-glow" : ""}`} type="button" disabled={!canContinueCurrentStep} onClick={next}>
              {currentIndex === 2 ? `Continue with ${settingsAreDefault ? "default" : "current"} analysis settings` : "Continue"} <ArrowRight size={17} />
            </button>
          ) : jobRunning ? (
            <button className="button danger" type="button" onClick={() => void analysisJob.cancel()}>
              <Square size={15} /> Stop analysis
            </button>
          ) : (
            <button
              className="button primary"
              type="button"
              disabled={!isDesktopRuntime() || !stepValid[4]}
              onClick={() => void analysisJob.start(toJobConfig(draft, createJobId(draft.analysisMode)))}
              title={isDesktopRuntime() ? "Run analysis" : "Open the Tauri desktop window to run"}
            >
              <Play size={17} /> Run analysis
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}

function createJobId(mode: AnalysisDraft["analysisMode"]): string {
  const prefix = mode === "ex_vivo" ? "ex-vivo" : "in-vitro";
  return prefix + "-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + crypto.randomUUID();
}

export default App;

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Activity, ArrowLeft, ArrowRight, ChevronDown, FileVideo2, FileUp, FolderOpen, LoaderCircle, Play, RotateCcw, Save, ScanSearch, Waves } from "lucide-react";
import { Field } from "../Field";
import { FrameCountField } from "../FrameCountField";
import { PolygonRoiEditor } from "../PolygonRoiEditor";
import { SpectrumPreview } from "../SpectrumPreview";
import { normalizeVideoPath as normalizePath } from "../../utils/paths";
import type { AnalysisDraft, FftPreview, FirstFramePreview, PipelineSettings, RoiPolygon } from "../../types/job";
import { defaultAdvancedSettings } from "../../types/job";
import type { PreviewStage } from "../AnalysisPreviewRail";
import { discoverRoiPolygons, saveRoiPolygons, selectInputDirectory } from "../../services/desktop";

interface ExVivoSettingsStepProps {
  draft: AnalysisDraft;
  setDraft: Dispatch<SetStateAction<AnalysisDraft>>;
  framePreview: FirstFramePreview | null;
  frameLoading: boolean;
  frameError: string | null;
  fftPreview: FftPreview | null;
  computedPreviewStage: PreviewStage | null;
  fftPreviewIsCurrent: boolean;
  analysisPreviewIsCurrent: boolean;
  fftLoading: boolean;
  fftError: string | null;
  validationErrors: string[];
  onRunFftPreview: (stage: PreviewStage) => void;
  settingsFileNotice: string | null;
  onLoadSettings: () => void;
}

const stages = ["video", "roi", "fft", "band", "filter"] as const;
type ExVivoStage = typeof stages[number];
type RoiOperation = { videoPath: string; draft: AnalysisDraft };
type SavedRoi = { outputRoot: string; polygons: RoiPolygon[] };
type RoiSaveNotice = { videoPath: string; outputRoot: string; message: string; error: boolean };

export function ExVivoSettingsStep({
  draft,
  setDraft,
  framePreview,
  frameLoading,
  frameError,
  fftPreview,
  computedPreviewStage,
  fftPreviewIsCurrent,
  analysisPreviewIsCurrent,
  fftLoading,
  fftError,
  validationErrors,
  onRunFftPreview,
  settingsFileNotice,
  onLoadSettings,
}: ExVivoSettingsStepProps) {
  const settings = draft.settings;
  const [stage, setStage] = useState<ExVivoStage>("video");
  const [roiIndex, setRoiIndex] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [roiSaveNotice, setRoiSaveNotice] = useState<RoiSaveNotice | null>(null);
  const [roiImportNotice, setRoiImportNotice] = useState<string | null>(null);
  const [dirtyRois, setDirtyRois] = useState<Set<string>>(new Set());
  const [savedRois, setSavedRois] = useState<Record<string, SavedRoi>>({});
  const [roiPending, setRoiPending] = useState<"save" | "import" | null>(null);
  const roiOperation = useRef<RoiOperation | null>(null);
  const [previewMode, setPreviewMode] = useState<"video" | "roi" | "frequency" | "phase">("video");
  const [showRawFrequency, setShowRawFrequency] = useState(true);
  const currentRoiIndex = Math.min(roiIndex, Math.max(0, draft.inputVideos.length - 1));
  const currentVideo = draft.inputVideos[currentRoiIndex] ?? "";
  const latestContext = useRef({ draft, currentVideo, stage });
  latestContext.current = { draft, currentVideo, stage };
  const roiBusy = roiPending !== null;

  useEffect(() => () => { roiOperation.current = null; }, []);

  useEffect(() => {
    setRoiSaveNotice(null);
    setRoiImportNotice(null);
  }, [currentVideo, draft.outputRoot]);

  useEffect(() => {
    if (stage === "roi" && currentVideo && draft.sampleVideo !== currentVideo) {
      setDraft((value) => ({ ...value, sampleVideo: currentVideo }));
    }
  }, [stage, currentVideo, draft.sampleVideo, setDraft]);

  const update = (patch: Partial<PipelineSettings>) => setDraft((value) => ({ ...value, settings: { ...value.settings, ...patch } }));
  const updatePolygons = (videoPath: string, polygons: RoiPolygon[]) => {
    if (roiOperation.current || latestContext.current.currentVideo !== videoPath) return;
    setRoiSaveNotice(null);
    setRoiImportNotice(null);
    setDirtyRois((current) => {
      const next = new Set(current);
      next.add(videoPath);
      return next;
    });
    setDraft((value) => ({ ...value, roiPolygons: { ...value.roiPolygons, [videoPath]: polygons } }));
  };
  const currentPolygons = currentVideo ? draft.roiPolygons[currentVideo] ?? [] : [];
  const hasValidRoi = (videoPath: string) => (draft.roiPolygons[videoPath] ?? []).some((polygon) => polygon.length >= 3);
  const hasSavedRoi = (videoPath: string) => {
    const saved = savedRois[videoPath];
    return hasValidRoi(videoPath) && !dirtyRois.has(videoPath)
      && (!saved || (saved.outputRoot === draft.outputRoot && saved.polygons === draft.roiPolygons[videoPath]));
  };
  const previewVideo = stage === "roi" ? currentVideo : draft.sampleVideo;
  // Parent preview requests can finish after the selected video has changed.
  const currentFramePreview = !frameLoading && framePreview && previewVideo
    && normalizePath(framePreview.video_path) === normalizePath(previewVideo) ? framePreview : null;
  const currentFftPreview = fftPreview && previewVideo
    && normalizePath(fftPreview.video_path) === normalizePath(previewVideo) ? fftPreview : null;
  const previewPolygons = previewVideo ? draft.roiPolygons[previewVideo] ?? [] : [];
  const previewRoiSaved = settings.roiMode === "full" || (previewVideo ? hasSavedRoi(previewVideo) : false);
  const currentRoiValid = settings.roiMode === "full" || (currentVideo ? hasValidRoi(currentVideo) : false);
  const currentRoiSaved = settings.roiMode === "full" || (currentVideo ? hasSavedRoi(currentVideo) : false);
  const completedRois = draft.inputVideos.filter((path) => hasSavedRoi(path)).length;
  const allRoisSaved = settings.roiMode === "full" || (draft.inputVideos.length > 0 && draft.inputVideos.every((path) => hasSavedRoi(path)));
  const canNextVideo = Boolean(currentVideo && currentRoiSaved && currentFramePreview && !roiBusy && draft.outputRoot.trim() && currentRoiIndex < draft.inputVideos.length - 1);
  const bandPreviewReady = Boolean(
    fftPreview
    && fftPreviewIsCurrent
    && stageReached(computedPreviewStage, "band")
    && fftPreview.band_low === settings.bandLow
    && fftPreview.band_high === settings.bandHigh,
  );
  const filterPreviewReady = computedPreviewStage === "filter" && fftPreviewIsCurrent && analysisPreviewIsCurrent;
  const fftPreviewReady = Boolean(fftPreview && fftPreviewIsCurrent && stageReached(computedPreviewStage, "fft"));
  const canAdvanceFromStage = (
    !frameLoading
    && !roiBusy
    && (stage === "video" || stage === "roi" ? Boolean(currentFramePreview) : true)
    && (stage !== "roi" || settings.roiMode === "full" || Boolean(draft.outputRoot.trim()))
    && (stage !== "roi" || settings.roiMode === "full" || allRoisSaved)
    && (stage !== "fft" || fftPreviewReady)
    && (stage !== "band" || bandPreviewReady)
  );
  const stageIndex = stages.indexOf(stage);

  useEffect(() => {
    if (stage === "roi") setPreviewMode(currentRoiSaved ? "roi" : "video");
    if (stage === "fft") setPreviewMode(fftPreviewReady ? "frequency" : "video");
    if (stage === "band" || stage === "filter") setPreviewMode(fftPreview ? "frequency" : "video");
  }, [stage, currentVideo, currentRoiSaved, fftPreview, fftPreviewReady]);

  useEffect(() => {
    if (computedPreviewStage === "band" || computedPreviewStage === "filter") setShowRawFrequency(false);
  }, [computedPreviewStage]);

  useEffect(() => setAdvancedOpen(false), [stage]);

  const operationIsCurrent = (operation: RoiOperation) => {
    const latest = latestContext.current;
    return roiOperation.current === operation && latest.stage === "roi"
      && latest.currentVideo === operation.videoPath
      && latest.draft.inputVideos === operation.draft.inputVideos
      && latest.draft.roiPolygons === operation.draft.roiPolygons
      && latest.draft.outputRoot === operation.draft.outputRoot
      && latest.draft.settings.roiMode === operation.draft.settings.roiMode;
  };

  const saveCurrentRoi = async () => {
    if (roiOperation.current || !currentVideo || !currentRoiValid || currentRoiSaved || !currentFramePreview || !draft.outputRoot.trim()) return;
    const operation = { videoPath: currentVideo, draft };
    roiOperation.current = operation;
    setRoiPending("save");
    setRoiSaveNotice(null);
    setRoiImportNotice(null);
    try {
      const path = await saveRoiPolygons(currentVideo, currentPolygons, draft.outputRoot);
      if (!operationIsCurrent(operation)) return;
      setSavedRois((current) => ({ ...current, [currentVideo]: { outputRoot: draft.outputRoot, polygons: currentPolygons } }));
      setDirtyRois((current) => {
        const next = new Set(current);
        next.delete(currentVideo);
        return next;
      });
      setRoiSaveNotice({ videoPath: currentVideo, outputRoot: draft.outputRoot, message: `ROI saved to ${path}`, error: false });
      setPreviewMode("roi");
    } catch (error) {
      if (operationIsCurrent(operation)) {
        setRoiSaveNotice({ videoPath: currentVideo, outputRoot: draft.outputRoot, message: `ROI was not saved. ${error instanceof Error ? error.message : String(error)}`, error: true });
      }
    } finally {
      if (roiOperation.current === operation) {
        roiOperation.current = null;
        setRoiPending(null);
      }
    }
  };

  const importRoiDirectory = async () => {
    if (roiOperation.current) return;
    const operation = { videoPath: currentVideo, draft };
    roiOperation.current = operation;
    setRoiPending("import");
    setRoiImportNotice(null);
    setRoiSaveNotice(null);
    try {
      const directory = await selectInputDirectory();
      if (!directory || !operationIsCurrent(operation)) return;
      const imported = await discoverRoiPolygons(directory);
      if (!operationIsCurrent(operation)) return;
      const importedByPath = new Map(Object.entries(imported));
      const importedByNormalizedPath = new Map(Object.entries(imported).map(([path, polygons]) => [normalizePath(path), polygons]));
      const matched: Record<string, RoiPolygon[]> = {};
      const matchedVideos: string[] = [];
      for (const videoPath of draft.inputVideos) {
        const polygons = importedByPath.get(videoPath) ?? importedByNormalizedPath.get(normalizePath(videoPath));
        if (polygons?.some((polygon) => polygon.length >= 3)) {
          matched[videoPath] = polygons;
          matchedVideos.push(videoPath);
        }
      }
      if (!matchedVideos.length) {
        setRoiImportNotice("No ROI files in that folder matched the currently selected videos by saved video path.");
        return;
      }
      setDraft((value) => ({
        ...value,
        settings: { ...value.settings, roiMode: "custom" },
        roiPolygons: { ...value.roiPolygons, ...matched },
      }));
      setDirtyRois((current) => {
        const next = new Set(current);
        matchedVideos.forEach((videoPath) => next.delete(videoPath));
        return next;
      });
      setSavedRois((current) => {
        const next = { ...current };
        matchedVideos.forEach((videoPath) => delete next[videoPath]);
        return next;
      });
      const unmatchedCount = draft.inputVideos.length - matchedVideos.length;
      setRoiImportNotice(`Matched ${matchedVideos.length} saved ROI file(s). ${unmatchedCount} selected video(s) still need a custom ROI.`);
      if (currentVideo && matchedVideos.includes(currentVideo)) setPreviewMode("roi");
    } catch (error) {
      if (operationIsCurrent(operation)) setRoiImportNotice(error instanceof Error ? error.message : "Could not import ROI files from that folder.");
    } finally {
      if (roiOperation.current === operation) {
        roiOperation.current = null;
        setRoiPending(null);
      }
    }
  };

  return (
    <div className="step-content settings-workflow">
      <div className="section-heading settings-heading-row">
        <div>
          <span className="eyebrow">Ex-vivo workflow</span>
          <h1>Configure ROI-based analysis</h1>
          <p>Ex-vivo analysis computes ROI-level CBF and phase outputs without tuft segmentation.</p>
        </div>
        <button className="button secondary" type="button" disabled={roiBusy} onClick={onLoadSettings}><FileUp size={16} /> Import parameters.json</button>
      </div>

      {stage === "video" && <div className="settings-reuse-note">
        <div>
          <strong>This analysis configuration is saved with every run.</strong>
          <span>Import the `parameters.json` file from a previous ex-vivo run to reuse settings. Full-frame ROI runs need only that file; custom ROI runs can also import a folder of saved ROI files below.</span>
        </div>
      </div>}
      {settingsFileNotice && <div className="inline-notice">{settingsFileNotice}</div>}

      <div className="settings-layout ex-vivo-layout">
        <div className="settings-control-column">
          {stage === "video" && (
            <section className="panel settings-section active-step">
              <div className="panel-title"><FileVideo2 size={18} /><h2>1. Video assumptions</h2></div>
              <div className="field-grid video-assumptions-fields">
                <NumberField label="Frame rate" hint="frames per second" value={settings.fps} min={1} onChange={(fps) => update({ fps })} />
                <FrameCountField value={settings.frameCount} onChange={(frameCount) => update({ frameCount })} />
                <Field label="Preview video" hint="First video is used for downstream previews">
                  <select value={draft.sampleVideo} onChange={(event) => setDraft((value) => ({ ...value, sampleVideo: event.currentTarget.value }))}>
                    {draft.inputVideos.map((path) => <option key={path} value={path}>{fileName(path)}</option>)}
                  </select>
                </Field>
              </div>
              <p className="control-note">FFT frequency resolution is sample rate / FFT length. Here, sample rate is the video FPS and FFT length is the number of frames, so more frames give finer Hz bins. Choose All to process every available frame in each video.</p>
              {frameLoading && <div className="decode-modal" role="status"><span className="decode-spinner" aria-hidden="true" /><strong>Decoding video preview<span className="loading-ellipsis" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></strong><span>The app is reading a lightweight preview so ROI setup can begin.</span></div>}
              {frameError && <div className="validation-message">{frameError}</div>}
            </section>
          )}

          {stage === "roi" && (
            <section className="panel settings-section active-step">
              <div className="panel-title"><ScanSearch size={18} /><h2>2. Region of interest</h2></div>
              <div className="segmented" role="group" aria-label="Ex-vivo ROI mode">
                <button type="button" disabled={roiBusy} className={settings.roiMode === "full" ? "active" : ""} onClick={() => update({ roiMode: "full" })}>Full frame</button>
                <button type="button" disabled={roiBusy} className={settings.roiMode === "custom" ? "active" : ""} onClick={() => update({ roiMode: "custom" })}>Custom ROI per video</button>
              </div>
              {settings.roiMode === "custom" && (
                <>
                  <div className="settings-reuse-note compact">
                    <div>
                      <strong>Reuse saved custom ROIs.</strong>
                      <span>Select a previous output folder, or any folder containing saved ROI JSON files. ROIs are matched to the currently selected videos by their saved video-file path; unmatched videos stay in this review list for drawing.</span>
                    </div>
                    <button className="button secondary" type="button" disabled={roiBusy} onClick={importRoiDirectory}><FolderOpen size={16} /> {roiPending === "import" ? "Importing..." : "Import ROI folder"}</button>
                  </div>
                  {roiImportNotice && <div className="inline-notice">{roiImportNotice}</div>}
                  <div className="roi-review-bar">
                    <span className="roi-review-video"><strong>{currentVideo ? currentRoiIndex + 1 : 0}/{draft.inputVideos.length}</strong> {currentVideo ? fileName(currentVideo) : "No video"}</span>
                    <div className="roi-review-actions">
                      <button className="button secondary" type="button" disabled={currentRoiIndex <= 0 || frameLoading || roiBusy} onClick={() => setRoiIndex(Math.max(0, currentRoiIndex - 1))}><ArrowLeft size={16} /> Previous video</button>
                      <button className={`button primary ${currentRoiValid && !currentRoiSaved ? "next-action" : ""}`} type="button" disabled={!currentVideo || !currentRoiValid || currentRoiSaved || !currentFramePreview || roiBusy || !draft.outputRoot.trim()} onClick={saveCurrentRoi}>
                        {roiPending === "save" ? <LoaderCircle className="roi-saving-spinner" size={16} /> : <Save size={16} />} {roiPending === "save" ? "Saving ROI..." : currentRoiSaved ? "ROI saved" : "Save ROI"}
                      </button>
                      <button className={`button ${canNextVideo ? "primary roi-next-ready" : "secondary"}`} type="button" disabled={!canNextVideo} onClick={() => {
                        if (canNextVideo && !roiOperation.current) setRoiIndex(currentRoiIndex + 1);
                      }}>Next video <ArrowRight size={16} /></button>
                    </div>
                    <small role="status">{completedRois}/{draft.inputVideos.length} videos have saved ROIs. {roiPending === "save" ? "Saving ROI to disk..." : roiPending === "import" ? "Importing saved ROIs..." : frameLoading || !currentFramePreview ? "Waiting for this video's preview." : !currentRoiSaved ? "Unsaved ROI. Save is required before continuing." : "This video's ROI is saved."}</small>
                  </div>
                  {draft.outputRoot.trim()
                    ? <div className="inline-notice roi-storage-notice">ROI files are saved under <strong>{draft.outputRoot.replace(/[\\/]+$/, "")}/rois</strong>. Source video folders are not modified.</div>
                    : <div className="validation-message" role="alert">Select an output directory before saving custom ROIs or continuing.</div>}
                  {roiSaveNotice && roiSaveNotice.videoPath === currentVideo && roiSaveNotice.outputRoot === draft.outputRoot && <div className={`${roiSaveNotice.error ? "validation-message" : "inline-notice"} roi-storage-notice`} role={roiSaveNotice.error ? "alert" : "status"}>{roiSaveNotice.message}</div>}
                  {frameError && !frameLoading && <div className="validation-message" role="alert">{frameError}</div>}
                  {currentFramePreview && currentVideo ? (
                    <div className="roi-editor-lock" inert={roiBusy} aria-busy={roiBusy}>
                      <PolygonRoiEditor key={currentVideo} preview={currentFramePreview} polygons={currentPolygons} onChange={(polygons) => updatePolygons(currentVideo, polygons)} />
                    </div>
                  ) : <div className="preview-placeholder">A decoded video preview will appear here.</div>}
                </>
              )}
              {settings.roiMode === "full" && <div className="inline-notice">The full detected frame is used as the ROI for every video. Importing a previous ex-vivo `parameters.json` is enough; no separate ROI folder is needed.</div>}
            </section>
          )}

          {stage === "fft" && (
            <section className="panel settings-section active-step">
              <div className="panel-title"><Activity size={18} /><h2>3. Per-pixel FFT preview</h2></div>
              <p className="pipeline-order-note">Run FFT on the current sample video and ROI before choosing the CBF band. If you change the ROI, FPS, frame count, sample video, or windowing, rerun this step.</p>
              {!fftPreviewReady && fftPreview && <div className="stale-preview">The displayed FFT no longer matches the current video assumptions or ROI. Rerun the FFT preview.</div>}
              {fftPreviewReady && fftPreview && (
                <div className="preview-facts">
                  <span>{fftPreview.decoded_frames} frames decoded</span>
                  <span>{fftPreview.roi_pixel_count.toLocaleString()} ROI pixels</span>
                  <span>{format(fftPreview.frequency_resolution_hz)} Hz resolution</span>
                  <span>{format(fftPreview.nyquist_hz)} Hz maximum</span>
                </div>
              )}
              <button className={`button primary inline-update prominent-update ${!fftPreviewReady ? "next-action" : ""}`} type="button" disabled={fftLoading || validationErrors.length > 0 || fftPreviewReady} onClick={() => onRunFftPreview("fft")}>
                <Activity size={16} /> {fftLoading ? "Running FFT preview..." : fftPreviewReady ? "FFT preview is current" : "Run FFT preview"}
              </button>
              {fftError && <div className="validation-message">{fftError}</div>}
              {validationErrors.length > 0 && <div className="validation-summary"><strong>Resolve before continuing</strong><span>{validationErrors[0]}</span></div>}
            </section>
          )}

          {stage === "band" && (
            <section className="panel settings-section active-step">
              <div className="panel-title"><Waves size={18} /><h2>4. CBF bandpass and background/noise removal</h2></div>
              <p className="pipeline-order-note">Choose the CBF window from the current FFT preview, then apply the combined preview. Gaussian evidence background removal, Otsu thresholding, and SNR settings are controlled in Advanced settings below. Additional pixels will be removed regardless of bandpass when they fail those background/noise criteria.</p>
              {!fftPreviewReady && <div className="validation-message">Return to the FFT step and run the preview with the current video assumptions and ROI.</div>}
              {fftPreviewReady && fftPreview && <SpectrumPreview preview={fftPreview} bandLow={settings.bandLow} bandHigh={settings.bandHigh} onBandChange={(bandLow, bandHigh) => update({ bandLow, bandHigh })} />}
              <div className="field-grid two">
                <NumberField label="CBF lower bound" hint="Hz" value={settings.bandLow} min={0} max={fftPreview?.nyquist_hz ?? settings.fps / 2} disabled={!fftPreviewReady} onChange={(bandLow) => update({ bandLow })} />
                <NumberField label="CBF upper bound" hint={fftPreview ? `Hz; max ${format(fftPreview.nyquist_hz)}` : `Hz; Nyquist ${format(settings.fps / 2)}`} value={settings.bandHigh} min={0} max={fftPreview?.nyquist_hz ?? settings.fps / 2} disabled={!fftPreviewReady} onChange={(bandHigh) => update({ bandHigh })} />
              </div>
              <button className={`button primary inline-update prominent-update ${fftPreviewReady && !bandPreviewReady ? "next-action" : ""}`} type="button" disabled={!fftPreviewReady || fftLoading || bandPreviewReady || validationErrors.length > 0} onClick={() => { setShowRawFrequency(true); onRunFftPreview("band"); }}>
                <Activity size={16} /> {fftLoading ? "Applying preview..." : bandPreviewReady ? "CBF/background preview is current" : "Apply CBF bandpass and background/noise removal"}
              </button>
              {fftError && <div className="validation-message">{fftError}</div>}
              {validationErrors.length > 0 && <div className="validation-summary"><strong>Resolve before continuing</strong><span>{validationErrors[0]}</span></div>}
            </section>
          )}

          {stage === "filter" && (
            <section className="panel settings-section active-step">
              <div className="panel-title"><Activity size={18} /><h2>5. Foreground filtering and despeckle</h2></div>
              <p className="pipeline-order-note">Apply the final ex-vivo foreground cleanup by removing small connected regions from the current CBF/background mask. The preview will not update to this despeckled result until you click the button below.</p>
              {!bandPreviewReady && <div className="validation-message">Return to the CBF bandpass step and apply the bandpass preview first.</div>}
              <div className="field-grid two">
                <NumberField label="Despeckle minimum" hint="area, px^2; default 150" value={settings.exVivoDespeckleMinArea} min={1} step={1} onChange={(exVivoDespeckleMinArea) => update({ exVivoDespeckleMinArea })} />
                <Field label="Cleanup rule" hint="Fixed ex-vivo workflow">
                  <input value="Remove small connected regions after CBF/background masking" disabled readOnly />
                </Field>
              </div>
              <button className={`button primary inline-update prominent-update ${bandPreviewReady && !filterPreviewReady ? "next-action" : ""}`} type="button" disabled={!bandPreviewReady || fftLoading || filterPreviewReady || validationErrors.length > 0} onClick={() => { setShowRawFrequency(true); onRunFftPreview("filter"); }}>
                <Activity size={16} /> {fftLoading ? "Applying foreground filter..." : filterPreviewReady ? "Foreground filter preview is current" : "Apply foreground filter preview"}
              </button>
              {fftPreview && filterPreviewReady && (
                <div className="preview-facts">
                  <span>{fftPreview.band_retained_pixels.toLocaleString()} CBF/background pixels</span>
                  <span>{fftPreview.cleanup_retained_pixels.toLocaleString()} foreground pixels after despeckle</span>
                </div>
              )}
              {fftError && <div className="validation-message">{fftError}</div>}
              {validationErrors.length > 0 && <div className="validation-summary"><strong>Resolve before continuing</strong><span>{validationErrors[0]}</span></div>}
            </section>
          )}

          <div className="settings-stage-actions">
            <button className="button secondary" type="button" disabled={stageIndex === 0 || fftLoading || roiBusy} onClick={() => setStage(stages[stageIndex - 1])}>Previous setting</button>
            <span>Step {stageIndex + 1} of {stages.length}</span>
            <button className={`button primary ${canAdvanceFromStage ? "next-action" : ""}`} type="button" disabled={stageIndex === stages.length - 1 || !canAdvanceFromStage || fftLoading} onClick={() => {
              if (stage === "roi" && draft.inputVideos[0]) {
                setDraft((value) => ({ ...value, sampleVideo: value.inputVideos[0] }));
              }
              setStage(stages[stageIndex + 1]);
            }}>Next setting</button>
          </div>

          {stage !== "video" && stage !== "roi" && <details className="panel advanced-settings-panel" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
            <summary>
              <span>Advanced settings <ChevronDown className="advanced-chevron" size={16} /></span>
              <button className="button secondary advanced-reset" type="button" onClick={(event) => { event.preventDefault(); update(defaultAdvancedSettings); }}><RotateCcw size={14} /> Reset defaults</button>
            </summary>
            <div className="advanced-settings-groups">
              {stage === "fft" && (
                <section>
                  <h3>FFT and frequency correction</h3>
                  <div className="field-grid three">
                    <NumberField label="Half-power ratio" hint="de-doubling; default 0.6" value={settings.halfPowerRatioThreshold} min={0} max={1} step={0.05} onChange={(halfPowerRatioThreshold) => update({ halfPowerRatioThreshold })} />
                    <Field label="Hann window" hint="Recommended">
                      <select value={settings.useHann ? "on" : "off"} onChange={(event) => update({ useHann: event.currentTarget.value === "on" })}>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                    </Field>
                    <Field label="Maximum FFT pixel chunk" hint="pixels; default 8,192">
                      <select value={settings.fftChunkPixels} onChange={(event) => update({ fftChunkPixels: Number(event.currentTarget.value) })}>
                        {![4096, 8192, 16384, 32768].includes(settings.fftChunkPixels) && <option value={settings.fftChunkPixels}>{settings.fftChunkPixels.toLocaleString()} - imported custom value</option>}
                        <option value={4096}>4,096 - lower memory</option>
                        <option value={8192}>8,192 - recommended</option>
                        <option value={16384}>16,384 - higher memory</option>
                        <option value={32768}>32,768 - very high memory</option>
                      </select>
                    </Field>
                  </div>
                  <p className="advanced-help">Controls the maximum number of complete pixel time-series transformed together. Larger chunks may improve speed but increase RAM per worker. TuFFT automatically uses a smaller effective chunk for long videos to keep the estimated FFT workspace near 96 MB. This setting changes resource use, not the scientific method.</p>
                  <div className="toggle-pair">
                    <ToggleRow label="Frequency de-doubling" description="Allow high apparent frequencies to be corrected to half-frequency" checked={settings.removeDoubling} onChange={(removeDoubling) => update({ removeDoubling })} />
                    <ToggleRow label="Spatial consensus" description="Require local agreement for de-doubling" checked={settings.useSpatialConsensus} disabled={!settings.removeDoubling} onChange={(useSpatialConsensus) => update({ useSpatialConsensus })} />
                    <ToggleRow label="Autocorrelation fallback" description="Use autocorrelation when half-frequency evidence is ambiguous" checked={settings.useAutocorrelationFallback} disabled={!settings.removeDoubling} onChange={(useAutocorrelationFallback) => update({ useAutocorrelationFallback })} />
                  </div>
                </section>
              )}
              {stage === "band" && (
                <section>
                  <h3>Gaussian evidence background threshold</h3>
                  <ExVivoEvidenceThresholdControls settings={settings} update={update} fftPreview={fftPreview} />
                </section>
              )}
              {stage === "filter" && (
                <section>
                  <h3>Foreground filtering</h3>
                  <p className="advanced-help">These controls are applied after Gaussian evidence and CBF bandpass.</p>
                <div className="field-grid three">
                  <NumberField label="SNR threshold" hint="dB; default 7" value={settings.snrThresholdDb} step={0.5} onChange={(snrThresholdDb) => update({ snrThresholdDb })} />
                  <NumberField label="Despeckle minimum" hint="area, px^2; default 150" value={settings.exVivoDespeckleMinArea} min={1} step={1} onChange={(exVivoDespeckleMinArea) => update({ exVivoDespeckleMinArea })} />
                </div>
              </section>
              )}
            </div>
          </details>}
        </div>

        <aside className="analysis-preview-rail">
          <div className="preview-rail-heading"><div><span>Ex-vivo preview</span><strong>{stage === "roi" ? "ROI drawing" : stage === "fft" ? "FFT preview" : stage === "band" ? "CBF/background mask" : stage === "filter" ? "Foreground filter" : "Video"}</strong></div></div>
          <div className="preview-mode-tabs" role="tablist" aria-label="Ex-vivo preview display">
            <button type="button" className={previewMode === "video" ? "active" : ""} onClick={() => setPreviewMode("video")}><Play size={15} /> Video</button>
            <button type="button" className={previewMode === "roi" ? "active" : ""} disabled={!previewRoiSaved} onClick={() => setPreviewMode("roi")}><ScanSearch size={15} /> ROI</button>
            <button type="button" className={previewMode === "frequency" ? "active" : ""} disabled={!currentFftPreview} onClick={() => setPreviewMode("frequency")}><Activity size={15} /> Frequency</button>
            <button type="button" className={previewMode === "phase" ? "active" : ""} disabled={!currentFftPreview?.pixel_phase_heatmap_data_url} onClick={() => setPreviewMode("phase")}><Waves size={15} /> Phase</button>
          </div>
          {(previewMode === "frequency" || previewMode === "phase") && currentFftPreview && (
            <div className="preview-compare-toggle" role="group" aria-label="Preview masking">
              <button type="button" className={showRawFrequency ? "active" : ""} onClick={() => setShowRawFrequency(true)}>Raw</button>
              <button type="button" className={!showRawFrequency ? "active" : ""} disabled={!bandPreviewReady} onClick={() => setShowRawFrequency(false)}>Masked</button>
            </div>
          )}
          <div className="analysis-preview-surface" style={{ aspectRatio: currentFramePreview ? `${currentFramePreview.width} / ${currentFramePreview.height}` : "1 / 1" }}>
            {renderPreviewSurface(previewMode, currentFramePreview, currentFftPreview, showRawFrequency, previewRoiSaved ? previewPolygons : [], settings.roiMode === "full", frameLoading, stage, filterPreviewReady)}
          </div>
          <div className="preview-help"><Activity size={15} /> The first selected video is used for filtering preview decisions. Custom ROI drawing walks through every selected video.</div>
        </aside>
      </div>
    </div>
  );
}

function renderPreviewSurface(
  mode: "video" | "roi" | "frequency" | "phase",
  framePreview: FirstFramePreview | null,
  fftPreview: FftPreview | null,
  showRawFrequency: boolean,
  polygons: RoiPolygon[],
  fullFrameRoi: boolean,
  frameLoading: boolean,
  stage: ExVivoStage,
  filterPreviewReady: boolean,
) {
  if (mode === "frequency" && fftPreview) {
    const maskedSource = stage === "filter" && filterPreviewReady ? fftPreview.cleanup_heatmap_data_url : fftPreview.band_heatmap_data_url;
    return <img className="preview-base-image" src={showRawFrequency ? fftPreview.fft_heatmap_data_url : maskedSource} alt="Ex-vivo frequency preview" draggable={false} />;
  }
  if (mode === "phase" && fftPreview?.pixel_phase_heatmap_data_url) {
    const maskedSource = stage === "filter" && filterPreviewReady ? fftPreview.pixel_phase_masked_data_url : fftPreview.pixel_phase_band_data_url;
    const source = showRawFrequency ? fftPreview.pixel_phase_heatmap_data_url : maskedSource ?? fftPreview.pixel_phase_heatmap_data_url;
    return <img className="preview-base-image" src={source} alt="Ex-vivo phase preview" draggable={false} />;
  }
  if (!framePreview) return <span>{frameLoading ? "Decoding video preview..." : "A decoded preview will appear here."}</span>;
  const showRoi = mode === "roi";
  return (
    <>
      <img className="preview-base-image" src={framePreview.loop_data_url || framePreview.image_data_url} alt="Ex-vivo preview" draggable={false} />
      {showRoi && <RoiPolygonOverlay preview={framePreview} polygons={polygons} fullFrame={fullFrameRoi} />}
    </>
  );
}

function RoiPolygonOverlay({ preview, polygons, fullFrame }: { preview: FirstFramePreview; polygons: RoiPolygon[]; fullFrame: boolean }) {
  const maskId = "ex-vivo-preview-roi-mask";
  if (fullFrame) return null;
  return (
    <svg className="preview-roi-overlay ex-vivo-roi-overlay" viewBox={`0 0 ${preview.width} ${preview.height}`} preserveAspectRatio="none">
      <defs>
        <mask id={maskId}>
          <rect width={preview.width} height={preview.height} fill="white" />
          {polygons.map((polygon, index) => (
            polygon.length >= 3 ? <polygon key={index} points={polygon.map((point) => `${point.x},${point.y}`).join(" ")} fill="black" /> : null
          ))}
        </mask>
      </defs>
      <rect className="roi-excluded-white" width={preview.width} height={preview.height} mask={`url(#${maskId})`} />
    </svg>
  );
}

function NumberField({ label, hint, value, min, max, step = 0.1, disabled, onChange }: { label: string; hint?: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Number(text);
    if (text.trim() && Number.isFinite(parsed)) onChange(parsed);
    else setText(String(value));
  };
  return <Field label={label} hint={hint}><input type="number" value={text} min={min} max={max} step={step} disabled={disabled} onChange={(event) => setText(event.currentTarget.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></Field>;
}

function ToggleRow({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="setting-toggle">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>
  );
}

function ExVivoEvidenceThresholdControls({ settings, update, fftPreview }: { settings: PipelineSettings; update: (patch: Partial<PipelineSettings>) => void; fftPreview: FftPreview | null }) {
  return (
    <div className="evidence-settings">
      <p className="advanced-help">* If valid ROI signal is removed, the Gaussian evidence threshold may be too high. This is most likely when the ROI contains little background. Lower the Otsu coefficient or switch to a manual evidence cutoff.</p>
      <div className="field-grid three">
        <NumberField label="Gaussian sigma" hint="evidence blur; default 3" value={settings.evidenceGaussianSigma} min={0} step={0.1} onChange={(evidenceGaussianSigma) => update({ evidenceGaussianSigma })} />
        <Field label="Threshold mode" hint="Default Otsu x coefficient">
          <select value={settings.evidenceThresholdMode} onChange={(event) => update({ evidenceThresholdMode: event.currentTarget.value as "otsu" | "manual" })}>
            <option value="otsu">Otsu threshold x coefficient</option>
            <option value="manual">Manual evidence cutoff</option>
          </select>
        </Field>
        {settings.evidenceThresholdMode === "otsu"
          ? <NumberField label="Otsu coefficient" hint="default 0.9" value={settings.evidenceOtsuCoefficient} min={0} max={1.5} step={0.05} onChange={(evidenceOtsuCoefficient) => update({ evidenceOtsuCoefficient })} />
          : <NumberField label="Manual evidence cutoff" hint="0-1 evidence scale; default 0.5" value={settings.evidenceManualThreshold} min={0} max={1} step={0.01} onChange={(evidenceManualThreshold) => update({ evidenceManualThreshold })} />}
      </div>
      {fftPreview ? (
        <div className="evidence-preview-card">
          <div>
            <strong>Gaussian evidence heatmap</strong>
            <small>Evidence is scaled 0-1. Active cutoff: {format(fftPreview.evidence_threshold)}; Otsu cutoff before coefficient: {format(fftPreview.otsu_threshold)}.</small>
          </div>
          <img src={fftPreview.gaussian_evidence_heatmap_data_url} alt="Gaussian evidence heatmap" />
          <div className="evidence-preview-legend">
            <span>0</span>
            <div />
            <span>1</span>
          </div>
        </div>
      ) : (
        <p className="advanced-help">Run the FFT preview to inspect the Gaussian evidence heatmap for this sample video.</p>
      )}
    </div>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function stageReached(computed: PreviewStage | null, required: PreviewStage): boolean {
  const order: PreviewStage[] = ["sample", "roi", "fft", "band", "filter", "tufts", "phase"];
  return order.indexOf(computed ?? "sample") >= order.indexOf(required);
}

function format(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

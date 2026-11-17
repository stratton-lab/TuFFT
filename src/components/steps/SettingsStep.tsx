import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Activity, ArrowLeft, ArrowRight, ChevronDown, FileUp, FileVideo2, Play, RotateCcw, ScanSearch, Split, Waves } from "lucide-react";
import { Field } from "../Field";
import { FrameCountField } from "../FrameCountField";
import { RoiFramePreview } from "../RoiFramePreview";
import { SpectrumPreview } from "../SpectrumPreview";
import { AnalysisPreviewRail, PREVIEW_STAGES, stageIndex, type PreviewStage, type SizeReference } from "../AnalysisPreviewRail";
import { defaultAdvancedSettings, type AnalysisDraft, type FftPreview, type FirstFramePreview, type PipelineSettings } from "../../types/job";
import { validatePreviewInputs } from "../../types/validation";

interface SettingsStepProps {
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
  onActiveStageChange?: (stage: PreviewStage) => void;
}

export function SettingsStep({
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
  onActiveStageChange,
}: SettingsStepProps) {
  const settings = draft.settings;
  const [activeStage, setActiveStage] = useState<PreviewStage>("sample");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sizeReference, setSizeReference] = useState<SizeReference | null>(null);
  const update = (patch: Partial<PipelineSettings>) => setDraft((value) => ({ ...value, settings: { ...value.settings, ...patch } }));
  const setSampleVideo = (sampleVideo: string) => setDraft((value) => ({ ...value, sampleVideo }));
  const previewInputErrors = validatePreviewInputs(draft, framePreview);
  const maxRadius = framePreview ? Math.floor(Math.min(framePreview.width, framePreview.height) / 2) : undefined;
  const maxSquareWidth = framePreview ? Math.min(framePreview.width, framePreview.height) : undefined;
  const currentStageIndex = stageIndex(activeStage);
  const computedIndex = stageIndex(computedPreviewStage);
  const bandPreviewMatchesSettings = Boolean(
    fftPreview
    && Math.abs(fftPreview.band_low - settings.bandLow) < 1e-6
    && Math.abs(fftPreview.band_high - settings.bandHigh) < 1e-6,
  );
  const heatmapIsCurrent = Boolean(
    fftPreviewIsCurrent
    && analysisPreviewIsCurrent
    && fftPreview
    && (computedIndex < stageIndex("band") || bandPreviewMatchesSettings),
  );
  const stageReady = (stage: PreviewStage) => stageIndex(stage) <= stageIndex("fft") || computedIndex >= stageIndex(stage) - 1;
  const stageIsCurrent = (stage: PreviewStage) => {
    if (stage === "sample" || stage === "roi") return true;
    if (stage === "fft") return Boolean(fftPreviewIsCurrent && stageIndex(computedPreviewStage) >= stageIndex("fft"));
    if (stageIndex(stage) >= stageIndex("band") && !bandPreviewMatchesSettings) return false;
    return Boolean(fftPreviewIsCurrent && analysisPreviewIsCurrent && stageIndex(computedPreviewStage) >= stageIndex(stage));
  };
  const canAdvanceSetting = () => {
    if (currentStageIndex >= PREVIEW_STAGES.length - 1) return false;
    if (frameLoading) return false;
    if ((activeStage === "sample" || activeStage === "roi") && !framePreview) return false;
    if (activeStage === "fft") return stageIsCurrent("fft");
    if (activeStage === "band") return stageIsCurrent("band");
    if (activeStage === "tufts") return stageIsCurrent("tufts");
    if (activeStage === "phase") return false;
    return true;
  };
  const highestSelectableStageIndex = () => {
    if (frameLoading || !framePreview) return stageIndex("sample");
    let highest = stageIndex("fft");
    if (stageIsCurrent("fft")) highest = Math.max(highest, stageIndex("band"));
    if (stageIsCurrent("band")) highest = Math.max(highest, stageIndex("tufts"));
    if (stageIsCurrent("tufts")) highest = Math.max(highest, stageIndex("phase"));
    return highest;
  };
  const canSelectPreviewStage = (stage: PreviewStage) => !fftLoading && stageIndex(stage) <= highestSelectableStageIndex();

  useEffect(() => setSizeReference(null), [activeStage]);
  useEffect(() => {
    setAdvancedOpen(false);
    onActiveStageChange?.(activeStage);
  }, [activeStage, onActiveStageChange]);
  useEffect(() => {
    if (!fftLoading && activeStage === "fft" && computedPreviewStage === "fft" && fftPreviewIsCurrent) setActiveStage("band");
  }, [activeStage, computedPreviewStage, fftLoading, fftPreviewIsCurrent]);

  return (
    <div className="step-content settings-workflow">
      <div className="section-heading settings-heading-row">
        <div>
          <span className="eyebrow">Tuft workflow</span>
          <h1>Configure tuft-analysis pipeline settings</h1>
        </div>
        <button className="button secondary" type="button" onClick={onLoadSettings}><FileUp size={16} /> Import parameters.json</button>
      </div>

      {activeStage === "sample" && <div className="settings-reuse-note">
        <div>
          <strong>This analysis configuration is saved with every run.</strong>
          <span>Import the `parameters.json` file from a previous in-vitro run to reuse the same ROI choice, processing parameters, and output choices on the videos selected for this new run. Files from the wrong analysis mode are rejected with an error.</span>
        </div>
      </div>}
      {settingsFileNotice && <div className="inline-notice">{settingsFileNotice}</div>}

      <div className="settings-layout">
        <div className="settings-control-column">
          <SettingsPanel active={activeStage === "sample"} icon={<FileVideo2 size={18} />} title="1. Video assumptions">
            <div className="field-grid video-assumptions-fields">
              <Field label="Representative video" hint="Used for setup previews">
                <select value={draft.sampleVideo} onChange={(event) => setSampleVideo(event.currentTarget.value)}>
                  {draft.inputVideos.map((path) => <option key={path} value={path}>{fileName(path)}</option>)}
                </select>
              </Field>
              <NumberField label="Frame rate" hint="frames per second" value={settings.fps} min={1} onChange={(fps) => update({ fps })} />
              <FrameCountField value={settings.frameCount} onChange={(frameCount) => update({ frameCount })} />
            </div>
            <p className="control-note">FFT frequency resolution is sample rate / FFT length. Here, sample rate is the video FPS and FFT length is the number of frames, so more frames give finer Hz bins. Choose All to process every available frame in each video.</p>
            {frameLoading && <div className="decode-modal" role="status"><span className="decode-spinner" aria-hidden="true" /><strong>Decoding video preview<span className="loading-ellipsis" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></strong><span>The app is reading a lightweight preview so ROI setup can begin.</span></div>}
            {frameError && <div className="validation-message">{frameError}</div>}
            {framePreview && (
              <div className="detected-metadata">
                <span>Detected dimensions</span>
                <strong>{framePreview.width} x {framePreview.height} pixels</strong>
                <small>Dimensions are detected from the video, not entered manually.</small>
              </div>
            )}
          </SettingsPanel>

          <SettingsPanel active={activeStage === "roi"} icon={<ScanSearch size={18} />} title="2. Region of interest">
            <div className="roi-layout">
              <div className="roi-controls">
                <div className="segmented" role="group" aria-label="ROI mode">
                  <button type="button" className={settings.roiMode === "circle" ? "active" : ""} onClick={() => update({ roiMode: "circle" })}>Centered circle</button>
                  <button type="button" className={settings.roiMode === "square" ? "active" : ""} onClick={() => update({ roiMode: "square" })}>Centered square</button>
                  <button type="button" className={settings.roiMode === "full" ? "active" : ""} onClick={() => update({ roiMode: "full" })}>Full frame</button>
                </div>
                {settings.roiMode === "circle" && <NumberField label="Circle radius" hint={maxRadius ? `pixels; max ${maxRadius}` : "pixels"} value={settings.radius} min={1} max={maxRadius} step={1} onChange={(radius) => update({ radius })} />}
                {settings.roiMode === "square" && <NumberField label="Square width" hint={maxSquareWidth ? `pixels; max ${maxSquareWidth}` : "pixels"} value={settings.squareWidth} min={1} max={maxSquareWidth} step={1} onChange={(squareWidth) => update({ squareWidth })} />}
                <p className="control-note">The shaded region is excluded. The same ROI is applied to every video in this batch.</p>
              </div>
              {framePreview ? <RoiFramePreview preview={framePreview} roiMode={settings.roiMode} radius={settings.radius} squareWidth={settings.squareWidth} /> : <div className="preview-placeholder">A decoded video preview will appear here.</div>}
            </div>
          </SettingsPanel>

          <SettingsPanel active={activeStage === "fft"} icon={<Activity size={18} />} title="3. Per-pixel FFT">
            <div className="fft-toolbar">
              <ToggleRow label="Hann window (recommended)" description="Apply temporal tapering before FFT" checked={settings.useHann} onChange={(useHann) => update({ useHann })} />
              <button className={`button primary ${!stageIsCurrent("fft") ? "next-action" : ""}`} type="button" disabled={fftLoading || previewInputErrors.length > 0 || stageIsCurrent("fft")} onClick={() => onRunFftPreview("fft")}>
                <Play size={16} /> {fftLoading ? "Running FFT..." : stageIsCurrent("fft") ? "FFT preview is current" : "Run FFT preview"}
              </button>
            </div>
            {previewInputErrors.length > 0 && <div className="validation-message">{previewInputErrors[0]}</div>}
            {fftError && <div className="validation-message">{fftError}</div>}
            {fftPreview && (
              <>
                {!fftPreviewIsCurrent && <div className="stale-preview">FFT inputs changed. Rerun the preview before choosing bounds.</div>}
                <p className="per-pixel-note">Every ROI pixel receives its own temporal FFT; chunking only controls memory use.</p>
                <div className="preview-facts">
                  <span>{fftPreview.decoded_frames} frames decoded</span>
                  <span>{fftPreview.roi_pixel_count.toLocaleString()} ROI pixels</span>
                  <span>{format(fftPreview.frequency_resolution_hz)} Hz resolution</span>
                  <span>{format(fftPreview.nyquist_hz)} Hz maximum</span>
                </div>
              </>
            )}
          </SettingsPanel>

          <SettingsPanel active={activeStage === "band"} icon={<Waves size={18} />} title="4. CBF bandpass and background/noise removal">
            {!fftPreview && <div className="validation-message">Run the per-pixel FFT preview before selecting a CBF band.</div>}
            {fftPreview && <SpectrumPreview preview={fftPreview} bandLow={settings.bandLow} bandHigh={settings.bandHigh} onBandChange={(bandLow, bandHigh) => update({ bandLow, bandHigh })} />}
            <div className="field-grid two">
              <NumberField label="CBF lower bound" hint="Hz" value={settings.bandLow} min={0} max={fftPreview?.nyquist_hz} disabled={!fftPreviewIsCurrent} onChange={(bandLow) => update({ bandLow })} />
              <NumberField label="CBF upper bound" hint={fftPreview ? `Hz; max ${format(fftPreview.nyquist_hz)}` : "Run FFT first"} value={settings.bandHigh} min={0} max={fftPreview?.nyquist_hz} disabled={!fftPreviewIsCurrent} onChange={(bandHigh) => update({ bandHigh })} />
            </div>
            <p className="pipeline-order-note">Drag the shared frequency window or type exact values. This preview also applies Gaussian evidence background removal, Otsu thresholding, and related noise-removal settings from Advanced settings below. Additional pixels will be removed regardless of bandpass when they fail those background/noise criteria.</p>
            <button className={`button primary inline-update prominent-update ${!stageIsCurrent("band") ? "next-action" : ""}`} type="button" disabled={!fftPreviewIsCurrent || fftLoading || previewInputErrors.length > 0 || stageIsCurrent("band")} onClick={() => onRunFftPreview("band")}><Waves size={16} /> {stageIsCurrent("band") ? "CBF/background preview is current" : "Apply CBF bandpass and background/noise removal"}</button>
          </SettingsPanel>

          <SettingsPanel active={activeStage === "tufts"} icon={<Split size={18} />} title="5. Tuft size and final segmentation">
            <p className="pipeline-order-note">Foreground is built from Gaussian evidence, bandpass, SNR filtering, flat-region pruning, repaired frequency clusters, and watershed of oversized clusters.</p>
            <div className="field-grid two">
              <NumberField label="Minimum tuft size" hint="area, px^2; default 150" value={settings.minTuftSize} min={1} step={1} visualized={sizeReference?.label === "Minimum tuft size"} onVisualize={() => setSizeReference({ label: "Minimum tuft size", value: settings.minTuftSize, kind: "area" })} onChange={(minTuftSize) => update({ minTuftSize, flatPostPruneMinArea: minTuftSize })} />
              <NumberField label="Maximum tuft size" hint="area, px^2 before watershed; default 800" value={settings.maxTuftSize} min={1} step={1} visualized={sizeReference?.label === "Maximum tuft size"} onVisualize={() => setSizeReference({ label: "Maximum tuft size", value: settings.maxTuftSize, kind: "area" })} onChange={(maxTuftSize) => update({ maxTuftSize })} />
            </div>
            <button className={`button primary inline-update prominent-update ${!stageIsCurrent("tufts") ? "next-action" : ""}`} type="button" disabled={!stageReady("tufts") || fftLoading || previewInputErrors.length > 0 || stageIsCurrent("tufts")} onClick={() => onRunFftPreview("tufts")}><Split size={16} /> {stageIsCurrent("tufts") ? "Tuft preview is current" : "Run final tuft preview"}</button>
          </SettingsPanel>

          <SettingsPanel active={activeStage === "phase"} icon={<Waves size={18} />} title="6. Phase tensor preview">
            <p className="pipeline-order-note">Phase tensor axes can be previewed here. During final analysis, tensor metrics are computed automatically when selected CSV columns or axis plots require them.</p>
            <button className={`button primary inline-update prominent-update ${!stageIsCurrent("phase") ? "next-action" : ""}`} type="button" disabled={!stageReady("phase") || fftLoading || previewInputErrors.length > 0 || stageIsCurrent("phase")} onClick={() => onRunFftPreview("phase")}><Waves size={16} /> {stageIsCurrent("phase") ? "Phase tensor preview is current" : "Run phase tensor preview"}</button>
          </SettingsPanel>

          {validationErrors.length > 0 && activeStage === "phase" && <div className="validation-summary"><strong>Resolve before continuing</strong><span>{validationErrors[0]}</span>{validationErrors.length > 1 && <small>{validationErrors.length - 1} additional setting issue(s)</small>}</div>}
          <div className="settings-stage-actions">
            <button className="button secondary" type="button" disabled={currentStageIndex === 0 || fftLoading} onClick={() => setActiveStage(PREVIEW_STAGES[currentStageIndex - 1][0])}><ArrowLeft size={16} /> Previous setting</button>
            <span>Step {currentStageIndex + 1} of {PREVIEW_STAGES.length}</span>
            <button className={`button primary ${canAdvanceSetting() ? "next-action" : ""}`} type="button" disabled={!canAdvanceSetting() || fftLoading} onClick={() => setActiveStage(PREVIEW_STAGES[currentStageIndex + 1][0])}>Next setting <ArrowRight size={16} /></button>
          </div>

          {activeStage !== "sample" && activeStage !== "roi" && <AdvancedSettings settings={settings} update={update} open={advancedOpen} onOpenChange={setAdvancedOpen} activeStage={activeStage} fftPreview={fftPreview} />}
        </div>

        <AnalysisPreviewRail
          framePreview={framePreview}
          fftPreview={fftPreview}
          computedStage={computedPreviewStage}
          fftLoading={fftLoading}
          previewIsCurrent={heatmapIsCurrent}
          activeStage={activeStage}
          settings={settings}
          sizeReference={sizeReference}
          onSelectStage={setActiveStage}
          canSelectStage={canSelectPreviewStage}
        />
      </div>
    </div>
  );
}

function AdvancedSettings({
  settings,
  update,
  open,
  onOpenChange,
  activeStage,
  fftPreview,
}: {
  settings: PipelineSettings;
  update: (patch: Partial<PipelineSettings>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeStage: PreviewStage;
  fftPreview: FftPreview | null;
}) {
  return (
    <details className="panel advanced-settings-panel" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary>
        <span>Advanced settings <ChevronDown className="advanced-chevron" size={16} /></span>
        <button className="button secondary advanced-reset" type="button" onClick={(event) => { event.preventDefault(); update(defaultAdvancedSettings); }}><RotateCcw size={14} /> Reset defaults</button>
      </summary>
      <div className="advanced-settings-groups">
        {activeStage === "fft" && (
          <section>
            <h3>FFT and frequency correction</h3>
            <div className="field-grid three">
              <NumberField label="Half-power ratio" hint="de-doubling; default 0.6" value={settings.halfPowerRatioThreshold} min={0} max={1} step={0.05} onChange={(halfPowerRatioThreshold) => update({ halfPowerRatioThreshold })} />
              <NumberField label="Spatial tolerance" hint="de-doubling fraction; default 0.25" value={settings.spatialToleranceFraction} min={0} max={1} step={0.05} onChange={(spatialToleranceFraction) => update({ spatialToleranceFraction })} />
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
        {activeStage === "band" && (
          <section>
            <h3>Gaussian evidence background threshold</h3>
            <EvidenceThresholdControls settings={settings} update={update} fftPreview={fftPreview} />
          </section>
        )}
        {activeStage === "tufts" && (
          <section>
            <h3>Foreground filtering and tuft segmentation</h3>
            <p className="advanced-help">These controls are applied after Gaussian evidence and CBF bandpass when building final tuft masks.</p>
          <div className="field-grid three">
            <NumberField label="SNR threshold" hint="dB; default 7" value={settings.snrThresholdDb} step={0.5} onChange={(snrThresholdDb) => update({ snrThresholdDb })} />
            <NumberField label="Frequency cluster width" hint="Hz; default 15" value={settings.frequencyClusterBinHz} min={1} step={1} onChange={(frequencyClusterBinHz) => update({ frequencyClusterBinHz })} />
            <NumberField label="Gap closing iterations" hint="default 4" value={settings.clusterGapClosingIterations} min={1} step={1} onChange={(clusterGapClosingIterations) => update({ clusterGapClosingIterations })} />
            <NumberField label="Cluster hole fill" hint="max px^2; default 100" value={settings.clusterHoleFillMaxArea} min={1} step={1} onChange={(clusterHoleFillMaxArea) => update({ clusterHoleFillMaxArea })} />
            <NumberField label="Flat-region component" hint="area, px^2; default 8000" value={settings.flatLargeComponentArea} min={1} step={1} onChange={(flatLargeComponentArea) => update({ flatLargeComponentArea })} />
            <NumberField label="Flat-region Hz tolerance" hint="Hz; default 5" value={settings.flatToleranceHz} min={0.01} step={0.5} onChange={(flatToleranceHz) => update({ flatToleranceHz })} />
            <NumberField label="Flat subregion minimum" hint="area, px^2; default 4000" value={settings.flatUniformSubregionMinArea} min={1} step={1} onChange={(flatUniformSubregionMinArea) => update({ flatUniformSubregionMinArea })} />
            <NumberField label="Peak distance" hint="px; default 8" value={settings.watershedMinPeakDistancePx} min={1} step={1} onChange={(watershedMinPeakDistancePx) => update({ watershedMinPeakDistancePx })} />
            <NumberField label="Peak radius threshold" hint="px; default 4" value={settings.watershedMinPeakRadiusPx} min={0.1} step={0.1} onChange={(watershedMinPeakRadiusPx) => update({ watershedMinPeakRadiusPx })} />
            <NumberField label="Distance sigma" hint="default 1" value={settings.watershedDistanceSigma} min={0} step={0.1} onChange={(watershedDistanceSigma) => update({ watershedDistanceSigma })} />
            <NumberField label="Max recursive splits" hint="default 10" value={settings.watershedMaxRecursiveSplits} min={1} step={1} onChange={(watershedMaxRecursiveSplits) => update({ watershedMaxRecursiveSplits })} />
          </div>
        </section>
        )}
        {activeStage === "phase" && (
          <section>
          <h3>Phase tensor and neighbor summaries</h3>
          <div className="field-grid three">
            <NumberField label="Phase tensor sigma" hint="default 1" value={settings.phaseTensorSmoothSigma} min={0} step={0.1} onChange={(phaseTensorSmoothSigma) => update({ phaseTensorSmoothSigma })} />
            <NumberField label="CBF neighbor scale" hint="Hz; default 5" value={settings.cbfSimilarityScaleHz} min={0.1} step={0.1} onChange={(cbfSimilarityScaleHz) => update({ cbfSimilarityScaleHz })} />
          </div>
        </section>
        )}
      </div>
    </details>
  );
}

function EvidenceThresholdControls({ settings, update, fftPreview }: { settings: PipelineSettings; update: (patch: Partial<PipelineSettings>) => void; fftPreview: FftPreview | null }) {
  return (
    <div className="evidence-settings">
      <p className="advanced-help">* If valid tufts look skeletonized or are removed, the Gaussian evidence threshold may be too high. This is most likely when the ROI contains little background. Lower the Otsu coefficient or switch to a manual evidence cutoff.</p>
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

function SettingsPanel({ active, icon, title, children }: { active: boolean; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  if (!active) return null;
  return <section className="panel settings-section active-step"><div className="panel-title">{icon}<h2>{title}</h2></div>{children}</section>;
}

interface NumberFieldProps {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  visualized?: boolean;
  onVisualize?: () => void;
  onChange: (value: number) => void;
}

function NumberField({ label, hint, value, min, max, step = 0.1, disabled, visualized, onVisualize, onChange }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  const commit = () => {
    focused.current = false;
    const parsed = Number(text);
    if (text.trim() !== "" && Number.isFinite(parsed)) {
      onChange(parsed);
      setText(String(parsed));
    } else {
      setText(String(value));
    }
  };
  return (
    <div className={`number-field-shell ${visualized ? "visualized" : ""}`} onClick={onVisualize} onFocusCapture={onVisualize}>
      <Field label={label} hint={hint}>
        <input type="number" value={text} min={min} max={max} step={step} disabled={disabled} onFocus={() => { focused.current = true; }} onChange={(event) => setText(event.currentTarget.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setText(String(value)); event.currentTarget.blur(); } }} />
      </Field>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ label, description, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <label className="setting-toggle">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function format(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

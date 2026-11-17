import { Activity, Compass, Grid3X3, Minus, Play, Plus, RotateCcw, Waves } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { FftPreview, FirstFramePreview, PipelineSettings } from "../types/job";

export type PreviewStage = "sample" | "roi" | "fft" | "band" | "filter" | "tufts" | "phase";

export interface SizeReference {
  label: string;
  value: number;
  kind: "area" | "radius" | "width";
}

interface AnalysisPreviewRailProps {
  framePreview: FirstFramePreview | null;
  fftPreview: FftPreview | null;
  computedStage: PreviewStage | null;
  fftLoading: boolean;
  previewIsCurrent: boolean;
  activeStage: PreviewStage;
  settings: PipelineSettings;
  sizeReference: SizeReference | null;
  onSelectStage: (stage: PreviewStage) => void;
  canSelectStage?: (stage: PreviewStage) => boolean;
}

type ViewMode = "video" | "frequency" | "phase" | "tufts" | "axes";

export const PREVIEW_STAGES: Array<[PreviewStage, string]> = [
  ["sample", "Video"], ["roi", "ROI"], ["fft", "FFT"], ["band", "Band"],
  ["tufts", "Tufts"], ["phase", "Phase"],
];

export function AnalysisPreviewRail({
  framePreview,
  fftPreview,
  computedStage,
  fftLoading,
  previewIsCurrent,
  activeStage,
  settings,
  sizeReference,
  onSelectStage,
  canSelectStage,
}: AnalysisPreviewRailProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("video");
  const [showRaw, setShowRaw] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const dimensions = framePreview ? { width: framePreview.width, height: framePreview.height } : null;
  const staleBandOrDownstreamPreview = !previewIsCurrent && stageIndex(activeStage) >= stageIndex("band");
  const visibleStage = staleBandOrDownstreamPreview ? "fft" : availableStage(activeStage, computedStage);
  const frequencyDisplayStage = stageIndex(activeStage) < stageIndex("fft") ? computedStage : visibleStage;
  const displayStage = showRaw || staleBandOrDownstreamPreview ? "fft" : frequencyDisplayStage;
  const frequencySource = selectFrequencyHeatmap(fftPreview, displayStage);
  const source = viewMode === "video"
    ? framePreview?.loop_data_url || framePreview?.image_data_url
    : viewMode === "frequency"
        ? frequencySource
        : viewMode === "phase"
          ? stageReached(computedStage, "fft") ? fftPreview?.pixel_phase_heatmap_data_url : undefined
          : viewMode === "axes"
            ? stageReached(computedStage, "phase") ? fftPreview?.phase_axis_overlay_data_url ?? undefined : undefined
            : stageReached(computedStage, "tufts") ? fftPreview?.tuft_heatmap_data_url ?? undefined : undefined;
  const retainedOverlay = !showRaw && !staleBandOrDownstreamPreview && (viewMode === "video" || viewMode === "phase")
    ? selectMaskOverlay(fftPreview, visibleStage)
    : undefined;
  const showSizeReference = Boolean(sizeReference && activeStage === "tufts");
  const previousComputedStage = useRef<PreviewStage | null>(null);

  useEffect(() => {
    if (activeStage === "fft" && !fftPreview) setViewMode("video");
    if (activeStage === "band" && stageReached(computedStage, "fft")) {
      setViewMode("frequency");
      if (!stageReached(computedStage, "band")) setShowRaw(true);
    }
  }, [activeStage, computedStage, fftPreview]);

  useEffect(() => {
    const previous = previousComputedStage.current;
    previousComputedStage.current = computedStage;
    if (activeStage === "band" && previous !== "band" && computedStage === "band") setShowRaw(false);
    if (previous !== "tufts" && computedStage === "tufts") setViewMode("tufts");
    if (previous !== "phase" && computedStage === "phase" && fftPreview?.phase_axis_overlay_data_url) setViewMode("axes");
  }, [activeStage, computedStage, fftPreview?.phase_axis_overlay_data_url]);

  const movePointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (drag.current) {
      const limitX = bounds.width * (zoom - 1) / 2;
      const limitY = bounds.height * (zoom - 1) / 2;
      setPan({
        x: clamp(drag.current.panX + event.clientX - drag.current.startX, -limitX, limitX),
        y: clamp(drag.current.panY + event.clientY - drag.current.startY, -limitY, limitY),
      });
      return;
    }
    if (!dimensions || !showSizeReference) return;
    const normalizedX = (event.clientX - bounds.left - pan.x) / bounds.width;
    const normalizedY = (event.clientY - bounds.top - pan.y) / bounds.height;
    setCursor({
      x: (((normalizedX - 0.5) / zoom) + 0.5) * dimensions.width,
      y: (((normalizedY - 0.5) / zoom) + 0.5) * dimensions.height,
    });
  };
  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || showSizeReference) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
  };
  const stopPan = () => { drag.current = null; };
  const changeZoom = (next: number) => {
    const value = clamp(next, 1, 4);
    setZoom(value);
    if (value === 1) {
      setPan({ x: 0, y: 0 });
    } else if (surface.current) {
      const bounds = surface.current.getBoundingClientRect();
      setPan((current) => ({
        x: clamp(current.x, -bounds.width * (value - 1) / 2, bounds.width * (value - 1) / 2),
        y: clamp(current.y, -bounds.height * (value - 1) / 2, bounds.height * (value - 1) / 2),
      }));
    }
  };
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const doubleClickZoom = (event: MouseEvent<HTMLDivElement>) => {
    if (!surface.current || showSizeReference) return;
    const bounds = surface.current.getBoundingClientRect();
    const nextZoom = zoom >= 4 ? 1 : clamp(zoom + 1, 1, 4);
    if (nextZoom === 1) {
      resetView();
      return;
    }
    const offsetX = event.clientX - bounds.left - bounds.width / 2;
    const offsetY = event.clientY - bounds.top - bounds.height / 2;
    const nextPan = {
      x: pan.x - offsetX * (nextZoom / zoom - 1),
      y: pan.y - offsetY * (nextZoom / zoom - 1),
    };
    setZoom(nextZoom);
    setPan({
      x: clamp(nextPan.x, -bounds.width * (nextZoom - 1) / 2, bounds.width * (nextZoom - 1) / 2),
      y: clamp(nextPan.y, -bounds.height * (nextZoom - 1) / 2, bounds.height * (nextZoom - 1) / 2),
    });
  };

  return (
    <aside className="analysis-preview-rail">
      <nav className="settings-stage-nav" aria-label="Analysis setting stages">
        {PREVIEW_STAGES.map(([stage, label], index) => {
          const disabled = fftLoading || (canSelectStage ? !canSelectStage(stage) : false);
          return (
            <button key={stage} type="button" disabled={disabled} className={`${activeStage === stage ? "active" : ""} ${stageReached(computedStage, stage) ? "completed" : ""}`} onClick={() => onSelectStage(stage)}>
              <span>{index + 1}</span>{label}
            </button>
          );
        })}
      </nav>

      <div className="preview-rail-heading">
        <div><span>Live setup preview</span><strong>{stageLabel(activeStage)}</strong></div>
      </div>

      <div className="preview-mode-tabs five" role="tablist" aria-label="Preview display">
        <button type="button" className={viewMode === "video" ? "active" : ""} onClick={() => setViewMode("video")}><Play size={15} /> Video</button>
        <button type="button" className={viewMode === "frequency" ? "active" : ""} disabled={!frequencySource} onClick={() => setViewMode("frequency")}><Activity size={15} /> Frequency</button>
        <button type="button" className={viewMode === "phase" ? "active" : ""} disabled={!stageReached(computedStage, "fft") || !fftPreview?.pixel_phase_heatmap_data_url} onClick={() => setViewMode("phase")}><Waves size={15} /> Phase</button>
        <button type="button" className={viewMode === "tufts" ? "active" : ""} disabled={!stageReached(computedStage, "tufts") || !fftPreview?.tuft_heatmap_data_url} onClick={() => setViewMode("tufts")}><Grid3X3 size={15} /> Tufts</button>
        <button type="button" className={viewMode === "axes" ? "active" : ""} disabled={!stageReached(computedStage, "phase") || !fftPreview?.phase_axis_overlay_data_url} onClick={() => setViewMode("axes")}><Compass size={15} /> Axes</button>
      </div>

      {stageIndex(activeStage) >= stageIndex("band") && viewMode !== "tufts" && viewMode !== "axes" && (
        <div className="preview-compare-toggle" role="group" aria-label="Preview masking">
          <button type="button" className={showRaw ? "active" : ""} onClick={() => setShowRaw(true)}>Raw</button>
          <button type="button" className={!showRaw ? "active" : ""} onClick={() => setShowRaw(false)}>Masked</button>
        </div>
      )}

      <div ref={surface} className={`analysis-preview-surface ${zoom > 1 && !showSizeReference ? "pannable" : ""}`} style={{ aspectRatio: dimensions ? `${dimensions.width} / ${dimensions.height}` : "1 / 1" }} onDoubleClick={doubleClickZoom} onPointerDown={startPan} onPointerMove={movePointer} onPointerUp={stopPan} onPointerCancel={stopPan} onPointerLeave={() => { setCursor(null); stopPan(); }}>
        {source ? (
          <div className="preview-plane" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <img className="preview-base-image" src={source} alt={`${viewMode} analysis preview`} draggable={false} />
            {retainedOverlay && <img className="preview-mask-image" src={retainedOverlay} alt="Excluded pixels mask" />}
            {dimensions && viewMode === "video" && !retainedOverlay && <RoiOverlay width={dimensions.width} height={dimensions.height} settings={settings} />}
            {dimensions && cursor && showSizeReference && sizeReference && (
              <svg className="size-reference-overlay" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} preserveAspectRatio="none">
                {sizeReference.kind === "width" ? <rect x={cursor.x - sizeReference.value / 2} y={cursor.y - sizeReference.value / 2} width={sizeReference.value} height={sizeReference.value} /> : <circle cx={cursor.x} cy={cursor.y} r={sizeReference.kind === "area" ? Math.sqrt(Math.max(0, sizeReference.value) / Math.PI) : sizeReference.value} />}
              </svg>
            )}
          </div>
        ) : <span>{fftLoading ? "Computing this preview stage..." : emptyMessage(viewMode, activeStage)}</span>}
        {fftLoading && <div className="preview-progress"><span /></div>}
      </div>

      <div className="preview-zoom-controls" aria-label="Preview zoom">
        <button className="icon-button" type="button" title="Zoom out" disabled={zoom <= 1} onClick={() => changeZoom(zoom - 0.5)}><Minus size={15} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button className="icon-button" type="button" title="Zoom in" disabled={zoom >= 4} onClick={() => changeZoom(zoom + 0.5)}><Plus size={15} /></button>
        <button className="icon-button" type="button" title="Reset zoom and position" disabled={zoom === 1 && pan.x === 0 && pan.y === 0} onClick={resetView}><RotateCcw size={14} /></button>
      </div>

      {viewMode === "frequency" && fftPreview && <FrequencyLegend stage={displayStage} preview={fftPreview} />}
      {viewMode === "phase" && <PhaseLegend />}
      {viewMode === "axes" && <AxisLegend />}
      {viewMode === "tufts" && <TuftLegend />}
      {showSizeReference && sizeReference && (
        <div className="size-reference-legend">
          <strong>{sizeReference.label}: {format(sizeReference.value)} {sizeReference.kind === "area" ? "px^2" : "px"}</strong>
          <span>{sizeReference.kind === "area" ? "The cursor shows an equivalent-area circle for this QC threshold." : "Move the cursor over the preview to compare this distance."}</span>
        </div>
      )}

      {fftPreview && <StageMetrics preview={fftPreview} stage={visibleStage} />}
      {!previewIsCurrent && fftPreview && stageIndex(activeStage) >= stageIndex("band") && <div className="stale-preview">These settings changed after the displayed preview. Update this stage to apply them.</div>}
    </aside>
  );
}

function availableStage(active: PreviewStage, computed: PreviewStage | null): PreviewStage | null {
  if (!computed || stageIndex(computed) < stageIndex("fft")) return null;
  return stageIndex(active) <= stageIndex(computed) ? active : computed;
}

export function stageIndex(stage: PreviewStage | null): number {
  return stage ? PREVIEW_STAGES.findIndex(([value]) => value === stage) : -1;
}

function stageReached(computed: PreviewStage | null, required: PreviewStage): boolean {
  return stageIndex(computed) >= stageIndex(required);
}

function selectFrequencyHeatmap(preview: FftPreview | null, stage: PreviewStage | null): string | undefined {
  if (!preview || !stage || stageIndex(stage) < stageIndex("fft")) return undefined;
  if (stage === "fft") return preview.fft_heatmap_data_url;
  if (stage === "band") return preview.band_heatmap_data_url;
  if (stage === "tufts" || stage === "phase") return preview.cleanup_heatmap_data_url;
  return preview.cleanup_heatmap_data_url;
}

function selectMaskOverlay(preview: FftPreview | null, stage: PreviewStage | null): string | undefined {
  if (!preview || !stage || stageIndex(stage) < stageIndex("band")) return undefined;
  if (stage === "band") return preview.band_mask_overlay_data_url;
  if (stage === "tufts" || stage === "phase") return preview.cleanup_mask_overlay_data_url;
  return preview.cleanup_mask_overlay_data_url;
}

function StageMetrics({ preview, stage }: { preview: FftPreview; stage: PreviewStage | null }) {
  if (!stage || stageIndex(stage) < stageIndex("band")) return null;
  const metrics: Array<[string, string]> = [["CBF/background retained", preview.band_retained_pixels.toLocaleString()]];
  metrics.push(["De-doubled", preview.dedoubled_pixels.toLocaleString()]);
  if (stageIndex(stage) >= stageIndex("tufts")) metrics.push(["Foreground pixels", preview.cleanup_retained_pixels.toLocaleString()]);
  if (stageIndex(stage) >= stageIndex("tufts")) metrics.push(["Tufts", preview.tuft_count.toLocaleString()]);
  return <div className="preview-retention">{metrics.map(([label, value]) => <span key={label}>{label}<strong>{value}</strong></span>)}</div>;
}

function FrequencyLegend({ stage, preview }: { stage: PreviewStage | null; preview: FftPreview }) {
  const banded = stage && stageIndex(stage) >= stageIndex("band");
  const low = banded ? preview.band_low : 0;
  const high = banded ? preview.band_high : preview.nyquist_hz;
  return <div className="preview-colour-legend"><div className="frequency-gradient" /><span>{format(low)} Hz</span><span>{format(high)} Hz</span>{banded && <small>Legend uses the selected CBF window; visible pixels also reflect background/noise removal.</small>}</div>;
}

function PhaseLegend() {
  return <div className="preview-colour-legend phase"><div className="phase-gradient" /><span>-pi</span><span>+pi</span><small>Wrapped per-pixel phase at each pixel's selected dominant FFT frequency.</small></div>;
}

function AxisLegend() {
  return (
    <div className="axis-preview-legend">
      <svg viewBox="0 0 120 72" aria-label="Tensor axis angle colour legend">
        {Array.from({ length: 19 }, (_, index) => {
          const angle = index * 10;
          const theta = Math.PI - (angle / 180) * Math.PI;
          const x1 = 60 + 34 * Math.cos(theta);
          const y1 = 50 - 34 * Math.sin(theta);
          const x2 = 60 + 52 * Math.cos(theta);
          const y2 = 50 - 52 * Math.sin(theta);
          return <line key={angle} x1={x1} y1={y1} x2={x2} y2={y2} stroke={`hsl(${angle * 2}, 78%, 48%)`} strokeWidth="5" />;
        })}
        <text x="4" y="66">180</text><text x="56" y="12">90</text><text x="103" y="66">0</text>
      </svg>
      <small>Tuft colour shows tensor-axis angle; opacity and black-line thickness increase with coherence. Black line indicates the tensor-derived metachronal axis.</small>
    </div>
  );
}

function TuftLegend() {
  return <div className="tuft-legend"><span className="tuft-colour-strip" /><small>Colours distinguish connected tufts; they do not encode a numeric value.</small></div>;
}

function stageLabel(stage: PreviewStage): string {
  return { sample: "Sample and video", roi: "Region of interest", fft: "Per-pixel FFT", band: "CBF/background mask", filter: "Foreground filtering", tufts: "Foreground and tufts", phase: "Phase tensor axis" }[stage];
}

function emptyMessage(mode: ViewMode, stage: PreviewStage): string {
  if (mode === "axes") return "Run the phase tensor preview to view per-tuft axes.";
  if (mode === "phase") return "Run the FFT preview to view per-pixel phase.";
  if (mode === "tufts") return "Run the tuft-identification preview to view tuft colouring.";
  if (mode === "frequency") return `Run or update the ${stageLabel(stage).toLowerCase()} preview.`;
  return "A decoded sample preview will appear here.";
}

function RoiOverlay({ width, height, settings }: { width: number; height: number; settings: PipelineSettings }) {
  const maskId = "preview-rail-roi-mask";
  return <svg className="preview-roi-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><defs><mask id={maskId}><rect width={width} height={height} fill="white" />{settings.roiMode === "circle" && <circle cx={width / 2} cy={height / 2} r={settings.radius} fill="black" />}{settings.roiMode === "square" && <rect x={(width - settings.squareWidth) / 2} y={(height - settings.squareWidth) / 2} width={settings.squareWidth} height={settings.squareWidth} fill="black" />}{settings.roiMode === "full" && <rect width={width} height={height} fill="black" />}</mask></defs><rect width={width} height={height} mask={`url(#${maskId})`} className="excluded-region" /></svg>;
}

function format(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

import { useRef, type PointerEvent } from "react";
import type { FftPreview } from "../types/job";

interface SpectrumPreviewProps {
  preview: FftPreview;
  bandLow: number;
  bandHigh: number;
  onBandChange: (low: number, high: number) => void;
}

const width = 920;
const height = 190;
const left = 48;
const right = 16;
const top = 12;
const bottom = 30;
const frequencyGradientStops = ["#440154", "#31688e", "#35b779", "#fde725"];

export function SpectrumPreview({ preview, bandLow, bandHigh, onBandChange }: SpectrumPreviewProps) {
  const safeLow = clamp(bandLow, 0, preview.nyquist_hz);
  const safeHigh = clamp(bandHigh, safeLow, preview.nyquist_hz);
  return (
    <div className="spectrum-stack">
      <PowerSpectrum preview={preview} bandLow={safeLow} bandHigh={safeHigh} />
      <DominantHistogram preview={preview} bandLow={safeLow} bandHigh={safeHigh} />
      <BandWindowTrack
        minimum={0}
        maximum={preview.nyquist_hz}
        step={preview.frequency_resolution_hz}
        low={safeLow}
        high={safeHigh}
        onChange={onBandChange}
      />
    </div>
  );
}

function PowerSpectrum({ preview, bandLow, bandHigh }: Omit<SpectrumPreviewProps, "onBandChange">) {
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const x = (frequency: number) => left + (frequency / preview.nyquist_hz) * plotWidth;
  const y = (power: number) => top + (1 - clamp(power, 0, 1)) * plotHeight;
  const points = preview.frequencies_hz
    .map((frequency, index) => `${x(frequency).toFixed(2)},${y(preview.mean_power_normalized[index] ?? 0).toFixed(2)}`)
    .join(" ");
  return (
    <figure className="spectrum-figure">
      <figcaption>Mean pixel power spectrum</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Mean FFT power by frequency">
        <FrequencyGradientDefs gradientId="power-spectrum-frequency-gradient" x1={left} x2={left + plotWidth} />
        <PlotBackground x={x} bandLow={bandLow} bandHigh={bandHigh} plotWidth={plotWidth} plotHeight={plotHeight} gradientId="power-spectrum-frequency-gradient" />
        <polyline points={points} fill="none" stroke="url(#power-spectrum-frequency-gradient)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        <Axes maximum={preview.nyquist_hz} plotWidth={plotWidth} plotHeight={plotHeight} />
      </svg>
    </figure>
  );
}

function DominantHistogram({ preview, bandLow, bandHigh }: Omit<SpectrumPreviewProps, "onBandChange">) {
  const counts = preview.dominant_histogram_counts;
  const maxCount = Math.max(1, ...counts);
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const barWidth = plotWidth / Math.max(1, counts.length);
  const x = (frequency: number) => left + (frequency / preview.nyquist_hz) * plotWidth;
  return (
    <figure className="spectrum-figure">
      <figcaption>Pixel dominant-frequency distribution</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Histogram of pixel dominant FFT frequencies">
        <FrequencyGradientDefs gradientId="dominant-histogram-frequency-gradient" x1={left} x2={left + plotWidth} />
        <PlotBackground x={x} bandLow={bandLow} bandHigh={bandHigh} plotWidth={plotWidth} plotHeight={plotHeight} gradientId="dominant-histogram-frequency-gradient" />
        {counts.map((count, index) => {
          const frequency = preview.dominant_histogram_edges_hz[index] ?? 0;
          const nextFrequency = preview.dominant_histogram_edges_hz[index + 1] ?? frequency;
          const selected = nextFrequency >= bandLow && frequency <= bandHigh;
          const barHeight = (count / maxCount) * plotHeight;
          return <rect key={`${frequency}-${index}`} x={left + index * barWidth} y={top + plotHeight - barHeight} width={Math.max(1, barWidth - 0.5)} height={barHeight} fill={frequencyColor((frequency + nextFrequency) / 2, preview.nyquist_hz)} opacity={selected ? 0.95 : 0.28} />;
        })}
        <Axes maximum={preview.nyquist_hz} plotWidth={plotWidth} plotHeight={plotHeight} />
      </svg>
    </figure>
  );
}

function PlotBackground({ x, bandLow, bandHigh, plotWidth, plotHeight, gradientId }: { x: (value: number) => number; bandLow: number; bandHigh: number; plotWidth: number; plotHeight: number; gradientId: string }) {
  return <>
    <rect x={left} y={top} width={plotWidth} height={plotHeight} fill="#f3f6f7" />
    <rect x={x(bandLow)} y={top} width={Math.max(0, x(bandHigh) - x(bandLow))} height={plotHeight} fill={`url(#${gradientId})`} opacity="0.18" />
    <line x1={x(bandLow)} y1={top} x2={x(bandLow)} y2={top + plotHeight} className="band-boundary" />
    <line x1={x(bandHigh)} y1={top} x2={x(bandHigh)} y2={top + plotHeight} className="band-boundary" />
  </>;
}

function FrequencyGradientDefs({ gradientId, x1, x2 }: { gradientId: string; x1: number; x2: number }) {
  return (
    <defs>
      <linearGradient id={gradientId} x1={x1} x2={x2} y1="0" y2="0" gradientUnits="userSpaceOnUse">
        {frequencyGradientStops.map((colour, index) => (
          <stop key={colour} offset={`${(index / (frequencyGradientStops.length - 1)) * 100}%`} stopColor={colour} />
        ))}
      </linearGradient>
    </defs>
  );
}

function Axes({ maximum, plotWidth, plotHeight }: { maximum: number; plotWidth: number; plotHeight: number }) {
  return <>
    <line x1={left} y1={top + plotHeight} x2={left + plotWidth} y2={top + plotHeight} className="chart-axis" />
    <line x1={left} y1={top} x2={left} y2={top + plotHeight} className="chart-axis" />
    <text x={left} y={height - 8}>0</text>
    <text x={left + plotWidth} y={height - 8} textAnchor="end">{format(maximum)} Hz</text>
  </>;
}

type DragMode = "low" | "high" | "window";

function BandWindowTrack({ minimum, maximum, step, low, high, onChange }: { minimum: number; maximum: number; step: number; low: number; high: number; onChange: (low: number, high: number) => void }) {
  const drag = useRef<{ mode: DragMode; startX: number; low: number; high: number; width: number } | null>(null);
  const range = Math.max(maximum - minimum, step);
  const lowPercent = ((low - minimum) / range) * 100;
  const highPercent = ((high - minimum) / range) * 100;

  const start = (event: PointerEvent<HTMLButtonElement>, mode: DragMode) => {
    const track = event.currentTarget.parentElement;
    if (!track) return;
    track.setPointerCapture(event.pointerId);
    drag.current = { mode, startX: event.clientX, low, high, width: track.getBoundingClientRect().width };
    event.preventDefault();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const state = drag.current;
    const delta = ((event.clientX - state.startX) / Math.max(1, state.width)) * range;
    const minimumWidth = Math.max(step, range / 500);
    if (state.mode === "low") onChange(round(clamp(state.low + delta, minimum, state.high - minimumWidth), step), state.high);
    if (state.mode === "high") onChange(state.low, round(clamp(state.high + delta, state.low + minimumWidth, maximum), step));
    if (state.mode === "window") {
      const windowWidth = state.high - state.low;
      const nextLow = clamp(state.low + delta, minimum, maximum - windowWidth);
      onChange(round(nextLow, step), round(nextLow + windowWidth, step));
    }
  };

  return (
    <div className="band-window-control">
      <span className="band-window-instruction">Drag the selected CBF window or either edge.</span>
      <div className="band-window-track" onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <div className="band-window-selection" style={{ left: `${lowPercent}%`, width: `${Math.max(0, highPercent - lowPercent)}%` }} />
        <button type="button" className="band-window-body" style={{ left: `${lowPercent}%`, width: `${Math.max(0, highPercent - lowPercent)}%` }} aria-label="Move selected frequency window" onPointerDown={(event) => start(event, "window")} />
        <button type="button" className="band-window-handle low" style={{ left: `${lowPercent}%` }} aria-label="Resize lower frequency bound" onPointerDown={(event) => start(event, "low")} />
        <button type="button" className="band-window-handle high" style={{ left: `${highPercent}%` }} aria-label="Resize upper frequency bound" onPointerDown={(event) => start(event, "high")} />
        <strong className="band-window-label" style={{ left: `${lowPercent}%` }}>{format(low)} Hz</strong>
        <strong className="band-window-label" style={{ left: `${highPercent}%` }}>{format(high)} Hz</strong>
      </div>
    </div>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function frequencyColor(frequency: number, maximum: number): string {
  const t = clamp(maximum > 0 ? frequency / maximum : 0, 0, 1);
  const scaled = t * (frequencyGradientStops.length - 1);
  const index = Math.min(frequencyGradientStops.length - 2, Math.floor(scaled));
  const localT = scaled - index;
  return interpolateHex(frequencyGradientStops[index], frequencyGradientStops[index + 1], localT);
}

function interpolateHex(start: string, end: string, t: number): string {
  const a = hexToRgb(start);
  const b = hexToRgb(end);
  const rgb = a.map((value, index) => Math.round(value + (b[index] - value) * t));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function round(value: number, step: number): number {
  const decimals = step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 2;
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

function format(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

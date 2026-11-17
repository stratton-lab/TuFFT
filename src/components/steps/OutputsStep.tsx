import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  CORE_SUMMARY_METRIC_COLUMNS,
  EX_VIVO_SUMMARY_COLUMNS,
  KNN_SUMMARY_SUFFIXES,
  TUFT_METRIC_COLUMNS,
  isKnnSummaryColumn,
  knnSummaryColumns,
  parseKnnNeighborValues,
  type AnalysisDraft,
} from "../../types/job";
import { Field } from "../Field";

interface OutputsStepProps {
  draft: AnalysisDraft;
  setDraft: Dispatch<SetStateAction<AnalysisDraft>>;
  validationErrors: string[];
}

type BooleanOutput =
  | "batchSummary"
  | "perTuftTable"
  | "rawFftPlot"
  | "rawPhasePlot"
  | "gaussianEvidencePlot"
  | "tuftLabelPlot"
  | "tuftPixelCbfPlot"
  | "tuftDominantCbfPlot"
  | "tuftDominantCbfAxisPlot"
  | "tuftPhaseAxisPlot"
  | "tuftAxisCoherencePlot"
  | "exVivoOriginalPlot"
  | "exVivoCbfPlot"
  | "exVivoPhasePlot";

export function OutputsStep({ draft, setDraft, validationErrors }: OutputsStepProps) {
  const updateOutput = (key: BooleanOutput, enabled: boolean) =>
    setDraft((value) => ({ ...value, outputs: { ...value.outputs, [key]: enabled } }));
  const updateSettings = (patch: Partial<AnalysisDraft["settings"]>) =>
    setDraft((value) => ({ ...value, settings: { ...value.settings, ...patch } }));
  const updateKnnNeighborValues = (knnNeighborValues: string) =>
    setDraft((value) => {
      let nextDynamic: string[] = [];
      try {
        const selectedSuffixes = new Set(
          value.outputs.summaryColumns
            .map((column) => column.match(/^knn\d+_(.+)$/)?.[1])
            .filter((suffix): suffix is string => Boolean(suffix)),
        );
        nextDynamic = knnSummaryColumns(knnNeighborValues).filter((column) => {
          const suffix = column.match(/^knn\d+_(.+)$/)?.[1];
          return suffix ? selectedSuffixes.has(suffix) : false;
        });
      } catch {
        nextDynamic = [];
      }
      return {
        ...value,
        settings: { ...value.settings, knnNeighborValues },
        outputs: {
          ...value.outputs,
          summaryColumns: [
            ...value.outputs.summaryColumns.filter((column) => !isKnnSummaryColumn(column)),
            ...nextDynamic,
          ],
        },
      };
    });
  const toggleKnnMetric = (suffix: string, enabled: boolean) =>
    setDraft((value) => {
      let dynamicColumns: string[] = [];
      try {
        dynamicColumns = knnSummaryColumns(value.settings.knnNeighborValues).filter((column) => column.endsWith(`_${suffix}`));
      } catch {
        dynamicColumns = [];
      }
      const current = value.outputs.summaryColumns.filter((column) => !dynamicColumns.includes(column));
      return {
        ...value,
        outputs: {
          ...value.outputs,
          summaryColumns: enabled ? [...new Set([...current, ...dynamicColumns])] : current.filter((column) => !column.match(new RegExp(`^knn\\d+_${suffix}$`))),
        },
      };
    });
  const toggleColumn = (key: "summaryColumns" | "tuftColumns", column: string, enabled: boolean) =>
    setDraft((value) => {
      const columns = enabled ? [...new Set([...value.outputs[key], column])] : value.outputs[key].filter((item) => item !== column);
      return { ...value, outputs: { ...value.outputs, [key]: columns } };
    });
  const plotOptions: Array<[BooleanOutput, string, string]> = [
    ["rawFftPlot", "Raw FFT CBF", "Full-ROI dominant CBF before filtering"],
    ["rawPhasePlot", "Raw phase", "Full-ROI phase at each pixel's dominant frequency"],
    ["gaussianEvidencePlot", "Gaussian evidence heatmap", "Advanced diagnostic map used for background thresholding"],
    ["tuftLabelPlot", "Tuft ID labels", "Final tufts in distinct colors with black tuft numbers"],
    ["tuftPixelCbfPlot", "Final pixel CBF map", "Tuft-only mask colored by each pixel's dominant CBF"],
    ["tuftDominantCbfPlot", "Tuft mean CBF", "Each full tuft colored by the mean of its per-pixel dominant CBF values"],
    ["tuftDominantCbfAxisPlot", "Mean CBF with axes", "Tuft mean CBF plus tensor-axis lines"],
    ["tuftPhaseAxisPlot", "Phase with tensor axes", "Tuft phase map with black tensor-axis lines"],
    ["tuftAxisCoherencePlot", "Axis angle and coherence", "Tuft hue encodes tensor axis; opacity encodes coherence"],
  ];
  const dynamicKnnValues = useMemo(() => {
    try {
      return parseKnnNeighborValues(draft.settings.knnNeighborValues);
    } catch {
      return [];
    }
  }, [draft.settings.knnNeighborValues]);
  const dynamicKnnColumns = useMemo(() => knnSummaryColumns(dynamicKnnValues), [dynamicKnnValues]);
  const summaryColumns = useMemo(() => [...CORE_SUMMARY_METRIC_COLUMNS, ...dynamicKnnColumns], [dynamicKnnColumns]);
  const summaryColumnGroups = useMemo(() => [{ title: "Core video summary", columns: CORE_SUMMARY_METRIC_COLUMNS }], []);

  if (draft.analysisMode === "ex_vivo") {
    return (
      <div className="step-content">
        <div className="section-heading">
          <span className="eyebrow">Outputs</span>
          <h1>Choose ex-vivo tables and plots</h1>
          <p>Ex-vivo outputs are per-video ROI summaries and simple full-resolution diagnostic plots.</p>
        </div>

        <section className="panel output-rendering-settings">
          <div className="panel-title"><h2>Plot rendering</h2></div>
          <p>These choices affect saved figures only; they do not change measurements.</p>
          <div className="field-grid three">
            <OutputNumberField label="Raw FFT color minimum" hint={`Hz; default CBF lower bound (${draft.settings.bandLow})`} min={0} value={draft.settings.plotFrequencyMin} onChange={(plotFrequencyMin) => updateSettings({ plotFrequencyMin })} />
            <OutputNumberField label="Raw FFT color maximum" hint={`Hz; default CBF upper bound (${draft.settings.bandHigh})`} min={0} value={draft.settings.plotFrequencyMax} onChange={(plotFrequencyMax) => updateSettings({ plotFrequencyMax })} />
            <OutputNumberField label="Output resolution" hint="DPI; default 600" min={72} step={1} value={draft.settings.outputDpi} onChange={(outputDpi) => updateSettings({ outputDpi })} />
          </div>
          <Field label="Raw FFT colormap" hint="Default viridis">
            <select value={draft.settings.rawFftColormap} onChange={(event) => updateSettings({ rawFftColormap: event.currentTarget.value })}>
              <option value="viridis">Viridis - blue/green/yellow</option>
              <option value="turbo">Turbo - high contrast rainbow</option>
              <option value="magma">Magma - dark purple/orange</option>
              <option value="plasma">Plasma - purple/yellow</option>
              <option value="gray">Gray - grayscale</option>
            </select>
          </Field>
        </section>

        <section className="panel output-options">
          <div className="panel-title"><h2>CSV tables</h2></div>
          <div className="output-option">
            <label>
              <input type="checkbox" checked={draft.outputs.batchSummary} onChange={(event) => updateOutput("batchSummary", event.currentTarget.checked)} />
              <span><strong>Per-video summary CSV</strong><small>ROI area, foreground area, dominant CBF peak, FWHM, and per-pixel CBF summaries</small></span>
            </label>
            {draft.outputs.batchSummary && <ColumnMenu title="Summary CSV fields" columns={EX_VIVO_SUMMARY_COLUMNS} selected={draft.outputs.summaryColumns} onChange={(column, enabled) => toggleColumn("summaryColumns", column, enabled)} />}
          </div>
        </section>

        <section className="panel output-options">
          <div className="panel-title"><h2>Per-video PNG plots</h2></div>
          {([
            ["exVivoOriginalPlot", "Original ROI frame", "First frame with selected ROI mask"],
            ["gaussianEvidencePlot", "Gaussian evidence heatmap", "Advanced diagnostic map used for background thresholding"],
            ["exVivoCbfPlot", "Filtered CBF map", "Final ex-vivo foreground pixels colored by CBF"],
            ["exVivoPhasePlot", "Filtered phase map", "Final ex-vivo foreground pixels colored by phase"],
          ] as Array<[BooleanOutput, string, string]>).map(([key, label, description]) => (
            <div className="output-option" key={key}>
              <label>
                <input type="checkbox" checked={draft.outputs[key]} onChange={(event) => updateOutput(key, event.currentTarget.checked)} />
                <span><strong>{label}</strong><small>{description}</small></span>
              </label>
            </div>
          ))}
        </section>

        <section className="panel output-options">
          <div className="panel-title"><h2>Required run records</h2></div>
          <label className="required-output">
            <input type="checkbox" checked readOnly />
            <span><strong>Settings, ROI definitions, manifest, and logs</strong><small>Required for reproducibility and troubleshooting</small></span>
            <span className="status-label">Required</span>
          </label>
        </section>
        {validationErrors.length > 0 && <div className="validation-summary"><strong>Resolve output settings</strong><span>{validationErrors[0]}</span></div>}
      </div>
    );
  }

  return (
    <div className="step-content">
      <div className="section-heading">
        <span className="eyebrow">Outputs</span>
        <h1>Choose tables and plots</h1>
        <p>These choices control retained files for each run. Metachronal tensor metrics are computed when axis plots or axis columns are requested.</p>
      </div>

      <section className="panel output-rendering-settings">
        <div className="panel-title"><h2>Plot rendering</h2></div>
        <p>These choices affect saved figures only; they do not change segmentation or measurements.</p>
        <div className="field-grid three">
          <OutputNumberField label="Raw FFT color minimum" hint={`Hz; default CBF lower bound (${draft.settings.bandLow})`} min={0} value={draft.settings.plotFrequencyMin} onChange={(plotFrequencyMin) => updateSettings({ plotFrequencyMin })} />
          <OutputNumberField label="Raw FFT color maximum" hint={`Hz; default CBF upper bound (${draft.settings.bandHigh})`} min={0} value={draft.settings.plotFrequencyMax} onChange={(plotFrequencyMax) => updateSettings({ plotFrequencyMax })} />
          <OutputNumberField label="Output resolution" hint="DPI; default 600" min={72} step={1} value={draft.settings.outputDpi} onChange={(outputDpi) => updateSettings({ outputDpi })} />
        </div>
        <Field label="Raw FFT colormap" hint="Default viridis">
          <select value={draft.settings.rawFftColormap} onChange={(event) => updateSettings({ rawFftColormap: event.currentTarget.value })}>
            <option value="viridis">Viridis - blue/green/yellow</option>
            <option value="turbo">Turbo - high contrast rainbow</option>
            <option value="magma">Magma - dark purple/orange</option>
            <option value="plasma">Plasma - purple/yellow</option>
            <option value="gray">Gray - grayscale</option>
          </select>
        </Field>
      </section>

      <section className="panel output-options">
        <div className="panel-title"><h2>CSV tables</h2></div>
        <div className="output-option">
          <label>
            <input type="checkbox" checked={draft.outputs.batchSummary} onChange={(event) => updateOutput("batchSummary", event.currentTarget.checked)} />
            <span><strong>Per-video summary CSV</strong><small>Tuft counts, size and CBF summaries, tensor-axis summaries, and optional local planar-axis alignment</small></span>
          </label>
          {draft.outputs.batchSummary && <ColumnMenu title="Summary CSV fields" columns={summaryColumns} groups={summaryColumnGroups} selected={draft.outputs.summaryColumns} onChange={(column, enabled) => toggleColumn("summaryColumns", column, enabled)} knnControl={<PlanarPolarityColumnGroup knnValues={draft.settings.knnNeighborValues} selected={draft.outputs.summaryColumns} onKnnValuesChange={updateKnnNeighborValues} onMetricChange={toggleKnnMetric} />} />}
        </div>
        <div className="output-option">
          <label>
            <input type="checkbox" checked={draft.outputs.perTuftTable} onChange={(event) => updateOutput("perTuftTable", event.currentTarget.checked)} />
            <span><strong>Per-tuft CSV</strong><small>Centroids, area, per-pixel CBF summaries, binned joint spectral peak, tensor angle, and coherence</small></span>
          </label>
          {draft.outputs.perTuftTable && <ColumnMenu title="Per-tuft CSV fields" columns={TUFT_METRIC_COLUMNS} selected={draft.outputs.tuftColumns} onChange={(column, enabled) => toggleColumn("tuftColumns", column, enabled)} />}
        </div>
      </section>

      <section className="panel output-options">
        <div className="panel-title"><h2>Per-video PNG plots</h2></div>
        {plotOptions.map(([key, label, description]) => (
          <div className="output-option" key={key}>
            <label>
              <input type="checkbox" checked={draft.outputs[key]} onChange={(event) => updateOutput(key, event.currentTarget.checked)} />
              <span><strong>{label}</strong><small>{description}</small></span>
            </label>
          </div>
        ))}
      </section>

      <section className="panel output-options">
        <div className="panel-title"><h2>Required run records</h2></div>
        <label className="required-output">
          <input type="checkbox" checked readOnly />
          <span><strong>Settings, manifest, and logs</strong><small>Required for reproducibility and troubleshooting</small></span>
          <span className="status-label">Required</span>
        </label>
      </section>
      {validationErrors.length > 0 && <div className="validation-summary"><strong>Resolve output settings</strong><span>{validationErrors[0]}</span></div>}
    </div>
  );
}

interface ColumnGroup {
  title: string;
  columns: readonly string[];
}

function ColumnMenu({ title, columns, groups, selected, onChange, knnControl }: { title: string; columns: readonly string[]; groups?: ColumnGroup[]; selected: string[]; onChange: (column: string, enabled: boolean) => void; knnControl?: ReactNode }) {
  const count = columns.filter((column) => selected.includes(column)).length;
  return (
    <details className="column-menu">
      <summary>{title} <span>{count}/{columns.length} selected</span></summary>
      <div className="column-menu-actions">
        <button type="button" onClick={() => columns.forEach((column) => onChange(column, true))}>Select all</button>
        <button type="button" onClick={() => columns.forEach((column) => onChange(column, false))}>Clear optional</button>
      </div>
      {(groups ?? [{ title: "", columns }]).map((group) => (
        <div className="column-group" key={group.title || title}>
          {group.title && <strong>{group.title}</strong>}
          <div className="column-options">
            {group.columns.map((column) => (
              <label key={column}>
                <input type="checkbox" checked={selected.includes(column)} onChange={(event) => onChange(column, event.currentTarget.checked)} />
                <span>{humanize(column)}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {knnControl}
      <small>Video identity, status, error, and tuft ID fields are always retained where applicable.</small>
    </details>
  );
}

function PlanarPolarityColumnGroup({
  knnValues,
  selected,
  onKnnValuesChange,
  onMetricChange,
}: {
  knnValues: string;
  selected: string[];
  onKnnValuesChange: (value: string) => void;
  onMetricChange: (suffix: string, enabled: boolean) => void;
}) {
  const parsed = useMemo(() => {
    try {
      return parseKnnNeighborValues(knnValues);
    } catch {
      return [];
    }
  }, [knnValues]);
  return (
    <div className="column-group knn-column-group">
      <strong>Local planar-axis alignment</strong>
      <p className="column-group-description">A k-nearest-neighbour graph compares metachronal axes with an axial statistic, so 0 and 180 degrees are treated as the same alignment.</p>
      <Field label="Neighbour k value(s)" hint="Default 5-10; examples: 2, 3-5, or 4,7">
        <input value={knnValues} onChange={(event) => onKnnValuesChange(event.currentTarget.value)} />
      </Field>
      <div className="column-options">
        {KNN_SUMMARY_SUFFIXES.map((suffix) => {
          const expected = parsed.map((k) => `knn${k}_${suffix}`);
          const checked = expected.length > 0 && expected.every((column) => selected.includes(column));
          return (
            <label key={suffix}>
              <input type="checkbox" checked={checked} disabled={!parsed.length} onChange={(event) => onMetricChange(suffix, event.currentTarget.checked)} />
              <span>{humanize(suffix)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

const COLUMN_LABELS: Record<string, string> = {
  pixel_mean_cbf_mean_hz: "Mean of tuft mean CBF values (Hz)",
  pixel_mean_cbf_std_hz: "Std of tuft mean CBF values (Hz)",
  joint_peak_cbf_mean_hz: "Mean joint spectral peak CBF (binned) (Hz)",
  joint_peak_cbf_std_hz: "Std joint spectral peak CBF (binned) (Hz)",
  joint_spectral_cbf_hz: "Joint spectral peak CBF (binned) (Hz)",
  joint_peak_fwhm_hz: "Joint spectral peak FWHM (binned) (Hz)",
  joint_power_weighted_std_hz: "Joint spectral power-weighted std (binned) (Hz)",
  pixel_dominant_cbf_mean_hz: "Tuft mean per-pixel dominant CBF (Hz)",
  pixel_dominant_cbf_std_hz: "Tuft std per-pixel dominant CBF (Hz)",
  cbf_mean_abs_diff_hz: "Local CBF mean absolute difference (Hz)",
  cbf_std_abs_diff_hz: "Local CBF difference std (Hz)",
  cbf_exp_similarity: "Local CBF exponential similarity (0-1)",
  angle_mean_axial_agreement: "Planar-axis mean alignment (-1 to 1)",
  angle_std_axial_agreement: "Planar-axis alignment std",
  angle_coherence_weighted_axial_agreement: "Coherence-weighted planar-axis alignment (-1 to 1)",
};

function humanize(value: string): string {
  const neighborColumn = value.match(/^knn(\d+)_(.+)$/);
  if (neighborColumn) {
    const metric = COLUMN_LABELS[neighborColumn[2]] ?? neighborColumn[2].replaceAll("_", " ");
    return `k=${neighborColumn[1]}: ${metric}`;
  }
  return COLUMN_LABELS[value] ?? value.replaceAll("_", " ").replace(/\bcbf\b/gi, "CBF").replace(/\bknn\b/gi, "kNN").replace(/\bpx\b/gi, "px");
}

function OutputNumberField({ label, hint, value, min, step = 0.1, onChange }: { label: string; hint?: string; value: number; min?: number; step?: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  const commit = () => {
    focused.current = false;
    const parsed = Number(text);
    if (text.trim() && Number.isFinite(parsed)) {
      onChange(parsed);
      setText(String(parsed));
    } else {
      setText(String(value));
    }
  };
  return <Field label={label} hint={hint}><input type="number" min={min} step={step} value={text} onFocus={() => { focused.current = true; }} onChange={(event) => setText(event.currentTarget.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></Field>;
}

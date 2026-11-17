import { CheckCircle2, CircleDotDashed, Microscope } from "lucide-react";
import type { AnalysisMode } from "../../types/job";

export function ModeStep({ value, onChange }: { value: AnalysisMode; onChange: (mode: AnalysisMode) => void }) {
  return (
    <div className="step-content">
      <div className="section-heading">
        <span className="eyebrow">New analysis</span>
        <h1>Choose an analysis type</h1>
        <p>The processing workflow and available controls will follow this choice.</p>
      </div>
      <div className="mode-grid">
        <button className={`mode-option ${value === "in_vitro" ? "selected" : ""}`} type="button" onClick={() => onChange("in_vitro")}>
          <CircleDotDashed size={24} />
          <span><strong>In-vitro</strong><small>Culture-style CBF and tuft analysis</small></span>
          {value === "in_vitro" && <CheckCircle2 className="selection-mark" size={19} />}
        </button>
        <button className={`mode-option ${value === "ex_vivo" ? "selected" : ""}`} type="button" onClick={() => onChange("ex_vivo")}>
          <Microscope size={24} />
          <span><strong>Ex-vivo</strong><small>ROI-based CBF and phase analysis without tuft segmentation</small></span>
          {value === "ex_vivo" && <CheckCircle2 className="selection-mark" size={19} />}
        </button>
      </div>
    </div>
  );
}

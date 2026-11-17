import { useEffect, useId, useRef, useState } from "react";
import type { FrameCountSelection } from "../types/job";

interface FrameCountFieldProps {
  value: FrameCountSelection;
  onChange: (value: FrameCountSelection) => void;
}

export function FrameCountField({ value, onChange }: FrameCountFieldProps) {
  const inputId = useId();
  const rememberedCount = useRef(typeof value === "number" ? value : 100);
  const [text, setText] = useState(String(rememberedCount.current));

  useEffect(() => {
    if (typeof value === "number") {
      rememberedCount.current = value;
      setText(String(value));
    }
  }, [value]);

  const commit = () => {
    const parsed = Number(text);
    if (Number.isInteger(parsed) && parsed >= 4) {
      rememberedCount.current = parsed;
      onChange(parsed);
      setText(String(parsed));
    } else {
      setText(String(rememberedCount.current));
    }
  };

  return (
    <div className="field frame-count-field">
      <label className="field-label" htmlFor={value === "all" ? undefined : inputId}>Frames to process</label>
      <div className="frame-count-controls">
        {value === "all"
          ? <div className="all-frames-value">All frames</div>
          : <input id={inputId} type="number" value={text} min={4} step={1} onChange={(event) => setText(event.currentTarget.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />}
        <div className="frame-count-mode" role="group" aria-label="Frame count mode">
          <button type="button" aria-pressed={value !== "all"} className={value !== "all" ? "active" : ""} onClick={() => onChange(rememberedCount.current)}>Set number</button>
          <button type="button" aria-pressed={value === "all"} className={value === "all" ? "active" : ""} onClick={() => onChange("all")}>All</button>
        </div>
      </div>
      <small>Final analysis</small>
    </div>
  );
}

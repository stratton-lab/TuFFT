import { Check, Circle } from "lucide-react";

export interface SetupStep {
  id: string;
  label: string;
}

interface StepNavigationProps {
  steps: SetupStep[];
  currentIndex: number;
  furthestIndex: number;
  disabled?: boolean;
  onSelect: (index: number) => void;
}

export function StepNavigation({ steps, currentIndex, furthestIndex, disabled = false, onSelect }: StepNavigationProps) {
  return (
    <nav className="step-navigation" aria-label="Analysis setup">
      <div className="product-mark">
        <span className="product-wordmark" aria-label="TuFFT"><span>Tu</span><strong>FFT</strong></span>
      </div>
      <ol>
        {steps.map((step, index) => {
          const complete = index < currentIndex;
          const available = index <= furthestIndex && !disabled;
          return (
            <li key={step.id}>
              <button
                type="button"
                className={index === currentIndex ? "active" : ""}
                disabled={!available}
                onClick={() => onSelect(index)}
              >
                {complete ? <Check size={16} /> : <Circle size={14} />}
                <span>{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

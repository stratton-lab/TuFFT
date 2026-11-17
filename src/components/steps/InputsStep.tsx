import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { CheckSquare2, FileVideo2, FolderSearch2, FolderOpen, Trash2 } from "lucide-react";
import type { AnalysisDraft } from "../../types/job";
import { acceptedVideoDescription, isDesktopRuntime } from "../../services/desktop";

interface InputsStepProps {
  draft: AnalysisDraft;
  notice: string | null;
  directoryBusy: boolean;
  onChooseVideos: () => void;
  onChooseDirectory: () => void;
  onChooseOutput: () => void;
  onRemoveVideos: (paths: string[]) => void;
  onDropPaths: (paths: string[]) => void;
}

export function InputsStep({
  draft,
  notice,
  directoryBusy,
  onChooseVideos,
  onChooseDirectory,
  onChooseOutput,
  onRemoveVideos,
  onDropPaths,
}: InputsStepProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const subscription = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      setDragging(payload.type === "enter" || payload.type === "over");
      if (payload.type === "drop" && !directoryBusy) onDropPaths(payload.paths);
    });
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten());
    };
  }, [directoryBusy, onDropPaths]);

  useEffect(() => {
    setSelected((current) => new Set([...current].filter((path) => draft.inputVideos.includes(path))));
  }, [draft.inputVideos]);

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="step-content">
      <div className="section-heading">
        <span className="eyebrow">Inputs</span>
        <h1>Select videos and output</h1>
        <p>Add files, select several folders, or drag videos and folders together into this window. All subfolders are searched.</p>
      </div>

      <div className="batch-note">
        <strong>Accepted inputs: {acceptedVideoDescription}</strong>
        <span>Every video in this batch will use the same FPS, frame count, ROI, QC settings, and outputs. Create separate runs for videos requiring different specifications.</span>
      </div>

      <section className={`panel${dragging ? " input-drop-active" : ""}`}>
        <div className="panel-heading input-heading">
          <div><h2>Videos</h2><p>{draft.inputVideos.length} selected</p></div>
          <div className="button-row">
            <button className="button secondary" type="button" disabled={directoryBusy} onClick={onChooseVideos}>
              <FileVideo2 size={17} /> Add files
            </button>
            <button className="button secondary" type="button" disabled={directoryBusy} onClick={onChooseDirectory}>
              <FolderSearch2 size={17} /> {directoryBusy ? "Searching..." : "Add folders"}
            </button>
          </div>
        </div>
        {notice && <div className="notice input-notice" role="status">{notice}</div>}

        {draft.inputVideos.length ? (
          <>
            <div className="file-list-actions">
              <button
                type="button"
                onClick={() => setSelected(new Set(selected.size === draft.inputVideos.length ? [] : draft.inputVideos))}
              >
                <CheckSquare2 size={15} /> {selected.size === draft.inputVideos.length ? "Clear selection" : "Select all"}
              </button>
              <button
                type="button"
                disabled={!selected.size}
                onClick={() => {
                  onRemoveVideos([...selected]);
                  setSelected(new Set());
                }}
              >
                <Trash2 size={15} /> Remove selected ({selected.size})
              </button>
            </div>
            <ul className="file-list scrollable">
              {draft.inputVideos.map((path) => (
                <li key={path}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${fileName(path)}`}
                    checked={selected.has(path)}
                    onChange={() => toggle(path)}
                  />
                  <FileVideo2 size={17} />
                  <span title={path}>{fileName(path)}<small>{path}</small></span>
                  <button className="icon-button" type="button" title={`Remove ${fileName(path)}`} onClick={() => onRemoveVideos([path])}>
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : <div className="empty-state">No videos selected</div>}
      </section>

      <section className="panel output-row">
        <div><h2>Output directory</h2><p className={draft.outputRoot ? "path-value" : "muted"}>{draft.outputRoot || "Not selected"}</p></div>
        <button className="button secondary" type="button" onClick={onChooseOutput}>
          <FolderOpen size={17} /> Choose folder
        </button>
      </section>
    </div>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

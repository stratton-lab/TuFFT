import { useMemo, useState, type PointerEvent } from "react";
import type { FirstFramePreview, RoiPolygon } from "../types/job";

interface PolygonRoiEditorProps {
  preview: FirstFramePreview;
  polygons: RoiPolygon[];
  onChange: (polygons: RoiPolygon[]) => void;
}

export function PolygonRoiEditor({ preview, polygons, onChange }: PolygonRoiEditorProps) {
  const [activePolygon, setActivePolygon] = useState(0);
  const [dragging, setDragging] = useState<{ polygon: number; vertex: number } | null>(null);
  const current = polygons[activePolygon] ?? [];
  const pathData = useMemo(() => current.map((point) => `${point.x},${point.y}`).join(" "), [current]);

  const pointerPoint = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(preview.width, ((event.clientX - bounds.left) / bounds.width) * preview.width)),
      y: Math.max(0, Math.min(preview.height, ((event.clientY - bounds.top) / bounds.height) * preview.height)),
    };
  };

  const updatePolygon = (index: number, polygon: RoiPolygon) => {
    const next = polygons.slice();
    next[index] = polygon;
    onChange(next);
  };

  const addPoint = (event: PointerEvent<SVGSVGElement>) => {
    if (dragging || event.target instanceof SVGCircleElement) return;
    const next = polygons.length ? polygons : [[]];
    const index = polygons.length ? activePolygon : 0;
    const polygon = [...(next[index] ?? []), pointerPoint(event)];
    const copy = next.slice();
    copy[index] = polygon;
    onChange(copy);
    setActivePolygon(index);
  };

  const moveVertex = (event: PointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    const next = polygons[dragging.polygon]?.slice() ?? [];
    next[dragging.vertex] = pointerPoint(event);
    updatePolygon(dragging.polygon, next);
  };

  const deleteVertex = (polygonIndex: number, vertexIndex: number) => {
    const next = polygons.slice();
    next[polygonIndex] = next[polygonIndex].filter((_, index) => index !== vertexIndex);
    onChange(next.filter((polygon) => polygon.length > 0));
    setActivePolygon(0);
  };

  return (
    <div className="polygon-editor">
      <div className="polygon-toolbar">
        <button className="button secondary" type="button" onClick={() => { onChange([...polygons, []]); setActivePolygon(polygons.length); }}>New selection</button>
        <button className="button secondary" type="button" disabled={!polygons.length} onClick={() => { onChange(polygons.filter((_, index) => index !== activePolygon)); setActivePolygon(0); }}>Delete selection</button>
        <button className="button danger" type="button" disabled={!polygons.length} onClick={() => { onChange([]); setActivePolygon(0); }}>Clear ROI</button>
      </div>
      <div className="polygon-stage" style={{ aspectRatio: `${preview.width} / ${preview.height}` }}>
        <img src={preview.loop_data_url || preview.image_data_url} alt="Video preview for ROI drawing" draggable={false} />
        <svg
          viewBox={`0 0 ${preview.width} ${preview.height}`}
          preserveAspectRatio="none"
          onPointerDown={addPoint}
          onPointerMove={moveVertex}
          onPointerUp={() => setDragging(null)}
          onPointerCancel={() => setDragging(null)}
        >
          {polygons.map((polygon, polygonIndex) => (
            <g key={polygonIndex} className={polygonIndex === activePolygon ? "active" : ""} onPointerDown={(event) => { event.stopPropagation(); setActivePolygon(polygonIndex); }}>
              {polygon.length >= 3 && <polygon points={polygon.map((point) => `${point.x},${point.y}`).join(" ")} />}
              {polygon.length > 1 && <polyline points={polygon.map((point) => `${point.x},${point.y}`).join(" ")} />}
              {polygon.map((point, vertexIndex) => (
                <circle
                  key={`${point.x}-${point.y}-${vertexIndex}`}
                  cx={point.x}
                  cy={point.y}
                  r={Math.max(4, preview.width / 180)}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    if (event.altKey) {
                      deleteVertex(polygonIndex, vertexIndex);
                      return;
                    }
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragging({ polygon: polygonIndex, vertex: vertexIndex });
                    setActivePolygon(polygonIndex);
                  }}
                />
              ))}
            </g>
          ))}
          {current.length > 0 && current.length < 3 && <polyline className="draft-polyline" points={pathData} />}
        </svg>
      </div>
      <small>Click to add vertices. Drag a vertex to modify it. Alt-click a vertex to delete it. Use New selection for disjoint ROI regions.</small>
    </div>
  );
}

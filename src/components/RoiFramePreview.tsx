import type { FirstFramePreview, RoiMode } from "../types/job";

interface RoiFramePreviewProps {
  preview: FirstFramePreview;
  roiMode: RoiMode;
  radius: number;
  squareWidth: number;
}

export function RoiFramePreview({ preview, roiMode, radius, squareWidth }: RoiFramePreviewProps) {
  const maskId = "roi-exclusion-mask";
  return (
    <div className="roi-preview" style={{ aspectRatio: `${preview.width} / ${preview.height}` }}>
      <img src={preview.image_data_url} alt="First frame of representative video" />
      <svg viewBox={`0 0 ${preview.width} ${preview.height}`} preserveAspectRatio="xMidYMid meet" aria-label="ROI overlay">
        {roiMode === "circle" ? (
          <>
            <defs>
              <mask id={maskId}>
                <rect width={preview.width} height={preview.height} fill="white" />
                <circle cx={preview.width / 2} cy={preview.height / 2} r={Math.max(0, radius)} fill="black" />
              </mask>
            </defs>
            <rect width={preview.width} height={preview.height} fill="rgba(21, 34, 43, 0.62)" mask={`url(#${maskId})`} />
            <circle
              cx={preview.width / 2}
              cy={preview.height / 2}
              r={Math.max(0, radius)}
              fill="none"
              stroke="#2aa994"
              strokeWidth={Math.max(2, preview.width / 300)}
            />
          </>
        ) : roiMode === "square" ? (
          <>
            <defs>
              <mask id={maskId}>
                <rect width={preview.width} height={preview.height} fill="white" />
                <rect
                  x={(preview.width - squareWidth) / 2}
                  y={(preview.height - squareWidth) / 2}
                  width={Math.max(0, squareWidth)}
                  height={Math.max(0, squareWidth)}
                  fill="black"
                />
              </mask>
            </defs>
            <rect width={preview.width} height={preview.height} fill="rgba(21, 34, 43, 0.62)" mask={`url(#${maskId})`} />
            <rect
              x={(preview.width - squareWidth) / 2}
              y={(preview.height - squareWidth) / 2}
              width={Math.max(0, squareWidth)}
              height={Math.max(0, squareWidth)}
              fill="none"
              stroke="#2aa994"
              strokeWidth={Math.max(2, preview.width / 300)}
            />
          </>
        ) : (
          <rect
            x="2"
            y="2"
            width={preview.width - 4}
            height={preview.height - 4}
            fill="none"
            stroke="#2aa994"
            strokeWidth={Math.max(2, preview.width / 300)}
          />
        )}
      </svg>
      <span>{preview.width} x {preview.height} px</span>
    </div>
  );
}

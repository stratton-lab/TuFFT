# Desktop Tutorial

Install and open TuFFT using the [installation guide](INSTALLATION.md). This walkthrough uses an in-vitro video recorded at **500 fps**, the first **100 frames**, and default parameters. Screenshots show a real example; use your own videos locally.

## 1. Choose Mode, Videos, And Output

Choose **In-vitro** and click **Continue**. Add individual videos, select multiple folders for recursive discovery, or drag a mixture of files and folders into selection. Duplicate paths are removed. Remove unwanted videos from the scrollable list and choose a writable output folder.

Accepted containers: `.avi`, `.mp4`, `.mov`, `.m4v`, `.mkv`, `.wmv`, `.mpg`, `.mpeg`; FFmpeg must support the internal codec.

All batch videos share FPS, frame-count choice, filtering, and outputs. In-vitro also shares one ROI. Use separate batches for incompatible acquisition settings.

## 2. Set FPS, Frames, And ROI

On **Video assumptions**, enter acquisition FPS, not playback rate. Keep **100** frames for this quick example; choose a larger count or **All** for final work as appropriate. At 500 fps, 100 frames gives 5 Hz FFT spacing; 500 frames gives 1 Hz. Scientific setup previews use at most 100 frames even when the final job uses more.

Wait for the video preview, then click **Next setting**. Choose a centered circle (default radius **440 pixels**), centered square, or full frame. Make sure the ROI fits your video. Excluded pixels are shaded.

![Centered circular ROI selection](images/desktop-roi.png)

## 3. Inspect FFT And Apply Filtering

Click **Next setting**, leave **Hann window (recommended)** enabled, then **Run FFT preview**. Each ROI pixel is analyzed independently. After completion the app advances to CBF/background settings.

Inspect the spectrum, dominant-frequency histogram, and frequency map. Drag the shared window or type lower/upper bounds; this example uses **5-60 Hz**. Click **Apply CBF bandpass and background/noise removal**, then inspect **Raw / Masked**.

![CBF window and combined foreground filtering](images/desktop-band.png)

This button applies both band and evidence/SNR filtering: pixels may disappear even with a broad band. Reapplying different bounds starts from the FFT result, not the previously filtered mask.

**Advanced settings** exposes controls for the current stage. Otsu may remove valid signal when the ROI has little background. Inspect the mask; reduce the Otsu coefficient or choose a manual evidence cutoff if appropriate. The evidence heatmap is available in this advanced section and as an optional PNG.

## 4. Inspect Tufts And Axes

Click **Next setting**. Keep minimum tuft area **150 px²** and maximum size before splitting **800 px²** for this example. The size reference draws an equivalent-area circle on the preview. Click **Run final tuft preview**.

![Segmented tufts shown in distinct colors](images/desktop-tufts.png)

Inspect lost or merged tufts. The 800-pixel value triggers attempted splitting, not a guaranteed final upper bound: regions can remain larger if no acceptable watershed split is found.

Continue to **Phase tensor preview**, then **Run phase tensor preview**. Switch among Video, Frequency, Phase, Tufts, and Axes as available. Black lines indicate metachronal axes, modulo 180 degrees, not signed flow. Coherence describes phase-gradient organization, not anatomical polarity directly.

Zoom/pan is shared across views: use zoom controls, double-click to zoom toward a point, drag while zoomed, or reset the view. Upstream changes require refreshed downstream previews. The bottom **Continue with default/current analysis settings** accepts valid settings without completing every optional preview; leaving settings cancels an active preview safely.

## 5. Select Outputs

Continue to **Outputs**. Both CSVs are enabled by default. Expand their field menus to select measurements; required identity/status columns remain. Defaults include per-pixel mean CBF and joint spectral CBF peak, a discrete FFT-bin estimate.

![CSV and per-video PNG output selection](images/desktop-outputs.png)

Optional **local planar-axis alignment** uses nearest neighbours: enter values such as `5-10` or `4,7`, then enable desired metrics. Axial agreement treats 0 and 180 degrees as equivalent. Computations needed by selected CSVs and plots are enabled automatically.

Choose PNGs, colormap, DPI (default **600**), and display range. Color limits initially follow the CBF band; band edits reset them, so apply custom plot limits after final band selection. Display limits do not alter measurements.

## 6. Run And Find Results

Continue to **Review and run**, confirm settings, then **Run analysis**. Start with **1** CPU worker; more workers process separate videos concurrently and increase RAM and temporary-disk use.

Monitor stages, progress, elapsed time, ETA, and warnings. **Stop analysis** cancels; completed outputs remain and incomplete outputs are recorded. Inspect the manifest and per-video statuses for failures.

At completion, choose **Open output directory**. Every unique job folder contains `parameters.json`, `manifest.json`, logs, selected batch tables, and per-video CSVs/PNGs. Keep parameters and manifest with exported results.

**Reset setup** clears the previous job. **Import parameters.json** reuses settings and output choices on newly selected videos. The file must match the chosen analysis mode.

## Ex-Vivo Workflow

Choose **Ex-vivo** for ROI-level analysis without tuft segmentation. Default FPS is **2000**; confirm the acquisition rate.

1. Select videos and an output folder.
2. Choose **Full frame** or **Custom ROI per video**. Click to draw polygons, use **New selection** for disjoint regions, drag vertices to adjust, Alt-click to delete a vertex, or delete/clear selections.
3. Click **Save ROI** above the video before **Next video**. Next highlights after saving. Complete every video's ROI.
4. Run FFT, select the CBF window, and apply CBF/background filtering. Then choose the despeckle minimum and click **Apply foreground filter preview**. Inspect Frequency/Phase and Raw/Masked views.
5. Select summary CSV fields and original, CBF, phase, or evidence PNGs; review and run.

Saving writes reusable JSON immediately to **`<selected output folder>/rois/`**, never beside source videos. **Import ROI folder** matches records by source-video path; assign unmatched videos manually. Moving a video may prevent matching. Full-frame analysis needs only imported parameters, not an ROI folder.

The display loops the first 90 frames at **30 fps**, independent of acquisition FPS. Computation uses acquisition FPS and the requested frame count. Ex-vivo summarizes retained ROI foreground, without per-tuft tables or splitting.

# Desktop Tutorial

Install and open TuFFT using the [installation guide](INSTALLATION.md). This walkthrough uses an in-vitro video recorded at **500 fps**, the first **100 frames**, and default parameters. Screenshots show a real example; use your own videos locally.

## 1. Choose Analysis Mode

Choose **In-vitro** for tuft segmentation and tuft-level measurements, then click **Continue**. The [ex-vivo workflow](#ex-vivo-workflow) uses ROI-level measurements instead.

![Analysis mode selection](images/desktop-mode.png)

## 2. Select Videos And Output Folder

Add individual videos, select multiple folders for recursive discovery, or drag a mixture of files and folders into selection. Duplicate paths are removed. Remove unwanted videos from the scrollable list and choose a writable output folder. Click **Continue**.

![Input video list and output-folder selection; local paths are anonymized](images/desktop-inputs.png)

Accepted containers: `.avi`, `.mp4`, `.mov`, `.m4v`, `.mkv`, `.wmv`, `.mpg`, `.mpeg`; FFmpeg must support the internal codec.

All batch videos share FPS, frame-count choice, filtering, and outputs. In-vitro also shares one ROI. Use separate batches for incompatible acquisition settings.

## 3. Set FPS And Frame Count

On **Video assumptions**, enter acquisition FPS, not playback rate. Keep **100** frames for this quick example; choose a larger count or **All** for final work as appropriate. At 500 fps, 100 frames gives 5 Hz FFT spacing; 500 frames gives 1 Hz. Scientific setup previews use at most 100 frames even when the final job uses more.

Wait for the video preview to finish decoding before clicking **Next setting**.

![Video assumptions: acquisition FPS, frame count, detected dimensions, and video preview](images/desktop-video-assumptions.png)

## 4. Select The ROI

Choose a centered circle (default radius **440 pixels**), centered square, or full frame. Make sure the ROI fits your video. Excluded pixels are shaded. This tutorial retains the default circle.

![Centered circular ROI selection](images/desktop-roi.png)

<details>
<summary>Compare the other ROI shapes</summary>

The square uses an adjustable width. Full frame includes every pixel. Switch back to **Centered circle** to follow this example without changing its parameters.

![Centered square ROI](images/desktop-roi-square.png)

![Full-frame ROI](images/desktop-roi-full.png)

</details>

## 5. Run The Per-Pixel FFT

Click **Next setting**, leave **Hann window (recommended)** enabled, then **Run FFT preview**. Each ROI pixel is analyzed independently. After completion the app advances to CBF/background settings.

![Per-pixel FFT setup before running the preview](images/desktop-fft.png)

## 6. Choose The CBF Band And Remove Background

Inspect the spectrum, dominant-frequency histogram, and frequency map. Drag the shared window or type lower/upper bounds; this example uses **5-60 Hz**. The **Raw** frequency view shows the FFT result before foreground filtering.

![Raw frequency preview with the shared CBF selection window](images/desktop-raw-frequency.png)

Click **Apply CBF bandpass and background/noise removal**, then inspect **Raw / Masked**.

![CBF window and combined foreground filtering](images/desktop-band.png)

This button applies both band and evidence/SNR filtering: pixels may disappear even with a broad band. Reapplying different bounds starts from the FFT result, not the previously filtered mask.

**Advanced settings** exposes controls for the current stage. Otsu may remove valid signal when the ROI has little background. Inspect the mask; reduce the Otsu coefficient or choose a manual evidence cutoff if appropriate. The evidence heatmap is available in this advanced section and as an optional PNG.

![Advanced background controls and Gaussian evidence preview with its 0-1 scale](images/desktop-evidence-settings.png)

<details>
<summary>Compare raw and filtered phase views</summary>

The **Phase** tab is available after FFT. **Raw** shows phase throughout the ROI; **Masked** applies the foreground mask from the current processing stage. Switching views does not rerun the analysis.

![Raw pixel-phase preview before foreground filtering](images/desktop-raw-phase.png)

![Phase preview after CBF and background filtering](images/desktop-filtered-phase.png)

</details>

## 7. Set Tuft Sizes And Inspect Segmentation

Click **Next setting**. Keep minimum tuft area **150 px²** and maximum size before splitting **800 px²** for this example, then click **Run final tuft preview**. Click a size field and move the cursor over the preview to display its equivalent-area circle. The references below are shown over the masked video after computing the tuft preview; they can also be inspected before running it.

![Minimum tuft-area reference circle over the preview](images/desktop-minimum-size.png)

<details>
<summary>Compare the maximum-size reference</summary>

![Maximum tuft-area reference circle over the preview](images/desktop-maximum-size.png)

</details>

Switch to the **Tufts** view. Different colors identify separate labels; they do not represent CBF.

![Segmented tufts shown in distinct colors](images/desktop-tufts.png)

Inspect lost or merged tufts. The 800-pixel value triggers attempted splitting, not a guaranteed final upper bound: regions can remain larger if no acceptable watershed split is found.

![Final tuft-only frequency preview](images/desktop-final-frequency.png)

## 8. Inspect Phase And Metachronal Axes

Continue to **Phase tensor preview**, then **Run phase tensor preview**. Switch among Video, Frequency, Phase, Tufts, and Axes as available. Black lines indicate metachronal axes, modulo 180 degrees, not signed flow. Coherence describes phase-gradient organization, not anatomical polarity directly.

![Tensor-axis preview: tuft hue represents axis angle and opacity represents coherence](images/desktop-axes.png)

<details>
<summary>Switch between phase and the masked video</summary>

![Phase view with the final tuft mask](images/desktop-tuft-phase.png)

![Video view with the same retained tuft mask](images/desktop-masked-video.png)

</details>

Zoom/pan is shared across views: use zoom controls, double-click to zoom toward a point, drag while zoomed, or reset the view. Upstream changes require refreshed downstream previews. The bottom **Continue with default/current analysis settings** accepts valid settings without completing every optional preview; leaving settings cancels an active preview safely.

## 9. Select Outputs

Continue to **Outputs**. Both CSVs are enabled by default. Expand their field menus to select measurements; required identity/status columns remain. Defaults include per-pixel mean CBF and joint spectral CBF peak, a discrete FFT-bin estimate.

![CSV and per-video PNG output selection](images/desktop-outputs.png)

Optional **local planar-axis alignment** uses nearest neighbours: enter values such as `5-10` or `4,7`, then enable desired metrics. Axial agreement treats 0 and 180 degrees as equivalent. Computations needed by selected CSVs and plots are enabled automatically.

<details>
<summary>See the expanded CSV field menus</summary>

Choose only the measurements you want saved. The local planar-axis alignment controls sit inside the summary menu; these optional metrics are unchecked in this example.

![Expanded summary and per-tuft CSV field menus](images/desktop-csv-fields.png)

</details>

Choose PNGs, colormap, DPI (default **600**), and display range. Color limits initially follow the CBF band; band edits reset them, so apply custom plot limits after final band selection. Display limits do not alter measurements.

Select **Gaussian evidence heatmap** to save the diagnostic map shown below. It is optional and must be checked explicitly for this example. All analysis parameters remain at their defaults.

![Per-video PNG choices with Gaussian evidence heatmap selected](images/desktop-output-plots.png)

## 10. Review, Run, And Find Results

Continue to **Review and run**, confirm settings, then **Run analysis**. Start with **1** CPU worker; more workers process separate videos concurrently and increase RAM and temporary-disk use.

![Pre-run review of inputs, ROI, parameters, and selected outputs](images/desktop-review.png)

Monitor stages, progress, elapsed time, ETA, and warnings. **Stop analysis** cancels; completed outputs remain and incomplete outputs are recorded. Inspect the manifest and per-video statuses for failures.

![Analysis running with current-video stages and batch progress](images/desktop-running.png)

At completion, choose **Open output directory**. Every unique job folder contains `parameters.json`, `manifest.json`, logs, selected batch tables, and per-video CSVs/PNGs. Keep parameters and manifest with exported results.

![Completed analysis and the Open output directory action](images/desktop-completed.png)

The Gaussian evidence PNG below is an actual saved output from this example run, not a screenshot of the preview. Its colorbar shows the normalized evidence used for background thresholding. It is not a CBF or phase map.

![Saved Gaussian evidence heatmap with its labeled evidence colorbar](images/desktop-evidence-result.png)

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

# TuFFT

**TuFFT** analyzes high-speed microscopy videos of motile cilia through a guided Windows desktop application and a Python CLI using the same analysis engine.

- **In-vitro:** segment ciliated tufts and measure area, ciliary beat frequency (CBF), metachronal axis, and phase-tensor coherence.
- **Ex-vivo:** analyze full frames or per-video polygonal ROIs, with foreground filtering and ROI-level CBF summaries.
- Choose CSV fields and PNG plots, reuse settings, and monitor or cancel batch runs.

## Download And Start

| Goal | Start here |
| --- | --- |
| Use the Windows app | [Download the installer](https://github.com/stratton-lab/TuFFT/releases/latest), then follow [installation](docs/INSTALLATION.md#windows-installer). |
| Learn the desktop workflow | [Illustrated desktop tutorial](docs/USER_MANUAL.md). |
| Analyze from a terminal | [Python-only installation](docs/INSTALLATION.md#python-cli-only), then [CLI tutorial](docs/CLI_TUTORIAL.md). |
| Develop the desktop app | [Desktop source installation](docs/INSTALLATION.md#desktop-from-source-windows). |

The installer includes Python, scientific dependencies, and FFmpeg; no development tools are required. Download the **setup .exe** under release Assets, not GitHub's source-code ZIP. While this repository is private, downloads and cloning require an invited GitHub account; a link alone does not grant access.

Windows 10/11 x64 is supported. macOS desktop packaging and validation are in progress; no supported macOS installer is available yet.

## Quick Workflow

1. Choose in-vitro or ex-vivo.
2. Add videos or folders and select an output folder.
3. Set acquisition FPS, frame count, and ROI. Inspect FFT and filtering previews.
4. Select CSV measurements and PNG plots.
5. Review and run. Each job saves parameters, a manifest, logs, and selected results in a new folder.

Supported containers: `.avi`, `.mp4`, `.mov`, `.m4v`, `.mkv`, `.wmv`, `.mpg`, `.mpeg`; the codec must also be supported by FFmpeg. Batch videos share processing settings; ex-vivo custom ROIs may differ per video.

![TuFFT final tuft segmentation preview](docs/images/desktop-tufts.png)

## Practical Limits

Acquisition FPS sets the frequency scale. For N frames, FFT bin spacing is FPS / N: 100 frames at 500 fps gives 5 Hz spacing; 500 frames gives 1 Hz. Setup FFT previews use at most 100 frames; final analysis honors the requested count or **All**.

Final processing uses disk-backed grayscale frames and bounded pixel-wise FFT chunks. Allow sufficient temporary disk space; start with one worker.

Inspect foreground masks before batch analysis. Evidence thresholding can remove valid signal when an ROI contains little background; advanced settings offer an Otsu multiplier or manual evidence cutoff. The metachronal result is an **axis modulo 180 degrees**, not signed flow. Tensor coherence measures phase-gradient organization, not anatomical polarity directly.

## Source And Development

```text
src/                 React/TypeScript interface
src-tauri/           Rust/Tauri desktop host and icons
python/sidecar/      Python analysis engine and CLI
examples/            Editable CLI job configurations
tests/               Frontend, Rust, and Python checks
tools/               Build and verification utilities
docs/                Installation, tutorials, and integration reference
```

See [development and releases](docs/RELEASE_AND_GITHUB.md), the [job configuration reference](docs/contracts/job-config-v1.md), and [progress events](docs/contracts/events-v1.md).

This repository contains application source, tests, and user documentation. Installers are release assets, not Git files. Raw videos, experimental validation, generated results, and manuscript materials are not included.

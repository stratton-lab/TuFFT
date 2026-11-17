# Installation

Choose the Windows installer for routine desktop use, Python-only installation for the CLI, or the full source toolchain for desktop development.

## Windows Installer

Requires Windows 10/11 x64, a writable output folder, and sufficient free disk space for decoded video data.

1. Sign in to GitHub with an account granted access to this private repository.
2. Open [TuFFT Releases](https://github.com/stratton-lab/TuFFT/releases/latest).
3. Under **Assets**, download `TuFFT_0.1.1_x64-setup.exe`, not **Source code**.
4. Run the installer and launch **TuFFT** from the Start menu.
5. Follow the [desktop tutorial](USER_MANUAL.md).

No Python, Conda, Node.js, Rust, or separate FFmpeg installation is required. Share the setup `.exe`, not the installed application executable alone: supporting files are required. The installer can also be transferred by USB.

The installer is unsigned. If Windows or institutional Application Control blocks it, ask IT to approve it; do not disable security controls. Compare the downloaded file's checksum against the release's `SHA256SUMS.txt`:

```powershell
Get-FileHash .\TuFFT_0.1.1_x64-setup.exe -Algorithm SHA256
```

## Python CLI Only

The CLI does **not** require Node.js, pnpm, Rust, Tauri, or Visual Studio Build Tools.

Install [Git for Windows](https://git-scm.com/downloads/win) and [Python 3.12 x64](https://www.python.org/downloads/windows/) with the Python launcher. Open PowerShell in a suitable parent folder:

```powershell
git clone https://github.com/stratton-lab/TuFFT.git
cd TuFFT
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install .
.\.venv\Scripts\tufft-sidecar.exe --help
```

Explicit environment paths avoid PowerShell activation scripts and execution-policy changes. Pip installs NumPy, SciPy, scikit-image, imageio, imageio-ffmpeg, and Pillow. FFmpeg comes through imageio-ffmpeg. Internet is needed for installation, not normal analysis.

Private-repository cloning requires an invited account. Complete Git Credential Manager's browser sign-in; GitHub passwords are not used as Git HTTPS passwords. Ask the maintainer for access if cloning reports **Repository not found**.

Continue with the [CLI tutorial](CLI_TUTORIAL.md), including editable in-vitro and ex-vivo examples.

### Conda Alternative

Install [Miniforge](https://github.com/conda-forge/miniforge), Miniconda, or Anaconda. From the cloned repository:

```powershell
conda env create -f environment.yml
conda activate tufft
python -m pip install -e .
tufft-sidecar --help
```

The environment file specifies Python 3.12. Its package versions are resolved at installation, not fully locked across platforms.

## Desktop From Source (Windows)

Complete cloning and Python setup above, then install:

| Requirement | Version / installation |
| --- | --- |
| [Node.js](https://nodejs.org/en/download) | Node 24 is tested; use Node 22.12+ for the frontend. |
| pnpm | 11.13.0, matching `packageManager` in `package.json`. |
| [Rust/rustup](https://www.rust-lang.org/tools/install) | Stable x64 MSVC toolchain; Rust 1.97 is tested. |
| [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | **Desktop development with C++**, including a Windows SDK. |
| [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) | Usually present on current Windows systems. |

Restart PowerShell afterward. Confirm `node --version`, `cargo --version`, and `rustc --version` work. From the repository root:

```powershell
npm.cmd install --global pnpm@11.13.0
pnpm.cmd install --frozen-lockfile
$env:TUFFT_PYTHON_EXECUTABLE = (Resolve-Path .\.venv\Scripts\python.exe).Path
pnpm.cmd tauri dev
```

If using an activated Conda environment, set its interpreter instead:

```powershell
$env:TUFFT_PYTHON_EXECUTABLE = (python -c "import sys; print(sys.executable)")
pnpm.cmd tauri dev
```

Keep the terminal open while using the development app. First launch compiles Rust and takes longer. Tauri, React, TypeScript, and Vite are project-local dependencies. JavaScript and Rust use committed lockfiles. The globally installed pnpm is only the package manager; an existing matching Corepack-managed pnpm is also suitable.

## Updates

Installer users download and run the newer setup file. Source users stop TuFFT, then run:

```powershell
git pull --ff-only
.\.venv\Scripts\python.exe -m pip install --upgrade .
```

Desktop source users also run `pnpm.cmd install --frozen-lockfile`. Conda users can run `conda env update -f environment.yml --prune`, followed by `python -m pip install -e .`.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Download/repository returns 404 | Sign in with an invited GitHub account; check access. |
| Cargo or `cargo metadata` not found | Restart the terminal; confirm `%USERPROFILE%\.cargo\bin` is on PATH. Desktop source builds only. |
| Preview fails to decode | Check file access and codec support. Source users can run `python tools\probe_video.py "C:\data\sample.avi"`. |
| Output directory already exists | Use a new CLI `job_id`; non-empty job folders are not overwritten. |
| Long videos exhaust disk | Reduce workers/frame count or use a larger output drive. Decoded data exceeds compressed file size. |
| Application Control blocks launch | Ask IT to approve the installer or development executable. |

## macOS

macOS desktop support is in progress. Preliminary build configuration exists, but no tested, signed, notarized macOS installer is available. Windows cannot validate a macOS release. The Python CLI has no desktop-toolchain requirement, but the currently documented and tested installation target is Windows x64.

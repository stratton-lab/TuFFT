# Development And Releases

TuFFT uses React/TypeScript for workflow and previews, a Rust/Tauri host for native dialogs and process management, and Python for scientific processing. Frontend requests pass validated paths/settings rather than full videos or large numerical arrays.

## Repository Scope

Track application source, tests, build definitions, user guides, protocol references, and curated tutorial images in `docs/images/`. The tutorial's Gaussian evidence PNG illustrates a saved output; other generated analysis results remain excluded. Do not commit raw videos, validation experiments, manuscript materials, local notes, packaged runtimes, or installers. See `.gitignore`.

Python package metadata is in `pyproject.toml`; JavaScript and Rust dependencies use `pnpm-lock.yaml` and `src-tauri/Cargo.lock`. The Conda environment is defined in `environment.yml`.

## Checks

After [source setup](INSTALLATION.md#desktop-from-source-windows), run:

```powershell
pnpm.cmd build
pnpm.cmd test:frontend
cargo fmt --manifest-path src-tauri\Cargo.toml -- --check
cargo clippy --manifest-path src-tauri\Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri\Cargo.toml
pnpm.cmd check:python
```

Smoke-test both analysis modes, ROI save/reuse, preview cancellation, multi-video processing, selected CSV columns, and reset. Check `git status --short` before release.

## Windows Packaging

Activate the Python environment or set `TUFFT_PYTHON_EXECUTABLE`, then:

```powershell
pnpm.cmd build:release
```

PyInstaller builds a one-directory scientific sidecar; Tauri bundles the frontend, host, sidecar, and supporting runtime into one NSIS setup executable. Keeping the installed runtime available avoids per-process extraction. Compression can take several minutes.

Installer location:

```text
src-tauri/target/release/bundle/nsis/TuFFT_0.1.1_x64-setup.exe
```

Test the installer on a Windows account without development dependencies. Distribute the setup file, not the application executable alone. The release is unsigned; code signing requires a certificate and packaging integration.

## GitHub Downloads

Host installers under **Releases**, not in the Git tree. GitHub blocks normal Git files larger than 100 MiB; release assets must each be under 2 GiB. See GitHub's [large-file guidance](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) and [release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

1. Create a version tag and release, for example `v0.1.1`, from a verified commit.
2. Attach the setup executable and `SHA256SUMS.txt` containing its SHA-256 hash and filename.
3. State supported platforms and signing status.
4. Verify the [latest release link](https://github.com/stratton-lab/TuFFT/releases/latest) and asset download.

Private releases require authenticated repository access. GitHub does not have an anonymous unlisted/link-only repository mode. Invite specific collaborators or an appropriate lab team; keep the repository private until publication is intended. A separate access-controlled institutional file share can distribute the installer without granting source access.

Keep versions synchronized in `package.json`, `src-tauri/Cargo.toml` and lockfile, `src-tauri/tauri.conf.json`, `pyproject.toml`, and Python `__version__`. Protocol schema versions are independent.

## macOS

macOS packaging is in progress, not a supported release. Preliminary entry point: `pnpm run build:release:mac`. Native macOS builds, Intel/Apple Silicon testing, FFmpeg/dialog checks, Developer ID signing, notarization, and Gatekeeper verification remain necessary. Windows cannot build or validate the complete macOS application.

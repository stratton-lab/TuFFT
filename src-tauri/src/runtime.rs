use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) fn preview_cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|directory| directory.join("analysis-previews"))
        .map_err(|error| format!("Could not resolve preview cache directory: {error}"))
}

#[derive(Clone, Debug)]
pub(crate) struct SidecarLaunch {
    pub program: PathBuf,
    pub script: Option<PathBuf>,
}

pub(crate) fn repository_root() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri must have a repository parent")
            .to_path_buf()
    }

    #[cfg(not(debug_assertions))]
    {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }
}

fn sidecar_script() -> PathBuf {
    repository_root()
        .join("python")
        .join("sidecar")
        .join("main.py")
}

fn preview_script() -> PathBuf {
    repository_root()
        .join("python")
        .join("sidecar")
        .join("preview.py")
}

fn python_executable() -> PathBuf {
    if let Some(path) = std::env::var_os("TUFFT_PYTHON_EXECUTABLE") {
        return PathBuf::from(path);
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let candidate = PathBuf::from(profile)
            .join(".conda")
            .join("envs")
            .join("tufft")
            .join("python.exe");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("python")
}

pub(crate) fn analysis_sidecar_launch() -> Result<SidecarLaunch, String> {
    if let Some(program) = bundled_sidecar_executable() {
        return Ok(SidecarLaunch {
            program,
            script: None,
        });
    }
    python_script_launch(sidecar_script(), "Python sidecar entry point")
}

pub(crate) fn preview_sidecar_launch() -> Result<SidecarLaunch, String> {
    if let Some(program) = bundled_sidecar_executable() {
        return Ok(SidecarLaunch {
            program,
            script: None,
        });
    }
    python_script_launch(preview_script(), "Preview entry point")
}

pub(crate) fn media_preview_sidecar_launch() -> Result<SidecarLaunch, String> {
    if let Some(program) = bundled_sidecar_executable() {
        return Ok(SidecarLaunch {
            program,
            script: None,
        });
    }
    python_script_launch(
        repository_root()
            .join("python")
            .join("sidecar")
            .join("media_preview.py"),
        "Video preview entry point",
    )
}

fn python_script_launch(script: PathBuf, label: &str) -> Result<SidecarLaunch, String> {
    if !script.is_file() {
        return Err(format!("{label} was not found: {}", script.display()));
    }
    Ok(SidecarLaunch {
        program: python_executable(),
        script: Some(script),
    })
}

fn bundled_sidecar_executable() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TUFFT_SIDECAR_EXECUTABLE") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    #[cfg(debug_assertions)]
    {
        None
    }

    #[cfg(not(debug_assertions))]
    {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))?;
        sidecar_candidates(&exe_dir)
            .into_iter()
            .find(|candidate| candidate.is_file())
    }
}

#[cfg(not(debug_assertions))]
fn sidecar_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    let directories = [
        exe_dir.to_path_buf(),
        exe_dir.join("binaries"),
        exe_dir.join("resources"),
        exe_dir.join("Resources"),
    ];
    directories
        .iter()
        .flat_map(|directory| {
            sidecar_file_names()
                .iter()
                .map(move |name| directory.join(name))
        })
        .collect()
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn sidecar_file_names() -> &'static [&'static str] {
    &[
        "tufft-sidecar.exe",
        "tufft-sidecar-x86_64-pc-windows-msvc.exe",
    ]
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
fn sidecar_file_names() -> &'static [&'static str] {
    &[
        "tufft-sidecar",
        "tufft-sidecar-aarch64-apple-darwin",
        "tufft-sidecar-x86_64-apple-darwin",
        "tufft-sidecar-universal-apple-darwin",
    ]
}

#[cfg(all(
    not(debug_assertions),
    not(target_os = "windows"),
    not(target_os = "macos")
))]
fn sidecar_file_names() -> &'static [&'static str] {
    &["tufft-sidecar"]
}

use crate::runtime::{media_preview_sidecar_launch, preview_sidecar_launch, SidecarLaunch};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
};
use tauri::State;
use tokio::{io::AsyncReadExt, process::Command, sync::oneshot};

const VIDEO_EXTENSIONS: &[&str] = &["avi", "mp4", "mov", "m4v", "mkv", "wmv", "mpg", "mpeg"];

#[derive(Default)]
pub struct ManagedPreviews(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FftPreviewRequest {
    preview_id: String,
    video_path: String,
    fps: f64,
    frame_count: u16,
    roi_mode: String,
    radius: Option<u32>,
    square_width: Option<u32>,
    roi_polygons: Option<Value>,
    use_hann: bool,
    band_low: f64,
    band_high: f64,
    snr_threshold_db: Option<f64>,
    remove_doubling: bool,
    half_power_ratio_threshold: f64,
    use_spatial_consensus: bool,
    neighbor_radius: u16,
    spatial_tolerance_fraction: f64,
    use_autocorrelation_fallback: bool,
    pipeline_params: Value,
}

#[tauri::command]
pub async fn generate_first_frame_preview(video_path: String) -> Result<Value, String> {
    let video = validate_video_path(&video_path)?;
    run_preview_with_launch(
        media_preview_sidecar_launch()?,
        [
            "first-frame".to_string(),
            "--video".to_string(),
            video.to_string_lossy().into_owned(),
        ],
    )
    .await
}

#[tauri::command]
pub async fn generate_video_loop_preview(video_path: String) -> Result<Value, String> {
    let video = validate_video_path(&video_path)?;
    run_preview_with_launch(
        media_preview_sidecar_launch()?,
        [
            "video-loop".to_string(),
            "--video".to_string(),
            video.to_string_lossy().into_owned(),
        ],
    )
    .await
}

#[tauri::command]
pub async fn generate_fft_preview(
    previews: State<'_, ManagedPreviews>,
    request: FftPreviewRequest,
) -> Result<Value, String> {
    validate_preview_id(&request.preview_id)?;
    let video = validate_video_path(&request.video_path)?;
    if !(1..=100).contains(&request.frame_count) {
        return Err("FFT preview frame count must be between 1 and 100.".to_string());
    }
    if !request.fps.is_finite() || request.fps <= 0.0 {
        return Err("FFT preview FPS must be greater than zero.".to_string());
    }
    if !matches!(
        request.roi_mode.as_str(),
        "circle" | "square" | "full" | "custom"
    ) {
        return Err(
            "FFT preview ROI mode must be 'circle', 'square', 'full', or 'custom'.".to_string(),
        );
    }

    let mut args = vec![
        "fft".to_string(),
        "--video".to_string(),
        video.to_string_lossy().into_owned(),
        "--fps".to_string(),
        request.fps.to_string(),
        "--frames".to_string(),
        request.frame_count.to_string(),
        "--roi-mode".to_string(),
        request.roi_mode,
        "--band-low".to_string(),
        request.band_low.to_string(),
        "--band-high".to_string(),
        request.band_high.to_string(),
        "--half-power-ratio-threshold".to_string(),
        request.half_power_ratio_threshold.to_string(),
        "--neighbor-radius".to_string(),
        request.neighbor_radius.to_string(),
        "--spatial-tolerance-fraction".to_string(),
        request.spatial_tolerance_fraction.to_string(),
        "--pipeline-params-json".to_string(),
        serde_json::to_string(&request.pipeline_params)
            .map_err(|error| format!("Could not serialize preview settings: {error}"))?,
    ];
    if let Some(radius) = request.radius {
        args.push("--radius".to_string());
        args.push(radius.to_string());
    }
    if let Some(square_width) = request.square_width {
        args.push("--square-width".to_string());
        args.push(square_width.to_string());
    }
    if let Some(roi_polygons) = request.roi_polygons {
        args.push("--roi-polygons-json".to_string());
        args.push(
            serde_json::to_string(&roi_polygons)
                .map_err(|error| format!("Could not serialize preview ROI polygons: {error}"))?,
        );
    }
    args.push(if request.use_hann {
        "--use-hann".to_string()
    } else {
        "--no-use-hann".to_string()
    });
    if let Some(snr_threshold_db) = request.snr_threshold_db {
        args.push("--snr-threshold-db".to_string());
        args.push(snr_threshold_db.to_string());
    }
    args.push(if request.remove_doubling {
        "--remove-doubling".to_string()
    } else {
        "--no-remove-doubling".to_string()
    });
    args.push(if request.use_spatial_consensus {
        "--use-spatial-consensus".to_string()
    } else {
        "--no-use-spatial-consensus".to_string()
    });
    args.push(if request.use_autocorrelation_fallback {
        "--use-autocorrelation-fallback".to_string()
    } else {
        "--no-use-autocorrelation-fallback".to_string()
    });
    let (cancel_sender, cancel_receiver) = oneshot::channel();
    previews
        .0
        .lock()
        .map_err(|_| "Preview state is unavailable.".to_string())?
        .insert(request.preview_id.clone(), cancel_sender);
    let result = run_cancellable_preview(args, cancel_receiver).await;
    previews
        .0
        .lock()
        .map_err(|_| "Preview state is unavailable.".to_string())?
        .remove(&request.preview_id);
    result
}

#[tauri::command]
pub fn cancel_fft_preview(
    previews: State<'_, ManagedPreviews>,
    preview_id: String,
) -> Result<bool, String> {
    validate_preview_id(&preview_id)?;
    let sender = previews
        .0
        .lock()
        .map_err(|_| "Preview state is unavailable.".to_string())?
        .remove(&preview_id);
    Ok(sender.is_some_and(|sender| sender.send(()).is_ok()))
}

async fn run_preview_with_launch<I>(launch: SidecarLaunch, args: I) -> Result<Value, String>
where
    I: IntoIterator<Item = String>,
{
    let mut command = Command::new(&launch.program);
    if let Some(script) = &launch.script {
        command.arg(script);
    }
    configure_child_command(&mut command);
    let output = command
        .args(args)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("Could not start preview process: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!(
                "Preview process exited with code {:?}.",
                output.status.code()
            )
        } else {
            message
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Preview returned invalid JSON: {error}"))
}

async fn run_cancellable_preview<I>(
    args: I,
    mut cancel: oneshot::Receiver<()>,
) -> Result<Value, String>
where
    I: IntoIterator<Item = String>,
{
    let launch = preview_sidecar_launch()?;
    let mut command = Command::new(&launch.program);
    if let Some(script) = &launch.script {
        command.arg(script);
    }
    configure_child_command(&mut command);
    let mut child = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start preview process: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture preview output.".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture preview errors.".to_string())?;
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });

    let status = tokio::select! {
        result = child.wait() => result.map_err(|error| format!("Preview process failed: {error}"))?,
        _ = &mut cancel => {
            terminate_preview_process(&mut child).await;
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            return Err("FFT preview cancelled.".to_string());
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| format!("Could not join preview output task: {error}"))?
        .map_err(|error| format!("Could not read preview output: {error}"))?;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("Could not join preview error task: {error}"))?
        .map_err(|error| format!("Could not read preview errors: {error}"))?;
    if !status.success() {
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("Preview process exited with code {:?}.", status.code())
        } else {
            message
        });
    }
    serde_json::from_slice(&stdout)
        .map_err(|error| format!("Preview returned invalid JSON: {error}"))
}

#[cfg(target_os = "windows")]
fn configure_child_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.as_std_mut().creation_flags(0x0800_0000);
}

#[cfg(not(target_os = "windows"))]
fn configure_child_command(_command: &mut Command) {}

async fn terminate_preview_process(child: &mut tokio::process::Child) {
    #[cfg(target_os = "windows")]
    if let Some(process_id) = child.id() {
        use std::os::windows::process::CommandExt;

        let mut taskkill = Command::new("taskkill.exe");
        taskkill.args(["/PID", &process_id.to_string(), "/T", "/F"]);
        taskkill.as_std_mut().creation_flags(0x0800_0000);
        if taskkill.status().await.is_ok_and(|status| status.success()) {
            return;
        }
    }
    let _ = child.kill().await;
}

fn validate_preview_id(value: &str) -> Result<(), String> {
    if !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        Ok(())
    } else {
        Err("Preview ID is invalid.".to_string())
    }
}

fn validate_video_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value)
        .canonicalize()
        .map_err(|error| format!("Video is unavailable: {error}"))?;
    if !path.is_file() || !is_supported_video(&path) {
        return Err(format!(
            "Preview input must be an existing supported video file: {}",
            path.display()
        ));
    }
    Ok(path)
}

fn is_supported_video(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            VIDEO_EXTENSIONS
                .iter()
                .any(|accepted| extension.eq_ignore_ascii_case(accepted))
        })
}

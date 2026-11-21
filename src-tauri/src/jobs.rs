use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::oneshot,
};

use crate::runtime::{analysis_sidecar_launch, preview_cache_directory};

#[derive(Default)]
pub struct ManagedJobs(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostJobExit {
    job_id: String,
    exit_code: Option<i32>,
    cancelled: bool,
    success: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarLog {
    job_id: String,
    line: String,
}

#[tauri::command]
pub async fn start_analysis(
    app: AppHandle,
    jobs: State<'_, ManagedJobs>,
    config: Value,
) -> Result<String, String> {
    let job_id = config
        .get("job_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Job configuration is missing a string job_id.".to_string())?
        .to_string();
    validate_job_id(&job_id)?;

    if config.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Err("Only job configuration schema_version 1 is supported.".to_string());
    }

    {
        let active = jobs
            .0
            .lock()
            .map_err(|_| "Job state is unavailable.".to_string())?;
        if active.contains_key(&job_id) {
            return Err(format!("Job {job_id} is already running."));
        }
    }

    let config_path = write_pending_config(&app, &job_id, &config)?;
    let launch = analysis_sidecar_launch()?;
    let mut command = Command::new(&launch.program);
    if let Some(script) = &launch.script {
        command.arg(script);
    }
    configure_child_command(&mut command);
    let mut child = command
        .env("TUFFT_PREVIEW_CACHE_DIR", preview_cache_directory(&app)?)
        .arg("--config")
        .arg(&config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start analysis sidecar at {}: {error}",
                launch.program.display()
            )
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture sidecar stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture sidecar stderr.".to_string())?;
    let (cancel_sender, cancel_receiver) = oneshot::channel();
    jobs.0
        .lock()
        .map_err(|_| "Job state is unavailable.".to_string())?
        .insert(job_id.clone(), cancel_sender);

    let task_app = app.clone();
    let task_job_id = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let stdout_app = task_app.clone();
        let stdout_job_id = task_job_id.clone();
        let stdout_task = tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<Value>(&line) {
                    Ok(event) => {
                        let _ = stdout_app.emit("sidecar-event", event);
                    }
                    Err(_) => {
                        let _ = stdout_app.emit(
                            "sidecar-log",
                            SidecarLog {
                                job_id: stdout_job_id.clone(),
                                line: format!("Unexpected stdout: {line}"),
                            },
                        );
                    }
                }
            }
        });

        let stderr_app = task_app.clone();
        let stderr_job_id = task_job_id.clone();
        let stderr_task = tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = stderr_app.emit(
                    "sidecar-log",
                    SidecarLog {
                        job_id: stderr_job_id.clone(),
                        line,
                    },
                );
            }
        });

        let (status, cancelled) = tokio::select! {
            status = child.wait() => (status.ok(), false),
            _ = cancel_receiver => {
                terminate_analysis_process(&mut child).await;
                (child.wait().await.ok(), true)
            }
        };

        let _ = stdout_task.await;
        let _ = stderr_task.await;
        if let Ok(mut active) = task_app.state::<ManagedJobs>().0.lock() {
            active.remove(&task_job_id);
        }
        let exit_code = status.as_ref().and_then(|value| value.code());
        let success = !cancelled && status.as_ref().is_some_and(|value| value.success());
        let _ = task_app.emit(
            "host-job-exited",
            HostJobExit {
                job_id: task_job_id,
                exit_code,
                cancelled,
                success,
            },
        );
    });

    Ok(job_id)
}

#[cfg(target_os = "windows")]
fn configure_child_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.as_std_mut().creation_flags(0x0800_0000);
}

#[cfg(not(target_os = "windows"))]
fn configure_child_command(_command: &mut Command) {}

async fn terminate_analysis_process(child: &mut tokio::process::Child) {
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

#[tauri::command]
pub fn cancel_analysis(jobs: State<'_, ManagedJobs>, job_id: String) -> Result<(), String> {
    validate_job_id(&job_id)?;
    let sender = jobs
        .0
        .lock()
        .map_err(|_| "Job state is unavailable.".to_string())?
        .remove(&job_id)
        .ok_or_else(|| format!("No active job named {job_id}."))?;
    sender
        .send(())
        .map_err(|_| format!("Job {job_id} has already exited."))
}

fn write_pending_config(app: &AppHandle, job_id: &str, config: &Value) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("pending-jobs");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create pending job directory: {error}"))?;

    let path = directory.join(format!("{job_id}.json"));
    let temporary = directory.join(format!("{job_id}.json.tmp"));
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Could not serialize job configuration: {error}"))?;
    std::fs::write(&temporary, serialized)
        .map_err(|error| format!("Could not write job configuration: {error}"))?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| {
            format!("Could not replace previous pending configuration: {error}")
        })?;
    }
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not finalize job configuration: {error}"))?;
    Ok(path)
}

fn validate_job_id(job_id: &str) -> Result<(), String> {
    let valid = !job_id.is_empty()
        && job_id.len() <= 64
        && job_id.as_bytes()[0].is_ascii_alphanumeric()
        && job_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err("Invalid job_id. Use 1-64 letters, numbers, '.', '_' or '-'.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_job_id;

    #[test]
    fn validates_job_identifiers() {
        assert!(validate_job_id("in-vitro_2026.07.15").is_ok());
        assert!(validate_job_id("").is_err());
        assert!(validate_job_id("../escape").is_err());
        assert!(validate_job_id("spaces are not valid").is_err());
    }
}

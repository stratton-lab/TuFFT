use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_DISCOVERED_VIDEOS: usize = 20_000;
const MAX_DISCOVERED_ROI_FILES: usize = 20_000;
const MAX_ROI_JSON_BYTES: u64 = 1_048_576;
const VIDEO_EXTENSIONS: &[&str] = &["avi", "mp4", "mov", "m4v", "mkv", "wmv", "mpg", "mpeg"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoiPoint {
    x: f64,
    y: f64,
}

type RoiPolygon = Vec<RoiPoint>;
type RoiPolygons = Vec<RoiPolygon>;

#[derive(Debug, Deserialize)]
struct SavedRoiFile {
    video_file: String,
    polygons: RoiPolygons,
}

#[tauri::command]
pub fn discover_video_files(root: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Could not open input directory: {error}"))?;
    if !root.is_dir() {
        return Err(format!("Input path is not a directory: {}", root.display()));
    }

    discover_inputs(vec![root])
}

#[tauri::command]
pub async fn discover_video_inputs(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let roots = paths.into_iter().map(PathBuf::from).collect();
        discover_inputs(roots)
    })
    .await
    .map_err(|error| format!("Video discovery failed: {error}"))?
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn discover_inputs(roots: Vec<PathBuf>) -> Result<Vec<String>, String> {
    let mut directories = Vec::new();
    let mut visited = HashSet::new();
    let mut found = HashMap::new();
    for path in roots {
        let path = path
            .canonicalize()
            .map_err(|error| format!("Could not open input {}: {error}", path.display()))?;
        if path.is_dir() {
            directories.push(path);
        } else if path.is_file() && is_supported_video(&path) {
            found.insert(path_key(&path), path.to_string_lossy().into_owned());
        } else {
            return Err(format!(
                "Input must be a folder or a supported video: {}",
                path.display()
            ));
        }
    }
    if found.len() > MAX_DISCOVERED_VIDEOS {
        return Err(format!(
            "Select no more than {MAX_DISCOVERED_VIDEOS} supported video files."
        ));
    }
    while let Some(directory) = directories.pop() {
        if !visited.insert(path_key(&directory)) {
            continue;
        }
        let entries = std::fs::read_dir(&directory)
            .map_err(|error| format!("Could not read {}: {error}", directory.display()))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("Could not read directory entry: {error}"))?;
            let file_type = entry.file_type().map_err(|error| {
                format!("Could not inspect {}: {error}", entry.path().display())
            })?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                directories.push(entry.path());
            } else if file_type.is_file() && is_supported_video(&entry.path()) {
                found.insert(
                    path_key(&entry.path()),
                    entry.path().to_string_lossy().into_owned(),
                );
                if found.len() > MAX_DISCOVERED_VIDEOS {
                    return Err(format!(
                        "Directory contains more than {MAX_DISCOVERED_VIDEOS} supported video files; choose a narrower input directory."
                    ));
                }
            }
        }
    }
    let mut videos: Vec<String> = found.into_values().collect();
    videos.sort_by_key(|path| path.to_lowercase());
    Ok(videos)
}

#[tauri::command]
pub async fn save_roi_polygons(
    video_path: String,
    polygons: RoiPolygons,
    output_root: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_roi(&video_path, polygons, &output_root))
        .await
        .map_err(|error| format!("Could not save ROI: {error}"))?
}

fn save_roi(video_path: &str, polygons: RoiPolygons, output_root: &str) -> Result<String, String> {
    let video = PathBuf::from(video_path)
        .canonicalize()
        .map_err(|error| format!("Video is unavailable: {error}"))?;
    if !video.is_file() || !is_supported_video(&video) {
        return Err("ROI source must be an existing supported video.".to_string());
    }
    let polygons: RoiPolygons = polygons
        .into_iter()
        .filter(|polygon| polygon.len() >= 3)
        .collect();
    if polygons.is_empty()
        || polygons.iter().flatten().any(|point| {
            !point.x.is_finite() || !point.y.is_finite() || point.x < 0.0 || point.y < 0.0
        })
    {
        return Err("An ROI requires a polygon with at least three valid points.".to_string());
    }
    let root = PathBuf::from(output_root)
        .canonicalize()
        .map_err(|error| format!("Output folder is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err("Select an output folder before saving an ROI.".to_string());
    }
    let directory = root.join("rois");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create ROI folder: {error}"))?;
    let directory = directory
        .canonicalize()
        .map_err(|error| format!("Could not open ROI folder: {error}"))?;
    if !directory.starts_with(&root) || directory == root {
        return Err("The ROI subfolder must be inside the selected output folder.".to_string());
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path_key(&video).hash(&mut hasher);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let filename = format!("roi-{:016x}-{timestamp}.json", hasher.finish());
    let contents = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": 1,
        "video_file": video_path,
        "roi_mode": "custom",
        "polygons": polygons,
    }))
    .map_err(|error| format!("Could not serialize ROI: {error}"))?;
    if contents.len() > MAX_ROI_JSON_BYTES as usize {
        return Err("ROI records must be smaller than 1 MB.".to_string());
    }
    let temporary = directory.join(format!("{filename}.tmp"));
    let target = directory.join(filename);
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&contents)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &target)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "Could not save ROI in {}: {error}",
            directory.display()
        ));
    }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn discover_roi_polygons(root: String) -> Result<HashMap<String, RoiPolygons>, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Could not open ROI directory: {error}"))?;
    if !root.is_dir() {
        return Err(format!("ROI path is not a directory: {}", root.display()));
    }

    let mut directories = vec![root];
    let mut scanned_files = 0usize;
    let mut rois = HashMap::new();
    let mut updated = HashMap::new();
    while let Some(directory) = directories.pop() {
        let entries = std::fs::read_dir(&directory)
            .map_err(|error| format!("Could not read {}: {error}", directory.display()))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("Could not read directory entry: {error}"))?;
            let file_type = entry.file_type().map_err(|error| {
                format!("Could not inspect {}: {error}", entry.path().display())
            })?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                directories.push(entry.path());
            } else if file_type.is_file() && is_json(&entry.path()) {
                scanned_files += 1;
                if scanned_files > MAX_DISCOVERED_ROI_FILES {
                    return Err(format!(
                        "ROI directory contains more than {MAX_DISCOVERED_ROI_FILES} JSON files; choose a narrower folder."
                    ));
                }
                if let Some((video_file, polygons)) = read_saved_roi_file(&entry.path())? {
                    let modified = entry
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .map_err(|error| format!("Could not inspect ROI date: {error}"))?;
                    if updated
                        .get(&video_file)
                        .is_none_or(|current| modified >= *current)
                    {
                        updated.insert(video_file.clone(), modified);
                        rois.insert(video_file, polygons);
                    }
                }
            }
        }
    }
    Ok(rois)
}

#[tauri::command]
pub fn open_output_directory(path: String) -> Result<(), String> {
    let directory = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Output directory is unavailable: {error}"))?;
    if !directory.is_dir() {
        return Err(format!(
            "Output path is not a directory: {}",
            directory.display()
        ));
    }
    open_directory(&directory)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_directory(directory: &Path) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(directory)
        .spawn()
        .map_err(|error| format!("Could not open {}: {error}", directory.display()))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_directory(directory: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(directory)
        .spawn()
        .map_err(|error| format!("Could not open {}: {error}", directory.display()))?;
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn open_directory(directory: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(directory)
        .spawn()
        .map_err(|error| format!("Could not open {}: {error}", directory.display()))?;
    Ok(())
}

#[tauri::command]
pub fn read_settings_file(path: String) -> Result<Value, String> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not open settings file: {error}"))?;
    ensure_json_path(&path)?;
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("Could not inspect settings file: {error}"))?;
    if metadata.len() > 1_048_576 {
        return Err("Settings files must be smaller than 1 MB.".to_string());
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| format!("Could not read settings file: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Settings file is not valid JSON: {error}"))
}

#[tauri::command]
pub fn write_settings_file(path: String, value: Value) -> Result<(), String> {
    let path = PathBuf::from(path);
    ensure_json_path(&path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Settings path has no parent directory.".to_string())?;
    if !parent.is_dir() {
        return Err(format!(
            "Settings directory does not exist: {}",
            parent.display()
        ));
    }
    let contents = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Could not serialize settings: {error}"))?;
    std::fs::write(&path, format!("{contents}\n"))
        .map_err(|error| format!("Could not write settings file: {error}"))
}

fn ensure_json_path(path: &Path) -> Result<(), String> {
    if is_json(path) {
        Ok(())
    } else {
        Err("Analysis settings files must use the .json extension.".to_string())
    }
}

fn read_saved_roi_file(path: &Path) -> Result<Option<(String, RoiPolygons)>, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Could not inspect ROI file {}: {error}", path.display()))?;
    if metadata.len() > MAX_ROI_JSON_BYTES {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read ROI file {}: {error}", path.display()))?;
    let parsed: SavedRoiFile = match serde_json::from_str(&contents) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let polygons: RoiPolygons = parsed
        .polygons
        .into_iter()
        .filter(|polygon| polygon.len() >= 3)
        .collect();
    if parsed.video_file.trim().is_empty() || polygons.is_empty() {
        return Ok(None);
    }
    Ok(Some((parsed.video_file, polygons)))
}

fn is_json(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
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

#[cfg(test)]
mod tests {
    use super::{
        discover_inputs, discover_roi_polygons, discover_video_files, is_supported_video, save_roi,
        RoiPoint,
    };
    use std::path::Path;

    #[test]
    fn supported_video_extension_is_case_insensitive() {
        assert!(is_supported_video(Path::new("sample.avi")));
        assert!(is_supported_video(Path::new("sample.AVI")));
        assert!(is_supported_video(Path::new("sample.mp4")));
        assert!(is_supported_video(Path::new("sample.MOV")));
        assert!(!is_supported_video(Path::new("sample.txt")));
    }

    #[test]
    fn discovers_video_files_in_nested_directories() {
        let root =
            std::env::temp_dir().join(format!("tufft-video-discovery-test-{}", std::process::id()));
        let nested = root.join("nested").join("deeper");
        std::fs::create_dir_all(&nested).expect("create test directory");
        std::fs::write(root.join("one.avi"), b"").expect("create first AVI");
        std::fs::write(nested.join("two.MP4"), b"").expect("create nested MP4");
        std::fs::write(nested.join("three.mov"), b"").expect("create nested MOV");
        std::fs::write(nested.join("ignore.txt"), b"").expect("create non-video");

        let videos =
            discover_video_files(root.to_string_lossy().into_owned()).expect("discover videos");

        assert_eq!(videos.len(), 3);
        assert!(videos.iter().any(|path| path.ends_with("one.avi")));
        assert!(videos.iter().any(|path| path.ends_with("two.MP4")));
        assert!(videos.iter().any(|path| path.ends_with("three.mov")));
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn discovers_saved_roi_polygons_by_video_path() {
        let root =
            std::env::temp_dir().join(format!("cilia-roi-discovery-test-{}", std::process::id()));
        let nested = root.join("job").join("rois");
        std::fs::create_dir_all(&nested).expect("create test directory");
        std::fs::write(
            nested.join("sample__roi.json"),
            r#"{
                "video_file": "D:\\videos\\sample.avi",
                "roi_mode": "custom",
                "polygons": [[{"x": 1, "y": 2}, {"x": 8, "y": 2}, {"x": 8, "y": 9}]],
                "roi_area_px": 22
            }"#,
        )
        .expect("create ROI JSON");
        std::fs::write(root.join("parameters.json"), r#"{"schema_version": 1}"#)
            .expect("create non-ROI JSON");

        let rois =
            discover_roi_polygons(root.to_string_lossy().into_owned()).expect("discover ROIs");

        assert_eq!(rois.len(), 1);
        let polygons = rois
            .get("D:\\videos\\sample.avi")
            .expect("matched video path");
        assert_eq!(polygons.len(), 1);
        assert_eq!(polygons[0].len(), 3);
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn mixed_video_inputs_deduplicate_overlapping_folders_and_files() {
        let root =
            std::env::temp_dir().join(format!("tufft-mixed-input-test-{}", std::process::id()));
        let nested = root.join("nested");
        let other = root.join("other");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let first = nested.join("one.avi");
        std::fs::write(&first, b"").unwrap();
        std::fs::write(other.join("two.MOV"), b"").unwrap();
        let videos = discover_inputs(vec![root.clone(), nested, first, other]).unwrap();
        assert_eq!(videos.len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn roi_save_is_immediate_reusable_and_only_writes_inside_output_subfolder() {
        let root = std::env::temp_dir().join(format!("tufft-roi-save-test-{}", std::process::id()));
        let source = root.join("source");
        let output = root.join("output");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&output).unwrap();
        let video = source.join("sample.avi");
        std::fs::write(&video, b"").unwrap();
        let polygons = vec![vec![
            RoiPoint { x: 1.0, y: 2.0 },
            RoiPoint { x: 8.0, y: 2.0 },
            RoiPoint { x: 8.0, y: 9.0 },
        ]];
        let saved = save_roi(
            video.to_str().unwrap(),
            polygons.clone(),
            output.to_str().unwrap(),
        )
        .unwrap();
        assert!(Path::new(&saved).is_file());
        assert_eq!(
            Path::new(&saved).parent().unwrap(),
            output.join("rois").canonicalize().unwrap()
        );
        assert_eq!(std::fs::read_dir(&source).unwrap().count(), 1);
        let rois = discover_roi_polygons(output.to_string_lossy().into_owned()).unwrap();
        assert_eq!(rois.get(video.to_str().unwrap()).unwrap()[0].len(), 3);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&saved)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1))
            .unwrap();
        let mut edited = polygons;
        edited[0][0].x = 2.0;
        let newer = save_roi(video.to_str().unwrap(), edited, output.to_str().unwrap()).unwrap();
        assert_ne!(saved, newer);
        let imported = discover_roi_polygons(output.to_string_lossy().into_owned()).unwrap();
        assert_eq!(imported.get(video.to_str().unwrap()).unwrap()[0][0].x, 2.0);
        assert!(save_roi(video.to_str().unwrap(), vec![], output.to_str().unwrap()).is_err());
        let invalid = vec![vec![
            RoiPoint {
                x: f64::NAN,
                y: 1.0
            };
            3
        ]];
        assert!(save_roi(video.to_str().unwrap(), invalid, output.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

mod files;
mod jobs;
mod previews;
mod runtime;

use files::{
    discover_roi_polygons, discover_video_files, discover_video_inputs, open_output_directory,
    read_settings_file, save_roi_polygons, write_settings_file,
};
use jobs::{cancel_analysis, start_analysis, ManagedJobs};
use previews::{
    cancel_fft_preview, generate_fft_preview, generate_first_frame_preview,
    generate_video_loop_preview, ManagedPreviews,
};
use tauri::Manager;

#[cfg(target_os = "windows")]
fn set_windows_window_icons(
    window: &tauri::WebviewWindow,
) -> Result<(), Box<dyn std::error::Error>> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LPARAM, WPARAM},
            System::LibraryLoader::GetModuleHandleW,
            UI::{
                HiDpi::GetDpiForWindow,
                WindowsAndMessaging::{
                    LoadImageW, SendMessageW, SetClassLongPtrW, GCLP_HICON, GCLP_HICONSM, ICON_BIG,
                    ICON_SMALL, IMAGE_ICON, LR_SHARED, WM_SETICON,
                },
            },
        },
    };

    let hwnd = window.hwnd()?;
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    let icon_size = |logical_px: u32| ((logical_px * dpi + 48) / 96) as i32;
    let module = unsafe { GetModuleHandleW(PCWSTR::null()) }?;
    let resource = PCWSTR(32512usize as *const u16);

    for (slot, logical_size) in [(ICON_SMALL, 16), (ICON_BIG, 32)] {
        let size = icon_size(logical_size);
        let icon = unsafe {
            LoadImageW(
                Some(module.into()),
                resource,
                IMAGE_ICON,
                size,
                size,
                LR_SHARED,
            )
        }?;
        unsafe {
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(slot as usize)),
                Some(LPARAM(icon.0 as isize)),
            );
            SetClassLongPtrW(
                hwnd,
                if slot == ICON_SMALL {
                    GCLP_HICONSM
                } else {
                    GCLP_HICON
                },
                icon.0 as isize,
            );
        }
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ManagedJobs::default())
        .manage(ManagedPreviews::default())
        .invoke_handler(tauri::generate_handler![
            start_analysis,
            cancel_analysis,
            discover_video_files,
            discover_video_inputs,
            discover_roi_polygons,
            save_roi_polygons,
            open_output_directory,
            read_settings_file,
            write_settings_file,
            generate_first_frame_preview,
            generate_video_loop_preview,
            generate_fft_preview,
            cancel_fft_preview
        ])
        .build(tauri::generate_context!())
        .expect("error while building the TuFFT desktop application")
        .run(|app, event| {
            #[cfg(target_os = "windows")]
            if matches!(event, tauri::RunEvent::Ready) {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = set_windows_window_icons(&window) {
                        eprintln!("failed to set Windows window icons: {error}");
                    }
                }
            }
        });
}

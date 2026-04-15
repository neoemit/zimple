#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![cfg_attr(test, allow(dead_code, unused_imports))]

mod job_manager;
mod models;
mod runtime;
mod settings_store;

use job_manager::AppState;
use models::{CancelJobResponse, OpenOutputResponse, Settings, StartJobRequest, StartJobResponse};
#[cfg(not(test))]
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
async fn start_job(
    request: StartJobRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StartJobResponse, String> {
    let validated_url = models::validate_public_url(&request.url)?;

    let normalized_crawl = request.crawl.clone().normalized();
    let mut normalized_request = request.clone();
    normalized_request.url = validated_url.to_string();
    normalized_request.crawl = normalized_crawl;

    let settings = job_manager::get_settings(state.inner.clone()).await;

    let requested_output_directory = normalized_request
        .output_directory
        .clone()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());

    let settings_output_directory = settings
        .output_directory
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());

    let output_directory = requested_output_directory
        .or(settings_output_directory)
        .or_else(models::default_downloads_directory)
        .ok_or_else(|| {
            "No output directory configured. Set one in Advanced Settings before starting jobs."
                .to_string()
        })?;

    tokio::fs::create_dir_all(&output_directory)
        .await
        .map_err(|err| format!("Unable to create output directory {output_directory}: {err}"))?;

    let preferred_name = normalized_request
        .output_filename
        .as_deref()
        .map(models::sanitize_output_name)
        .unwrap_or_else(|| models::default_output_filename(&validated_url));

    let output_filename = preferred_name
        .strip_suffix(".zim")
        .or_else(|| preferred_name.strip_suffix(".ZIM"))
        .unwrap_or(&preferred_name)
        .to_string();

    let job_id = job_manager::enqueue_job(
        app,
        state.inner.clone(),
        normalized_request,
        output_directory,
        output_filename,
    )
    .await?;

    Ok(StartJobResponse { job_id })
}

#[tauri::command]
async fn list_jobs(state: State<'_, AppState>) -> Result<Vec<models::JobSummary>, String> {
    Ok(job_manager::list_jobs(state.inner.clone()).await)
}

#[tauri::command]
async fn get_job(job_id: String, state: State<'_, AppState>) -> Result<models::JobDetail, String> {
    job_manager::get_job(state.inner.clone(), &job_id)
        .await
        .ok_or_else(|| format!("Unknown job id: {job_id}"))
}

#[tauri::command]
async fn cancel_job(
    job_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CancelJobResponse, String> {
    let cancelled = job_manager::cancel_job(app, state.inner.clone(), &job_id).await;
    Ok(CancelJobResponse { cancelled })
}

#[tauri::command]
async fn open_output(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<OpenOutputResponse, String> {
    let Some(path) = job_manager::get_output_path(state.inner.clone(), &job_id).await else {
        return Ok(OpenOutputResponse { opened: false });
    };

    runtime::open_path(&path)?;
    Ok(OpenOutputResponse { opened: true })
}

#[tauri::command]
async fn get_runtime_health(app: AppHandle) -> Result<models::RuntimeHealth, String> {
    let health = runtime::check_runtime_health().await;
    let _ = app.emit("runtime:health_changed", &health);
    Ok(health)
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(job_manager::get_settings(state.inner.clone()).await)
}

#[tauri::command]
async fn set_settings(
    settings: Settings,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Settings, String> {
    let sanitized = Settings {
        output_directory: settings
            .output_directory
            .clone()
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
            .or_else(models::default_downloads_directory),
        auto_open_on_success: settings.auto_open_on_success,
    };

    if let Some(ref output_directory) = sanitized.output_directory {
        tokio::fs::create_dir_all(output_directory)
            .await
            .map_err(|err| {
                format!("Unable to create configured output directory {output_directory}: {err}")
            })?;
    }

    job_manager::set_settings(state.inner.clone(), sanitized.clone()).await;
    settings_store::save_settings(&app, &sanitized).await?;

    Ok(sanitized)
}

#[tauri::command]
async fn pick_output_directory() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

fn bootstrap_settings(app: &AppHandle) -> Settings {
    tauri::async_runtime::block_on(async {
        match settings_store::load_settings(app).await {
            Ok(settings) => settings,
            Err(_) => Settings::default(),
        }
    })
}

#[cfg(not(test))]
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();
            let settings = bootstrap_settings(&app_handle);

            app.manage(AppState::new(settings));

            tauri::async_runtime::spawn(async move {
                let health = runtime::check_runtime_health().await;
                let _ = app_handle.emit("runtime:health_changed", &health);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_job,
            list_jobs,
            get_job,
            cancel_job,
            open_output,
            get_runtime_health,
            get_settings,
            set_settings,
            pick_output_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zimple application")
}

#[cfg(test)]
fn main() {}

use crate::models::Settings;
use tauri::{AppHandle, Manager};

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Unable to resolve config directory: {err}"))?;

    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("Unable to create config directory {}: {err}", dir.display()))?;

    Ok(dir.join("settings.json"))
}

pub async fn load_settings(app: &AppHandle) -> Result<Settings, String> {
    let path = settings_path(app)?;

    if !path.exists() {
        return Ok(Settings::default());
    }

    let data = tokio::fs::read_to_string(&path)
        .await
        .map_err(|err| format!("Unable to read settings file {}: {err}", path.display()))?;

    let mut settings = serde_json::from_str::<Settings>(&data)
        .map_err(|err| format!("Unable to parse settings file {}: {err}", path.display()))?;

    if settings.output_directory.is_none() {
        settings.output_directory = crate::models::default_downloads_directory();
    }

    Ok(settings)
}

pub async fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|err| format!("Unable to serialize settings: {err}"))?;

    tokio::fs::write(&path, serialized)
        .await
        .map_err(|err| format!("Unable to write settings file {}: {err}", path.display()))
}

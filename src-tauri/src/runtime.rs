use crate::models::{RuntimeHealth, StartJobRequest};
use serde_json::Value;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

const ZIMIT_IMAGE: &str = "ghcr.io/openzim/zimit";
const IDENTITY_ENCODING_DRIVER_SOURCE: &str = r#"export default async ({ page, data, crawler, seed }) => {
  await page.setExtraHTTPHeaders({ "Accept-Encoding": "identity" });
  await crawler.loadPage(page, data, seed);
};
"#;

#[derive(Debug, Clone)]
pub struct DockerRunResult {
    pub success: bool,
    pub error_message: Option<String>,
}

fn extract_docker_error(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| "Unknown Docker error".to_string())
}

fn is_docker_noise_line(line: &str) -> bool {
    let lowered = line.to_ascii_lowercase();
    if lowered.starts_with("digest:") || lowered.starts_with("status:") {
        return true;
    }

    if lowered.contains("pulling from") || lowered.contains("pull complete") {
        return true;
    }

    if let Some((prefix, suffix)) = line.split_once(':') {
        let is_hex_layer = prefix.len() >= 12 && prefix.chars().all(|ch| ch.is_ascii_hexdigit());
        if is_hex_layer {
            let suffix = suffix.trim().to_ascii_lowercase();
            return suffix == "already exists"
                || suffix == "download complete"
                || suffix == "pull complete"
                || suffix == "waiting"
                || suffix.starts_with("extracting")
                || suffix.starts_with("verifying checksum");
        }
    }

    false
}

fn normalize_zimit_log_line(line: &str) -> Option<String> {
    let parsed: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return Some(line.to_string()),
    };

    let message = parsed
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let context = parsed
        .get("context")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let level = parsed
        .get("logLevel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let details = parsed.get("details").cloned().unwrap_or(Value::Null);

    if context == "redis" && level == "warn" {
        return None;
    }

    match message {
        "Starting page" => {
            let page = details
                .get("page")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Some(format!("Starting page crawl: {page}"))
        }
        "Page Finished" => {
            let page = details
                .get("page")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Some(format!("Page finished: {page}"))
        }
        "Crawl statistics" => {
            let crawled = details.get("crawled").and_then(Value::as_i64).unwrap_or(0);
            let total = details.get("total").and_then(Value::as_i64).unwrap_or(0);
            let pending = details.get("pending").and_then(Value::as_i64).unwrap_or(0);
            let failed = details.get("failed").and_then(Value::as_i64).unwrap_or(0);
            Some(format!(
                "Crawl progress: {crawled}/{total} crawled, {pending} pending, {failed} failed"
            ))
        }
        "Crawling done" => Some("Crawl completed. Starting ZIM conversion...".to_string()),
        _ => {
            if message.is_empty() {
                return None;
            }
            Some(match context {
                "" => message.to_string(),
                "general" | "worker" | "pageStatus" | "crawlStatus" => message.to_string(),
                _ => format!("{context}: {message}"),
            })
        }
    }
}

fn push_recent_output_line(buffer: &mut VecDeque<String>, line: String) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }

    let compact = if trimmed.chars().count() > 280 {
        let shortened = trimmed.chars().take(280).collect::<String>();
        format!("{shortened}...")
    } else {
        trimmed.to_string()
    };

    if buffer
        .back()
        .map(|previous| previous == &compact)
        .unwrap_or(false)
    {
        return;
    }

    if buffer.len() >= 6 {
        buffer.pop_front();
    }
    buffer.push_back(compact);
}

async fn read_log_stream<R>(reader: R, sender: mpsc::UnboundedSender<String>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let _ = sender.send(trimmed.to_string());
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
}

async fn command_succeeds(program: &str, args: &[String]) -> bool {
    match Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
    {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

pub async fn check_runtime_health() -> RuntimeHealth {
    let docker_installed = command_succeeds("docker", &["--version".to_string()]).await;

    if !docker_installed {
        return RuntimeHealth {
            docker_installed: false,
            docker_responsive: false,
            zimit_image_present: false,
            ready: false,
            message: Some("Docker is not installed or is not available on PATH.".to_string()),
        };
    }

    let docker_responsive = command_succeeds(
        "docker",
        &[
            "info".to_string(),
            "--format".to_string(),
            "{{.ServerVersion}}".to_string(),
        ],
    )
    .await;

    if !docker_responsive {
        return RuntimeHealth {
            docker_installed: true,
            docker_responsive: false,
            zimit_image_present: false,
            ready: false,
            message: Some("Docker is installed but the daemon is not reachable.".to_string()),
        };
    }

    let zimit_image_present = command_succeeds(
        "docker",
        &[
            "image".to_string(),
            "inspect".to_string(),
            ZIMIT_IMAGE.to_string(),
        ],
    )
    .await;

    let message = if zimit_image_present {
        Some("Runtime ready. ZIM jobs can be started.".to_string())
    } else {
        Some(
            "Docker is ready. Pulling ghcr.io/openzim/zimit may be required on first run."
                .to_string(),
        )
    };

    RuntimeHealth {
        docker_installed: true,
        docker_responsive: true,
        zimit_image_present,
        ready: true,
        message,
    }
}

pub async fn ensure_zimit_image(timeout_duration: Duration) -> Result<bool, String> {
    let inspect_status = tokio::time::timeout(
        Duration::from_secs(20),
        Command::new("docker")
            .args(["image", "inspect", ZIMIT_IMAGE])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status(),
    )
    .await
    .map_err(|_| "Timed out while checking local zimit image state.".to_string())?
    .map_err(|err| format!("Failed to inspect Docker image: {err}"))?;

    if inspect_status.success() {
        return Ok(false);
    }

    let mut pull_cmd = Command::new("docker");
    pull_cmd
        .args(["pull", "--quiet", ZIMIT_IMAGE])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let pull_child = pull_cmd
        .spawn()
        .map_err(|err| format!("Failed to start Docker image pull: {err}"))?;

    let pull_output = tokio::time::timeout(timeout_duration, pull_child.wait_with_output())
        .await
        .map_err(|_| {
            "Timed out while preparing zimit runtime image. Check Docker connectivity and try again."
                .to_string()
        })?
        .map_err(|err| format!("Failed while waiting for Docker image pull: {err}"))?;

    if pull_output.status.success() {
        Ok(true)
    } else {
        let stderr = String::from_utf8_lossy(&pull_output.stderr);
        Err(format!(
            "Failed to prepare zimit runtime image: {}",
            extract_docker_error(&stderr)
        ))
    }
}

pub fn retry_delay_seconds(attempt_index: u32) -> u64 {
    let exponent = attempt_index.min(4);
    2_u64.pow(exponent)
}

pub fn container_name_for_job(job_id: &str) -> String {
    let suffix = job_id.chars().take(12).collect::<String>();
    format!("zimple-{suffix}")
}

fn docker_mount_path(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();

    if cfg!(target_os = "windows") {
        let replaced = raw.replace('\\', "/");
        if replaced.len() >= 3 {
            let mut chars = replaced.chars();
            if let (Some(drive), Some(':'), Some('/')) = (chars.next(), chars.next(), chars.next())
            {
                let tail = replaced[3..].to_string();
                return format!("/{}/{tail}", drive.to_ascii_lowercase());
            }
        }
        replaced
    } else {
        raw
    }
}

#[derive(Debug)]
struct DriverScriptGuard {
    path: PathBuf,
}

impl DriverScriptGuard {
    fn prepare(output_dir: &Path, container_name: &str) -> Result<(Self, String), String> {
        let script_filename = format!(".zimple-driver-{container_name}.mjs");
        let script_path = output_dir.join(&script_filename);
        fs::write(&script_path, IDENTITY_ENCODING_DRIVER_SOURCE).map_err(|err| {
            format!(
                "Failed to write zimit compatibility driver at {}: {err}",
                script_path.to_string_lossy()
            )
        })?;

        Ok((
            Self { path: script_path },
            format!("/output/{script_filename}"),
        ))
    }
}

impl Drop for DriverScriptGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn build_docker_args(
    request: &StartJobRequest,
    output_dir: &Path,
    output_filename: &str,
    container_name: &str,
    driver_container_path: Option<&str>,
) -> Vec<String> {
    let mount = docker_mount_path(output_dir);
    let output_dir_mb = u64::from(request.crawl.limits.max_total_size_mb);
    let size_hard_limit_bytes = output_dir_mb.saturating_mul(1024).saturating_mul(1024);
    let time_hard_limit_seconds =
        u64::from(request.crawl.limits.timeout_minutes).saturating_mul(60);
    let mut args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--name".to_string(),
        container_name.to_string(),
        "-v".to_string(),
        format!("{mount}:/output"),
        ZIMIT_IMAGE.to_string(),
        "zimit".to_string(),
        "--seeds".to_string(),
        request.url.trim().to_string(),
        "--name".to_string(),
        output_filename.to_string(),
        "--output".to_string(),
        "/output".to_string(),
        "--scopeType".to_string(),
        if request.crawl.include_patterns.is_empty() {
            "domain".to_string()
        } else {
            "custom".to_string()
        },
        "--diskUtilization".to_string(),
        "0".to_string(),
        "-w".to_string(),
        request.crawl.workers.to_string(),
        "--depth".to_string(),
        request.crawl.limits.max_depth.to_string(),
        "--pageLimit".to_string(),
        request.crawl.limits.max_pages.to_string(),
        "--maxPageRetries".to_string(),
        request.crawl.limits.retries.to_string(),
        "--timeHardLimit".to_string(),
        time_hard_limit_seconds.to_string(),
        "--sizeHardLimit".to_string(),
        size_hard_limit_bytes.to_string(),
    ];

    if let Some(driver_path) = driver_container_path {
        args.push("--driver".to_string());
        args.push(driver_path.to_string());
    }

    for include_pattern in &request.crawl.include_patterns {
        args.push("--scopeIncludeRx".to_string());
        args.push(include_pattern.clone());
    }

    for exclude_pattern in &request.crawl.exclude_patterns {
        args.push("--scopeExcludeRx".to_string());
        args.push(exclude_pattern.clone());
    }

    args
}

pub async fn run_zimit_once<F>(
    request: &StartJobRequest,
    output_dir: &Path,
    output_filename: &str,
    container_name: &str,
    mut on_log: F,
) -> Result<DockerRunResult, String>
where
    F: FnMut(String),
{
    let (_driver_guard, driver_container_path) =
        DriverScriptGuard::prepare(output_dir, container_name)?;
    let args = build_docker_args(
        request,
        output_dir,
        output_filename,
        container_name,
        Some(&driver_container_path),
    );

    let mut child = Command::new("docker")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("Failed to start Docker process: {err}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Docker stdout stream.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture Docker stderr stream.".to_string())?;

    let (line_tx, mut line_rx) = mpsc::unbounded_channel::<String>();
    let stdout_task = tokio::spawn(read_log_stream(stdout, line_tx.clone()));
    let stderr_task = tokio::spawn(read_log_stream(stderr, line_tx.clone()));
    drop(line_tx);
    let mut recent_output = VecDeque::with_capacity(6);

    while let Some(line) = line_rx.recv().await {
        if !is_docker_noise_line(&line) {
            if let Some(normalized) = normalize_zimit_log_line(&line) {
                push_recent_output_line(&mut recent_output, normalized.clone());
                on_log(normalized);
            }
        }
    }

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let status = child
        .wait()
        .await
        .map_err(|err| format!("Failed while waiting for Docker process: {err}"))?;

    let success = status.success();
    let error_message = if success {
        None
    } else {
        let mut message = match status.code() {
            Some(code) => format!("zimit container failed with exit code {code}."),
            None => "zimit container terminated by signal.".to_string(),
        };

        if status.code() == Some(2) {
            message.push_str(
                " Exit code 2 usually means zimit rejected one or more options or the output archive name already exists.",
            );
        }

        if !recent_output.is_empty() {
            let context = recent_output
                .iter()
                .cloned()
                .collect::<Vec<String>>()
                .join(" | ");
            message.push_str(" Last output: ");
            message.push_str(&context);
        }

        Some(message)
    };

    Ok(DockerRunResult {
        success,
        error_message,
    })
}

pub async fn stop_container(container_name: &str) -> bool {
    let args = vec![
        "rm".to_string(),
        "-f".to_string(),
        container_name.to_string(),
    ];

    command_succeeds("docker", &args).await
}

pub fn open_path(path: &Path) -> Result<(), String> {
    let mut command = if cfg!(target_os = "macos") {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(path);
        cmd
    } else if cfg!(target_os = "windows") {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg("start").arg("").arg(path);
        cmd
    } else {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(path);
        cmd
    };

    command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Unable to open output file: {err}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Output file open command returned a non-zero status.".to_string())
            }
        })
}

pub async fn sleep_for_retry(attempt_index: u32) {
    let seconds = retry_delay_seconds(attempt_index);
    tokio::time::sleep(Duration::from_secs(seconds)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CrawlLimits, CrawlOptions};

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_delay_seconds(0), 1);
        assert_eq!(retry_delay_seconds(1), 2);
        assert_eq!(retry_delay_seconds(4), 16);
        assert_eq!(retry_delay_seconds(12), 16);
    }

    #[test]
    fn container_name_has_prefix() {
        let name = container_name_for_job("1234567890abcdef");
        assert_eq!(name, "zimple-1234567890ab");
    }

    #[test]
    fn builds_expected_arguments() {
        let request = StartJobRequest {
            url: "https://example.com".to_string(),
            output_directory: None,
            output_filename: None,
            crawl: CrawlOptions {
                respect_robots: true,
                workers: 4,
                include_patterns: vec!["/docs".to_string()],
                exclude_patterns: vec!["/admin".to_string()],
                limits: CrawlLimits::default(),
            },
        };

        let args = build_docker_args(
            &request,
            Path::new("/tmp/zimple"),
            "example",
            "zimple-test",
            Some("/output/.zimple-driver-zimple-test.mjs"),
        );

        assert!(args.contains(&"run".to_string()));
        assert!(args.contains(&"zimit".to_string()));
        assert!(args.contains(&"--seeds".to_string()));
        assert!(args.contains(&"https://example.com".to_string()));
        assert!(args.contains(&"--driver".to_string()));
        assert!(args.contains(&"/output/.zimple-driver-zimple-test.mjs".to_string()));
        assert!(args.contains(&"--scopeIncludeRx".to_string()));
        assert!(args.contains(&"--output".to_string()));
        assert!(args.contains(&"/output".to_string()));
    }
}

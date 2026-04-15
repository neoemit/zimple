use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::path::PathBuf;
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlLimits {
    pub max_pages: u32,
    pub max_depth: u32,
    pub max_total_size_mb: u32,
    pub max_asset_size_mb: u32,
    pub timeout_minutes: u32,
    pub retries: u32,
}

impl Default for CrawlLimits {
    fn default() -> Self {
        Self {
            max_pages: 2000,
            max_depth: 5,
            max_total_size_mb: 2048,
            max_asset_size_mb: 50,
            timeout_minutes: 120,
            retries: 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlOptions {
    pub respect_robots: bool,
    pub workers: u32,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub limits: CrawlLimits,
}

impl Default for CrawlOptions {
    fn default() -> Self {
        Self {
            respect_robots: true,
            workers: 4,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limits: CrawlLimits::default(),
        }
    }
}

impl CrawlOptions {
    pub fn normalized(mut self) -> Self {
        self.workers = self.workers.clamp(1, 12);
        self.limits.max_pages = self.limits.max_pages.clamp(1, 100_000);
        self.limits.max_depth = self.limits.max_depth.clamp(1, 32);
        self.limits.max_total_size_mb = self.limits.max_total_size_mb.clamp(64, 102_400);
        self.limits.max_asset_size_mb = self.limits.max_asset_size_mb.clamp(1, 4_096);
        self.limits.timeout_minutes = self.limits.timeout_minutes.clamp(5, 1_440);
        self.limits.retries = self.limits.retries.clamp(0, 10);

        self.include_patterns = self
            .include_patterns
            .iter()
            .map(|pattern| pattern.trim().to_string())
            .filter(|pattern| !pattern.is_empty())
            .collect();

        self.exclude_patterns = self
            .exclude_patterns
            .iter()
            .map(|pattern| pattern.trim().to_string())
            .filter(|pattern| !pattern.is_empty())
            .collect();

        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobRequest {
    pub url: String,
    pub output_directory: Option<String>,
    pub output_filename: Option<String>,
    pub crawl: CrawlOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobResponse {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelJobResponse {
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOutputResponse {
    pub opened: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub id: String,
    pub url: String,
    pub state: JobState,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub output_path: Option<String>,
    pub error_message: Option<String>,
    pub attempt: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub job_id: String,
    pub stage: String,
    pub message: String,
    pub timestamp: String,
    pub attempt: Option<u32>,
    pub percent: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetail {
    pub summary: JobSummary,
    pub request: StartJobRequest,
    pub logs: Vec<String>,
    pub progress: Vec<ProgressEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub docker_installed: bool,
    pub docker_responsive: bool,
    pub zimit_image_present: bool,
    pub ready: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub output_directory: Option<String>,
    pub auto_open_on_success: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            output_directory: default_downloads_directory(),
            auto_open_on_success: true,
        }
    }
}

pub fn default_downloads_directory() -> Option<String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .or_else(|| {
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            Some(PathBuf::from(drive).join(path))
        })?;

    Some(home.join("Downloads").to_string_lossy().to_string())
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

pub fn validate_public_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    let parsed = Url::parse(trimmed).map_err(|err| format!("Invalid URL: {err}"))?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Only http:// and https:// URLs are supported.".to_string());
    }

    if parsed.username() != "" || parsed.password().is_some() {
        return Err("Credentials are not supported in URLs for public-site capture.".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "URL must include a valid hostname.".to_string())?;

    let lowered = host.to_lowercase();
    if lowered == "localhost" {
        return Err("Local-only hosts are not supported in public-site mode.".to_string());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        let blocked = match ip {
            IpAddr::V4(v4) => {
                v4.is_private()
                    || v4.is_loopback()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_multicast()
                    || v4.is_unspecified()
            }
            IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_multicast()
                    || v6.is_unspecified()
                    || v6.is_unique_local()
                    || v6.is_unicast_link_local()
            }
        };

        if blocked {
            return Err(
                "Private or local network addresses are not supported in public-site mode."
                    .to_string(),
            );
        }
    }

    Ok(parsed)
}

pub fn sanitize_output_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }

    while out.ends_with('-') {
        out.pop();
    }

    let out = out.trim_start_matches('-').to_string();
    if out.is_empty() {
        "site".to_string()
    } else {
        out
    }
}

pub fn ensure_zim_extension(filename: &str) -> String {
    if filename.to_ascii_lowercase().ends_with(".zim") {
        filename.to_string()
    } else {
        format!("{filename}.zim")
    }
}

pub fn default_output_filename(url: &Url) -> String {
    let host = url.host_str().unwrap_or("site");
    let timestamp = Utc::now().format("%Y%m%dT%H%M%SZ");
    format!("{}-{timestamp}", sanitize_output_name(host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_public_urls() {
        let url = validate_public_url("https://example.org/path").expect("valid public url");
        assert_eq!(url.scheme(), "https");
    }

    #[test]
    fn rejects_local_urls() {
        let err = validate_public_url("http://127.0.0.1").expect_err("must reject private address");
        assert!(err.contains("Private or local"));
    }

    #[test]
    fn creates_sanitized_filename() {
        let out = sanitize_output_name("Docs @ Example.com");
        assert_eq!(out, "docs-example-com");
    }

    #[test]
    fn appends_extension() {
        assert_eq!(ensure_zim_extension("archive"), "archive.zim");
        assert_eq!(ensure_zim_extension("archive.zim"), "archive.zim");
    }

    #[test]
    fn normalizes_limits() {
        let options = CrawlOptions {
            workers: 50,
            limits: CrawlLimits {
                max_pages: 0,
                max_depth: 60,
                max_total_size_mb: 10,
                max_asset_size_mb: 0,
                timeout_minutes: 2,
                retries: 42,
            },
            include_patterns: vec!["  /docs ".into(), "".into()],
            exclude_patterns: vec!["  /admin ".into()],
            respect_robots: true,
        }
        .normalized();

        assert_eq!(options.workers, 12);
        assert_eq!(options.limits.max_pages, 1);
        assert_eq!(options.limits.timeout_minutes, 5);
        assert_eq!(options.limits.retries, 10);
        assert_eq!(options.include_patterns, vec!["/docs"]);
    }
}

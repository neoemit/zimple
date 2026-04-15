use crate::models::{
    now_iso, JobDetail, JobState, JobSummary, ProgressEvent, Settings, StartJobRequest,
};
use crate::runtime;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, timeout, MissedTickBehavior};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct JobRecord {
    pub summary: JobSummary,
    pub request: StartJobRequest,
    pub logs: Vec<String>,
    pub progress: Vec<ProgressEvent>,
    pub output_directory: String,
    pub output_filename: String,
    pub container_name: String,
    pub cancel_requested: bool,
}

#[derive(Debug)]
pub struct InnerState {
    pub jobs: HashMap<String, JobRecord>,
    pub queue: VecDeque<String>,
    pub active_job: Option<String>,
    pub worker_running: bool,
    pub settings: Settings,
}

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<Mutex<InnerState>>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            inner: Arc::new(Mutex::new(InnerState {
                jobs: HashMap::new(),
                queue: VecDeque::new(),
                active_job: None,
                worker_running: false,
                settings,
            })),
        }
    }
}

fn emit_job_state(app: &AppHandle, summary: &JobSummary) {
    let _ = app.emit("job:state_changed", summary);
}

fn emit_progress(app: &AppHandle, event: &ProgressEvent) {
    let _ = app.emit("job:progress", event);
}

fn add_progress_event(
    job: &mut JobRecord,
    stage: &str,
    message: impl Into<String>,
    attempt: Option<u32>,
) {
    let message = message.into();
    let event = ProgressEvent {
        job_id: job.summary.id.clone(),
        stage: stage.to_string(),
        message: message.clone(),
        timestamp: now_iso(),
        attempt,
        percent: None,
    };

    job.logs.push(message);
    job.progress.push(event);
}

pub async fn list_jobs(state: Arc<Mutex<InnerState>>) -> Vec<JobSummary> {
    let guard = state.lock().await;
    let mut summaries: Vec<JobSummary> =
        guard.jobs.values().map(|job| job.summary.clone()).collect();
    summaries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    summaries
}

pub async fn get_job(state: Arc<Mutex<InnerState>>, job_id: &str) -> Option<JobDetail> {
    let guard = state.lock().await;
    guard.jobs.get(job_id).map(|record| JobDetail {
        summary: record.summary.clone(),
        request: record.request.clone(),
        logs: record.logs.clone(),
        progress: record.progress.clone(),
    })
}

pub async fn get_output_path(state: Arc<Mutex<InnerState>>, job_id: &str) -> Option<PathBuf> {
    let guard = state.lock().await;
    guard
        .jobs
        .get(job_id)
        .and_then(|record| record.summary.output_path.clone())
        .map(PathBuf::from)
}

pub async fn get_settings(state: Arc<Mutex<InnerState>>) -> Settings {
    let guard = state.lock().await;
    guard.settings.clone()
}

pub async fn set_settings(state: Arc<Mutex<InnerState>>, settings: Settings) {
    let mut guard = state.lock().await;
    guard.settings = settings;
}

pub async fn enqueue_job(
    app: AppHandle,
    state: Arc<Mutex<InnerState>>,
    request: StartJobRequest,
    output_directory: String,
    output_filename: String,
) -> Result<String, String> {
    let job_id = Uuid::new_v4().to_string();
    let container_name = runtime::container_name_for_job(&job_id);

    let summary = JobSummary {
        id: job_id.clone(),
        url: request.url.clone(),
        state: JobState::Queued,
        created_at: now_iso(),
        started_at: None,
        finished_at: None,
        output_path: None,
        error_message: None,
        attempt: 0,
    };

    {
        let mut guard = state.lock().await;
        guard.jobs.insert(
            job_id.clone(),
            JobRecord {
                summary: summary.clone(),
                request,
                logs: vec!["Job queued".to_string()],
                progress: Vec::new(),
                output_directory,
                output_filename,
                container_name,
                cancel_requested: false,
            },
        );
        guard.queue.push_back(job_id.clone());
    }

    emit_job_state(&app, &summary);
    maybe_spawn_worker(app, state).await;
    Ok(job_id)
}

pub async fn cancel_job(app: AppHandle, state: Arc<Mutex<InnerState>>, job_id: &str) -> bool {
    let mut container_to_stop: Option<String> = None;
    let mut updated_summary: Option<JobSummary> = None;

    {
        let mut guard = state.lock().await;

        if let Some(position) = guard.queue.iter().position(|queued| queued == job_id) {
            guard.queue.remove(position);
            if let Some(job) = guard.jobs.get_mut(job_id) {
                job.summary.state = JobState::Cancelled;
                job.summary.finished_at = Some(now_iso());
                add_progress_event(job, "cancelled", "Job cancelled while queued", None);
                updated_summary = Some(job.summary.clone());
            }
        } else if let Some(job) = guard.jobs.get_mut(job_id) {
            if job.summary.state == JobState::Running {
                job.cancel_requested = true;
                job.summary.state = JobState::Cancelled;
                job.summary.finished_at = Some(now_iso());
                add_progress_event(
                    job,
                    "cancel",
                    "Cancellation requested. Stopping container...",
                    None,
                );
                container_to_stop = Some(job.container_name.clone());
                updated_summary = Some(job.summary.clone());
            }
        }
    }

    let has_update = updated_summary.is_some();

    if let Some(summary) = updated_summary.as_ref() {
        emit_job_state(&app, &summary);
    }

    if let Some(container_name) = container_to_stop {
        let _ = runtime::stop_container(&container_name).await;
        true
    } else {
        has_update
    }
}

pub async fn maybe_spawn_worker(app: AppHandle, state: Arc<Mutex<InnerState>>) {
    let should_spawn = {
        let mut guard = state.lock().await;
        if guard.worker_running {
            false
        } else {
            guard.worker_running = true;
            true
        }
    };

    if !should_spawn {
        return;
    }

    tauri::async_runtime::spawn(async move {
        worker_loop(app, state).await;
    });
}

async fn worker_loop(app: AppHandle, state: Arc<Mutex<InnerState>>) {
    loop {
        let next_job_id = {
            let mut guard = state.lock().await;
            let next = guard.queue.pop_front();

            match next {
                Some(job_id) => {
                    guard.active_job = Some(job_id.clone());
                    if let Some(job) = guard.jobs.get_mut(&job_id) {
                        job.summary.state = JobState::Running;
                        job.summary.started_at = Some(now_iso());
                        add_progress_event(job, "running", "Job started", None);
                        emit_job_state(&app, &job.summary);
                    }
                    Some(job_id)
                }
                None => {
                    guard.worker_running = false;
                    guard.active_job = None;
                    None
                }
            }
        };

        let Some(job_id) = next_job_id else {
            break;
        };

        process_job(&app, state.clone(), &job_id).await;

        let mut guard = state.lock().await;
        guard.active_job = None;
    }
}

async fn process_job(app: &AppHandle, state: Arc<Mutex<InnerState>>, job_id: &str) {
    let (request, output_directory, initial_output_filename, retries, container_name) = {
        let guard = state.lock().await;
        let Some(record) = guard.jobs.get(job_id) else {
            return;
        };

        (
            record.request.clone(),
            record.output_directory.clone(),
            record.output_filename.clone(),
            record.request.crawl.limits.retries,
            record.container_name.clone(),
        )
    };

    let output_dir = PathBuf::from(output_directory.clone());
    let output_filename = {
        let mut guard = state.lock().await;
        let Some(job) = guard.jobs.get_mut(job_id) else {
            return;
        };

        let resolved = ensure_available_output_filename(&output_dir, &initial_output_filename);
        if resolved != job.output_filename {
            let previous_name = format!("{}.zim", job.output_filename);
            let next_name = format!("{}.zim", resolved);
            add_progress_event(
                job,
                "runtime",
                format!(
                    "Output file {previous_name} already exists. Using {next_name} for this run."
                ),
                None,
            );
            if let Some(last_event) = job.progress.last().cloned() {
                emit_progress(app, &last_event);
            }
            job.output_filename = resolved.clone();
        }

        resolved
    };

    {
        let mut guard = state.lock().await;
        if let Some(job) = guard.jobs.get_mut(job_id) {
            if !job.request.crawl.respect_robots {
                add_progress_event(
                    job,
                    "runtime",
                    "Robots override is not supported by zimit; crawler policy remains zimit-default.",
                    None,
                );
                if let Some(last_event) = job.progress.last().cloned() {
                    emit_progress(app, &last_event);
                }
            }

            if job.request.crawl.limits.max_asset_size_mb > 0 {
                add_progress_event(
                    job,
                    "runtime",
                    "Per-asset size cap is not directly enforceable in zimit; using total size hard limit.",
                    None,
                );
                if let Some(last_event) = job.progress.last().cloned() {
                    emit_progress(app, &last_event);
                }
            }
        }
    }

    {
        let mut guard = state.lock().await;
        if let Some(job) = guard.jobs.get_mut(job_id) {
            add_progress_event(job, "runtime", "Checking zimit runtime image...", None);
            if let Some(last_event) = job.progress.last().cloned() {
                emit_progress(app, &last_event);
            }
        }
    }

    let mut runtime_heartbeat = interval(Duration::from_secs(15));
    runtime_heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut runtime_cancel_poll = interval(Duration::from_secs(1));
    runtime_cancel_poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let runtime_prepare_timeout = Duration::from_secs(20 * 60);
    let runtime_prepare_future = runtime::ensure_zimit_image(runtime_prepare_timeout);
    tokio::pin!(runtime_prepare_future);
    let runtime_started_at = Instant::now();

    let runtime_prepare_result = loop {
        tokio::select! {
            _ = runtime_heartbeat.tick() => {
                if runtime_started_at.elapsed() >= Duration::from_secs(15) {
                    let mut guard = state.lock().await;
                    if let Some(job) = guard.jobs.get_mut(job_id) {
                        if job.cancel_requested {
                            continue;
                        }
                        add_progress_event(
                            job,
                            "runtime",
                            "Preparing zimit runtime image (first run may take several minutes)...",
                            None,
                        );
                        if let Some(last_event) = job.progress.last().cloned() {
                            emit_progress(app, &last_event);
                        }
                    }
                }
            }
            _ = runtime_cancel_poll.tick() => {
                let should_cancel = {
                    let guard = state.lock().await;
                    guard
                        .jobs
                        .get(job_id)
                        .map(|job| job.cancel_requested)
                        .unwrap_or(false)
                };

                if should_cancel {
                    let mut guard = state.lock().await;
                    if let Some(job) = guard.jobs.get_mut(job_id) {
                        job.summary.state = JobState::Cancelled;
                        if job.summary.finished_at.is_none() {
                            job.summary.finished_at = Some(now_iso());
                        }
                        add_progress_event(job, "cancelled", "Job cancelled during runtime preparation", None);
                        if let Some(last_event) = job.progress.last().cloned() {
                            emit_progress(app, &last_event);
                        }
                        emit_job_state(app, &job.summary);
                    }
                    return;
                }
            }
            result = &mut runtime_prepare_future => {
                break result;
            }
        }
    };

    match runtime_prepare_result {
        Ok(true) => {
            let mut guard = state.lock().await;
            if let Some(job) = guard.jobs.get_mut(job_id) {
                add_progress_event(job, "runtime", "Runtime image prepared.", None);
                if let Some(last_event) = job.progress.last().cloned() {
                    emit_progress(app, &last_event);
                }
            }
        }
        Ok(false) => {
            let mut guard = state.lock().await;
            if let Some(job) = guard.jobs.get_mut(job_id) {
                add_progress_event(job, "runtime", "Runtime image ready.", None);
                if let Some(last_event) = job.progress.last().cloned() {
                    emit_progress(app, &last_event);
                }
            }
        }
        Err(error) => {
            let mut guard = state.lock().await;
            if let Some(job) = guard.jobs.get_mut(job_id) {
                if job.cancel_requested {
                    job.summary.state = JobState::Cancelled;
                    if job.summary.finished_at.is_none() {
                        job.summary.finished_at = Some(now_iso());
                    }
                    add_progress_event(
                        job,
                        "cancelled",
                        "Job cancelled during runtime preparation",
                        None,
                    );
                } else {
                    job.summary.state = JobState::Failed;
                    job.summary.finished_at = Some(now_iso());
                    job.summary.error_message = Some(error.clone());
                    add_progress_event(job, "error", error, None);
                }
                if let Some(last_event) = job.progress.last().cloned() {
                    emit_progress(app, &last_event);
                }
                emit_job_state(app, &job.summary);
            }
            return;
        }
    }

    for attempt in 1..=retries + 1 {
        let cancelled = {
            let guard = state.lock().await;
            guard
                .jobs
                .get(job_id)
                .map(|job| job.cancel_requested)
                .unwrap_or(false)
        };

        if cancelled {
            finalize_cancelled(app, state.clone(), job_id, "Job cancelled before attempt").await;
            return;
        }

        {
            let mut guard = state.lock().await;
            if let Some(job) = guard.jobs.get_mut(job_id) {
                job.summary.attempt = attempt;
                let attempt_message = format!("Attempt {attempt} of {} started", retries + 1);
                add_progress_event(job, "attempt", attempt_message, Some(attempt));
                if let Some(last_event) = job.progress.last().cloned() {
                    emit_progress(app, &last_event);
                }
                add_progress_event(
                    job,
                    "runtime",
                    "Launching zimit capture engine...",
                    Some(attempt),
                );
                if let Some(last_event) = job.progress.last().cloned() {
                    emit_progress(app, &last_event);
                }
                emit_job_state(app, &job.summary);
            }
        }

        enum AttemptRunOutcome {
            Completed(Result<runtime::DockerRunResult, String>),
            TimedOut,
            Cancelled,
        }

        let previous_zims = list_zim_files(&output_dir);

        let attempt_timeout = Duration::from_secs(
            u64::from(request.crawl.limits.timeout_minutes)
                .saturating_mul(60)
                .saturating_add(60),
        );

        let (log_tx, mut log_rx) = mpsc::unbounded_channel::<String>();
        let run_future = timeout(
            attempt_timeout,
            runtime::run_zimit_once(
                &request,
                &output_dir,
                &output_filename,
                &container_name,
                move |line| {
                    let _ = log_tx.send(line);
                },
            ),
        );
        tokio::pin!(run_future);

        let mut heartbeat = interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut cancel_poll = interval(Duration::from_secs(1));
        cancel_poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut last_progress_at = Instant::now();

        let run_result = loop {
            tokio::select! {
                maybe_line = log_rx.recv() => {
                    if let Some(line) = maybe_line {
                        last_progress_at = Instant::now();
                        let mut guard = state.lock().await;
                        if let Some(job) = guard.jobs.get_mut(job_id) {
                            if job.cancel_requested {
                                continue;
                            }
                            add_progress_event(job, "log", line, Some(attempt));
                            if let Some(last_event) = job.progress.last().cloned() {
                                emit_progress(app, &last_event);
                            }
                        }
                    }
                }
                _ = heartbeat.tick() => {
                    if last_progress_at.elapsed() >= Duration::from_secs(15) {
                        let mut guard = state.lock().await;
                        if let Some(job) = guard.jobs.get_mut(job_id) {
                            if job.cancel_requested {
                                continue;
                            }
                            add_progress_event(
                                job,
                                "heartbeat",
                                format!("Attempt {attempt} still running..."),
                                Some(attempt),
                            );
                            if let Some(last_event) = job.progress.last().cloned() {
                                emit_progress(app, &last_event);
                            }
                        }
                    }
                }
                _ = cancel_poll.tick() => {
                    let should_cancel = {
                        let guard = state.lock().await;
                        guard
                            .jobs
                            .get(job_id)
                            .map(|job| job.cancel_requested)
                            .unwrap_or(false)
                    };
                    if should_cancel {
                        let _ = runtime::stop_container(&container_name).await;
                        break AttemptRunOutcome::Cancelled;
                    }
                }
                result = &mut run_future => {
                    while let Ok(line) = log_rx.try_recv() {
                        let mut guard = state.lock().await;
                        if let Some(job) = guard.jobs.get_mut(job_id) {
                            if job.cancel_requested {
                                continue;
                            }
                            add_progress_event(job, "log", line, Some(attempt));
                            if let Some(last_event) = job.progress.last().cloned() {
                                emit_progress(app, &last_event);
                            }
                        }
                    }

                    break match result {
                        Ok(outcome) => AttemptRunOutcome::Completed(outcome),
                        Err(_) => AttemptRunOutcome::TimedOut,
                    };
                }
            }
        };

        if matches!(
            run_result,
            AttemptRunOutcome::TimedOut | AttemptRunOutcome::Cancelled
        ) {
            let _ = runtime::stop_container(&container_name).await;
        }

        {
            let mut guard = state.lock().await;
            if let Some(job) = guard.jobs.get_mut(job_id) {
                if job.cancel_requested || matches!(run_result, AttemptRunOutcome::Cancelled) {
                    job.summary.state = JobState::Cancelled;
                    if job.summary.finished_at.is_none() {
                        job.summary.finished_at = Some(now_iso());
                    }
                    add_progress_event(job, "cancelled", "Job cancelled", Some(attempt));
                    if let Some(last_event) = job.progress.last().cloned() {
                        emit_progress(app, &last_event);
                    }
                    emit_job_state(app, &job.summary);
                    return;
                }

                match run_result {
                    AttemptRunOutcome::Completed(Ok(result)) => {
                        if result.success {
                            let resolved_output =
                                resolve_output_path(&output_dir, &previous_zims, &output_filename);

                            if let Some(output_path) = resolved_output {
                                job.summary.state = JobState::Succeeded;
                                job.summary.finished_at = Some(now_iso());
                                job.summary.output_path = Some(output_path.clone());
                                add_progress_event(
                                    job,
                                    "completed",
                                    "ZIM build completed",
                                    Some(attempt),
                                );
                                add_progress_event(
                                    job,
                                    "output",
                                    format!("Generated output: {output_path}"),
                                    Some(attempt),
                                );
                                if let Some(last_event) = job.progress.last().cloned() {
                                    emit_progress(app, &last_event);
                                }
                                emit_job_state(app, &job.summary);
                                return;
                            }

                            let missing_output_message = "zimit completed without writing a .zim file into the output directory.".to_string();
                            add_progress_event(
                                job,
                                "error",
                                missing_output_message.clone(),
                                Some(attempt),
                            );
                            if let Some(last_event) = job.progress.last().cloned() {
                                emit_progress(app, &last_event);
                            }

                            if attempt <= retries {
                                add_progress_event(
                                    job,
                                    "retry",
                                    format!(
                                        "Attempt {attempt} produced no output archive. Retrying..."
                                    ),
                                    Some(attempt),
                                );
                                if let Some(last_event) = job.progress.last().cloned() {
                                    emit_progress(app, &last_event);
                                }
                            } else {
                                job.summary.state = JobState::Failed;
                                job.summary.finished_at = Some(now_iso());
                                job.summary.error_message = Some(missing_output_message);
                                add_progress_event(
                                    job,
                                    "failed",
                                    "ZIM build failed",
                                    Some(attempt),
                                );
                                if let Some(last_event) = job.progress.last().cloned() {
                                    emit_progress(app, &last_event);
                                }
                                emit_job_state(app, &job.summary);
                                return;
                            }
                            continue;
                        }

                        if attempt <= retries {
                            let retry_message = format!(
                                "Attempt {attempt} failed: {}. Retrying...",
                                result
                                    .error_message
                                    .clone()
                                    .unwrap_or_else(|| "unknown error".to_string())
                            );
                            add_progress_event(job, "retry", retry_message, Some(attempt));
                            if let Some(last_event) = job.progress.last().cloned() {
                                emit_progress(app, &last_event);
                            }
                        } else {
                            job.summary.state = JobState::Failed;
                            job.summary.finished_at = Some(now_iso());
                            job.summary.error_message = result.error_message;
                            add_progress_event(job, "failed", "ZIM build failed", Some(attempt));
                            if let Some(last_event) = job.progress.last().cloned() {
                                emit_progress(app, &last_event);
                            }
                            emit_job_state(app, &job.summary);
                            return;
                        }
                    }
                    AttemptRunOutcome::Completed(Err(error)) => {
                        let message = format!("Failed to execute Docker job: {error}");
                        add_progress_event(job, "error", message.clone(), Some(attempt));
                        if let Some(last_event) = job.progress.last().cloned() {
                            emit_progress(app, &last_event);
                        }

                        if attempt <= retries {
                            add_progress_event(
                                job,
                                "retry",
                                "Retrying after execution failure",
                                Some(attempt),
                            );
                            if let Some(last_event) = job.progress.last().cloned() {
                                emit_progress(app, &last_event);
                            }
                        } else {
                            job.summary.state = JobState::Failed;
                            job.summary.finished_at = Some(now_iso());
                            job.summary.error_message = Some(message);
                            emit_job_state(app, &job.summary);
                            return;
                        }
                    }
                    AttemptRunOutcome::TimedOut => {
                        let message = format!(
                            "Attempt {attempt} timed out after {} minutes. Retrying if attempts remain.",
                            request.crawl.limits.timeout_minutes
                        );
                        add_progress_event(job, "timeout", message.clone(), Some(attempt));
                        if let Some(last_event) = job.progress.last().cloned() {
                            emit_progress(app, &last_event);
                        }

                        if attempt <= retries {
                            add_progress_event(
                                job,
                                "retry",
                                "Retrying after timeout",
                                Some(attempt),
                            );
                            if let Some(last_event) = job.progress.last().cloned() {
                                emit_progress(app, &last_event);
                            }
                        } else {
                            job.summary.state = JobState::Failed;
                            job.summary.finished_at = Some(now_iso());
                            job.summary.error_message = Some(message);
                            emit_job_state(app, &job.summary);
                            return;
                        }
                    }
                    AttemptRunOutcome::Cancelled => {}
                }
            }
        }

        runtime::sleep_for_retry(attempt).await;
    }
}

fn list_zim_files(output_dir: &PathBuf) -> HashSet<String> {
    let mut files = HashSet::new();
    let entries = match fs::read_dir(output_dir) {
        Ok(entries) => entries,
        Err(_) => return files,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("zim"))
            .unwrap_or(false)
        {
            files.insert(path.to_string_lossy().to_string());
        }
    }

    files
}

fn ensure_available_output_filename(output_dir: &PathBuf, preferred_name: &str) -> String {
    let mut candidate = preferred_name.to_string();
    let mut suffix = 1_u32;

    while output_dir.join(format!("{candidate}.zim")).exists() {
        candidate = format!("{preferred_name}-{suffix}");
        suffix = suffix.saturating_add(1);
    }

    candidate
}

fn resolve_output_path(
    output_dir: &PathBuf,
    previous_zims: &HashSet<String>,
    preferred_name: &str,
) -> Option<String> {
    let preferred_path = output_dir.join(format!("{preferred_name}.zim"));
    if preferred_path.exists() {
        return Some(preferred_path.to_string_lossy().to_string());
    }

    let entries = fs::read_dir(output_dir).ok()?;
    let mut candidates: Vec<(String, std::time::SystemTime)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let is_zim = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("zim"))
            .unwrap_or(false);
        if !is_zim {
            continue;
        }

        let as_string = path.to_string_lossy().to_string();
        if !previous_zims.contains(&as_string) {
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            candidates.push((as_string, modified));
        }
    }

    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    candidates.first().map(|(path, _)| path.clone())
}

async fn finalize_cancelled(
    app: &AppHandle,
    state: Arc<Mutex<InnerState>>,
    job_id: &str,
    message: &str,
) {
    let mut guard = state.lock().await;
    if let Some(job) = guard.jobs.get_mut(job_id) {
        job.summary.state = JobState::Cancelled;
        job.summary.finished_at = Some(now_iso());
        add_progress_event(job, "cancelled", message.to_string(), None);
        emit_job_state(app, &job.summary);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CrawlLimits, CrawlOptions};
    use std::fs;

    fn sample_request() -> StartJobRequest {
        StartJobRequest {
            url: "https://example.com".to_string(),
            output_directory: Some("/tmp".to_string()),
            output_filename: Some("example".to_string()),
            crawl: CrawlOptions {
                respect_robots: true,
                workers: 4,
                include_patterns: vec![],
                exclude_patterns: vec![],
                limits: CrawlLimits::default(),
            },
        }
    }

    #[tokio::test]
    async fn list_jobs_sorts_descending() {
        let state = Arc::new(Mutex::new(InnerState {
            jobs: HashMap::new(),
            queue: VecDeque::new(),
            active_job: None,
            worker_running: false,
            settings: Settings::default(),
        }));

        {
            let mut guard = state.lock().await;
            guard.jobs.insert(
                "1".to_string(),
                JobRecord {
                    summary: JobSummary {
                        id: "1".to_string(),
                        url: "https://a.example".to_string(),
                        state: JobState::Queued,
                        created_at: "2026-04-15T10:00:00Z".to_string(),
                        started_at: None,
                        finished_at: None,
                        output_path: None,
                        error_message: None,
                        attempt: 0,
                    },
                    request: sample_request(),
                    logs: vec![],
                    progress: vec![],
                    output_directory: "/tmp".to_string(),
                    output_filename: "a".to_string(),
                    container_name: "zimple-a".to_string(),
                    cancel_requested: false,
                },
            );

            guard.jobs.insert(
                "2".to_string(),
                JobRecord {
                    summary: JobSummary {
                        id: "2".to_string(),
                        url: "https://b.example".to_string(),
                        state: JobState::Queued,
                        created_at: "2026-04-15T11:00:00Z".to_string(),
                        started_at: None,
                        finished_at: None,
                        output_path: None,
                        error_message: None,
                        attempt: 0,
                    },
                    request: sample_request(),
                    logs: vec![],
                    progress: vec![],
                    output_directory: "/tmp".to_string(),
                    output_filename: "b".to_string(),
                    container_name: "zimple-b".to_string(),
                    cancel_requested: false,
                },
            );
        }

        let jobs = list_jobs(state).await;
        assert_eq!(jobs[0].id, "2");
        assert_eq!(jobs[1].id, "1");
    }

    #[test]
    fn appends_suffix_when_output_name_already_exists() {
        let temp_dir = std::env::temp_dir().join(format!("zimple-output-name-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        fs::write(temp_dir.join("capture.zim"), b"").expect("create first zim");
        fs::write(temp_dir.join("capture-1.zim"), b"").expect("create second zim");

        let candidate = ensure_available_output_filename(&temp_dir, "capture");
        assert_eq!(candidate, "capture-2");

        let _ = fs::remove_dir_all(temp_dir);
    }
}

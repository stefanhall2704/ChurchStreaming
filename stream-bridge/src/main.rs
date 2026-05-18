use std::{collections::HashMap, sync::Arc, time::Instant};

use anyhow::Context;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};

#[derive(rust_embed::Embed)]
#[folder = "../dashboard/dist"]
struct Frontend;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{broadcast, mpsc, Mutex},
    time::{interval, sleep, Duration},
};
use tracing::{error, info, warn};
use axum::routing::delete;

const HLS_DIR: &str = "/dev/shm/hls";

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Destination {
    id:         String,
    name:       String,
    rtmp_url:   String,
    stream_key: String,
    enabled:    bool,
    // Google OAuth — stored in config.json, never sent to the browser
    #[serde(default)]
    google_client_id:     Option<String>,
    #[serde(default)]
    google_client_secret: Option<String>,
    #[serde(default)]
    refresh_token:        Option<String>,
}

impl Destination {
    fn push_url(&self) -> String {
        format!("{}/{}", self.rtmp_url.trim_end_matches('/'), self.stream_key)
    }
    fn key_hint(&self) -> String {
        let n = self.stream_key.len().min(4);
        if n == 0 { return "(no key)".into(); }
        format!("{}****", &self.stream_key[..n])
    }
    fn has_credentials(&self) -> bool {
        self.google_client_id.as_deref().map_or(false, |s| !s.is_empty()) &&
        self.google_client_secret.as_deref().map_or(false, |s| !s.is_empty())
    }
    fn authenticated(&self) -> bool {
        self.refresh_token.as_deref().map_or(false, |s| !s.is_empty())
    }
}

// In-flight device authorization waiting for user to visit the Google URL
#[derive(Debug, Clone)]
struct PendingDeviceAuth {
    client_id:     String,
    client_secret: String,
    device_code:   String,
    expires_at:    Instant,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct SessionMeta {
    title:       Option<String>,
    description: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Config {
    srt_port:     u16,
    #[serde(default = "default_metrics_port")]
    metrics_port: u16,
    #[serde(default = "default_max_retries")]
    max_retries:  u32,
    #[serde(default)]
    destinations: Vec<Destination>,
}

fn default_metrics_port() -> u16 { 3030 }
fn default_max_retries()  -> u32 { 3 }

impl Config {
    fn load() -> anyhow::Result<Self> {
        let path = config_path();
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading config from '{path}'"))?;
        serde_json::from_str(&text).context("parsing config.json")
    }

    fn save(&self) -> anyhow::Result<()> {
        let path = config_path();
        let text = serde_json::to_string_pretty(self).context("serialising config")?;
        std::fs::write(&path, text)
            .with_context(|| format!("writing config to '{path}'"))?;
        Ok(())
    }

    fn srt_url(&self) -> String {
        format!("srt://0.0.0.0:{}?mode=listener", self.srt_port)
    }

    fn active_destinations(&self) -> Vec<&Destination> {
        self.destinations.iter()
            .filter(|d| d.enabled && !d.stream_key.trim().is_empty())
            .collect()
    }
}

fn config_path() -> String {
    std::env::var("CONFIG_PATH").unwrap_or_else(|_| "config.json".into())
}

type SharedConfig = Arc<Mutex<Config>>;

// ── State Machine ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
enum Phase {
    #[default]
    Idle,
    Preview,
    Streaming,
    Error,
}

#[derive(Debug, Clone, Serialize, Default)]
struct AppState {
    phase:               Phase,
    bitrate_kbps:        f32,
    fps:                 f32,
    drop_frames:         u64,
    uptime_secs:         u64,
    retry_count:         u32,
    error_message:       Option<String>,
    cpu_temp_celsius:    f32,
    active_destinations: Vec<String>,   // display names of active RTMP targets
    #[serde(skip)]
    stream_start:        Option<Instant>,
}

impl AppState {
    fn go_preview(&mut self) {
        let temp = self.cpu_temp_celsius;
        *self = Self::default();
        self.phase        = Phase::Preview;
        self.stream_start = Some(Instant::now());
        self.cpu_temp_celsius = temp;
    }

    fn go_streaming(&mut self, active: Vec<String>) {
        let temp = self.cpu_temp_celsius;
        *self = Self::default();
        self.phase               = Phase::Streaming;
        self.stream_start        = Some(Instant::now());
        self.cpu_temp_celsius    = temp;
        self.active_destinations = active;
    }

    fn go_idle(&mut self) {
        let temp = self.cpu_temp_celsius;
        *self = Self::default();
        self.cpu_temp_celsius = temp;
    }

    fn go_error(&mut self, msg: impl Into<String>) {
        let temp = self.cpu_temp_celsius;
        *self = Self::default();
        self.phase         = Phase::Error;
        self.error_message = Some(msg.into());
        self.cpu_temp_celsius = temp;
    }

    fn refresh_uptime(&mut self) {
        if let Some(t) = self.stream_start {
            self.uptime_secs = t.elapsed().as_secs();
        }
    }
}

type Shared = Arc<Mutex<AppState>>;

// ── Control Channel ───────────────────────────────────────────────────────────

#[derive(Debug)]
enum Cmd { Preview, Start, Stop }

// ── Axum Context ─────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Ctx {
    state:        Shared,
    config:       SharedConfig,
    cmd:          mpsc::Sender<Cmd>,
    audio_tx:     broadcast::Sender<f32>,
    session:      Arc<Mutex<SessionMeta>>,
    http:         reqwest::Client,
    pending_auth: Arc<Mutex<HashMap<String, PendingDeviceAuth>>>,
}

// ── Entry Point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("stream_bridge=info".parse().unwrap()),
        )
        .init();

    std::fs::create_dir_all(HLS_DIR)
        .with_context(|| format!("creating HLS dir {HLS_DIR}"))?;
    clear_hls_dir();

    let config = Config::load()?;
    let active: Vec<_> = config.active_destinations().iter().map(|d| d.name.as_str()).collect();
    info!(
        srt_port     = config.srt_port,
        metrics_port = config.metrics_port,
        max_retries  = config.max_retries,
        destinations = config.destinations.len(),
        active       = active.join(", "),
        "stream-bridge v{} starting",
        env!("CARGO_PKG_VERSION")
    );

    let state:        Shared       = Arc::new(Mutex::new(AppState::default()));
    let config:       SharedConfig = Arc::new(Mutex::new(config));
    let (cmd_tx, cmd_rx)           = mpsc::channel::<Cmd>(8);
    let (audio_tx, _)              = broadcast::channel::<f32>(64);
    let session                    = Arc::new(Mutex::new(SessionMeta::default()));
    let http                       = reqwest::Client::builder()
        .user_agent("stream-bridge/0.2")
        .build()
        .context("building HTTP client")?;
    let pending_auth: Arc<Mutex<HashMap<String, PendingDeviceAuth>>>
        = Arc::new(Mutex::new(HashMap::new()));

    tokio::spawn(temp_monitor(state.clone()));
    tokio::spawn(telemetry_printer(state.clone()));
    tokio::spawn(supervisor(cmd_rx, state.clone(), config.clone(), audio_tx.clone()));

    let metrics_port = config.lock().await.metrics_port;
    let bind = format!("0.0.0.0:{metrics_port}");

    let ctx = Ctx { state, config, cmd: cmd_tx, audio_tx, session, http, pending_auth };
    let app = Router::new()
        .route("/metrics",                                 get(handle_status))
        .route("/api/status",                              get(handle_status))
        .route("/api/preview",                             post(handle_preview))
        .route("/api/start",                               post(handle_start))
        .route("/api/stop",                                post(handle_stop))
        .route("/api/config",                              get(handle_get_config))
        .route("/api/config/update",                       post(handle_update_config))
        .route("/api/destinations/{id}/toggle",            post(handle_toggle_destination))
        .route("/api/destinations/{id}",                   put(handle_update_destination))
        .route("/api/destinations/{id}/auth/start",        post(handle_auth_start))
        .route("/api/destinations/{id}/auth/poll",         post(handle_auth_poll))
        .route("/api/destinations/{id}/auth/disconnect",   delete(handle_auth_disconnect))
        .route("/api/session",                             get(handle_get_session))
        .route("/api/session",                             post(handle_set_session))
        .route("/ws",                                      get(ws_audio))
        .route("/hls/{file}",                              get(serve_hls))
        .fallback(serve_frontend)
        .with_state(ctx);

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("binding {bind}"))?;
    info!("HTTP listening on http://{bind}");
    axum::serve(listener, app).await.context("HTTP server")?;
    Ok(())
}

// ── Frontend (embedded SPA) ───────────────────────────────────────────────────

async fn serve_frontend(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match Frontend::get(path).or_else(|| Frontend::get("index.html")) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(axum::body::Body::from(file.data.into_owned()))
                .unwrap()
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(axum::body::Body::from("not found"))
            .unwrap(),
    }
}

// ── HLS Helpers ───────────────────────────────────────────────────────────────

fn clear_hls_dir() {
    if let Ok(entries) = std::fs::read_dir(HLS_DIR) {
        for entry in entries.flatten() {
            let p = entry.path();
            if matches!(p.extension().and_then(|e| e.to_str()), Some("ts" | "m3u8")) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

// ── CPU Temperature Monitor ───────────────────────────────────────────────────

fn read_cpu_temp() -> Option<f32> {
    std::fs::read_to_string("/sys/class/thermal/thermal_zone0/temp")
        .ok()
        .and_then(|s| s.trim().parse::<f32>().ok())
        .map(|t| t / 1000.0)
}

async fn temp_monitor(state: Shared) {
    let mut tick = interval(Duration::from_secs(5));
    loop {
        tick.tick().await;
        if let Some(t) = read_cpu_temp() {
            state.lock().await.cpu_temp_celsius = t;
        }
    }
}

// ── Supervisor ────────────────────────────────────────────────────────────────

async fn supervisor(
    mut cmd_rx: mpsc::Receiver<Cmd>,
    state:      Shared,
    config:     SharedConfig,
    audio_tx:   broadcast::Sender<f32>,
) {
    'outer: loop {
        let first = loop {
            match cmd_rx.recv().await {
                Some(Cmd::Preview) => break Cmd::Preview,
                Some(Cmd::Start)   => break Cmd::Start,
                Some(Cmd::Stop)    => warn!("Stop ignored — already idle"),
                None               => return,
            }
        };

        match first {
            Cmd::Preview => state.lock().await.go_preview(),
            _ => {
                let names = active_names(&*config.lock().await);
                state.lock().await.go_streaming(names);
            }
        }
        info!("Activated — phase={:?}", state.lock().await.phase);

        'active: loop {
            let cfg     = config.lock().await.clone();
            let is_live = state.lock().await.phase == Phase::Streaming;

            clear_hls_dir();

            let spawn_result = if is_live {
                spawn_ffmpeg_full(&cfg)
            } else {
                spawn_ffmpeg_preview(&cfg)
            };

            let mut child = match spawn_result {
                Ok(c)  => c,
                Err(e) => {
                    error!("spawn failed: {e:#}");
                    state.lock().await.go_error(e.to_string());
                    continue 'outer;
                }
            };

            let spawned_at = Instant::now();
            if is_live {
                let names = active_names(&cfg);
                info!("ffmpeg pid={} — SRT :{} (live → [{}])",
                    child.id().unwrap_or(0), cfg.srt_port, names.join(", "));
            } else {
                info!("ffmpeg pid={} — SRT :{} (preview/HLS only)",
                    child.id().unwrap_or(0), cfg.srt_port);
            }

            let stderr = child.stderr.take().expect("piped");
            tokio::spawn(parse_telemetry(stderr, state.clone(), audio_tx.clone()));

            loop {
                tokio::select! {
                    result = child.wait() => {
                        let code  = result.map(|s| s.to_string())
                                          .unwrap_or_else(|e| e.to_string());
                        let lived = spawned_at.elapsed().as_secs();
                        let retries = {
                            let mut s = state.lock().await;
                            if lived >= 5 { s.retry_count = 0; }
                            s.retry_count += 1;
                            s.bitrate_kbps = 0.0;
                            s.fps          = 0.0;
                            s.drop_frames  = 0;
                            s.retry_count
                        };
                        let max = config.lock().await.max_retries;
                        if retries <= max {
                            warn!("ffmpeg exited ({code}, lived {lived}s) — self-heal {retries}/{max} in 2 s");
                            sleep(Duration::from_secs(2)).await;
                            continue 'active;
                        }
                        error!("ffmpeg exited after {max} retries — Error");
                        state.lock().await.go_error(
                            format!("exited after {max} retries: {code}")
                        );
                        continue 'outer;
                    }

                    cmd = cmd_rx.recv() => match cmd {
                        Some(Cmd::Stop) => {
                            info!("Stop — graceful shutdown");
                            graceful_kill(&mut child).await;
                            state.lock().await.go_idle();
                            continue 'outer;
                        }
                        Some(Cmd::Start) => {
                            let phase = state.lock().await.phase.clone();
                            if phase == Phase::Streaming {
                                warn!("Start ignored — already streaming");
                            } else {
                                info!("Promoting preview → live");
                                graceful_kill(&mut child).await;
                                let names = active_names(&*config.lock().await);
                                state.lock().await.go_streaming(names);
                                continue 'active;
                            }
                        }
                        Some(Cmd::Preview) => warn!("Preview ignored — already active"),
                        None => return,
                    },
                }
            }
        }
    }
}

fn active_names(cfg: &Config) -> Vec<String> {
    cfg.destinations.iter()
        .filter(|d| d.enabled && !d.stream_key.trim().is_empty())
        .map(|d| d.name.clone())
        .collect()
}

// ── FFmpeg Spawners ───────────────────────────────────────────────────────────

// Preview: SRT → HLS + audio analysis. Untouched.
fn spawn_ffmpeg_preview(cfg: &Config) -> anyhow::Result<tokio::process::Child> {
    Command::new("ffmpeg")
        .args([
            "-hide_banner", "-loglevel", "warning",
            "-progress", "pipe:2",
            "-fflags", "+discardcorrupt",
            "-err_detect", "ignore_err",
            "-rw_timeout", "7000000",
            "-i", &cfg.srt_url(),
            "-map", "0:v", "-map", "0:a",
            "-c", "copy",
            "-f", "hls", "-hls_time", "2", "-hls_list_size", "3",
            "-hls_flags", "delete_segments",
            "-hls_segment_filename", &format!("{HLS_DIR}/seg%03d.ts"),
            &format!("{HLS_DIR}/stream.m3u8"),
            "-map", "0:a",
            "-af", "ebur128=framelog=24",
            "-f", "null", "-",
        ])
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("failed to spawn ffmpeg (preview)")
}

// Full: SRT → tee(RTMP × N) + HLS + audio analysis.
// Uses -f flv for a single destination, -f tee for multiple.
fn spawn_ffmpeg_full(cfg: &Config) -> anyhow::Result<tokio::process::Child> {
    let active = cfg.active_destinations();
    anyhow::ensure!(!active.is_empty(), "no enabled destinations with stream keys");

    let hls_seg  = format!("{HLS_DIR}/seg%03d.ts");
    let hls_m3u8 = format!("{HLS_DIR}/stream.m3u8");

    // Build the RTMP output section (single vs. tee muxer)
    let (rtmp_fmt, rtmp_target): (&str, String) = if active.len() == 1 {
        ("flv", active[0].push_url())
    } else {
        let tee = active.iter()
            .map(|d| format!("[f=flv]{}", d.push_url()))
            .collect::<Vec<_>>()
            .join("|");
        ("tee", tee)
    };

    let args: Vec<String> = vec![
        "-hide_banner".into(), "-loglevel".into(), "warning".into(),
        "-progress".into(), "pipe:2".into(),
        "-fflags".into(), "+discardcorrupt".into(),
        "-err_detect".into(), "ignore_err".into(),
        "-rw_timeout".into(), "7000000".into(),
        "-i".into(), cfg.srt_url(),
        // RTMP egress — single destination or tee muxer fan-out
        "-map".into(), "0:v".into(),
        "-map".into(), "0:a".into(),
        "-c".into(), "copy".into(),
        "-f".into(), rtmp_fmt.into(),
        rtmp_target,
        // HLS preview (unchanged from preview mode)
        "-map".into(), "0:v".into(),
        "-map".into(), "0:a".into(),
        "-c".into(), "copy".into(),
        "-f".into(), "hls".into(),
        "-hls_time".into(), "2".into(),
        "-hls_list_size".into(), "3".into(),
        "-hls_flags".into(), "delete_segments".into(),
        "-hls_segment_filename".into(), hls_seg,
        hls_m3u8,
        // Audio loudness analysis (untouched)
        "-map".into(), "0:a".into(),
        "-af".into(), "ebur128=framelog=24".into(),
        "-f".into(), "null".into(),
        "-".into(),
    ];

    Command::new("ffmpeg")
        .args(&args)
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("failed to spawn ffmpeg (full)")
}

async fn graceful_kill(child: &mut tokio::process::Child) {
    let Some(pid) = child.id() else { return };
    #[cfg(unix)]
    {
        use nix::{sys::signal::{kill, Signal}, unistd::Pid};
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    tokio::select! {
        _ = child.wait() => { info!("ffmpeg exited after SIGTERM"); }
        _ = sleep(Duration::from_secs(2)) => {
            warn!("ffmpeg still alive after 2 s — SIGKILL");
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
}

// ── Telemetry Parser (untouched) ──────────────────────────────────────────────

fn parse_ebur128_m(line: &str) -> Option<f32> {
    let i = line.find(" M:")?;
    let tail = line[i + 3..].trim_start();
    let end = tail.find(|c: char| c == ' ' || c == '\t').unwrap_or(tail.len());
    tail[..end].trim().parse().ok()
}

async fn parse_telemetry(
    stderr:   tokio::process::ChildStderr,
    state:    Shared,
    audio_tx: broadcast::Sender<f32>,
) {
    let mut lines = BufReader::new(stderr).lines();
    let mut kv: HashMap<String, String> = HashMap::new();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_owned();
        if line.is_empty() { continue; }
        match line.split_once('=') {
            Some((k, v)) => {
                kv.insert(k.to_owned(), v.trim().to_owned());
                if k == "progress" {
                    let mut s = state.lock().await;
                    if let Some(kb) = kv.get("bitrate")
                        .and_then(|v| v.strip_suffix("kbits/s"))
                        .and_then(|v| v.trim().parse::<f32>().ok())
                    { s.bitrate_kbps = kb; }
                    if let Ok(fps) = kv.get("fps").map(String::as_str).unwrap_or("").parse::<f32>()
                    { s.fps = fps; }
                    if let Ok(d) = kv.get("drop_frames").map(String::as_str).unwrap_or("0").parse::<u64>()
                    { s.drop_frames = d; }
                    s.refresh_uptime();
                    kv.clear();
                }
            }
            None => {
                if let Some(lufs) = parse_ebur128_m(&line) {
                    let level = ((lufs + 70.0) / 70.0).clamp(0.0, 1.0);
                    let _ = audio_tx.send(level);
                } else {
                    info!("ffmpeg: {line}");
                }
            }
        }
    }
}

// ── Telemetry Printer (untouched) ─────────────────────────────────────────────

async fn telemetry_printer(state: Shared) {
    let mut tick = interval(Duration::from_secs(10));
    tick.tick().await;
    loop {
        tick.tick().await;
        let mut s = state.lock().await;
        s.refresh_uptime();
        let snap = s.clone();
        drop(s);
        match snap.phase {
            Phase::Preview | Phase::Streaming => info!(
                phase        = format!("{:?}", snap.phase),
                bitrate_kbps = format!("{:.1}", snap.bitrate_kbps),
                fps          = format!("{:.1}", snap.fps),
                drop_frames  = snap.drop_frames,
                uptime_secs  = snap.uptime_secs,
                cpu_temp     = format!("{:.1}°C", snap.cpu_temp_celsius),
                destinations = snap.active_destinations.join(", "),
                "telemetry"
            ),
            Phase::Error => error!(
                msg = snap.error_message.as_deref().unwrap_or("unknown"),
                "in error state — POST /api/preview or /api/start to retry"
            ),
            Phase::Idle => info!("idle — POST /api/preview to begin"),
        }
    }
}

// ── WebSocket Audio (untouched) ───────────────────────────────────────────────

async fn ws_audio(ws: WebSocketUpgrade, State(ctx): State<Ctx>) -> Response {
    ws.on_upgrade(move |socket| stream_audio(socket, ctx.audio_tx.subscribe()))
}

async fn stream_audio(mut socket: WebSocket, mut rx: broadcast::Receiver<f32>) {
    loop {
        match rx.recv().await {
            Ok(level) => {
                if socket.send(Message::Text(format!("{level:.4}").into())).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

// ── HLS File Server (untouched) ───────────────────────────────────────────────

async fn serve_hls(Path(file): Path<String>) -> Response {
    if file.contains("..") || file.contains('/') {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = format!("{HLS_DIR}/{file}");
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let ct = if file.ends_with(".m3u8") {
                "application/vnd.apple.mpegurl"
            } else {
                "video/MP2T"
            };
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE,  HeaderValue::from_static(ct));
            headers.insert(header::CACHE_CONTROL,
                HeaderValue::from_static("no-cache, no-store, must-revalidate"));
            (headers, bytes).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────────

async fn handle_status(State(ctx): State<Ctx>) -> Response {
    let mut s = ctx.state.lock().await;
    s.refresh_uptime();
    let snap = s.clone();
    drop(s);
    Json(snap).into_response()
}

async fn handle_preview(State(ctx): State<Ctx>) -> Response {
    let phase = ctx.state.lock().await.phase.clone();
    match phase {
        Phase::Preview | Phase::Streaming =>
            (StatusCode::CONFLICT,
                Json(serde_json::json!({"error":"already active — stop first"}))).into_response(),
        _ => {
            clear_hls_dir();
            match ctx.cmd.send(Cmd::Preview).await {
                Ok(_)  => (StatusCode::ACCEPTED,
                    Json(serde_json::json!({"status":"preview starting"}))).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error":e.to_string()}))).into_response(),
            }
        }
    }
}

async fn handle_start(State(ctx): State<Ctx>) -> Response {
    if ctx.state.lock().await.phase == Phase::Streaming {
        return (StatusCode::CONFLICT,
            Json(serde_json::json!({"error":"already streaming"}))).into_response();
    }

    // Must have at least one enabled destination with a stream key before going live.
    let active_count = {
        let cfg = ctx.config.lock().await;
        cfg.active_destinations().len()
    };
    if active_count == 0 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "no enabled destinations — toggle at least one platform on and enter its stream key"
        }))).into_response();
    }

    clear_hls_dir();
    match ctx.cmd.send(Cmd::Start).await {
        Ok(_) => {
            // Best-effort: update YouTube broadcast title/description in background
            let ctx2 = ctx.clone();
            tokio::spawn(async move {
                if let Err(e) = yt_apply_session_metadata(&ctx2).await {
                    warn!("YouTube metadata update skipped: {e:#}");
                }
            });
            (StatusCode::ACCEPTED, Json(serde_json::json!({
                "status": "stream starting",
                "destinations": active_count,
            }))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":e.to_string()}))).into_response(),
    }
}

async fn handle_stop(State(ctx): State<Ctx>) -> Response {
    match ctx.state.lock().await.phase {
        Phase::Idle | Phase::Error =>
            (StatusCode::CONFLICT,
                Json(serde_json::json!({"error":"not active"}))).into_response(),
        Phase::Preview | Phase::Streaming =>
            match ctx.cmd.send(Cmd::Stop).await {
                Ok(_)  => (StatusCode::ACCEPTED,
                    Json(serde_json::json!({"status":"stopping"}))).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error":e.to_string()}))).into_response(),
            },
    }
}

async fn handle_get_config(State(ctx): State<Ctx>) -> Response {
    let cfg = ctx.config.lock().await;
    let destinations: Vec<_> = cfg.destinations.iter().map(|d| serde_json::json!({
        "id":              d.id,
        "name":            d.name,
        "rtmp_url":        d.rtmp_url,
        "stream_key_hint": d.key_hint(),
        "enabled":         d.enabled,
        "authenticated":   d.authenticated(),
        "has_credentials": d.has_credentials(),
    })).collect();
    Json(serde_json::json!({
        "srt_port":     cfg.srt_port,
        "metrics_port": cfg.metrics_port,
        "max_retries":  cfg.max_retries,
        "destinations": destinations,
    })).into_response()
}

#[derive(Deserialize)]
struct ConfigPatch {
    srt_port:    Option<u16>,
    max_retries: Option<u32>,
}

async fn handle_update_config(
    State(ctx): State<Ctx>,
    Json(patch): Json<ConfigPatch>,
) -> Response {
    let mut cfg = ctx.config.lock().await;
    if let Some(p) = patch.srt_port    { cfg.srt_port    = p; }
    if let Some(r) = patch.max_retries { cfg.max_retries = r; }

    if let Err(e) = cfg.save() {
        return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":e.to_string()}))).into_response();
    }
    info!(srt_port = cfg.srt_port, max_retries = cfg.max_retries, "config updated");
    (StatusCode::OK, Json(serde_json::json!({
        "status":      "updated — takes effect on next start",
        "srt_port":    cfg.srt_port,
        "max_retries": cfg.max_retries,
    }))).into_response()
}

// ── Destination Management ────────────────────────────────────────────────────

async fn handle_toggle_destination(
    State(ctx): State<Ctx>,
    Path(id):   Path<String>,
) -> Response {
    let mut cfg = ctx.config.lock().await;
    let Some(dest) = cfg.destinations.iter_mut().find(|d| d.id == id) else {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error":"destination not found"}))).into_response();
    };
    dest.enabled = !dest.enabled;
    let (enabled, name) = (dest.enabled, dest.name.clone());
    if let Err(e) = cfg.save() {
        return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":e.to_string()}))).into_response();
    }
    info!(destination = name, enabled = enabled, "destination toggled");
    (StatusCode::OK, Json(serde_json::json!({"id": id, "enabled": enabled}))).into_response()
}

#[derive(Deserialize)]
struct DestinationPatch {
    rtmp_url:             Option<String>,
    stream_key:           Option<String>,
    google_client_id:     Option<String>,
    google_client_secret: Option<String>,
}

async fn handle_update_destination(
    State(ctx): State<Ctx>,
    Path(id):   Path<String>,
    Json(patch): Json<DestinationPatch>,
) -> Response {
    let mut cfg = ctx.config.lock().await;
    let Some(dest) = cfg.destinations.iter_mut().find(|d| d.id == id) else {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error":"destination not found"}))).into_response();
    };
    if let Some(url) = patch.rtmp_url             { dest.rtmp_url             = url; }
    if let Some(key) = patch.stream_key           { dest.stream_key           = key; }
    if let Some(ci)  = patch.google_client_id     { dest.google_client_id     = Some(ci); }
    if let Some(cs)  = patch.google_client_secret { dest.google_client_secret = Some(cs); }
    let (hint, name, has_creds, authed) = (dest.key_hint(), dest.name.clone(), dest.has_credentials(), dest.authenticated());
    if let Err(e) = cfg.save() {
        return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":e.to_string()}))).into_response();
    }
    info!(destination = name, key_hint = hint, "destination updated");
    (StatusCode::OK, Json(serde_json::json!({
        "id":              id,
        "stream_key_hint": hint,
        "has_credentials": has_creds,
        "authenticated":   authed,
    }))).into_response()
}

// ── Session Metadata ──────────────────────────────────────────────────────────

async fn handle_get_session(State(ctx): State<Ctx>) -> Response {
    let s = ctx.session.lock().await;
    Json(serde_json::json!({
        "title":       s.title,
        "description": s.description,
    })).into_response()
}

async fn handle_set_session(
    State(ctx):  State<Ctx>,
    Json(meta):  Json<SessionMeta>,
) -> Response {
    let title = meta.title.clone();
    let desc  = meta.description.clone();
    *ctx.session.lock().await = meta;
    info!(title = ?title, description = ?desc, "session metadata updated");
    (StatusCode::OK, Json(serde_json::json!({"status":"session metadata updated"}))).into_response()
}

// ── Google OAuth Device Flow ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct DeviceCodeResp {
    device_code:               String,
    user_code:                 String,
    verification_url:          String,
    #[serde(default)]
    verification_url_complete: Option<String>,
    expires_in:                u64,
    #[serde(default = "default_interval")]
    interval:                  u64,
}
fn default_interval() -> u64 { 5 }

#[derive(Deserialize)]
struct OAuthTokenResp {
    access_token:  Option<String>,
    refresh_token: Option<String>,
    error:         Option<String>,
}

async fn handle_auth_start(
    State(ctx): State<Ctx>,
    Path(id):   Path<String>,
) -> Response {
    let (client_id, client_secret) = {
        let cfg = ctx.config.lock().await;
        let Some(dest) = cfg.destinations.iter().find(|d| d.id == id) else {
            return (StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"destination not found"}))).into_response();
        };
        if !dest.has_credentials() {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "error": "Google Client ID and Secret not configured for this destination"
            }))).into_response();
        }
        (dest.google_client_id.clone().unwrap(), dest.google_client_secret.clone().unwrap())
    };

    let resp = ctx.http
        .post("https://oauth2.googleapis.com/device/code")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", "https://www.googleapis.com/auth/youtube.force-ssl"),
        ])
        .send().await;

    match resp {
        Ok(r) if r.status().is_success() => {
            match r.json::<DeviceCodeResp>().await {
                Ok(d) => {
                    let expires = Instant::now() + std::time::Duration::from_secs(d.expires_in);
                    ctx.pending_auth.lock().await.insert(id.clone(), PendingDeviceAuth {
                        client_id,
                        client_secret,
                        device_code:  d.device_code,
                        expires_at:   expires,
                    });
                    let url = d.verification_url_complete
                        .as_deref()
                        .unwrap_or(&d.verification_url)
                        .to_owned();
                    info!(destination = id, user_code = d.user_code, "Google device auth started");
                    (StatusCode::OK, Json(serde_json::json!({
                        "user_code":        d.user_code,
                        "verification_url": url,
                        "expires_in":       d.expires_in,
                        "interval":         d.interval,
                    }))).into_response()
                }
                Err(e) => (StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({"error":format!("Google parse error: {e}")}))).into_response(),
            }
        }
        Ok(r) => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            (StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":format!("Google {status}: {body}")}))).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error":format!("request failed: {e}")}))).into_response(),
    }
}

async fn handle_auth_poll(
    State(ctx): State<Ctx>,
    Path(id):   Path<String>,
) -> Response {
    let pending = {
        let map = ctx.pending_auth.lock().await;
        match map.get(&id) {
            None => return (StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"no pending auth for this destination"}))).into_response(),
            Some(p) => p.clone(),
        }
    };

    if Instant::now() > pending.expires_at {
        ctx.pending_auth.lock().await.remove(&id);
        return (StatusCode::OK, Json(serde_json::json!({"status":"expired"}))).into_response();
    }

    let resp = ctx.http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id",     pending.client_id.as_str()),
            ("client_secret", pending.client_secret.as_str()),
            ("device_code",   pending.device_code.as_str()),
            ("grant_type",    "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send().await;

    let tok = match resp {
        Ok(r)  => r.json::<OAuthTokenResp>().await.unwrap_or_else(|_| OAuthTokenResp {
            access_token: None, refresh_token: None, error: Some("parse error".into()),
        }),
        Err(e) => return (StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error":format!("request failed: {e}")}))).into_response(),
    };

    if let Some(err) = &tok.error {
        return match err.as_str() {
            "authorization_pending" | "slow_down" =>
                (StatusCode::OK, Json(serde_json::json!({"status":"pending"}))).into_response(),
            "expired_token" | "access_denied" => {
                ctx.pending_auth.lock().await.remove(&id);
                (StatusCode::OK, Json(serde_json::json!({"status":"expired"}))).into_response()
            }
            _ => (StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":format!("Google token error: {err}")}))).into_response(),
        };
    }

    match (tok.refresh_token, tok.access_token) {
        (Some(rt), _) => {
            ctx.pending_auth.lock().await.remove(&id);
            let mut cfg = ctx.config.lock().await;
            if let Some(dest) = cfg.destinations.iter_mut().find(|d| d.id == id) {
                dest.refresh_token = Some(rt);
            }
            if let Err(e) = cfg.save() {
                return (StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error":e.to_string()}))).into_response();
            }
            info!(destination = id, "YouTube account connected");
            (StatusCode::OK, Json(serde_json::json!({"status":"authorized"}))).into_response()
        }
        _ => (StatusCode::OK, Json(serde_json::json!({"status":"pending"}))).into_response(),
    }
}

async fn handle_auth_disconnect(
    State(ctx): State<Ctx>,
    Path(id):   Path<String>,
) -> Response {
    let mut cfg = ctx.config.lock().await;
    let Some(dest) = cfg.destinations.iter_mut().find(|d| d.id == id) else {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error":"destination not found"}))).into_response();
    };
    dest.refresh_token = None;
    if let Err(e) = cfg.save() {
        return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":e.to_string()}))).into_response();
    }
    info!(destination = id, "YouTube account disconnected");
    (StatusCode::OK, Json(serde_json::json!({"status":"disconnected"}))).into_response()
}

// ── YouTube Live API ──────────────────────────────────────────────────────────

async fn yt_get_access_token(
    http:          &reqwest::Client,
    client_id:     &str,
    client_secret: &str,
    refresh_token: &str,
) -> anyhow::Result<String> {
    #[derive(Deserialize)]
    struct Resp { access_token: Option<String>, error: Option<String> }

    let resp: Resp = http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id",     client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type",    "refresh_token"),
        ])
        .send().await?
        .json().await?;

    if let Some(e) = resp.error { anyhow::bail!("token refresh: {e}"); }
    resp.access_token.ok_or_else(|| anyhow::anyhow!("no access_token in refresh response"))
}

async fn yt_update_broadcast(
    http:         &reqwest::Client,
    access_token: &str,
    title:        &str,
    description:  &str,
) -> anyhow::Result<()> {
    #[derive(Deserialize)]
    struct BroadcastList { items: Option<Vec<Broadcast>> }
    #[derive(Deserialize)]
    struct Broadcast { id: String, snippet: Snippet }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Snippet { scheduled_start_time: Option<String> }

    // Try active first (already streaming), then upcoming (pre-stream)
    let mut found: Option<(String, Option<String>)> = None;
    for status in &["active", "upcoming"] {
        let list: BroadcastList = http
            .get("https://www.googleapis.com/youtube/v3/liveBroadcasts")
            .bearer_auth(access_token)
            .query(&[("part","snippet"), ("broadcastStatus", status), ("mine","true"), ("maxResults","1")])
            .send().await?
            .error_for_status()?
            .json().await?;

        if let Some(mut items) = list.items {
            if !items.is_empty() {
                let b = items.remove(0);
                found = Some((b.id, b.snippet.scheduled_start_time));
                break;
            }
        }
    }

    let (broadcast_id, scheduled_start) = found
        .ok_or_else(|| anyhow::anyhow!("no active or upcoming YouTube broadcast found — create one in YouTube Studio first"))?;

    let mut snippet = serde_json::json!({
        "title":       title,
        "description": description,
    });
    if let Some(t) = scheduled_start {
        snippet["scheduledStartTime"] = serde_json::Value::String(t);
    }

    http.put("https://www.googleapis.com/youtube/v3/liveBroadcasts")
        .bearer_auth(access_token)
        .query(&[("part","snippet")])
        .json(&serde_json::json!({ "id": broadcast_id, "snippet": snippet }))
        .send().await?
        .error_for_status()?;

    info!(broadcast_id, title, "YouTube broadcast metadata updated");
    Ok(())
}

async fn yt_apply_session_metadata(ctx: &Ctx) -> anyhow::Result<()> {
    let (client_id, client_secret, refresh_token) = {
        let cfg = ctx.config.lock().await;
        let dest = cfg.destinations.iter()
            .find(|d| d.id == "youtube" && d.enabled && d.authenticated());
        match dest {
            None => return Ok(()), // YouTube not enabled or not authenticated — skip silently
            Some(d) => (
                d.google_client_id.clone().unwrap(),
                d.google_client_secret.clone().unwrap(),
                d.refresh_token.clone().unwrap(),
            ),
        }
    };

    let meta = ctx.session.lock().await.clone();
    let title = match &meta.title {
        Some(t) if !t.trim().is_empty() => t.trim().to_owned(),
        _ => return Ok(()), // no title set — skip silently
    };
    let desc = meta.description.as_deref().unwrap_or("").to_owned();

    let token = yt_get_access_token(&ctx.http, &client_id, &client_secret, &refresh_token).await?;
    yt_update_broadcast(&ctx.http, &token, &title, &desc).await?;
    Ok(())
}

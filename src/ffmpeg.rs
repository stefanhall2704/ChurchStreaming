use std::{collections::HashMap, sync::Arc};

use anyhow::Context;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::RwLock,
    time::{sleep, Duration},
};
use tracing::{debug, error, info, warn};

pub struct FfmpegConfig {
    pub bin: String,
    pub input: String,
}

/// Live state exposed on /healthz. All fields are reset when FFmpeg is not running.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct StreamState {
    /// FFmpeg process is alive and listening for a connection.
    pub process_running: bool,
    /// At least one progress update has been received (data is flowing).
    pub stream_active: bool,
    pub frame: u64,
    pub fps: f32,
    pub bitrate_kbps: f32,
    pub drop_frames: u64,
    pub dup_frames: u64,
    pub speed: f32,
    /// Seconds of media processed so far.
    pub stream_secs: u64,
}

/// Keeps FFmpeg alive forever, restarting on crash with a 5-second back-off.
pub async fn supervisor(state: Arc<RwLock<StreamState>>, cfg: FfmpegConfig) {
    loop {
        info!("Starting FFmpeg (input: {})", cfg.input);

        match run_ffmpeg(&cfg, state.clone()).await {
            Ok(status) => warn!("FFmpeg exited with status: {}", status),
            Err(e) => error!("FFmpeg error: {:#}", e),
        }

        {
            let mut s = state.write().await;
            *s = StreamState::default();
        }

        info!("Restarting FFmpeg in 5 s…");
        sleep(Duration::from_secs(5)).await;
    }
}

async fn run_ffmpeg(
    cfg: &FfmpegConfig,
    state: Arc<RwLock<StreamState>>,
) -> anyhow::Result<std::process::ExitStatus> {
    let mut child = Command::new(&cfg.bin)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-progress",
            "pipe:2",         // structured key=value progress → stderr
            "-re",            // read input at native frame rate (prevents buffering bursts)
            "-i",
            &cfg.input,
            "-c",
            "copy",
            "-f",
            "null",
            "-",
        ])
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("failed to spawn ffmpeg — is it installed?")?;

    state.write().await.process_running = true;

    let stderr = child.stderr.take().expect("stderr is piped");
    let mut lines = BufReader::new(stderr).lines();
    let mut progress: HashMap<String, String> = HashMap::new();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_owned();
        if line.is_empty() {
            continue;
        }

        match line.split_once('=') {
            Some((key, val)) => {
                progress.insert(key.to_owned(), val.to_owned());
                // FFmpeg flushes one block per "progress" sentinel key.
                if key == "progress" {
                    let next = parse_progress(&progress);
                    *state.write().await = next;
                    progress.clear();
                }
            }
            // Non key=value line — an FFmpeg log/error message.
            None => debug!("ffmpeg stderr: {}", line),
        }
    }

    Ok(child.wait().await?)
}

fn parse_progress(p: &HashMap<String, String>) -> StreamState {
    StreamState {
        process_running: true,
        stream_active: true,
        frame: parse_u64(p, "frame"),
        fps: parse_f32(p, "fps"),
        bitrate_kbps: p
            .get("bitrate")
            .and_then(|v| {
                let v = v.trim();
                if v == "N/A" {
                    return None;
                }
                v.strip_suffix("kbits/s")?.parse().ok()
            })
            .unwrap_or(0.0),
        drop_frames: parse_u64(p, "drop_frames"),
        dup_frames: parse_u64(p, "dup_frames"),
        speed: p
            .get("speed")
            .and_then(|v| {
                let v = v.trim();
                if v == "N/A" {
                    return None;
                }
                v.strip_suffix('x')?.parse().ok()
            })
            .unwrap_or(0.0),
        stream_secs: p
            .get("out_time_ms")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(|ms| ms / 1_000_000) // FFmpeg reports microseconds despite the "ms" key name
            .unwrap_or(0),
    }
}

fn parse_u64(p: &HashMap<String, String>, key: &str) -> u64 {
    p.get(key)
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

fn parse_f32(p: &HashMap<String, String>, key: &str) -> f32 {
    p.get(key)
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0.0)
}

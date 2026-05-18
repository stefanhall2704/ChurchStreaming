mod ffmpeg;
mod health;

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

pub struct Config {
    pub srt_input: String,
    pub health_addr: String,
    pub ffmpeg_bin: String,
}

impl Config {
    fn from_env() -> Self {
        Self {
            srt_input: std::env::var("SRT_INPUT")
                .unwrap_or_else(|_| "srt://0.0.0.0:4242?mode=listener".into()),
            health_addr: std::env::var("HEALTH_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:3000".into()),
            ffmpeg_bin: std::env::var("FFMPEG_BIN").unwrap_or_else(|_| "ffmpeg".into()),
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("church_streamer=debug".parse().unwrap()),
        )
        .init();

    let config = Config::from_env();
    info!("SRT input:       {}", config.srt_input);
    info!("Health endpoint: http://{}/healthz", config.health_addr);

    let state = Arc::new(RwLock::new(ffmpeg::StreamState::default()));

    let ffmpeg_state = state.clone();
    let ffmpeg_cfg = ffmpeg::FfmpegConfig {
        bin: config.ffmpeg_bin,
        input: config.srt_input,
    };

    tokio::spawn(async move {
        ffmpeg::supervisor(ffmpeg_state, ffmpeg_cfg).await;
    });

    health::serve(state, &config.health_addr).await;
}

use std::sync::Arc;

use axum::{extract::State, routing::get, Json, Router};
use tokio::sync::RwLock;
use tracing::info;

use crate::ffmpeg::StreamState;

pub async fn serve(state: Arc<RwLock<StreamState>>, addr: &str) {
    let app = Router::new()
        .route("/healthz", get(healthz))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind to {addr}: {e}"));

    info!("Health server listening on http://{addr}/healthz");
    axum::serve(listener, app).await.unwrap();
}

async fn healthz(State(state): State<Arc<RwLock<StreamState>>>) -> Json<StreamState> {
    Json(state.read().await.clone())
}

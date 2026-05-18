PI_HOST ?= pi@churchpi.local
TARGET  := aarch64-unknown-linux-gnu
BIN     := church-streamer
DEST    := /home/pi/church-streamer/

.PHONY: build deploy dev check fmt add-target install-cross

# ── Local dev ──────────────────────────────────────────────────────────────────

dev:
	cargo run

check:
	cargo clippy -- -D warnings

fmt:
	cargo fmt

# ── Cross-compile for Pi ───────────────────────────────────────────────────────

build: add-target
	cross build --release --target $(TARGET)

# ── Deploy to Pi ───────────────────────────────────────────────────────────────

deploy: build
	ssh $(PI_HOST) "mkdir -p $(DEST)"
	rsync -avz --progress \
		target/$(TARGET)/release/$(BIN) \
		$(PI_HOST):$(DEST)$(BIN)
	ssh $(PI_HOST) "chmod +x $(DEST)$(BIN)"
	@echo "Deployed. Run with: ssh $(PI_HOST) $(DEST)$(BIN)"

# ── One-time setup ─────────────────────────────────────────────────────────────

add-target:
	rustup target add $(TARGET)

install-cross:
	cargo install cross --git https://github.com/cross-rs/cross

.DEFAULT_GOAL := build

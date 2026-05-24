import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import type { Phase } from '../types'

interface Props {
  phase: Phase
}

export function VideoPreview({ phase }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef   = useRef<Hls | null>(null)
  const [hlsReady, setHlsReady] = useState(false)

  const active = phase === 'streaming' || phase === 'preview'

  // Poll /hls/stream.m3u8 with plain fetch() until it returns 200.
  // Only then start HLS.js — this prevents the 404 retry storm that happens
  // when OBS hasn't connected yet or FFmpeg is still writing the first segment.
  useEffect(() => {
    if (!active) { setHlsReady(false); return }

    setHlsReady(false)
    let cancelled = false

    ;(async () => {
      while (!cancelled) {
        try {
          const r = await fetch(`/hls/stream.m3u8?_=${Date.now()}`, { cache: 'no-store' })
          if (r.ok) { if (!cancelled) setHlsReady(true); return }
        } catch { /* network error — keep polling */ }
        await new Promise<void>(res => setTimeout(res, 2000))
      }
    })()

    return () => { cancelled = true }
  }, [active])

  // Start HLS.js only once the manifest is confirmed available.
  useEffect(() => {
    if (!hlsReady) {
      hlsRef.current?.destroy()
      hlsRef.current = null
      return
    }

    const video = videoRef.current
    if (!video) return

    if (!Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = '/hls/stream.m3u8'
        video.play().catch(() => {})
      }
      return
    }

    const hlsUrl = () => `/hls/stream.m3u8?_=${Date.now()}`

    const hls = new Hls({
      liveSyncDurationCount:       2,
      liveMaxLatencyDurationCount: 4,
      startPosition:               -1,
      manifestLoadingMaxRetry:     10,
      manifestLoadingRetryDelay:   1500,
      levelLoadingMaxRetry:        6,
    })

    // Track when we last reattached so the watchdog doesn't interrupt
    // HLS.js's own manifest retry sequence (10 retries × 1.5 s = 15 s).
    let lastReattach = 0
    const reattach = () => {
      lastReattach = Date.now()
      hls.detachMedia()
      hls.loadSource(hlsUrl())
      hls.attachMedia(video)
    }

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        setTimeout(reattach, 2000)
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError()
      } else {
        setTimeout(reattach, 3000)
      }
    })

    // EXT-X-ENDLIST received — MediaSource is ended; reattach to get a fresh one.
    hls.on(Hls.Events.BUFFER_EOS, () => { setTimeout(reattach, 2000) })
    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}) })

    // Jump to buffered live edge when the browser fires 'stalled'.
    const onStalled = () => {
      const buf = video.buffered
      if (buf.length > 0) video.currentTime = Math.max(buf.end(buf.length - 1) - 0.1, 0)
      video.play().catch(() => {})
    }
    video.addEventListener('stalled', onStalled)

    hls.loadSource(hlsUrl())
    hls.attachMedia(video)
    hlsRef.current = hls

    // Stall watchdog — runs every 3 s. Backs off 15 s after each reattach so
    // HLS.js has time to complete its natural manifest retry sequence.
    let lastTime  = -1
    let stallTick = 0
    const tryRecover = () => {
      const buf = video.buffered
      if (buf.length > 0) {
        video.currentTime = Math.max(buf.end(buf.length - 1) - 0.1, 0)
      } else {
        const edge = (hls as any).liveSyncPosition as number | null
        if (edge != null) video.currentTime = edge
      }
      video.play().catch(() => {})
    }

    const watchdog = window.setInterval(() => {
      if (Date.now() - lastReattach < 15_000) return

      if (video.ended) {
        reattach(); lastTime = -1; stallTick = 0; return
      }
      if (video.paused) {
        stallTick++
        video.play().catch(() => {})
        if (stallTick >= 2) { reattach(); lastTime = -1; stallTick = 0 }
        return
      }
      if (video.currentTime === lastTime) {
        stallTick++
        if (stallTick >= 2) {
          reattach(); lastTime = -1; stallTick = 0
        } else {
          tryRecover()
        }
      } else {
        stallTick = 0
        lastTime  = video.currentTime
      }
    }, 3000)

    return () => {
      clearInterval(watchdog)
      video.removeEventListener('stalled', onStalled)
      hls.destroy()
      hlsRef.current = null
    }
  }, [hlsReady])

  return (
    <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
      <div className="px-4 pt-3 pb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Live Preview
        </h3>
        {active && (
          <span className="text-xs text-zinc-500">
            {phase === 'preview' ? 'Preview only · not live' : 'Live · ~3 s delay'}
          </span>
        )}
      </div>
      {!active ? (
        <div className="aspect-video flex items-center justify-center text-zinc-600 text-sm bg-zinc-950">
          Waiting for stream…
        </div>
      ) : !hlsReady ? (
        <div className="aspect-video flex items-center justify-center bg-zinc-950 flex-col gap-2">
          <div className="text-zinc-500 text-sm">Waiting for OBS…</div>
          <div className="text-zinc-700 text-xs">Start streaming in OBS to begin preview</div>
        </div>
      ) : (
        <video
          ref={videoRef}
          className="w-full aspect-video bg-black"
          muted
          autoPlay
          playsInline
        />
      )}
    </div>
  )
}

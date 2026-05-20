import { useEffect, useRef } from 'react'
import Hls from 'hls.js'
import type { Phase } from '../types'

interface Props {
  phase: Phase
}

export function VideoPreview({ phase }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef   = useRef<Hls | null>(null)

  const active = phase === 'streaming' || phase === 'preview'

  useEffect(() => {
    if (!active) {
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
      startPosition:               -1,   // always join at live edge
      manifestLoadingMaxRetry:     10,
      manifestLoadingRetryDelay:   1500,
      levelLoadingMaxRetry:        6,
    })

    const reload = () => {
      hls.loadSource(hlsUrl())
      hls.startLoad(-1)   // -1 = live edge; 0 would restart from playlist beginning
    }

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // m3u8 not ready yet or gap during FFmpeg restart — keep retrying
        setTimeout(reload, 2000)
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError()
      } else {
        // Unrecoverable — full reload after delay
        setTimeout(reload, 3000)
      }
    })

    // FFmpeg exited and wrote #EXT-X-ENDLIST — hls.js stops polling after this.
    // Force a reload so we pick up the next FFmpeg session's segments.
    hls.on(Hls.Events.BUFFER_EOS, () => { setTimeout(reload, 2000) })

    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}) })
    hls.loadSource(hlsUrl())
    hls.attachMedia(video)
    hlsRef.current = hls

    // Stall watchdog: if currentTime hasn't moved in 3 s while "playing",
    // the decoder is frozen — snap back to the live edge and resume.
    let lastTime = -1
    const watchdog = window.setInterval(() => {
      if (video.paused || video.ended) return
      if (video.currentTime === lastTime) {
        const liveEdge = (hls as any).liveSyncPosition ?? null
        if (liveEdge !== null) video.currentTime = liveEdge
        video.play().catch(() => {})
      }
      lastTime = video.currentTime
    }, 3000)

    return () => {
      clearInterval(watchdog)
      hls.destroy()
      hlsRef.current = null
    }
  }, [active])

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

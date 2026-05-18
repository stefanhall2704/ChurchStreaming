import { useEffect, useRef, useState } from 'react'
import type { Phase } from '../types'

const NUM_BARS = 14
const BAR_HEIGHT_PX = 72  // matches h-[72px] container
const MIN_BAR_PX    = 4   // always visible baseline

const BAR_CFG = Array.from({ length: NUM_BARS }, (_, i) => {
  const x = i / (NUM_BARS - 1)
  return {
    boost:   0.55 + 0.9 * Math.sin(x * Math.PI),
    attack:  0.35 + (i % 3) * 0.08,
    release: 0.06 + (i % 5) * 0.02,
  }
})

function barColor(level: number): string {
  if (level > 0.82) return '#ef4444'
  if (level > 0.55) return '#eab308'
  return '#22c55e'
}

type WsStatus = 'connecting' | 'connected' | 'error' | 'closed'

interface Props { phase: Phase }

export function AudioEqualizer({ phase }: Props) {
  const [bars, setBars]       = useState<number[]>(Array(NUM_BARS).fill(0))
  const [wsStatus, setStatus] = useState<WsStatus>('closed')
  const wsRef                 = useRef<WebSocket | null>(null)
  const targetRef             = useRef<number[]>(Array(NUM_BARS).fill(0))
  const rafRef                = useRef<number>(0)

  useEffect(() => {
    if (phase !== 'streaming' && phase !== 'preview') {
      wsRef.current?.close()
      wsRef.current = null
      cancelAnimationFrame(rafRef.current)
      targetRef.current = Array(NUM_BARS).fill(0)
      setBars(Array(NUM_BARS).fill(0))
      setStatus('closed')
      return
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws    = new WebSocket(`${proto}://${location.host}/ws`)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen    = () => setStatus('connected')
    ws.onerror   = () => setStatus('error')
    ws.onclose   = () => setStatus('closed')

    ws.onmessage = (e) => {
      const raw = parseFloat(e.data)
      if (isNaN(raw)) return
      BAR_CFG.forEach((cfg, i) => {
        targetRef.current[i] = Math.min(1, raw * cfg.boost)
      })
    }

    const animate = () => {
      setBars(prev => prev.map((bar, i) => {
        const target = targetRef.current[i]
        const cfg    = BAR_CFG[i]
        const rate   = bar < target ? cfg.attack : cfg.release
        return Math.max(0, Math.min(1, bar + (target - bar) * rate))
      }))
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)

    return () => {
      ws.close()
      cancelAnimationFrame(rafRef.current)
    }
  }, [phase])

  const isActive = phase === 'streaming' || phase === 'preview'

  const statusDot: Record<WsStatus, string> = {
    connecting: 'text-yellow-400',
    connected:  'text-green-400',
    error:      'text-red-400',
    closed:     'text-zinc-600',
  }
  const statusLabel: Record<WsStatus, string> = {
    connecting: 'connecting…',
    connected:  'live',
    error:      'ws error',
    closed:     'off',
  }

  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Audio Level
        </h3>
        {isActive && (
          <span className={`text-xs font-mono ${statusDot[wsStatus]}`}>
            ● {statusLabel[wsStatus]}
          </span>
        )}
      </div>

      <div className="flex items-end gap-0.5" style={{ height: `${BAR_HEIGHT_PX}px` }}>
        {bars.map((level, i) => {
          const px = Math.max(MIN_BAR_PX, level * BAR_HEIGHT_PX)
          return (
            <div
              key={i}
              className="flex-1 rounded-sm transition-colors duration-100"
              style={{
                height:          `${px}px`,
                backgroundColor: isActive ? barColor(level) : '#3f3f46',
              }}
            />
          )
        })}
      </div>

      {!isActive && (
        <p className="text-xs text-zinc-600 text-center mt-2">Waiting for stream…</p>
      )}
    </div>
  )
}

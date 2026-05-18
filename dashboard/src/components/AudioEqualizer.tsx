import { useEffect, useRef, useState } from 'react'
import type { Phase } from '../types'

const NUM_BARS = 14

// Per-bar multiplier + smoothing shape to simulate different "frequency bands"
const BAR_CFG = Array.from({ length: NUM_BARS }, (_, i) => {
  const x = i / (NUM_BARS - 1)
  return {
    boost:     0.55 + 0.9 * Math.sin(x * Math.PI),   // centre bands are louder
    attack:    0.35 + (i % 3) * 0.08,                  // faster attack variation
    release:   0.06 + (i % 5) * 0.02,                  // slower release variation
  }
})

function barColor(level: number): string {
  if (level > 0.82) return '#ef4444'  // red
  if (level > 0.55) return '#eab308'  // yellow
  return '#22c55e'                     // green
}

interface Props { phase: Phase }

export function AudioEqualizer({ phase }: Props) {
  const [bars, setBars]   = useState<number[]>(Array(NUM_BARS).fill(0))
  const wsRef             = useRef<WebSocket | null>(null)
  const targetRef         = useRef<number[]>(Array(NUM_BARS).fill(0))
  const rafRef            = useRef<number>(0)

  useEffect(() => {
    if (phase !== 'streaming' && phase !== 'preview') {
      wsRef.current?.close()
      wsRef.current = null
      cancelAnimationFrame(rafRef.current)
      targetRef.current = Array(NUM_BARS).fill(0)
      setBars(Array(NUM_BARS).fill(0))
      return
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws    = new WebSocket(`${proto}://${location.host}/ws`)
    wsRef.current = ws

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

  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Audio Level
      </h3>

      <div className="flex items-end gap-0.5 h-[72px]">
        {bars.map((level, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm"
            style={{
              height:          `${Math.max(3, level * 100)}%`,
              backgroundColor: isActive ? barColor(level) : '#3f3f46',
              transition:      'background-color 0.1s',
            }}
          />
        ))}
      </div>

      {!isActive && (
        <p className="text-xs text-zinc-600 text-center mt-2">Waiting for stream…</p>
      )}
    </div>
  )
}

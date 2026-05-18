import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { TelemetryPoint } from './types'
import { StatusBadge }    from './components/StatusBadge'
import { TelemetryChart }  from './components/TelemetryChart'
import { ActionButtons }   from './components/ActionButtons'
import { ThermalMonitor }  from './components/ThermalMonitor'
import { ConfigEditor }      from './components/ConfigEditor'
import { DestinationsPanel } from './components/DestinationsPanel'
import { VideoPreview }      from './components/VideoPreview'
import { AudioEqualizer }    from './components/AudioEqualizer'

const MAX_POINTS = 30  // 60 s at 2 s interval

function fmtTime(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
}

export default function App() {
  const { data: status, isError } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 2000,
    staleTime: 1000,
  })

  // Rolling telemetry buffer
  const bufRef = useRef<TelemetryPoint[]>([])
  const [history, setHistory] = useState<TelemetryPoint[]>([])

  useEffect(() => {
    if (!status) return
    if (status.phase !== 'streaming' && status.phase !== 'preview') { bufRef.current = []; setHistory([]); return }
    const now = Date.now()
    const point: TelemetryPoint = {
      t: now,
      label: new Date(now).toLocaleTimeString('en-US', { hour12: false }),
      bitrate: status.bitrate_kbps,
      fps: status.fps,
    }
    bufRef.current = [...bufRef.current.slice(-(MAX_POINTS - 1)), point]
    setHistory([...bufRef.current])
  }, [status])

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100 tracking-tight">
            Stream Bridge
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">100.116.183.59 · Pi Zero W2</p>
        </div>
        <StatusBadge phase={status?.phase ?? 'idle'} />
      </header>

      {/* Error banner */}
      {status?.phase === 'error' && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm">
          <span className="font-semibold">Error: </span>{status.error_message ?? 'unknown'}
          <span className="text-zinc-400 ml-2">— POST /api/start to retry</span>
        </div>
      )}
      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          Cannot reach Pi — check Tailscale connection
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <TelemetryChart
          title="Bitrate"
          unit="kbps"
          dataKey="bitrate"
          color="#22c55e"
          gradientId="grad-bitrate"
          domain={[0, 8000]}
          history={history}
          current={status?.bitrate_kbps ?? 0}
        />
        <TelemetryChart
          title="FPS"
          unit="fps"
          dataKey="fps"
          color="#3b82f6"
          gradientId="grad-fps"
          domain={[0, 90]}
          history={history}
          current={status?.fps ?? 0}
        />
      </div>

      {/* Preview + Audio row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2">
          <VideoPreview phase={status?.phase ?? 'idle'} />
        </div>
        <AudioEqualizer phase={status?.phase ?? 'idle'} />
      </div>

      {/* Controls row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <ActionButtons
          phase={status?.phase ?? 'idle'}
          uptime={fmtTime(status?.uptime_secs ?? 0)}
          drops={status?.drop_frames ?? 0}
          retries={status?.retry_count ?? 0}
        />
        <ThermalMonitor temp={status?.cpu_temp_celsius ?? 0} />
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Stream Stats
          </h3>
          <Stat label="Uptime"         value={fmtTime(status?.uptime_secs ?? 0)} mono />
          <Stat label="Dropped Frames" value={String(status?.drop_frames ?? 0)}
                danger={(status?.drop_frames ?? 0) > 0} mono />
          <Stat label="Retries"        value={String(status?.retry_count ?? 0)}
                danger={(status?.retry_count ?? 0) > 0} mono />
          <Stat label="Phase"          value={status?.phase ?? 'idle'} />
        </div>
      </div>

      {/* Destinations + Settings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <DestinationsPanel />
        <ConfigEditor />
      </div>
    </div>
  )
}

function Stat({ label, value, mono, danger }: {
  label: string; value: string; mono?: boolean; danger?: boolean
}) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${danger ? 'text-red-400' : 'text-zinc-200'}`}>
        {value}
      </span>
    </div>
  )
}

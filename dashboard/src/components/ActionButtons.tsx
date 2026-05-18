import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import type { Phase } from '../types'
import { StreamSetupModal } from './StreamSetupModal'

interface Props {
  phase:   Phase
  uptime:  string
  drops:   number
  retries: number
}

export function ActionButtons({ phase }: Props) {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['status'] })

  const [showSetup, setShowSetup] = useState(false)

  const { mutate: preview, isPending: previewing, error: previewErr } = useMutation({
    mutationFn: api.preview, onSuccess: invalidate,
  })
  const { mutate: stop, isPending: stopping, error: stopErr } = useMutation({
    mutationFn: api.stop, onSuccess: invalidate,
  })

  const isIdle       = phase === 'idle' || phase === 'error'
  const isPreviewing = phase === 'preview'
  const isStreaming  = phase === 'streaming'
  const isActive     = isPreviewing || isStreaming

  const err = (previewErr ?? stopErr) as Error | null

  return (
    <>
      <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 flex flex-col gap-3">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Controls
        </h3>

        {/* Preview Stream — no auth or title check */}
        <button
          onClick={() => preview()}
          disabled={!isIdle || previewing}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg
                     font-semibold text-sm transition-all duration-150
                     bg-indigo-600 hover:bg-indigo-500 active:scale-95
                     disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
        >
          {previewing
            ? <span className="animate-spin text-base">⟳</span>
            : <span>◉</span>}
          {previewing ? 'Starting preview…' : 'Preview Stream'}
        </button>

        {/* Go Live — always opens setup modal for title + key verification */}
        <button
          onClick={() => setShowSetup(true)}
          disabled={isStreaming || isIdle}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg
                     font-semibold text-sm transition-all duration-150
                     bg-green-600 hover:bg-green-500 active:scale-95
                     disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
        >
          <span>▶</span>
          Start Stream
        </button>

        {/* Stop */}
        <button
          onClick={() => stop()}
          disabled={!isActive || stopping}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg
                     font-semibold text-sm transition-all duration-150
                     bg-red-700 hover:bg-red-600 active:scale-95
                     disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
        >
          {stopping
            ? <span className="animate-spin text-base">⟳</span>
            : <span>■</span>}
          {stopping ? 'Stopping…' : isPreviewing ? 'Stop Preview' : 'Stop Stream'}
        </button>

        {err && (
          <p className="text-xs text-red-400 text-center">{err.message}</p>
        )}

        {isPreviewing && (
          <p className="text-xs text-yellow-500/80 text-center leading-tight">
            Preview only — not streaming live
          </p>
        )}
      </div>

      {showSetup && (
        <StreamSetupModal
          onSuccess={() => { setShowSetup(false); invalidate() }}
          onCancel={() => setShowSetup(false)}
        />
      )}
    </>
  )
}

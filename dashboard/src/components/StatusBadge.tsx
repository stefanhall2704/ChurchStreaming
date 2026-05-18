import type { Phase } from '../types'

const cfg: Record<Phase, { dot: string; ring: string; label: string }> = {
  idle:      { dot: 'bg-zinc-500',              ring: 'ring-zinc-700',   label: 'Idle'      },
  preview:   { dot: 'bg-yellow-400 animate-pulse', ring: 'ring-yellow-800', label: 'Preview'   },
  streaming: { dot: 'bg-green-500 animate-ping',   ring: 'ring-green-800',  label: 'Live'      },
  error:     { dot: 'bg-red-500',               ring: 'ring-red-900',    label: 'Error'     },
}

export function StatusBadge({ phase }: { phase: Phase }) {
  const { dot, ring, label } = cfg[phase]
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full
                     bg-zinc-900 border border-zinc-800 ring-2 ${ring}`}>
      <span className="relative flex h-2.5 w-2.5">
        {phase === 'streaming' && (
          <span className="animate-ping absolute inline-flex h-full w-full
                           rounded-full bg-green-400 opacity-75" />
        )}
        <span className={`relative inline-flex rounded-full h-2.5 w-2.5
                          ${dot.replace('animate-ping','').replace('animate-pulse','')}`} />
      </span>
      <span className="text-sm font-semibold text-zinc-200">{label}</span>
    </div>
  )
}

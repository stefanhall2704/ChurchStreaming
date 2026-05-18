import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'

export function ConfigEditor() {
  const qc = useQueryClient()
  const { data: cfg, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: api.config,
    staleTime: 30_000,
  })

  const [srtPort,  setSrtPort]  = useState('')
  const [maxRetry, setMaxRetry] = useState('')
  const [saved,    setSaved]    = useState(false)

  const { mutate: update, isPending, error } = useMutation({
    mutationFn: () => {
      const patch: Parameters<typeof api.updateConfig>[0] = {}
      if (srtPort.trim())  patch.srt_port    = Number(srtPort)
      if (maxRetry.trim()) patch.max_retries = Number(maxRetry)
      return api.updateConfig(patch)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] })
      setSrtPort(''); setMaxRetry('')
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    },
  })

  const hasChanges = srtPort.trim() || maxRetry.trim()

  return (
    <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Settings
      </h3>

      {isLoading ? (
        <p className="text-sm text-zinc-600">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field
            label="SRT Port"
            hint={`current: ${cfg?.srt_port ?? '—'}`}
            placeholder={String(cfg?.srt_port ?? 4242)}
            value={srtPort}
            onChange={setSrtPort}
          />
          <Field
            label="Max Retries"
            hint={`current: ${cfg?.max_retries ?? '—'}`}
            placeholder={String(cfg?.max_retries ?? 3)}
            value={maxRetry}
            onChange={setMaxRetry}
          />
        </div>
      )}

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={() => update()}
          disabled={!hasChanges || isPending}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150
                     bg-indigo-600 hover:bg-indigo-500 active:scale-95
                     disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
        >
          {isPending ? 'Saving…' : 'Save Changes'}
        </button>

        {saved && (
          <span className="text-sm text-green-400">
            Saved — takes effect on next Start
          </span>
        )}
        {error && (
          <span className="text-sm text-red-400">
            {(error as Error).message}
          </span>
        )}
      </div>

      <p className="text-xs text-zinc-700 mt-3">
        Changes are persisted to <code className="text-zinc-500">config.json</code> on the Pi
        and take effect when you next click Start Stream.
      </p>
    </div>
  )
}

function Field({
  label, hint, placeholder, type = 'text', value, onChange,
}: {
  label: string; hint: string; placeholder: string;
  type?: string; value: string; onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-zinc-300">{label}</label>
      <p className="text-xs text-zinc-600">{hint}</p>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2
                   text-sm text-zinc-200 placeholder:text-zinc-600
                   focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                   transition-all"
      />
    </div>
  )
}

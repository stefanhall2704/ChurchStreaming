import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import type { Destination } from '../types'

interface Props {
  onSuccess: () => void
  onCancel:  () => void
}

const PLATFORM: Record<string, { steps: string[]; url: string; urlLabel: string }> = {
  youtube: {
    steps: [
      'Open YouTube Studio',
      'Click "Create" → "Go Live"',
      'Under the "Stream" tab, copy the Stream Key',
    ],
    url:      'https://studio.youtube.com',
    urlLabel: 'Open YouTube Studio',
  },
  facebook: {
    steps: [
      'Open Facebook Live Producer',
      'Click "Create Live Video"',
      'Choose "Use stream key" — copy the Stream Key shown',
    ],
    url:      'https://www.facebook.com/live/producer',
    urlLabel: 'Open Facebook Live Producer',
  },
  rumble: {
    steps: [
      'Open your Rumble account dashboard',
      'Navigate to Live Streaming settings',
      'Create or select a live event, then copy the Stream Key',
    ],
    url:      'https://rumble.com/account/live-streaming',
    urlLabel: 'Open Rumble Dashboard',
  },
}

export function StreamSetupModal({ onSuccess, onCancel }: Props) {
  const qc = useQueryClient()

  // Stream metadata
  const [title,       setTitle]       = useState('')
  const [description, setDescription] = useState('')

  // Destination key fields
  const [pendingKeys, setPendingKeys] = useState<Record<string, string>>({})
  const [justSaved,   setJustSaved]   = useState<Record<string, boolean>>({})

  const { data: cfg, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn:  api.config,
    staleTime: 0,
  })

  const { mutate: saveKey, isPending: savingKey } = useMutation({
    mutationFn: ({ id, key }: { id: string; key: string }) =>
      api.updateDestination(id, { stream_key: key }),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['config'] })
      setJustSaved(s => ({ ...s, [id]: true }))
      setPendingKeys(k => ({ ...k, [id]: '' }))
      setTimeout(() => setJustSaved(s => ({ ...s, [id]: false })), 2000)
    },
  })

  const { mutate: startStream, isPending: starting, error: startError } = useMutation({
    mutationFn: async () => {
      await api.setSession({ title: title.trim(), description: description.trim() || undefined })
      return api.start()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['status'] })
      onSuccess()
    },
  })

  if (isLoading || !cfg) {
    return (
      <Backdrop onDismiss={onCancel}>
        <div className="text-zinc-400 text-sm p-8">Loading…</div>
      </Backdrop>
    )
  }

  const enabled  = cfg.destinations.filter(d => d.enabled)
  const needsKey = (d: Destination) => d.stream_key_hint === '(no key)'
  const missing  = enabled.filter(needsKey)
  const allReady = missing.length === 0 && title.trim().length > 0

  return (
    <Backdrop onDismiss={onCancel}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4
                   flex flex-col max-h-[90vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Go Live</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Fill in stream details and confirm destinations before broadcasting.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-zinc-500 hover:text-zinc-300 text-2xl leading-none ml-4 transition-colors"
          >
            ×
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 flex flex-col gap-6">

          {/* ── Stream Info ── */}
          <section className="flex flex-col gap-3">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Stream Info
            </p>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-300">
                Title <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Sunday Morning Service — May 18"
                maxLength={150}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2
                           text-sm text-zinc-200 placeholder:text-zinc-600
                           focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                           transition-all"
              />
              {title.trim().length === 0 && (
                <p className="text-xs text-yellow-500/80">A title is required before going live.</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-300">
                Description <span className="text-zinc-600 font-normal">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Weekly service, scripture, announcements…"
                rows={3}
                maxLength={500}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2
                           text-sm text-zinc-200 placeholder:text-zinc-600 resize-none
                           focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                           transition-all"
              />
            </div>
          </section>

          {/* ── Destination status ── */}
          <section className="flex flex-col gap-3">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Destinations
            </p>
            {enabled.length === 0 ? (
              <p className="text-xs text-yellow-400">No destinations enabled. Toggle at least one platform on.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {enabled.map(d => (
                  <div key={d.id} className="flex items-center justify-between py-1.5 border-b border-zinc-800/60 last:border-0">
                    <div className="flex items-center gap-2 text-sm">
                      <PlatformIcon id={d.id} />
                      <span className="text-zinc-200 font-medium">{d.name}</span>
                      {!needsKey(d) && (
                        <span className="text-xs text-zinc-500 font-mono">{d.stream_key_hint}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {(d.id === 'youtube' || d.id === 'facebook') && (
                        d.authenticated
                          ? <span className="text-xs text-green-400">● title sync on</span>
                          : <span className="text-xs text-zinc-600">○ title sync off</span>
                      )}
                      {needsKey(d)
                        ? <span className="text-xs font-semibold text-yellow-400">⚠ needs key</span>
                        : justSaved[d.id]
                          ? <span className="text-xs font-semibold text-green-400">✓ saved</span>
                          : <span className="text-xs font-semibold text-green-400">✓ ready</span>
                      }
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Setup forms for missing keys ── */}
          {missing.length > 0 && (
            <section className="flex flex-col gap-4">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                Setup Required
              </p>
              {missing.map(d => (
                <DestSetup
                  key={d.id}
                  dest={d}
                  keyValue={pendingKeys[d.id] ?? ''}
                  onKeyChange={v => setPendingKeys(k => ({ ...k, [d.id]: v }))}
                  onSave={() => saveKey({ id: d.id, key: pendingKeys[d.id]?.trim() ?? '' })}
                  saving={savingKey}
                />
              ))}
            </section>
          )}

          {/* Start error */}
          {startError && (
            <div className="p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-xs leading-relaxed">
              <span className="font-semibold">Stream failed: </span>
              {(startError as Error).message}
              <p className="text-red-400/70 mt-1">Update the stream key above and try again.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 flex items-center justify-between gap-3 flex-shrink-0">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200
                       border border-zinc-700 hover:border-zinc-500 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={() => startStream()}
            disabled={!allReady || starting}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold
                       transition-all duration-150 active:scale-95
                       bg-green-600 hover:bg-green-500
                       disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
            title={!title.trim() ? 'Enter a stream title first' : !allReady ? 'Set up all destination keys first' : ''}
          >
            {starting
              ? <><SpinIcon /> Going live…</>
              : <><span>▶</span> Start Streaming</>
            }
          </button>
        </div>
      </div>
    </Backdrop>
  )
}

function DestSetup({
  dest, keyValue, onKeyChange, onSave, saving,
}: {
  dest:        Destination
  keyValue:    string
  onKeyChange: (v: string) => void
  onSave:      () => void
  saving:      boolean
}) {
  const info = PLATFORM[dest.id]

  return (
    <div className="bg-zinc-800/60 border border-zinc-700/60 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <PlatformIcon id={dest.id} />
        <span className="text-sm font-semibold text-zinc-100">{dest.name}</span>
      </div>

      {info ? (
        <>
          <ol className="text-xs text-zinc-400 list-decimal list-inside space-y-1.5 ml-1">
            {info.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          <a
            href={info.url}
            target="_blank"
            rel="noreferrer"
            className="self-start text-xs text-indigo-400 hover:text-indigo-300
                       underline underline-offset-2 transition-colors"
          >
            {info.urlLabel} →
          </a>
        </>
      ) : (
        <p className="text-xs text-zinc-500">
          Obtain the RTMP stream key from this platform's live dashboard.
        </p>
      )}

      <div className="flex gap-2 mt-1">
        <input
          type="password"
          value={keyValue}
          onChange={e => onKeyChange(e.target.value)}
          placeholder="Paste stream key here…"
          className="flex-1 bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2
                     text-sm text-zinc-200 placeholder:text-zinc-500
                     focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        <button
          onClick={onSave}
          disabled={!keyValue.trim() || saving}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-all active:scale-95
                     bg-indigo-600 hover:bg-indigo-500
                     disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed"
        >
          {saving ? '…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function Backdrop({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onDismiss}
    >
      {children}
    </div>
  )
}

function PlatformIcon({ id }: { id: string }) {
  const icons:  Record<string, string> = { youtube: '▶', facebook: 'f', rumble: 'R' }
  const colors: Record<string, string> = {
    youtube:  'text-red-500',
    facebook: 'text-blue-500',
    rumble:   'text-green-500',
  }
  return (
    <span className={`text-xs font-bold w-4 text-center ${colors[id] ?? 'text-zinc-400'}`}>
      {icons[id] ?? '•'}
    </span>
  )
}

function SpinIcon() {
  return <span className="inline-block animate-spin text-base">⟳</span>
}

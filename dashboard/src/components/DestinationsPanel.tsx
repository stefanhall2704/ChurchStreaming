import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import type { Destination } from '../types'

export function DestinationsPanel() {
  const qc = useQueryClient()
  const { data: cfg, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn:  api.config,
    staleTime: 30_000,
  })

  const { mutate: toggle } = useMutation({
    mutationFn: (id: string) => api.toggleDestination(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['config'] }),
  })

  if (isLoading) {
    return (
      <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
        <p className="text-sm text-zinc-600">Loading…</p>
      </div>
    )
  }

  return (
    <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Destinations
      </h3>
      <div className="flex flex-col gap-3">
        {(cfg?.destinations ?? []).map(dest => (
          <DestinationRow
            key={dest.id}
            dest={dest}
            onToggle={() => toggle(dest.id)}
          />
        ))}
      </div>
    </div>
  )
}

function DestinationRow({ dest, onToggle }: { dest: Destination; onToggle: () => void }) {
  const qc = useQueryClient()
  const [editing,   setEditing]   = useState(false)
  const [rtmpUrl,   setRtmpUrl]   = useState(dest.rtmp_url)
  const [streamKey, setStreamKey] = useState('')
  const [clientId,  setClientId]  = useState('')
  const [clientSec, setClientSec] = useState('')
  const [saved,     setSaved]     = useState(false)
  const [authFlow,  setAuthFlow]  = useState(false)

  const { mutate: update, isPending, error } = useMutation({
    mutationFn: () => {
      const patch: Parameters<typeof api.updateDestination>[1] = {}
      if (rtmpUrl.trim()   !== dest.rtmp_url) patch.rtmp_url             = rtmpUrl.trim()
      if (streamKey.trim())                   patch.stream_key           = streamKey.trim()
      if (clientId.trim())                    patch.google_client_id     = clientId.trim()
      if (clientSec.trim())                   patch.google_client_secret = clientSec.trim()
      return api.updateDestination(dest.id, patch)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] })
      setStreamKey(''); setClientId(''); setClientSec('')
      setSaved(true)
      setTimeout(() => { setSaved(false); setEditing(false) }, 2000)
    },
  })

  const { mutate: disconnect } = useMutation({
    mutationFn: () => api.authDisconnect(dest.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['config'] }),
  })

  const keyHint      = dest.stream_key_hint
  const needsGoogle  = dest.id === 'youtube' || dest.id === 'facebook'

  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
      {/* Top row: name + auth badge + toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <PlatformIcon id={dest.id} />
          <span className="text-sm font-medium text-zinc-200">{dest.name}</span>
          {dest.enabled && keyHint !== '(no key)' && (
            <span className="text-xs text-zinc-500 font-mono">{keyHint}</span>
          )}
          {dest.enabled && keyHint === '(no key)' && (
            <span className="text-xs text-yellow-500">no key</span>
          )}
          {/* Auth badge */}
          {needsGoogle && dest.authenticated && (
            <span className="text-xs text-green-400 font-semibold">● connected</span>
          )}
          {needsGoogle && !dest.authenticated && dest.has_credentials && (
            <span className="text-xs text-yellow-400">○ not connected</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => { setEditing(e => !e); setAuthFlow(false) }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-0.5 rounded"
          >
            {editing ? 'Cancel' : 'Edit'}
          </button>
          <Toggle enabled={dest.enabled} onToggle={onToggle} />
        </div>
      </div>

      {/* Google OAuth connect strip (outside edit mode) */}
      {needsGoogle && !editing && dest.has_credentials && !authFlow && (
        <div className="flex items-center gap-2 pt-1">
          {dest.authenticated ? (
            <button
              onClick={() => disconnect()}
              className="text-xs text-zinc-500 hover:text-red-400 transition-colors underline underline-offset-2"
            >
              Disconnect YouTube account
            </button>
          ) : (
            <button
              onClick={() => setAuthFlow(true)}
              className="text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2 transition-colors"
            >
              Connect YouTube account →
            </button>
          )}
        </div>
      )}

      {/* OAuth device flow widget */}
      {authFlow && (
        <OAuthFlow destId={dest.id} onDone={() => {
          setAuthFlow(false)
          qc.invalidateQueries({ queryKey: ['config'] })
        }} onCancel={() => setAuthFlow(false)} />
      )}

      {/* Inline edit form */}
      {editing && (
        <div className="flex flex-col gap-3 pt-1">
          <EditField label="RTMP URL" value={rtmpUrl} onChange={setRtmpUrl} mono />
          <EditField
            label={`Stream Key (current: ${keyHint})`}
            value={streamKey}
            onChange={setStreamKey}
            type="password"
            placeholder="Enter new key to replace…"
          />
          {needsGoogle && (
            <>
              <p className="text-xs text-zinc-500 mt-1">
                Google OAuth — needed to auto-update YouTube title/description on stream start.{' '}
                <a
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank" rel="noreferrer"
                  className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
                >
                  Get credentials →
                </a>
              </p>
              <EditField
                label={`Google Client ID${dest.has_credentials ? ' (set)' : ''}`}
                value={clientId}
                onChange={setClientId}
                placeholder={dest.has_credentials ? '(unchanged)' : 'paste Client ID…'}
              />
              <EditField
                label={`Google Client Secret${dest.has_credentials ? ' (set)' : ''}`}
                value={clientSec}
                onChange={setClientSec}
                type="password"
                placeholder={dest.has_credentials ? '(unchanged)' : 'paste Client Secret…'}
              />
            </>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => update()}
              disabled={isPending}
              className="px-3 py-1 rounded-md text-xs font-semibold transition-all
                         bg-indigo-600 hover:bg-indigo-500 active:scale-95
                         disabled:bg-zinc-700 disabled:text-zinc-500"
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
            {saved  && <span className="text-xs text-green-400">Saved</span>}
            {error  && <span className="text-xs text-red-400">{(error as Error).message}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── OAuth device-flow widget ──────────────────────────────────────────────────

interface OAuthFlowProps { destId: string; onDone: () => void; onCancel: () => void }

function OAuthFlow({ destId, onDone, onCancel }: OAuthFlowProps) {
  const [step, setStep]   = useState<'idle' | 'waiting' | 'done' | 'expired' | 'error'>('idle')
  const [code, setCode]   = useState('')
  const [url,  setUrl]    = useState('')
  const [errMsg, setErr]  = useState('')
  const intervalRef       = useRef<number | null>(null)

  const stopPolling = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
  }

  const startAuth = async () => {
    setErr('')
    try {
      const data = await api.authStart(destId)
      setCode(data.user_code)
      setUrl(data.verification_url)
      setStep('waiting')

      const pollMs = (data.interval + 1) * 1000
      intervalRef.current = window.setInterval(async () => {
        try {
          const result = await api.authPoll(destId)
          if (result.status === 'authorized') {
            stopPolling(); setStep('done'); setTimeout(onDone, 1500)
          } else if (result.status === 'expired') {
            stopPolling(); setStep('expired')
          }
          // 'pending' → keep polling
        } catch (e) { stopPolling(); setErr(String(e)); setStep('error') }
      }, pollMs)
    } catch (e) {
      setErr((e as Error).message)
      setStep('error')
    }
  }

  useEffect(() => () => stopPolling(), [])

  if (step === 'idle') {
    return (
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={startAuth}
          className="text-xs px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500
                     font-semibold transition-all active:scale-95"
        >
          Connect YouTube account
        </button>
        <button onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
      </div>
    )
  }

  if (step === 'waiting') {
    return (
      <div className="bg-zinc-700/50 rounded-lg p-3 flex flex-col gap-2">
        <p className="text-xs text-zinc-300 font-medium">Complete Google sign-in:</p>
        <div className="flex items-center gap-2">
          <a
            href={url}
            target="_blank" rel="noreferrer"
            className="text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
          >
            Open sign-in page →
          </a>
        </div>
        <p className="text-xs text-zinc-400">
          Enter code: <span className="font-mono font-bold text-zinc-200 tracking-widest">{code}</span>
        </p>
        <p className="text-xs text-zinc-600 animate-pulse">Waiting for authorization…</p>
        <button onClick={() => { stopPolling(); onCancel() }}
          className="self-start text-xs text-zinc-500 hover:text-zinc-300">
          Cancel
        </button>
      </div>
    )
  }

  if (step === 'done') {
    return <p className="text-xs text-green-400 font-semibold pt-1">✓ YouTube account connected</p>
  }

  if (step === 'expired') {
    return (
      <div className="flex items-center gap-2 pt-1">
        <p className="text-xs text-yellow-400">Code expired.</p>
        <button onClick={startAuth}
          className="text-xs text-indigo-400 underline underline-offset-2 hover:text-indigo-300">
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 pt-1">
      <p className="text-xs text-red-400">{errMsg}</p>
      <button onClick={startAuth}
        className="text-xs text-indigo-400 underline underline-offset-2 hover:text-indigo-300">
        Retry
      </button>
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function EditField({ label, value, onChange, type = 'text', placeholder, mono }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; mono?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-zinc-500">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`bg-zinc-700 border border-zinc-600 rounded-md px-2 py-1.5
                   text-xs text-zinc-200 ${mono ? 'font-mono' : ''}
                   focus:outline-none focus:ring-1 focus:ring-indigo-500
                   placeholder:text-zinc-600`}
      />
    </div>
  )
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200
                  ${enabled ? 'bg-indigo-600' : 'bg-zinc-700'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow
                        transition-transform duration-200
                        ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
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
    <span className={`text-xs font-bold w-4 text-center flex-shrink-0 ${colors[id] ?? 'text-zinc-400'}`}>
      {icons[id] ?? '•'}
    </span>
  )
}

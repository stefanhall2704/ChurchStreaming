import type { Status, ConfigInfo, SessionMeta } from './types'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

type Ok = { status: string }

export const api = {
  status:  (): Promise<Status>     => fetch('/api/status').then(json<Status>),
  config:  (): Promise<ConfigInfo> => fetch('/api/config').then(json<ConfigInfo>),
  preview: (): Promise<Ok> =>
    fetch('/api/preview', { method: 'POST' }).then(json<Ok>),
  start:   (): Promise<Ok> =>
    fetch('/api/start', { method: 'POST' }).then(json<Ok>),
  stop:    (): Promise<Ok> =>
    fetch('/api/stop', { method: 'POST' }).then(json<Ok>),

  updateConfig: (patch: { srt_port?: number; max_retries?: number }): Promise<Ok> =>
    fetch('/api/config/update', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    }).then(json<Ok>),

  toggleDestination: (id: string): Promise<Ok> =>
    fetch(`/api/destinations/${id}/toggle`, { method: 'POST' }).then(json<Ok>),

  updateDestination: (id: string, patch: { rtmp_url?: string; stream_key?: string; google_client_id?: string; google_client_secret?: string }): Promise<Ok> =>
    fetch(`/api/destinations/${id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    }).then(json<Ok>),

  getSession: (): Promise<SessionMeta> =>
    fetch('/api/session').then(json<SessionMeta>),

  setSession: (meta: SessionMeta): Promise<Ok> =>
    fetch('/api/session', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(meta),
    }).then(json<Ok>),

  authStart: (id: string): Promise<{ user_code: string; verification_url: string; expires_in: number; interval: number }> =>
    fetch(`/api/destinations/${id}/auth/start`, { method: 'POST' })
      .then(json<{ user_code: string; verification_url: string; expires_in: number; interval: number }>),

  authPoll: (id: string): Promise<{ status: 'pending' | 'authorized' | 'expired' }> =>
    fetch(`/api/destinations/${id}/auth/poll`, { method: 'POST' })
      .then(json<{ status: 'pending' | 'authorized' | 'expired' }>),

  authDisconnect: (id: string): Promise<Ok> =>
    fetch(`/api/destinations/${id}/auth/disconnect`, { method: 'DELETE' }).then(json<Ok>),
}

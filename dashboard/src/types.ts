export type Phase = 'idle' | 'preview' | 'streaming' | 'error'

export interface Destination {
  id:              string
  name:            string
  rtmp_url:        string
  stream_key_hint: string
  enabled:         boolean
  authenticated:   boolean   // Google OAuth token stored on Pi
  has_credentials: boolean   // Google client_id + secret configured
}

export interface Status {
  phase:               Phase
  bitrate_kbps:        number
  fps:                 number
  drop_frames:         number
  uptime_secs:         number
  retry_count:         number
  error_message:       string | null
  cpu_temp_celsius:    number
  active_destinations: string[]
}

export interface ConfigInfo {
  srt_port:     number
  metrics_port: number
  max_retries:  number
  destinations: Destination[]
}

export interface SessionMeta {
  title?:       string
  description?: string
}

export interface TelemetryPoint {
  t:       number   // ms timestamp
  label:   string   // HH:MM:SS for x-axis
  bitrate: number
  fps:     number
}

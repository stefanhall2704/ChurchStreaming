import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import type { TelemetryPoint } from '../types'

interface Props {
  title: string
  unit: string
  dataKey: keyof Pick<TelemetryPoint, 'bitrate' | 'fps'>
  color: string
  gradientId: string
  domain: [number, number]
  history: TelemetryPoint[]
  current: number
}

export function TelemetryChart({
  title, unit, dataKey, color, gradientId, domain, history, current,
}: Props) {
  const idle = history.length === 0

  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          {title}
        </h3>
        <span className="font-mono text-2xl font-bold text-zinc-100">
          {idle ? '—' : current.toFixed(1)}
          <span className="text-sm font-normal text-zinc-500 ml-1">{unit}</span>
        </span>
      </div>

      {idle ? (
        <div className="h-[120px] flex items-center justify-center text-zinc-600 text-sm">
          Waiting for stream…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={history} margin={{ top: 4, right: 0, bottom: 0, left: -20 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0}    />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="2 4" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: '#52525b', fontSize: 9 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={domain}
              tick={{ fill: '#52525b', fontSize: 9 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={{
                background: '#18181b', border: '1px solid #3f3f46',
                borderRadius: 8, fontSize: 12,
              }}
              labelStyle={{ color: '#a1a1aa' }}
              itemStyle={{ color: color }}
              formatter={(v) => [`${Number(v ?? 0).toFixed(1)} ${unit}`, title]}
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              fill={`url(#${gradientId})`}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

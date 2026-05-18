interface Props { temp: number }

export function ThermalMonitor({ temp }: Props) {
  const pct = Math.min((temp / 85) * 100, 100)

  const { text, bar, label } =
    temp > 75 ? { text: 'text-red-400',    bar: 'bg-red-500',    label: 'Hot'    } :
    temp > 60 ? { text: 'text-yellow-400', bar: 'bg-yellow-500', label: 'Warm'   } :
    temp > 40 ? { text: 'text-green-400',  bar: 'bg-green-500',  label: 'Normal' } :
                { text: 'text-zinc-400',   bar: 'bg-zinc-500',   label: 'Cool'   }

  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          CPU Temp
        </h3>
        <span className="text-xs text-zinc-600">{label}</span>
      </div>

      <div className={`font-mono text-4xl font-bold ${text}`}>
        {temp > 0 ? temp.toFixed(1) : '—'}
        <span className="text-lg font-normal text-zinc-500 ml-1">°C</span>
      </div>

      {/* Progress bar: 0–85 °C scale */}
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${bar}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-zinc-700">
        <span>0°</span><span>85°</span>
      </div>
    </div>
  )
}

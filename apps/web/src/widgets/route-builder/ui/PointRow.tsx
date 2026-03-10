import { useState, useRef } from 'react'
import { Trash2, MapPin } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'
import type { UpdatePointPayload } from '@/entities/route-point'

interface PointRowProps {
  point: RoutePoint
  index: number
  onDelete: (id: string) => Promise<void>
  onUpdate?: (id: string, payload: UpdatePointPayload) => Promise<void>
}

export function PointRow({ point, index, onDelete, onUpdate }: PointRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = () => {
    setDraft(String(point.budget ?? 0))
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commitEdit = () => {
    setEditing(false)
    const val = Math.max(0, Number(draft) || 0)
    if (val !== (point.budget ?? 0)) {
      onUpdate?.(point.id, { budget: val })
    }
  }

  return (
    <div className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow group">
      {/* Номер */}
      <div className="shrink-0 w-7 h-7 rounded-full bg-brand-sky text-white text-xs font-bold flex items-center justify-center">
        {index + 1}
      </div>

      <MapPin className="shrink-0 w-4 h-4 text-gray-400" />

      {/* Название + координаты */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{point.title}</p>
        <p className="text-xs text-gray-400">
          {point.lat.toFixed(4)}, {point.lon.toFixed(4)}
        </p>
      </div>

      {/* Бюджет — кликабельный для редактирования */}
      {editing ? (
        <input
          ref={inputRef}
          type="number"
          min="0"
          step="100"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="shrink-0 w-20 text-xs font-semibold text-brand-amber bg-amber-50 border border-brand-amber/40 rounded-full px-2 py-0.5 text-center outline-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          style={{ MozAppearance: 'textfield' }}
        />
      ) : (
        <button
          onClick={onUpdate ? startEdit : undefined}
          title={onUpdate ? 'Нажмите для редактирования' : undefined}
          className={`shrink-0 text-xs font-semibold text-brand-amber bg-amber-50 px-2 py-0.5 rounded-full ${onUpdate ? 'hover:bg-amber-100 cursor-text' : ''}`}
        >
          {(point.budget ?? 0).toLocaleString('ru-RU')} ₽
        </button>
      )}

      {/* Удалить */}
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7 text-red-400 hover:text-red-600 hover:bg-red-50"
        onClick={() => onDelete(point.id)}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </div>
  )
}

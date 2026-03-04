import { Trash2, MapPin } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'

interface PointRowProps {
  point: RoutePoint
  index: number
  onDelete: (id: string) => void
}

export function PointRow({ point, index, onDelete }: PointRowProps) {
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

      {/* Бюджет */}
      {point.budget != null && (
        <span className="shrink-0 text-xs font-semibold text-brand-amber bg-amber-50 px-2 py-0.5 rounded-full">
          {point.budget.toLocaleString('ru-RU')} ₽
        </span>
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

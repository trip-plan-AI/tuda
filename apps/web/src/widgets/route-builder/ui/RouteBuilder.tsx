import { MapPin } from 'lucide-react'
import { PointRow } from './PointRow'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'

interface RouteBuilderProps {
  points: RoutePoint[]
  onDelete: (id: string) => void
}

export function RouteBuilder({ points, onDelete }: RouteBuilderProps) {
  const totalBudget = points.reduce((sum, p) => sum + (p.budget ?? 0), 0)

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-gray-800">
          Точки маршрута
          {points.length > 0 && (
            <span className="ml-2 text-xs font-medium text-gray-400">
              {points.length}
            </span>
          )}
        </h2>
      </div>

      <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
        {points.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 rounded-full bg-brand-light flex items-center justify-center mb-3">
              <MapPin className="w-6 h-6 text-brand-sky" />
            </div>
            <p className="text-sm font-medium text-gray-500">Нет точек</p>
            <p className="text-xs text-gray-400 mt-1">Добавьте первую точку маршрута</p>
          </div>
        ) : (
          points.map((point, index) => (
            <PointRow
              key={point.id}
              point={point}
              index={index}
              onDelete={onDelete}
            />
          ))
        )}
      </div>

      {points.length > 0 && (
        <div className="border-t border-gray-100 pt-3 flex items-center justify-between">
          <span className="text-sm text-gray-500">Итого бюджет</span>
          <span className="text-sm font-bold text-brand-amber">
            {totalBudget.toLocaleString('ru-RU')} ₽
          </span>
        </div>
      )}
    </div>
  )
}

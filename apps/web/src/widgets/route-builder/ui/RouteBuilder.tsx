'use client'

import { useState } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { MapPin, Plus } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { AddPointForm } from '@/features/route-create'
import { SortablePointRow } from './SortablePointRow'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'
import type { CreatePointPayload } from '@/entities/route-point'

interface RouteBuilderProps {
  points: RoutePoint[]
  onDelete: (id: string) => Promise<void>
  onAdd: (payload: CreatePointPayload) => Promise<unknown>
  onReorder: (orderedIds: string[]) => Promise<void>
}

export function RouteBuilder({ points, onDelete, onAdd, onReorder }: RouteBuilderProps) {
  const [showForm, setShowForm] = useState(false)
  const totalBudget = points.reduce((sum, p) => sum + (p.budget ?? 0), 0)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = points.findIndex((p) => p.id === active.id)
    const newIndex = points.findIndex((p) => p.id === over.id)
    const reordered = arrayMove(points, oldIndex, newIndex)

    onReorder(reordered.map((p) => p.id))
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-gray-800">
          Точки маршрута
          {points.length > 0 && (
            <span className="ml-2 text-xs font-medium text-gray-400">{points.length}</span>
          )}
        </h2>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-brand-sky hover:bg-brand-sky/10"
          onClick={() => setShowForm((v) => !v)}
          title="Добавить точку"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {showForm && (
        <AddPointForm onAdd={onAdd} onCancel={() => setShowForm(false)} />
      )}

      <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
        {points.length === 0 && !showForm ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 rounded-full bg-brand-light flex items-center justify-center mb-3">
              <MapPin className="w-6 h-6 text-brand-sky" />
            </div>
            <p className="text-sm font-medium text-gray-500">Нет точек</p>
            <p className="text-xs text-gray-400 mt-1">
              Нажмите <Plus className="inline w-3 h-3" /> чтобы добавить
            </p>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={points.map((p) => p.id)} strategy={verticalListSortingStrategy}>
              {points.map((point, index) => (
                <SortablePointRow
                  key={point.id}
                  point={point}
                  index={index}
                  onDelete={onDelete}
                />
              ))}
            </SortableContext>
          </DndContext>
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

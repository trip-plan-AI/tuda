'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { PointRow } from './PointRow'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'

interface SortablePointRowProps {
  point: RoutePoint
  index: number
  onDelete: (id: string) => Promise<void>
}

export function SortablePointRow({ point, index, onDelete }: SortablePointRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: point.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-1">
      {/* Drag handle */}
      <div
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 touch-none"
      >
        <GripVertical className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <PointRow point={point} index={index} onDelete={onDelete} />
      </div>
    </div>
  )
}

import type { RoutePoint } from '@/entities/route-point/model/route-point.types'

export interface Trip {
  id: string
  title: string
  description: string | null
  budget: number | null
  ownerId: string
  isActive: boolean
  isPredefined: boolean
  startDate: string | null
  endDate: string | null
  createdAt: string
  updatedAt: string
  points: RoutePoint[]
}

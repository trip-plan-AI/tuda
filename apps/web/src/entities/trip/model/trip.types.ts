import type { RoutePoint } from '@/entities/route-point/model/route-point.types'

export interface Trip {
  id: string
  title: string
  description: string | null
  budget: number | null
  ownerId: string
  isActive: boolean
  isPredefined: boolean
  img?: string | null
  tags?: string[] | null
  temp?: string | null
  startDate: string | null
  endDate: string | null
  createdAt: string
  updatedAt: string
  points?: RoutePoint[]
}

import { api } from '@/shared/api'
import type { RoutePoint } from '../model/route-point.types'

export interface CreatePointPayload {
  title: string
  lat: number
  lon: number
  budget?: number
  visitDate?: string
  imageUrl?: string
  order?: number
  address?: string
}

export interface UpdatePointPayload {
  title?: string
  lat?: number
  lon?: number
  budget?: number
  visitDate?: string
  imageUrl?: string
  address?: string | null
}

const base = (tripId: string) => `/trips/${tripId}/points`

export const pointsApi = {
  getAll: (tripId: string) =>
    api.get<RoutePoint[]>(base(tripId)),

  create: (tripId: string, payload: CreatePointPayload) =>
    api.post<RoutePoint>(base(tripId), payload),

  update: (tripId: string, id: string, payload: UpdatePointPayload) =>
    api.patch<RoutePoint>(`${base(tripId)}/${id}`, payload),

  remove: (tripId: string, id: string) =>
    api.del<void>(`${base(tripId)}/${id}`),

  reorder: (tripId: string, orderedIds: string[]) =>
    api.patch<void>(`${base(tripId)}/reorder`, { ids: orderedIds }),
}

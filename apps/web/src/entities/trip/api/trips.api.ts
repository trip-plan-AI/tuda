import { api } from '@/shared/api'
import type { Trip } from '../model/trip.types'

export interface CreateTripPayload {
  title: string
  description?: string
  isActive?: boolean
}

export interface UpdateTripPayload {
  title?: string
  description?: string
  budget?: number | null
  isActive?: boolean
  startDate?: string | null
  endDate?: string | null
}

export const tripsApi = {
  getAll: () => api.get<Trip[]>('/trips'),
  getPredefined: () => api.get<Trip[]>('/trips/predefined'),
  create: (payload: CreateTripPayload) => api.post<Trip>('/trips', payload),
  update: (id: string, payload: UpdateTripPayload) => api.patch<Trip>(`/trips/${id}`, payload),
  remove: (id: string) => api.del<void>(`/trips/${id}`),
  optimize: (id: string, transportMode: 'driving' | 'foot' | 'bike' | 'direct' = 'driving') => api.post<any>(`/trips/${id}/optimize`, { transportMode }),
}

'use client'

import { useCallback } from 'react'
import { useTripStore } from '@/entities/trip/model/trip.store'
import type { CreatePointPayload, UpdatePointPayload } from '@/entities/route-point'
import { getSocket } from '@/shared/socket/socket-client'

export function usePointCrud(tripId: string | undefined) {
  const { addPoint, updatePoint, removePoint, reorderPoints } = useTripStore()

  const add = useCallback(
    async (payload: CreatePointPayload) => {
      if (!tripId) return
      const localPoint = {
        ...payload,
        id: `point-${Date.now()}`,
        tripId,
        order: payload.order ?? 0,
        budget: payload.budget ?? 0,
        visitDate: payload.visitDate ?? null,
        imageUrl: payload.imageUrl ?? null,
        address: payload.address ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      addPoint(localPoint as any)
      return localPoint
    },
    [tripId, addPoint],
  )

  const remove = useCallback(
    async (id: string) => {
      if (!tripId) return
      removePoint(id)
    },
    [tripId, removePoint],
  )

  const update = useCallback(
    async (id: string, payload: UpdatePointPayload) => {
      if (!tripId) return
      updatePoint(id, payload) // optimistic update
      if (!tripId.startsWith('guest-')) {
        await pointsApi.update(tripId, id, payload)
        // Broadcast to collaborators in real-time
        getSocket().emit('point:update', { trip_id: tripId, point_id: id, ...payload })
      }
      updatePoint(id, payload)
    },
    [tripId, updatePoint],
  )

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      if (!tripId) return
      reorderPoints(orderedIds)
    },
    [tripId, reorderPoints],
  )

  return { add, update, remove, reorder }
}

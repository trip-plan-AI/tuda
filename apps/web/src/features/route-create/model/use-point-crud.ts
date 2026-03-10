'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useTripStore } from '@/entities/trip/model/trip.store'
import { pointsApi } from '@/entities/route-point'
import type { CreatePointPayload, UpdatePointPayload } from '@/entities/route-point'

export function usePointCrud(tripId: string | undefined) {
  const { setPoints, setCurrentTrip, addPoint, updatePoint, removePoint, reorderPoints } = useTripStore()
  const loadedTripId = useRef<string | null>(null)

  // Загружаем точки при смене tripId
  useEffect(() => {
    if (!tripId || loadedTripId.current === tripId) return
    loadedTripId.current = tripId

    if (tripId.startsWith('guest-')) {
      // Points for guest trip are already in the store or will be added manually
      return
    }

    pointsApi
      .getAll(tripId)
      .then(setPoints)
      .catch((e) => {
        const message = e instanceof Error ? e.message : ''
        if (message.includes('Access denied') || message.includes('403')) {
          setCurrentTrip(null as any)
          return
        }

        console.error(e)
      })
  }, [tripId, setPoints, setCurrentTrip])

  const add = useCallback(
    async (payload: CreatePointPayload) => {
      if (!tripId) return
      
      if (tripId.startsWith('guest-')) {
        const guestPoint = {
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
        addPoint(guestPoint as any)
        return guestPoint
      }

      const created = await pointsApi.create(tripId, payload)
      addPoint(created)
      return created
    },
    [tripId, addPoint],
  )

  const remove = useCallback(
    async (id: string) => {
      if (!tripId) return
      if (!tripId.startsWith('guest-')) {
        await pointsApi.remove(tripId, id)
      }
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
      }
    },
    [tripId, updatePoint],
  )

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      if (!tripId) return
      reorderPoints(orderedIds) // optimistic update
      if (!tripId.startsWith('guest-')) {
        await pointsApi.reorder(tripId, orderedIds)
      }
    },
    [tripId, reorderPoints],
  )

  return { add, update, remove, reorder }
}

'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useTripStore } from '@/entities/trip/model/trip.store'
import { pointsApi } from '@/entities/route-point'
import type { CreatePointPayload } from '@/entities/route-point'

export function usePointCrud(tripId: string | undefined) {
  const { setPoints, addPoint, removePoint, reorderPoints } = useTripStore()
  const loadedTripId = useRef<string | null>(null)

  // Загружаем точки при смене tripId
  useEffect(() => {
    if (!tripId || loadedTripId.current === tripId) return
    loadedTripId.current = tripId

    pointsApi.getAll(tripId).then(setPoints).catch(console.error)
  }, [tripId, setPoints])

  const add = useCallback(
    async (payload: CreatePointPayload) => {
      if (!tripId) return
      const created = await pointsApi.create(tripId, payload)
      addPoint(created)
      return created
    },
    [tripId, addPoint],
  )

  const remove = useCallback(
    async (id: string) => {
      if (!tripId) return
      await pointsApi.remove(tripId, id)
      removePoint(id)
    },
    [tripId, removePoint],
  )

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      if (!tripId) return
      reorderPoints(orderedIds) // optimistic update
      await pointsApi.reorder(tripId, orderedIds)
    },
    [tripId, reorderPoints],
  )

  return { add, remove, reorder }
}

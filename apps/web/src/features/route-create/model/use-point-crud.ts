'use client';

import { useCallback } from 'react';
import { useTripStore } from '@/entities/trip/model/trip.store';
import {
  pointsApi,
  type CreatePointPayload,
  type UpdatePointPayload,
} from '@/entities/route-point';
import { getSocket } from '@/shared/socket/socket-client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function usePointCrud(tripId: string | undefined) {
  const { addPoint, updatePoint, removePoint, reorderPoints } = useTripStore();

  const isRealTrip = !!tripId && !tripId.startsWith('guest-') && UUID_RE.test(tripId);

  const add = useCallback(
    async (payload: CreatePointPayload) => {
      if (!tripId) return;
      if (isRealTrip) {
        // Real trip: save to backend to get a proper UUID
        const savedPoint = await pointsApi.create(tripId, payload);
        addPoint(savedPoint as any);
        // Broadcast to collaborators
        getSocket().emit('point:add', { trip_id: tripId, point: savedPoint });
        return savedPoint;
      }
      // Guest trip: local-only with temp ID
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
      };
      addPoint(localPoint as any);
      return localPoint;
    },
    [tripId, isRealTrip, addPoint],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!tripId) return;
      removePoint(id);
      if (isRealTrip) {
        await pointsApi.remove(tripId, id);
        getSocket().emit('point:delete', { trip_id: tripId, point_id: id });
      }
    },
    [tripId, isRealTrip, removePoint],
  );

  const update = useCallback(
    async (id: string, payload: UpdatePointPayload) => {
      if (!tripId) return;
      updatePoint(id, payload); // optimistic update
      if (!tripId.startsWith('guest-')) {
        await pointsApi.update(tripId, id, payload);
        // Broadcast to collaborators in real-time
        getSocket().emit('point:update', { trip_id: tripId, point_id: id, ...payload });
      }
    },
    [tripId, updatePoint],
  );

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      if (!tripId) return;
      reorderPoints(orderedIds);
      if (!tripId.startsWith('guest-')) {
        // Broadcast to collaborators
        getSocket().emit('point:reorder', { trip_id: tripId, pointIds: orderedIds });
        await pointsApi.reorder(tripId, orderedIds);
      }
    },
    [tripId, reorderPoints],
  );

  return { add, update, remove, reorder };
}

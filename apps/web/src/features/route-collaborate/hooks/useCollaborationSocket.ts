'use client';

import { useEffect } from 'react';
import { getSocket } from '@/shared/socket/socket-client';
import { useTripStore } from '@/entities/trip/model/trip.store';
import { pointsApi } from '@/entities/route-point/api/points.api';
import { useCollaborateStore } from '../model/collaborate.store';
import type { Collaborator } from '../model/collaborate.store';

export function useCollaborationSocket(tripId: string, isActive: boolean = true) {
  const { setOnline, addCollaborator, removeCollaborator } = useCollaborateStore();
  const { addPoint, updatePoint, removePoint, setPoints } = useTripStore();

  useEffect(() => {
    if (!tripId || !isActive || tripId.startsWith('guest-')) return;

    pointsApi.getAll(tripId).then(setPoints).catch(console.error);

    const socket = getSocket();
    socket.emit('join:trip', { trip_id: tripId });

    socket.on('presence:update', ({ onlineUserIds }: { onlineUserIds: string[] }) => {
      setOnline(onlineUserIds);
    });
    socket.on('collaborator:added', (c: Collaborator) => addCollaborator(c));
    socket.on('collaborator:removed', ({ userId }: { userId: string }) =>
      removeCollaborator(userId),
    );

    // Real-time point sync (changes from other users)
    socket.on('point:added', ({ point }: { point: any }) => addPoint(point));
    socket.on(
      'point:moved',
      ({ point_id, coords }: { point_id: string; coords: { lat: number; lon: number } }) => {
        updatePoint(point_id, { lat: coords.lat, lon: coords.lon });
      },
    );
    socket.on('point:deleted', ({ point_id }: { point_id: string }) => {
      removePoint(point_id);
    });
    socket.on(
      'point:updated',
      ({ point_id, ...patch }: { point_id: string } & Record<string, unknown>) => {
        updatePoint(point_id, patch as Parameters<typeof updatePoint>[1]);
      },
    );

    return () => {
      socket.emit('leave:trip', { trip_id: tripId });
      socket.off('presence:update');
      socket.off('collaborator:added');
      socket.off('collaborator:removed');
      socket.off('point:added');
      socket.off('point:moved');
      socket.off('point:deleted');
      socket.off('point:updated');
    };
  }, [tripId, isActive]);
}

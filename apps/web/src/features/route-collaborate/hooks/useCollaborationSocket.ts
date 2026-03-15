'use client';

import { useEffect } from 'react';
import { getSocket } from '@/shared/socket/socket-client';
import { useTripStore } from '@/entities/trip/model/trip.store';
import { pointsApi } from '@/entities/route-point/api/points.api';
import { useCollaborateStore } from '../model/collaborate.store';
import type { Collaborator } from '../model/collaborate.store';

import { tripsApi } from '@/entities/trip/api/trips.api';

export function useCollaborationSocket(tripId: string) {
  const { setOnline, addCollaborator, removeCollaborator } = useCollaborateStore();
  const { addPoint, updatePoint, removePoint, setPoints, setCurrentTrip } = useTripStore();

  useEffect(() => {
    if (!tripId || tripId.startsWith('guest-')) return;

    const loadTripData = () => {
      // Load actual trip and points concurrently to avoid partial state updates
      Promise.all([tripsApi.getOne(tripId), pointsApi.getAll(tripId)])
        .then(([trip, points]) => {
          if (trip && points) {
            useTripStore.setState((state) => ({
              ...state,
              currentTrip: { ...trip, points },
              isDirty: false,
            }));
          }
        })
        .catch(console.error);
    };

    loadTripData();

    const socket = getSocket();
    socket.emit('join:trip', { trip_id: tripId });

    socket.on('connect', () => {
      loadTripData();
      socket.emit('join:trip', { trip_id: tripId });
    });

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadTripData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    socket.on('presence:update', ({ onlineUserIds }: { onlineUserIds: string[] }) => {
      setOnline(onlineUserIds);
    });
    socket.on('collaborator:added', (c: Collaborator) => addCollaborator(c));
    socket.on('collaborator:removed', ({ userId }: { userId: string }) =>
      removeCollaborator(userId),
    );

    // Real-time point sync (changes from other users)
    socket.on('point:added', ({ point }: { point: any }) => addPoint(point));
    socket.on('point:reorder', ({ pointIds }: { pointIds: string[] }) => {
      try {
        useTripStore.getState().reorderPoints(pointIds);
      } catch (e) {
        console.error('Failed to sync point reorder from socket:', e);
      }
    });
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
      ({ point_id, trip_id: _trip_id, ...patch }: { point_id: string; trip_id?: string } & Record<string, unknown>) => {
        updatePoint(point_id, patch as Parameters<typeof updatePoint>[1]);
      },
    );

    socket.on('trip:update', (patch: Record<string, unknown>) => {
      try {
        const { trip_id, ...data } = patch;
        useTripStore.getState().updateCurrentTrip(data);
      } catch (e) {
        console.error('Failed to sync trip update from socket:', e);
      }
    });

    socket.on('trip:refresh', () => {
      loadTripData();
    });

    socket.on('trip_version_updated', (data: { version: number; points: any[] }) => {
      try {
        useTripStore.setState((state) => {
          if (!state.currentTrip) return state;
          return {
            ...state,
            currentTrip: {
              ...state.currentTrip,
              version: data.version,
              points: data.points,
            },
          };
        });
      } catch (e) {
        console.error('Failed to sync trip version from socket:', e);
      }
    });

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      socket.emit('leave:trip', { trip_id: tripId });
      socket.off('connect');
      socket.off('presence:update');
      socket.off('collaborator:added');
      socket.off('collaborator:removed');
      socket.off('point:added');
      socket.off('point:moved');
      socket.off('point:deleted');
      socket.off('point:updated');
      socket.off('point:reorder');
      socket.off('trip:update');
      socket.off('trip:refresh');
      socket.off('trip_version_updated');
    };
  }, [tripId]);
}

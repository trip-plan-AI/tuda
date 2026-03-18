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
          const storeState = useTripStore.getState();
          const currentStoreTrip = storeState.currentTrip;
          // 🛡 ЗАЩИТА: не перезаписываем стор, если пользователь редактирует другой маршрут
          // с несохранёнными изменениями (isDirty). Без isDirty-проверки страница AI-чата
          // не могла загрузить маршрут сессии, если Planner оставил в сторе другой tripId.
          if (currentStoreTrip && currentStoreTrip.id !== tripId && storeState.isDirty) {
            return;
          }

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

    const handleConnect = () => {
      loadTripData();
      socket.emit('join:trip', { trip_id: tripId });
    };
    socket.on('connect', handleConnect);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadTripData();
        const socket = getSocket();
        if (socket && socket.connected) {
          // Принудительно "пингуем" комнату при возврате на вкладку
          socket.emit('join:trip', { trip_id: tripId });
        } else if (socket) {
          socket.connect();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const handlePresenceUpdate = ({ onlineUserIds }: { onlineUserIds: string[] }) => {
      setOnline(onlineUserIds);
    };
    const handleCollaboratorAdded = (c: Collaborator) => addCollaborator(c);
    const handleCollaboratorRemoved = ({ userId }: { userId: string }) =>
      removeCollaborator(userId);

    socket.on('presence:update', handlePresenceUpdate);
    socket.on('collaborator:added', handleCollaboratorAdded);
    socket.on('collaborator:removed', handleCollaboratorRemoved);

    const checkTripId = () => useTripStore.getState().currentTrip?.id === tripId;

    // Real-time point sync (changes from other users)
    const handlePointAdded = ({ point }: { point: any }) => {
      if (checkTripId()) addPoint(point);
    };
    const handlePointReorder = ({ pointIds }: { pointIds: string[] }) => {
      if (!checkTripId()) return;
      try {
        useTripStore.getState().reorderPoints(pointIds);
      } catch (e) {
        console.error('Failed to sync point reorder from socket:', e);
      }
    };
    const handlePointMoved = ({
      point_id,
      coords,
    }: {
      point_id: string;
      coords: { lat: number; lon: number };
    }) => {
      if (checkTripId()) updatePoint(point_id, { lat: coords.lat, lon: coords.lon });
    };
    const handlePointDeleted = ({ point_id }: { point_id: string }) => {
      if (checkTripId()) removePoint(point_id);
    };
    const handlePointUpdated = ({
      point_id,
      trip_id: _trip_id,
      ...patch
    }: { point_id: string; trip_id?: string } & Record<string, unknown>) => {
      if (checkTripId()) updatePoint(point_id, patch as Parameters<typeof updatePoint>[1]);
    };
    const handleTripUpdate = (patch: Record<string, unknown>) => {
      if (!checkTripId()) return;
      try {
        const { trip_id, ...data } = patch;
        useTripStore.getState().updateCurrentTrip(data);
      } catch (e) {
        console.error('Failed to sync trip update from socket:', e);
      }
    };
    const handleTripBudgetUpdated = ({ trip_id: _trip_id, budget }: { trip_id: string; budget: number }) => {
      if (!checkTripId()) return;
      try {
        // Patch budget directly without setting isDirty — this is an external update
        useTripStore.setState((state) => {
          if (!state.currentTrip) return state;
          if (state.currentTrip.budget === budget) return state;
          return { ...state, currentTrip: { ...state.currentTrip, budget } };
        });
      } catch (e) {
        console.error('Failed to sync budget update from socket:', e);
      }
    };
    const handleTripRefresh = () => {
      if (checkTripId()) loadTripData();
    };
    const handleTripVersionUpdated = (data: { version: number; points: any[] }) => {
      try {
        useTripStore.setState((state) => {
          if (!state.currentTrip || state.currentTrip.id !== tripId) return state;
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
    };

    socket.on('point:added', handlePointAdded);
    socket.on('point:reorder', handlePointReorder);
    socket.on('point:moved', handlePointMoved);
    socket.on('point:deleted', handlePointDeleted);
    socket.on('point:updated', handlePointUpdated);
    socket.on('trip:update', handleTripUpdate);
    socket.on('trip:budget_updated', handleTripBudgetUpdated);
    socket.on('trip:refresh', handleTripRefresh);
    socket.on('trip_version_updated', handleTripVersionUpdated);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      socket.emit('leave:trip', { trip_id: tripId });
      socket.off('connect', handleConnect);
      socket.off('presence:update', handlePresenceUpdate);
      socket.off('collaborator:added', handleCollaboratorAdded);
      socket.off('collaborator:removed', handleCollaboratorRemoved);
      socket.off('point:added', handlePointAdded);
      socket.off('point:moved', handlePointMoved);
      socket.off('point:deleted', handlePointDeleted);
      socket.off('point:updated', handlePointUpdated);
      socket.off('point:reorder', handlePointReorder);
      socket.off('trip:update', handleTripUpdate);
      socket.off('trip:budget_updated', handleTripBudgetUpdated);
      socket.off('trip:refresh', handleTripRefresh);
      socket.off('trip_version_updated', handleTripVersionUpdated);
    };
  }, [tripId]);
}

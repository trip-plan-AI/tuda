'use client';

import { useEffect } from 'react';
import { getSocket } from '@/shared/socket/socket-client';
import { useCollaborateStore } from '../model/collaborate.store';
import type { Collaborator } from '../model/collaborate.store';

export function useCollaborationSocket(tripId: string) {
  const { setOnline, addCollaborator, removeCollaborator } = useCollaborateStore();

  useEffect(() => {
    if (!tripId) return;

    const socket = getSocket();
    socket.emit('room:join', { tripId });

    socket.on('presence:update', ({ onlineUserIds }: { onlineUserIds: string[] }) => {
      setOnline(onlineUserIds);
    });
    socket.on('collaborator:added', (c: Collaborator) => {
      addCollaborator(c);
    });
    socket.on('collaborator:removed', ({ userId }: { userId: string }) => {
      removeCollaborator(userId);
    });

    return () => {
      socket.emit('room:leave', { tripId });
      socket.off('presence:update');
      socket.off('collaborator:added');
      socket.off('collaborator:removed');
    };
  }, [tripId]);
}

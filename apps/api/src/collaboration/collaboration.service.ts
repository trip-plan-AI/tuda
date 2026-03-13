import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

interface PresenceInfo {
  userId: string;
  tripId: string;
  name: string;
  color: string;
}

const COLORS = [
  '#3b82f6',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
];

@Injectable()
export class CollaborationService {
  private presence = new Map<string, PresenceInfo>();

  getUserColor(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i++)
      hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    return COLORS[Math.abs(hash) % COLORS.length];
  }

  addPresence(socketId: string, data: PresenceInfo): PresenceInfo {
    this.presence.set(socketId, data);
    return data;
  }

  removePresence(socketId: string, server: Server): void {
    const data = this.presence.get(socketId);
    if (data) {
      this.presence.delete(socketId);
      server.to(`trip_${data.tripId}`).emit('presence:update', {
        onlineUserIds: this.getOnlineUsers(data.tripId),
      });
    }
  }

  getOnlineUsers(tripId: string): string[] {
    const userIds = new Set<string>();
    for (const info of this.presence.values()) {
      if (info.tripId === tripId) {
        userIds.add(info.userId);
      }
    }
    return Array.from(userIds);
  }
}

import { Injectable } from '@nestjs/common'
import { Server } from 'socket.io'

interface PresenceInfo {
  userId: string
  tripId: string
  name: string
  color: string
}

@Injectable()
export class CollaborationService {
  private presenceMap = new Map<string, PresenceInfo>()
  private userColors = new Map<string, string>()

  private readonly palette = [
    '#ef4444',
    '#f97316',
    '#eab308',
    '#22c55e',
    '#06b6d4',
    '#3b82f6',
    '#8b5cf6',
    '#ec4899',
  ]

  getUserColor(userId: string): string {
    if (!this.userColors.has(userId)) {
      const index = this.userColors.size % this.palette.length
      this.userColors.set(userId, this.palette[index])
    }
    return this.userColors.get(userId)!
  }

  addPresence(clientId: string, info: PresenceInfo): PresenceInfo {
    this.presenceMap.set(clientId, info)
    return info
  }

  removePresence(clientId: string, server: Server): void {
    const info = this.presenceMap.get(clientId)
    if (!info) return

    this.presenceMap.delete(clientId)
    const room = `trip_${info.tripId}`
    server.to(room).emit('presence:leave', { user_id: info.userId })
  }
}

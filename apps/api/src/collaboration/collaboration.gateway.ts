import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { JwtService } from '@nestjs/jwt'
import { CollaborationService } from './collaboration.service'

@WebSocketGateway({ namespace: '/collaboration', cors: { origin: '*' } })
export class CollaborationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server

  constructor(
    private collabService: CollaborationService,
    private jwtService: JwtService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token
      const payload = this.jwtService.verify(token)
      client.data.userId = payload.sub
      client.data.email = payload.email
    } catch {
      client.disconnect()
    }
  }

  handleDisconnect(client: Socket) {
    this.collabService.removePresence(client.id, this.server)
  }
}

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { CollaborationService } from './collaboration.service';

interface SocketData {
  userId: string;
  email: string;
  tripId?: string;
}

type TypedSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  SocketData
>;

@WebSocketGateway({ namespace: '/collaboration', cors: { origin: '*' } })
export class CollaborationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;

  constructor(
    private collabService: CollaborationService,
    private jwtService: JwtService,
  ) {}

  handleConnection(client: TypedSocket) {
    try {
      const token = String(client.handshake.auth?.token ?? '');
      const payload = this.jwtService.verify<{ sub: string; email: string }>(
        token,
      );
      client.data.userId = payload.sub;
      client.data.email = payload.email;
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: TypedSocket) {
    this.collabService.removePresence(client.id, this.server);
  }

  @SubscribeMessage('join:trip')
  handleJoin(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() data: { trip_id: string },
  ) {
    const room = `trip_${data.trip_id}`;
    client.join(room);
    client.data.tripId = data.trip_id;

    const presenceData = this.collabService.addPresence(client.id, {
      userId: client.data.userId,
      tripId: data.trip_id,
      name: client.data.email,
      color: this.collabService.getUserColor(client.data.userId),
    });

    client.to(room).emit('presence:join', presenceData);
  }

  @SubscribeMessage('leave:trip')
  handleLeave(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() data: { trip_id: string },
  ) {
    const room = `trip_${data.trip_id}`;
    client.leave(room);
    client.to(room).emit('presence:leave', { user_id: client.data.userId });
  }
}

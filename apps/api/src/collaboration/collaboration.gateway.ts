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
import { PointsService } from '../points/points.service';
import { CreatePointDto } from '../points/dto/create-point.dto';

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
    private pointsService: PointsService,
  ) {}

  handleConnection(client: TypedSocket) {
    try {
      const token = String(client.handshake.auth?.token ?? '');
      const payload = this.jwtService.verify<{ sub: string; email: string }>(
        token,
      );
      client.data.userId = payload.sub;
      client.data.email = payload.email;
      // Personal room so we can push notifications directly to this user
      client.join(`user_${payload.sub}`);
    } catch {
      client.disconnect();
    }
  }

  /** Notify a specific user that they were added to a trip */
  notifyTripShared(userId: string, trip: any) {
    this.server.to(`user_${userId}`).emit('trip:shared', trip);
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

  @SubscribeMessage('point:add')
  async handlePointAdd(
    @ConnectedSocket() _client: TypedSocket,
    @MessageBody() data: CreatePointDto & { trip_id: string },
  ) {
    const { trip_id, ...dto } = data;
    const point = await this.pointsService.create(trip_id, dto);
    this.server.to(`trip_${trip_id}`).emit('point:added', { point });
  }

  @SubscribeMessage('point:move')
  async handlePointMove(
    @ConnectedSocket() _client: TypedSocket,
    @MessageBody()
    data: { trip_id: string; point_id: string; lat: number; lon: number },
  ) {
    await this.pointsService.update(data.point_id, data.trip_id, {
      lat: data.lat,
      lon: data.lon,
    });
    this.server.to(`trip_${data.trip_id}`).emit('point:moved', {
      point_id: data.point_id,
      coords: { lat: data.lat, lon: data.lon },
    });
  }

  @SubscribeMessage('point:delete')
  async handlePointDelete(
    @ConnectedSocket() _client: TypedSocket,
    @MessageBody() data: { trip_id: string; point_id: string },
  ) {
    await this.pointsService.remove(data.point_id, data.trip_id);
    this.server
      .to(`trip_${data.trip_id}`)
      .emit('point:deleted', { point_id: data.point_id });
  }

  @SubscribeMessage('cursor:move')
  handleCursor(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() data: { trip_id: string; x: number; y: number },
  ) {
    client.to(`trip_${data.trip_id}`).emit('cursor:moved', {
      user_id: client.data.userId,
      name: client.data.email,
      color: this.collabService.getUserColor(client.data.userId),
      x: data.x,
      y: data.y,
    });
  }
}

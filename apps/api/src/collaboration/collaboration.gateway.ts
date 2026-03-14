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
import { TripsService } from '../trips/trips.service';
import { ForbiddenException } from '@nestjs/common';
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
    private tripsService: TripsService,
  ) {}

  async checkAccess(userId: string, tripId: string) {
    const trip = await this.tripsService.findByIdWithAccess(tripId, userId);
    if (trip.ownerId !== userId && !trip.ownerIsActive) {
      throw new ForbiddenException('Route editing is disabled by the owner');
    }
    return trip;
  }

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

  /** Broadcast new collaborator to all members in the trip room */
  notifyCollaboratorAdded(tripId: string, collaborator: any) {
    this.server
      .to(`trip_${tripId}`)
      .emit('collaborator:added', { tripId, ...collaborator });
  }

  /** Broadcast collaborator removal to all members in the trip room */
  notifyCollaboratorRemoved(tripId: string, userId: string) {
    this.server
      .to(`trip_${tripId}`)
      .emit('collaborator:removed', { tripId, userId });
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
    void client.join(room);
    client.data.tripId = data.trip_id;

    const presenceData = this.collabService.addPresence(client.id, {
      userId: client.data.userId,
      tripId: data.trip_id,
      name: client.data.email,
      color: this.collabService.getUserColor(client.data.userId),
    });

    this.server.to(room).emit('presence:update', {
      onlineUserIds: this.collabService.getOnlineUsers(data.trip_id),
    });
  }

  @SubscribeMessage('leave:trip')
  handleLeave(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() data: { trip_id: string },
  ) {
    const room = `trip_${data.trip_id}`;
    client.leave(room);
    this.collabService.removePresence(client.id, this.server);
  }

  @SubscribeMessage('point:add')
  async handlePointAdd(
    @ConnectedSocket() _client: TypedSocket,
    @MessageBody() data: { trip_id: string; point: any },
  ) {
    await this.checkAccess(_client.data.userId, data.trip_id);
    // DB already saved via REST — just broadcast to other collaborators
    _client
      .to(`trip_${data.trip_id}`)
      .emit('point:added', { point: data.point });
  }

  @SubscribeMessage('point:move')
  async handlePointMove(
    @ConnectedSocket() _client: TypedSocket,
    @MessageBody()
    data: { trip_id: string; point_id: string; lat: number; lon: number },
  ) {
    await this.checkAccess(_client.data.userId, data.trip_id);
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
    await this.checkAccess(_client.data.userId, data.trip_id);
    // DB already saved via REST — just broadcast to other collaborators
    _client
      .to(`trip_${data.trip_id}`)
      .emit('point:deleted', { point_id: data.point_id });
  }

  @SubscribeMessage('point:update')
  async handlePointUpdate(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody()
    data: { trip_id: string; point_id: string } & Record<string, unknown>,
  ) {
    await this.checkAccess(client.data.userId, data.trip_id);
    const { trip_id, ...rest } = data;
    // DB already saved via HTTP PATCH — just broadcast to other collaborators
    client.to(`trip_${trip_id}`).emit('point:updated', rest);
  }

  @SubscribeMessage('point:reorder')
  async handlePointReorder(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() data: { trip_id: string; pointIds: string[] },
  ) {
    await this.checkAccess(client.data.userId, data.trip_id);
    // DB already saved via HTTP PATCH — just broadcast new order to other collaborators
    client.to(`trip_${data.trip_id}`).emit('point:reorder', {
      trip_id: data.trip_id,
      pointIds: data.pointIds,
    });
  }

  @SubscribeMessage('trip:update')
  async handleTripUpdate(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() data: { trip_id: string } & Record<string, unknown>,
  ) {
    await this.checkAccess(client.data.userId, data.trip_id);
    const { trip_id, ...patch } = data;
    // DB already saved via HTTP PATCH — just broadcast to other collaborators
    client.to(`trip_${trip_id}`).emit('trip:update', { trip_id, ...patch });
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

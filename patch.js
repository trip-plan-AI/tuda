const fs = require('fs');
const file = 'apps/api/src/collaboration/collaboration.gateway.ts';
let code = fs.readFileSync(file, 'utf8');

if (!code.includes('import { TripsService }')) {
  code = code.replace(
    "import { PointsService } from '../points/points.service';",
    "import { PointsService } from '../points/points.service';\nimport { TripsService } from '../trips/trips.service';\nimport { ForbiddenException } from '@nestjs/common';"
  );
  code = code.replace(
    "private pointsService: PointsService,",
    "private pointsService: PointsService,\n    private tripsService: TripsService,"
  );
}

// Add checkAccess helper
if (!code.includes('async checkAccess(userId: string, tripId: string)')) {
  code = code.replace(
    "handleConnection(client: TypedSocket) {",
    "async checkAccess(userId: string, tripId: string) {\n    const trip = await this.tripsService.findByIdWithAccess(tripId, userId);\n    if (trip.ownerId !== userId && !trip.ownerIsActive) {\n      throw new ForbiddenException('Route editing is disabled by the owner');\n    }\n    return trip;\n  }\n\n  handleConnection(client: TypedSocket) {"
  );
}

// Update point:add
code = code.replace(
  "async handlePointAdd(\n    @ConnectedSocket() _client: TypedSocket,\n    @MessageBody() data: CreatePointDto & { trip_id: string },\n  ) {\n    const { trip_id, ...dto } = data;",
  "async handlePointAdd(\n    @ConnectedSocket() _client: TypedSocket,\n    @MessageBody() data: CreatePointDto & { trip_id: string },\n  ) {\n    await this.checkAccess(_client.data.userId, data.trip_id);\n    const { trip_id, ...dto } = data;"
);

// Update point:move
code = code.replace(
  "async handlePointMove(\n    @ConnectedSocket() _client: TypedSocket,\n    @MessageBody()\n    data: { trip_id: string; point_id: string; lat: number; lon: number },\n  ) {\n    await this.pointsService.update(data.point_id, data.trip_id, {",
  "async handlePointMove(\n    @ConnectedSocket() _client: TypedSocket,\n    @MessageBody()\n    data: { trip_id: string; point_id: string; lat: number; lon: number },\n  ) {\n    await this.checkAccess(_client.data.userId, data.trip_id);\n    await this.pointsService.update(data.point_id, data.trip_id, {"
);

// Update point:delete
code = code.replace(
  "async handlePointDelete(\n    @ConnectedSocket() _client: TypedSocket,\n    @MessageBody() data: { trip_id: string; point_id: string },\n  ) {\n    await this.pointsService.remove(data.point_id, data.trip_id);",
  "async handlePointDelete(\n    @ConnectedSocket() _client: TypedSocket,\n    @MessageBody() data: { trip_id: string; point_id: string },\n  ) {\n    await this.checkAccess(_client.data.userId, data.trip_id);\n    await this.pointsService.remove(data.point_id, data.trip_id);"
);

// Update point:update
code = code.replace(
  "handlePointUpdate(\n    @ConnectedSocket() client: TypedSocket,\n    @MessageBody()\n    data: { trip_id: string; point_id: string } & Record<string, unknown>,\n  ) {\n    const { trip_id, ...rest } = data;",
  "async handlePointUpdate(\n    @ConnectedSocket() client: TypedSocket,\n    @MessageBody()\n    data: { trip_id: string; point_id: string } & Record<string, unknown>,\n  ) {\n    await this.checkAccess(client.data.userId, data.trip_id);\n    const { trip_id, ...rest } = data;"
);

// Update point:reorder
code = code.replace(
  "handlePointReorder(\n    @ConnectedSocket() client: TypedSocket,\n    @MessageBody() data: { trip_id: string; pointIds: string[] },\n  ) {",
  "async handlePointReorder(\n    @ConnectedSocket() client: TypedSocket,\n    @MessageBody() data: { trip_id: string; pointIds: string[] },\n  ) {\n    await this.checkAccess(client.data.userId, data.trip_id);"
);

// Update trip:update
code = code.replace(
  "handleTripUpdate(\n    @ConnectedSocket() client: TypedSocket,\n    @MessageBody() data: { trip_id: string } & Record<string, unknown>,\n  ) {\n    const { trip_id, ...patch } = data;",
  "async handleTripUpdate(\n    @ConnectedSocket() client: TypedSocket,\n    @MessageBody() data: { trip_id: string } & Record<string, unknown>,\n  ) {\n    await this.checkAccess(client.data.userId, data.trip_id);\n    const { trip_id, ...patch } = data;"
);

fs.writeFileSync(file, code);
console.log('patched');

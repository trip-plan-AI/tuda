import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { CollaboratorsService } from './collaborators.service';

@Injectable()
export class TripsService {
  constructor(
    @Inject(DRIZZLE)
    private db: NodePgDatabase<typeof schema>,
    private collaboratorsService: CollaboratorsService,
  ) {}

  async findAllForUser(userId: string) {
    // 1. Own trips
    const ownTrips = await this.db.query.trips.findMany({
      where: eq(schema.trips.ownerId, userId),
      orderBy: [desc(schema.trips.createdAt)],
      with: { points: { orderBy: [schema.routePoints.order] } },
    });

    // 2. Trips where user is a collaborator
    const collabRows = await this.db
      .select({ tripId: schema.tripCollaborators.tripId })
      .from(schema.tripCollaborators)
      .where(eq(schema.tripCollaborators.userId, userId));

    const collabIds = collabRows.map((r) => r.tripId);

    let collabTrips: typeof ownTrips = [];
    if (collabIds.length > 0) {
      collabTrips = await this.db.query.trips.findMany({
        where: inArray(schema.trips.id, collabIds),
        with: { points: { orderBy: [schema.routePoints.order] } },
      });
    }

    // 3. Merge, remove duplicates
    const allIds = new Set(ownTrips.map((t) => t.id));
    const unique = [...ownTrips];
    for (const t of collabTrips) {
      if (!allIds.has(t.id)) unique.push(t);
    }
    return unique;
  }

  findPredefined() {
    return this.db.query.trips.findMany({
      where: eq(schema.trips.isPredefined, true),
      with: { points: { orderBy: [schema.routePoints.order] } },
    });
  }

  async findById(id: string) {
    const trip = await this.db.query.trips.findFirst({
      where: eq(schema.trips.id, id),
    });
    if (!trip) throw new NotFoundException('Trip not found');
    return trip;
  }

  async findOne(tripId: string) {
    const trip = await this.db.query.trips.findFirst({
      where: eq(schema.trips.id, tripId),
      with: { points: { orderBy: [schema.routePoints.order] } },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    const collaborators = await this.collaboratorsService.getAll(tripId);

    const ownerRow = await this.db.query.users.findFirst({
      where: eq(schema.users.id, trip.ownerId),
    });
    const owner = ownerRow
      ? {
          id: ownerRow.id,
          name: ownerRow.name,
          email: ownerRow.email,
          photo: ownerRow.photo,
        }
      : null;

    return { ...trip, collaborators, owner };
  }

  async findByIdWithAccess(id: string, userId: string) {
    const trip = await this.findOne(id);
    if (trip.ownerId !== userId) {
      const collab = await this.db.query.tripCollaborators.findFirst({
        where: and(
          eq(schema.tripCollaborators.tripId, id),
          eq(schema.tripCollaborators.userId, userId),
        ),
      });
      if (!collab) throw new ForbiddenException('Access denied');
    }
    return trip;
  }

  async create(userId: string, dto: CreateTripDto) {
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }

    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    });

    if (!user) {
      throw new UnauthorizedException('User not found for current token');
    }

    const [trip] = await this.db
      .insert(schema.trips)
      .values({ ...dto, ownerId: userId })
      .returning();
    return trip;
  }

  async update(id: string, userId: string, dto: UpdateTripDto) {
    const trip = await this.findById(id);
    if (trip.ownerId !== userId)
      throw new ForbiddenException('Only owner can update');
    const [updated] = await this.db
      .update(schema.trips)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(schema.trips.id, id))
      .returning();
    return updated;
  }

  async remove(id: string, userId: string) {
    const trip = await this.findById(id);
    if (trip.ownerId !== userId)
      throw new ForbiddenException('Only owner can delete');
    await this.db.delete(schema.trips).where(eq(schema.trips.id, id));
    return { deleted: true };
  }
}

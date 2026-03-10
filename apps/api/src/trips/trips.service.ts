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
    // 1. Own trips — isActive from trips table
    const ownTrips = await this.db.query.trips.findMany({
      where: eq(schema.trips.ownerId, userId),
      orderBy: [desc(schema.trips.createdAt)],
      with: { points: { orderBy: [schema.routePoints.order] } },
    });

    // 2. Trips where user is a collaborator — isActive from tripCollaborators
    const collabRows = await this.db
      .select({
        tripId: schema.tripCollaborators.tripId,
        isActive: schema.tripCollaborators.isActive,
      })
      .from(schema.tripCollaborators)
      .where(eq(schema.tripCollaborators.userId, userId));

    const collabIds = collabRows.map((r) => r.tripId);
    const collabActiveMap = new Map(
      collabRows.map((r) => [r.tripId, r.isActive]),
    );

    let collabTrips: ((typeof ownTrips)[0] & { isActive: boolean; ownerIsActive: boolean })[] = [];
    if (collabIds.length > 0) {
      const trips = await this.db.query.trips.findMany({
        where: inArray(schema.trips.id, collabIds),
        with: { points: { orderBy: [schema.routePoints.order] } },
      });
      // Override isActive with the per-user value from tripCollaborators
      // ownerIsActive = global trips.isActive (the owner's activation state)
      collabTrips = trips.map((t) => ({
        ...t,
        ownerIsActive: t.isActive,
        isActive: collabActiveMap.get(t.id) ?? false,
      }));
    }

    // 3. Merge, skip own trips already in the list
    const ownIds = new Set(ownTrips.map((t) => t.id));
    return [...ownTrips, ...collabTrips.filter((t) => !ownIds.has(t.id))];
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
    const isOwner = trip.ownerId === userId;

    if (!isOwner) {
      // Verify collaborator access
      const collab = await this.db.query.tripCollaborators.findFirst({
        where: and(
          eq(schema.tripCollaborators.tripId, id),
          eq(schema.tripCollaborators.userId, userId),
        ),
      });
      if (!collab) throw new ForbiddenException('Access denied');

      // Collaborators can only change isActive — extra fields are silently ignored
      const { isActive } = dto;

      if (isActive !== undefined) {
        if (isActive) {
          // Deactivate all trips this user owns
          await this.db
            .update(schema.trips)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(schema.trips.ownerId, userId));
          // Deactivate all other collab memberships for this user
          await this.db
            .update(schema.tripCollaborators)
            .set({ isActive: false })
            .where(eq(schema.tripCollaborators.userId, userId));
          // Activate this trip for this collaborator
          await this.db
            .update(schema.tripCollaborators)
            .set({ isActive: true })
            .where(
              and(
                eq(schema.tripCollaborators.tripId, id),
                eq(schema.tripCollaborators.userId, userId),
              ),
            );
        } else {
          // Deactivate only for this collaborator
          await this.db
            .update(schema.tripCollaborators)
            .set({ isActive: false })
            .where(
              and(
                eq(schema.tripCollaborators.tripId, id),
                eq(schema.tripCollaborators.userId, userId),
              ),
            );
        }
      }
      return this.findById(id);
    }

    // Owner update
    if (dto.isActive !== undefined) {
      if (dto.isActive) {
        // Deactivate all other owner trips
        await this.db
          .update(schema.trips)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(schema.trips.ownerId, userId));
        // Deactivate all collab memberships for this user
        await this.db
          .update(schema.tripCollaborators)
          .set({ isActive: false })
          .where(eq(schema.tripCollaborators.userId, userId));
      } else {
        // Owner deactivating: force deactivate for ALL collaborators in this trip
        await this.db
          .update(schema.tripCollaborators)
          .set({ isActive: false })
          .where(eq(schema.tripCollaborators.tripId, id));
      }
    }

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

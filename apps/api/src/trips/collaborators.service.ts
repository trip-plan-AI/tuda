import { Injectable, Inject, ConflictException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';

@Injectable()
export class CollaboratorsService {
  constructor(@Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>) {}

  async getAll(tripId: string) {
    // Collaborators from trip_collaborators table
    const rows = await this.db
      .select({
        userId: schema.tripCollaborators.userId,
        role: schema.tripCollaborators.role,
        joinedAt: schema.tripCollaborators.joinedAt,
        name: schema.users.name,
        email: schema.users.email,
        photo: schema.users.photo,
      })
      .from(schema.tripCollaborators)
      .innerJoin(
        schema.users,
        eq(schema.tripCollaborators.userId, schema.users.id),
      )
      .where(eq(schema.tripCollaborators.tripId, tripId));

    // Owner — fetch via trips → users join
    const ownerRows = await this.db
      .select({
        userId: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        photo: schema.users.photo,
        joinedAt: schema.trips.createdAt,
      })
      .from(schema.trips)
      .innerJoin(schema.users, eq(schema.trips.ownerId, schema.users.id))
      .where(eq(schema.trips.id, tripId))
      .limit(1);

    if (ownerRows.length === 0) return rows;

    const ownerEntry = {
      userId: ownerRows[0].userId,
      role: 'owner' as const,
      joinedAt: ownerRows[0].joinedAt,
      name: ownerRows[0].name,
      email: ownerRows[0].email,
      photo: ownerRows[0].photo ?? undefined,
    };

    // Exclude owner from collaborators list in case they were added manually
    const filteredRows = rows.filter((r) => r.userId !== ownerRows[0].userId);

    return [ownerEntry, ...filteredRows];
  }

  async add(tripId: string, userId: string, role: 'editor' | 'viewer') {
    const existing = await this.db.query.tripCollaborators.findFirst({
      where: and(
        eq(schema.tripCollaborators.tripId, tripId),
        eq(schema.tripCollaborators.userId, userId),
      ),
    });
    if (existing) throw new ConflictException('Already a collaborator');

    await this.db
      .insert(schema.tripCollaborators)
      .values({ tripId, userId, role });

    const userRow = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    });

    return {
      userId,
      name: userRow?.name,
      email: userRow?.email,
      photo: userRow?.photo,
      role,
      joinedAt: new Date(),
    };
  }

  async findUserName(userId: string): Promise<string> {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    });
    return user?.name ?? user?.email ?? 'Пользователь';
  }

  async remove(tripId: string, userId: string) {
    await this.db
      .delete(schema.tripCollaborators)
      .where(
        and(
          eq(schema.tripCollaborators.tripId, tripId),
          eq(schema.tripCollaborators.userId, userId),
        ),
      );
    return { removed: true };
  }
}

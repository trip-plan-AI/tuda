import { Injectable, Inject, ConflictException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';

@Injectable()
export class CollaboratorsService {
  constructor(@Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>) {}

  async getAll(tripId: string) {
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
    return rows;
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

import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '../db/db.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';

export type NewTrip = typeof schema.trips.$inferInsert;

@Injectable()
export class TripsService {
  constructor(
    @Inject(DRIZZLE)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async findAll() {
    return await this.db.select().from(schema.trips).orderBy(schema.trips.createdAt);
  }

  async create(data: NewTrip) {
    const result = await this.db.insert(schema.trips).values(data).returning();
    return result[0];
  }
}
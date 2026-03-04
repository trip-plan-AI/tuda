import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'
import { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { eq, and, desc } from 'drizzle-orm'
import { DRIZZLE } from '../db/db.module'
import * as schema from '../db/schema'
import { CreateTripDto } from './dto/create-trip.dto'
import { UpdateTripDto } from './dto/update-trip.dto'

@Injectable()
export class TripsService {
  constructor(
    @Inject(DRIZZLE)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  findByOwner(userId: string) {
    return this.db.query.trips.findMany({
      where: eq(schema.trips.ownerId, userId),
      orderBy: [desc(schema.trips.createdAt)],
    })
  }

  findPredefined() {
    return this.db.query.trips.findMany({
      where: eq(schema.trips.isPredefined, true),
    })
  }

  async findById(id: string) {
    const trip = await this.db.query.trips.findFirst({
      where: eq(schema.trips.id, id),
    })
    if (!trip) throw new NotFoundException('Trip not found')
    return trip
  }

  async findByIdWithAccess(id: string, userId: string) {
    const trip = await this.findById(id)
    if (trip.ownerId !== userId) {
      const collab = await this.db.query.tripCollaborators.findFirst({
        where: and(
          eq(schema.tripCollaborators.tripId, id),
          eq(schema.tripCollaborators.userId, userId),
        ),
      })
      if (!collab) throw new ForbiddenException('Access denied')
    }
    return trip
  }

  async create(userId: string, dto: CreateTripDto) {
    const [trip] = await this.db
      .insert(schema.trips)
      .values({ ...dto, ownerId: userId })
      .returning()
    return trip
  }

  async update(id: string, userId: string, dto: UpdateTripDto) {
    const trip = await this.findById(id)
    if (trip.ownerId !== userId) throw new ForbiddenException('Only owner can update')
    const [updated] = await this.db
      .update(schema.trips)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(schema.trips.id, id))
      .returning()
    return updated
  }

  async remove(id: string, userId: string) {
    const trip = await this.findById(id)
    if (trip.ownerId !== userId) throw new ForbiddenException('Only owner can delete')
    await this.db.delete(schema.trips).where(eq(schema.trips.id, id))
    return { deleted: true }
  }
}

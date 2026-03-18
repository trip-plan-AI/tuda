import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, asc } from 'drizzle-orm';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';
import { CreatePointDto } from './dto/create-point.dto';
import { UpdatePointDto } from './dto/update-point.dto';
import { ReorderPointsDto } from './dto/reorder-points.dto';
import { TripImageService } from '../trips/trip-image.service';

@Injectable()
export class PointsService {
  constructor(
    @Inject(DRIZZLE)
    private db: NodePgDatabase<typeof schema>,
    private readonly tripImageService: TripImageService,
  ) {}

  findByTrip(tripId: string) {
    return this.db.query.routePoints.findMany({
      where: eq(schema.routePoints.tripId, tripId),
      orderBy: [asc(schema.routePoints.order)],
    });
  }

  async create(tripId: string, dto: CreatePointDto) {
    // Определяем следующий order
    const existing = await this.findByTrip(tripId);
    const nextOrder = dto.order ?? existing.length;

    const [point] = await this.db
      .insert(schema.routePoints)
      .values({ ...dto, tripId, order: nextOrder })
      .returning();

    this.triggerTripImageRecalculation(tripId);
    return point;
  }

  async update(id: string, tripId: string, dto: UpdatePointDto) {
    const point = await this.findOne(id, tripId);
    const [updated] = await this.db
      .update(schema.routePoints)
      .set(dto)
      .where(eq(schema.routePoints.id, point.id))
      .returning();

    this.triggerTripImageRecalculation(tripId);
    return updated;
  }

  async remove(id: string, tripId: string) {
    const point = await this.findOne(id, tripId);
    await this.db
      .delete(schema.routePoints)
      .where(eq(schema.routePoints.id, point.id));

    // Перенумеруем оставшиеся точки
    const remaining = await this.findByTrip(tripId);
    await Promise.all(
      remaining.map((p, idx) =>
        this.db
          .update(schema.routePoints)
          .set({ order: idx })
          .where(eq(schema.routePoints.id, p.id)),
      ),
    );

    this.triggerTripImageRecalculation(tripId);

    return { deleted: true };
  }

  async reorder(tripId: string, dto: ReorderPointsDto) {
    const existing = await this.findByTrip(tripId);
    const existingIds = new Set(existing.map((p) => p.id));

    if (
      dto.ids.length !== existing.length ||
      dto.ids.some((id) => !existingIds.has(id))
    ) {
      throw new BadRequestException(
        'ids must contain all point ids for this trip',
      );
    }

    await Promise.all(
      dto.ids.map((id, idx) =>
        this.db
          .update(schema.routePoints)
          .set({ order: idx })
          .where(eq(schema.routePoints.id, id)),
      ),
    );

    return this.findByTrip(tripId);
  }

  private async findOne(id: string, tripId: string) {
    const point = await this.db.query.routePoints.findFirst({
      where: eq(schema.routePoints.id, id),
    });
    if (!point || point.tripId !== tripId) {
      throw new NotFoundException('Point not found');
    }
    return point;
  }

  private triggerTripImageRecalculation(tripId: string): void {
    void this.tripImageService.resolveTripCover(tripId).catch(() => {
      // Ошибки внешних сервисов не должны ломать CRUD точек.
    });
  }
}

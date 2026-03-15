import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';
import type { RoutePlan, SessionMessage } from './types/pipeline.types';

interface AiSessionEntity {
  id: string;
  tripId: string | null;
  userId: string;
  messages: SessionMessage[];
  createdAt: Date;
}

@Injectable()
export class AiSessionsService {
  private readonly logger = new Logger(AiSessionsService.name);

  private deriveSessionTitleFromRoute(messages: SessionMessage[]): string {
    const lastWithRoute = [...messages]
      .reverse()
      .find((item) => item.role === 'assistant' && item.route_plan != null);

    if (!lastWithRoute?.route_plan) {
      // legacy fallback: route plan stored as JSON string in content
      const lastAssistant = [...messages]
        .reverse()
        .find((item) => item.role === 'assistant');
      if (!lastAssistant) return 'Новый чат';
      try {
        const parsed = JSON.parse(lastAssistant.content) as {
          days?: Array<{ points?: Array<{ poi?: { name?: string } }> }>;
        };
        const allPoints = (parsed.days ?? []).flatMap((d) => d.points ?? []);
        const first = allPoints[0]?.poi?.name?.trim();
        const last = allPoints[allPoints.length - 1]?.poi?.name?.trim();
        if (first && last && first !== last)
          return `${first} → ${last}`.slice(0, 60);
        if (first) return first.slice(0, 60);
      } catch {
        // not JSON
      }
      return 'Новый чат';
    }

    const allPoints = (lastWithRoute.route_plan.days ?? []).flatMap(
      (d) => d.points ?? [],
    );
    const first = allPoints[0]?.poi?.name?.trim();
    const last = allPoints[allPoints.length - 1]?.poi?.name?.trim();
    if (first && last && first !== last)
      return `${first} → ${last}`.slice(0, 60);
    if (first) return first.slice(0, 60);
    return 'Новый чат';
  }

  constructor(
    @Inject(DRIZZLE)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async applyRoutePlanToTrip(params: {
    sessionId: string;
    userId: string;
    routePlan: RoutePlan;
  }) {
    // TRI-104: AI Assistant -> Planner.
    // Назначение: атомарно создать/обновить trip из AI routePlan и поддержать связь 1:1 session<->trip.
    // MERGE-NOTE: если в других ветках меняется формат routePlan или стратегия апдейта точек,
    // синхронизируйте это место с endpoint `POST /ai/sessions/:id/apply`.
    const { sessionId, userId, routePlan } = params;

    if (!routePlan?.days?.length) {
      throw new BadRequestException('Route plan is empty');
    }

    const session = await this.getByIdForUser(sessionId, userId);
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const [user] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    const firstPoint = routePlan.days[0]?.points[0]?.poi;
    const fallbackTitle = routePlan.city
      ? `Маршрут по ${routePlan.city}`
      : firstPoint?.name
        ? `Маршрут: ${firstPoint.name}`
        : 'Маршрут из AI-чата';

    const tripId = session.tripId;
    const targetTrip = tripId
      ? await this.db.query.trips.findFirst({
          where: eq(schema.trips.id, tripId),
        })
      : null;

    const trip = targetTrip
      ? targetTrip
      : (
          await this.db
            .insert(schema.trips)
            .values({
              ownerId: userId,
              title: fallbackTitle,
              budget: Math.round(routePlan.total_budget_estimated || 0),
              isActive: false,
            })
            .returning()
        )[0];

    if (!trip) {
      throw new BadRequestException('Trip was not created');
    }

    if (targetTrip) {
      await this.db
        .update(schema.trips)
        .set({
          title: routePlan.city
            ? `Маршрут по ${routePlan.city}`
            : targetTrip.title,
          budget: Math.round(routePlan.total_budget_estimated || 0),
          updatedAt: new Date(),
        })
        .where(eq(schema.trips.id, trip.id));

      await this.db
        .delete(schema.routePoints)
        .where(eq(schema.routePoints.tripId, trip.id));
    }

    const pointsToInsert = routePlan.days.flatMap((day) =>
      day.points.map((point, index) => ({
        tripId: trip.id,
        title: point.poi?.name || `Точка ${index + 1}`,
        description: null,
        lat: point.poi?.coordinates?.lat ?? 0,
        lon: point.poi?.coordinates?.lon ?? 0,
        budget:
          typeof point.estimated_cost === 'number'
            ? Math.round(point.estimated_cost)
            : null,
        visitDate: day.date || null,
        imageUrl: point.poi?.image_url || null,
        address: point.poi?.address || null,
        transportMode: 'driving',
        order: point.order,
      })),
    );

    if (pointsToInsert.length > 0) {
      await this.db.insert(schema.routePoints).values(pointsToInsert);
    }

    if (session.tripId !== trip.id) {
      await this.db
        .update(schema.aiSessions)
        .set({ tripId: trip.id })
        .where(eq(schema.aiSessions.id, session.id));
    }

    return { tripId: trip.id, created: !targetTrip };
  }

  async getOrCreateByTrip(userId: string, tripId: string) {
    // TRI-104: гарантирует инвариант "один маршрут -> один AI-чат" для пользователя.
    // MERGE-NOTE: при изменении уникальности/индексов ai_sessions по tripId обновить эту выборку.
    const existing = await this.db.query.aiSessions.findFirst({
      where: and(
        eq(schema.aiSessions.userId, userId),
        eq(schema.aiSessions.tripId, tripId),
      ),
    });

    if (existing) {
      return {
        id: existing.id,
        tripId: existing.tripId,
        userId: existing.userId,
        messages: this.normalizeMessages(existing.messages),
        createdAt: existing.createdAt,
      };
    }

    const [created] = await this.db
      .insert(schema.aiSessions)
      .values({ userId, tripId, messages: [] })
      .returning();

    return {
      id: created.id,
      tripId: created.tripId,
      userId: created.userId,
      messages: [] as SessionMessage[],
      createdAt: created.createdAt,
    };
  }

  async appendMessages(sessionId: string, messages: SessionMessage[]) {
    // TRI-104: сервисный append для сценария инициализации чата из Planner.
    // MERGE-NOTE: не заменяет историю, а дописывает, чтобы не терять сообщения при параллельной работе.
    const current = await this.db.query.aiSessions.findFirst({
      where: eq(schema.aiSessions.id, sessionId),
    });
    if (!current) {
      throw new NotFoundException('Session not found');
    }

    const merged = [...this.normalizeMessages(current.messages), ...messages];
    await this.saveMessages(sessionId, merged);

    // Если название сессии ещё не установлено и добавлены сообщения с маршрутом,
    // сохраняем название на основе маршрута (чтобы оно не менялось при очистке сообщений)
    if (!current.title && messages.some((m) => (m as any).route_plan)) {
      const derivedTitle = this.deriveSessionTitleFromRoute(merged);
      if (derivedTitle !== 'Новый чат') {
        await this.db
          .update(schema.aiSessions)
          .set({ title: derivedTitle })
          .where(eq(schema.aiSessions.id, sessionId));
      }
    }

    this.logger.log(
      `Appended ${messages.length} message(s) to AI session ${sessionId}`,
    );
  }

  async listByUser(userId: string) {
    const rows = await this.db
      .select()
      .from(schema.aiSessions)
      .where(eq(schema.aiSessions.userId, userId))
      .orderBy(desc(schema.aiSessions.createdAt));

    return rows.map((row) => {
      const messages = this.normalizeMessages(row.messages);
      const routeDerivedTitle = this.deriveSessionTitleFromRoute(messages);

      return {
        id: row.id,
        trip_id: row.tripId,
        created_at: row.createdAt,
        title: row.title ?? routeDerivedTitle,
        messages_count: messages.length,
      };
    });
  }

  async getByIdForUser(
    sessionId: string,
    userId: string,
  ): Promise<AiSessionEntity | null> {
    const row = await this.db.query.aiSessions.findFirst({
      where: and(
        eq(schema.aiSessions.id, sessionId),
        eq(schema.aiSessions.userId, userId),
      ),
    });

    if (!row) return null;

    return {
      id: row.id,
      tripId: row.tripId,
      userId: row.userId,
      messages: this.normalizeMessages(row.messages),
      createdAt: row.createdAt,
    };
  }

  async deleteByIdForUser(sessionId: string, userId: string) {
    const result = await this.db
      .delete(schema.aiSessions)
      .where(
        and(
          eq(schema.aiSessions.id, sessionId),
          eq(schema.aiSessions.userId, userId),
        ),
      )
      .returning({ id: schema.aiSessions.id });

    return result.length > 0;
  }

  async renameSession(sessionId: string, userId: string, title: string) {
    const result = await this.db
      .update(schema.aiSessions)
      .set({ title })
      .where(
        and(
          eq(schema.aiSessions.id, sessionId),
          eq(schema.aiSessions.userId, userId),
        ),
      )
      .returning({ id: schema.aiSessions.id });

    return result.length > 0;
  }

  async getOrCreateForPlan(params: {
    tripId?: string;
    userId: string;
    sessionId?: string;
  }) {
    const { tripId, userId, sessionId } = params;

    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: жестко изолировать AI-сессии; при явном sessionId нельзя "переиспользовать"
    //    другой чат пользователя по trip_id/null-trip, иначе однословный запрос может попасть в старый контекст.
    // 3) Если убрать: вернется склейка чатов, появятся ложные маршруты (например, "небанальный" -> старый город).
    // 4) В этом блоке ранее не было веточного комментария; прямого конфликта со старым комментарием нет.

    if (sessionId) {
      const byId = await this.getByIdForUser(sessionId, userId);
      if (byId) return byId;
      throw new NotFoundException('AI session not found');
    }

    const [created] = await this.db
      .insert(schema.aiSessions)
      .values({ userId, tripId: tripId ?? null, messages: [] })
      .returning();

    return {
      id: created.id,
      tripId: created.tripId,
      userId: created.userId,
      messages: [] as SessionMessage[],
      createdAt: created.createdAt,
    };
  }

  async saveMessages(sessionId: string, messages: SessionMessage[]) {
    await this.db
      .update(schema.aiSessions)
      .set({ messages })
      .where(eq(schema.aiSessions.id, sessionId));
  }

  normalizeMessages(raw: unknown): SessionMessage[] {
    if (!Array.isArray(raw)) return [];

    return raw.filter(
      (item): item is SessionMessage =>
        !!item &&
        typeof item === 'object' &&
        'role' in item &&
        'content' in item &&
        ((item as { role?: unknown }).role === 'user' ||
          (item as { role?: unknown }).role === 'assistant') &&
        typeof (item as { content?: unknown }).content === 'string',
    );
  }
}

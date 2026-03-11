import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';
import type { SessionMessage } from './types/pipeline.types';

interface AiSessionEntity {
  id: string;
  tripId: string | null;
  userId: string;
  messages: SessionMessage[];
  createdAt: Date;
}

@Injectable()
export class AiSessionsService {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async listByUser(userId: string) {
    const rows = await this.db
      .select()
      .from(schema.aiSessions)
      .where(eq(schema.aiSessions.userId, userId))
      .orderBy(desc(schema.aiSessions.createdAt));

    return rows.map((row) => {
      const messages = this.normalizeMessages(row.messages);
      const firstUserMessage = messages.find((item) => item.role === 'user');

      return {
        id: row.id,
        trip_id: row.tripId,
        created_at: row.createdAt,
        title: (firstUserMessage?.content ?? 'Новый чат').slice(0, 60),
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

  async getOrCreateForPlan(params: {
    tripId?: string;
    userId: string;
    sessionId?: string;
  }) {
    const { tripId, userId, sessionId } = params;

    if (sessionId) {
      const byId = await this.getByIdForUser(sessionId, userId);
      if (byId) return byId;
    }

    const existing = await this.db.query.aiSessions.findFirst({
      where: tripId
        ? and(
            eq(schema.aiSessions.userId, userId),
            eq(schema.aiSessions.tripId, tripId),
          )
        : and(
            eq(schema.aiSessions.userId, userId),
            isNull(schema.aiSessions.tripId),
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

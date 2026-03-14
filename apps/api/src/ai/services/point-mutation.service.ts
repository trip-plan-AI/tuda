import { Injectable, BadRequestException, Inject, Logger } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../db/db.module';
import * as schema from '../../db/schema';
import { PointMutation } from '../types/mutations';
import { applyMutations } from './mutation-engine';
import { randomUUID } from 'node:crypto';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';

type DbRoutePoint = typeof schema.routePoints.$inferSelect;

@Injectable()
export class PointMutationService {
  private readonly logger = new Logger('AI:PointMutation');

  constructor(
    @Inject(DRIZZLE)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly collaborationGateway: CollaborationGateway,
  ) {}

  async applyMutations(
    tripId: string,
    userId: string,
    mutations: PointMutation[],
    ifMatch: number
  ) {
    console.log(`[PointMutationService] Applying ${mutations.length} mutations to trip ${tripId}`);
    return await this.db.transaction(async (tx) => {
      // 1. Get current trip and verify version
      const tripRows = await tx
        .select()
        .from(schema.trips)
        .where(eq(schema.trips.id, tripId))
        .limit(1);
        
      if (tripRows.length === 0) {
        throw new BadRequestException('Trip not found');
      }
      
      const trip = tripRows[0];
      if (trip.version !== ifMatch) {
        throw new BadRequestException('Version conflict - please refresh your client');
      }

      // 2. Get current points
      const currentPoints = await tx
        .select()
        .from(schema.routePoints)
        .where(eq(schema.routePoints.tripId, tripId))
        .orderBy(schema.routePoints.order, schema.routePoints.createdAt);

      // 3. Resolve References
      const resolvedMutations = await this.resolveReferences(mutations, currentPoints);
      console.log(`[PointMutationService] Resolved mutations:`, JSON.stringify(resolvedMutations));

      // 4. Apply mutations to memory state
      const mutatedPoints = applyMutations(currentPoints, resolvedMutations, (m) => ({
        id: randomUUID(),
        tripId,
        title: m.name,
        description: null,
        lat: 0,
        lon: 0,
        budget: null,
        visitDate: null,
        imageUrl: null,
        order: 0,
        address: null,
        transportMode: 'driving',
        isTitleLocked: false,
        createdAt: new Date(),
      }));

      // Update order based on array index
      const updatedPoints = mutatedPoints.map((p, idx) => ({
        ...p,
        order: idx,
        updatedAt: new Date()
      }));

      // 5. Compute diff and update DB
      console.log(`[PointMutationService] Syncing points to DB. Current count: ${currentPoints.length}, New count: ${updatedPoints.length}`);
      await this.syncPointsToDb(tx, currentPoints, updatedPoints);

      // 6. Update version
      const newVersion = ifMatch + 1;
      await tx
        .update(schema.trips)
        .set({ version: newVersion })
        .where(eq(schema.trips.id, tripId));

      // 7. Broadcast update
      this.logger.log(`Broadcasting trip_version_updated for trip ${tripId}, version ${newVersion}, points: ${updatedPoints.length}`);
      this.collaborationGateway.emitTripVersionUpdated(tripId, {
        version: newVersion,
        mutations: resolvedMutations,
        points: updatedPoints
      });

      return {
        success: true,
        version: newVersion,
        points: updatedPoints
      };
    });
  }

  async applyMutationsInMemory(mutations: PointMutation[], points: DbRoutePoint[]): Promise<DbRoutePoint[]> {
    const resolved = await this.resolveReferences(mutations, points);
    return applyMutations(points, resolved, (m) => ({
      id: randomUUID(),
      tripId: points[0]?.tripId ?? '',
      order: points.length,
      createdAt: new Date(),
      visitDate: points[0]?.visitDate ?? null,
      budget: 0,
      address: null,
      description: null,
      lat: 0,
      lon: 0,
      title: m.name,
    } as DbRoutePoint));
  }

  async resolveReferences(mutations: PointMutation[], points: DbRoutePoint[]): Promise<PointMutation[]> {
    const resolved: PointMutation[] = [];
    this.logger.log(`Resolving references among points: ${points.map(p => p.title).join(', ')}`);
    
    for (const mutation of mutations) {
      if (mutation.type === 'REMOVE_BY_QUERY') {
        // Нормализация: заменяем всё кроме букв/цифр на пробел, чтобы не сливать слова
        const toWords = (s: string) =>
          s.toLowerCase().replace(/[^а-яёa-z0-9]/g, ' ').trim().split(/\s+/).filter(w => w.length >= 2);

        const queryNormJoined = mutation.query.toLowerCase().replace(/[^а-яёa-z0-9]/g, '');
        const queryWords = toWords(mutation.query);
        // «Значимые» слова — 4+ символов (имена, существительные)
        const significantWords = queryWords.filter(w => w.length >= 4);

        const matches = points.filter(p => {
          const titleLow = p.title.toLowerCase().trim();
          const queryLow = mutation.query.toLowerCase().trim();

          // 1. Exact match (case insensitive) - highest priority
          if (titleLow === queryLow) return true;

          const titleNormJoined = titleLow.replace(/[^а-яёa-z0-9]/g, '');
          
          // 2. Exact match after normalization
          if (titleNormJoined === queryNormJoined && queryNormJoined.length > 0) return true;

          // 3. Word-overlap: count significant query words found in title
          if (significantWords.length === 0) return false;
          const titleWords = toWords(p.title);
          
          // Use strict word comparison to avoid "2" matching "22"
          const overlap = significantWords.filter(qw =>
            titleWords.some(tw => tw === qw),
          );
          
          // Threshold: at least 50% of significant words must match exactly
          return overlap.length >= Math.ceil(significantWords.length * 0.5);
        });
        
        if (matches.length > 0) {
          const toRemove = mutation.limit === 1 ? [matches[0].id] : matches.map(m => m.id);
          resolved.push({
            type: 'REMOVE_BY_ID',
            pointIds: toRemove
          });
        }
      } else {
        resolved.push(mutation);
      }
    }
    
    return resolved;
  }
  
  private async syncPointsToDb(tx: any, oldPoints: DbRoutePoint[], newPoints: DbRoutePoint[]) {
    const newPointIds = new Set(newPoints.map(p => p.id));
    const toDelete = oldPoints.filter(p => !newPointIds.has(p.id));
    
    if (toDelete.length > 0) {
      this.logger.log(`Deleting ${toDelete.length} points`);
      for (const p of toDelete) {
        await tx.delete(schema.routePoints).where(eq(schema.routePoints.id, p.id));
      }
    }
    
    const oldPointIds = new Set(oldPoints.map(p => p.id));
    const toInsert = newPoints.filter(p => !oldPointIds.has(p.id));
    
    if (toInsert.length > 0) {
      this.logger.log(`Inserting ${toInsert.length} new points`);
      await tx.insert(schema.routePoints).values(toInsert);
    }

    // Update existing points (order, title, etc)
    const toUpdate = newPoints.filter(p => oldPointIds.has(p.id));
    if (toUpdate.length > 0) {
      this.logger.log(`Updating ${toUpdate.length} existing points`);
      for (const p of toUpdate) {
        await tx.update(schema.routePoints)
          .set({
            order: p.order,
            title: p.title,
            lat: p.lat,
            lon: p.lon,
            address: p.address,
            transportMode: p.transportMode,
            updatedAt: new Date()
          })
          .where(eq(schema.routePoints.id, p.id));
      }
    }
  }
}

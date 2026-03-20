import { Injectable, Logger } from '@nestjs/common';
import type { ParsedIntent, PlanDay, PlanDayPoint, RoutePlan } from '../types/pipeline.types';
import type { FilteredPoi } from '../types/poi.types';
import type { PointMutation } from '../types/mutations';
import { SchedulerService } from '../pipeline/scheduler.service';
import { PoiResolverService } from './poi-resolver.service';

@Injectable()
export class RouteMutatorService {
  private readonly logger = new Logger('AI:RouteMutator');

  constructor(
    private readonly scheduler: SchedulerService,
    private readonly poiResolver: PoiResolverService,
  ) {}

  /**
   * Apply a list of parsed mutations to an existing route plan atomically:
   *   1. REMOVE operations first (by ID or by query)
   *   2. ADD operations second (inject from addCandidates pool or via PoiResolverService)
   *
   * @param plan            The current route plan
   * @param mutations       Parsed mutations (from MutationParserService)
   * @param intent          Current parsed intent (used for scheduler.injectPoints)
   * @param addCandidates   Pre-fetched POI candidates for ADD operations (from pipeline's
   *                        selectedForScheduler). Falls back to PoiResolverService if empty.
   */
  async applyMutations(
    plan: RoutePlan,
    mutations: PointMutation[],
    intent: ParsedIntent,
    addCandidates: FilteredPoi[] = [],
  ): Promise<RoutePlan> {
    // Deep clone to avoid mutating the original
    let days: PlanDay[] = plan.days.map((d) => ({ ...d, points: [...d.points] }));

    // ── 1. REMOVE FIRST ────────────────────────────────────────────────────────
    const removeMutations = mutations.filter(
      (m) => m.type === 'REMOVE_BY_ID' || m.type === 'REMOVE_BY_QUERY',
    );

    if (removeMutations.length > 0) {
      const modifiedDayIndices = new Set<number>();

      days = days.map((day, dayIdx) => {
        const before = day.points.length;
        let points = [...day.points];

        for (const m of removeMutations) {
          if (m.type === 'REMOVE_BY_ID') {
            const idSet = new Set(m.pointIds);
            points = points.filter((p) => !idSet.has(p.poi_id));
          } else if (m.type === 'REMOVE_BY_QUERY') {
            points = this.filterByQuery(points, m.query, m.limit ?? null);
          }
        }

        if (points.length !== before) modifiedDayIndices.add(dayIdx);
        return { ...day, points };
      });

      // Rebuild times for all modified days
      days = days.map((day, idx) =>
        modifiedDayIndices.has(idx) ? this.rebuildDayTimes(day) : day,
      );
    }

    // ── 2. ADD ─────────────────────────────────────────────────────────────────
    const addMutations = mutations.filter((m) => m.type === 'ADD');

    if (addMutations.length > 0) {
      let poisToInject: FilteredPoi[] = [];

      if (addCandidates.length > 0) {
        // Use the pre-fetched candidates from the main pipeline
        poisToInject = addCandidates.slice(0, addMutations.length);
      } else {
        // Resolve each ADD mutation by name via PoiResolverService
        const resolved = await Promise.all(
          addMutations.map((m) =>
            m.type === 'ADD'
              ? this.poiResolver.resolve({
                  name: m.name,
                  category: m.category,
                  city: plan.city,
                  intent,
                })
              : Promise.resolve(null),
          ),
        );
        poisToInject = resolved.filter((p): p is FilteredPoi => p !== null);
      }

      if (poisToInject.length > 0) {
        const intermediate: RoutePlan = {
          ...plan,
          days,
          total_budget_estimated: days.reduce((s, d) => s + (d.day_budget_estimated ?? 0), 0),
        };
        return this.scheduler.injectPoints(intermediate, poisToInject, {
          ...intent,
          days: Math.max(intent.days, days.length),
        });
      }
    }

    // ── 3. NORMALIZE & RETURN ─────────────────────────────────────────────────
    const normalizedDays = days
      .filter((d) => d.points.length > 0)
      .map((d, i) => ({ ...d, day_number: i + 1 }));

    return {
      ...plan,
      days: normalizedDays,
      total_budget_estimated: normalizedDays.reduce((s, d) => s + (d.day_budget_estimated ?? 0), 0),
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private filterByQuery(
    points: PlanDayPoint[],
    query: string,
    limit: number | null,
  ): PlanDayPoint[] {
    const q = query.toLowerCase().trim();
    let removedCount = 0;

    return points.filter((point) => {
      if (limit !== null && removedCount >= limit) return true;

      const name = (point.poi?.name ?? '').toLowerCase();
      const category = ((point.poi as any)?.category ?? '').toLowerCase();

      // Match if name contains query, or query contains first word of name,
      // or category matches query
      const matched =
        name.includes(q) ||
        (name.split(' ')[0] !== '' && q.includes(name.split(' ')[0]!)) ||
        category === q ||
        category.includes(q);

      if (matched) {
        removedCount++;
        this.logger.log(`[RouteMutator] REMOVE matched: "${point.poi?.name}" by query "${query}"`);
        return false;
      }
      return true;
    });
  }

  private rebuildDayTimes(day: PlanDay): PlanDay {
    let currentMin = this.timeToMin(day.day_start_time);

    const points: PlanDayPoint[] = day.points.map((p, i) => {
      const transitMins = i === 0 ? 0 : (p.travel_from_prev_min ?? 15);
      const arrivalMin = currentMin + transitMins;
      const duration = p.visit_duration_min || 60;
      const departureMin = arrivalMin + duration;
      currentMin = departureMin;

      return {
        ...p,
        order: i,
        arrival_time: this.minToTime(arrivalMin),
        departure_time: this.minToTime(departureMin),
      };
    });

    return {
      ...day,
      points,
      day_budget_estimated: points.reduce((s, p) => s + (p.estimated_cost ?? 0), 0),
    };
  }

  private timeToMin(t: string | undefined | null): number {
    if (!t) return 9 * 60;
    const parts = t.split(':');
    const h = parseInt(parts[0] ?? '9', 10);
    const m = parseInt(parts[1] ?? '0', 10);
    return h * 60 + (isNaN(m) ? 0 : m);
  }

  private minToTime(total: number): string {
    const clamped = Math.max(0, Math.min(23 * 60 + 59, total));
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

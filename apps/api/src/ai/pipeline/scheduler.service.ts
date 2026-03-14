import { Injectable, Logger } from '@nestjs/common';
import type {
  ParsedIntent,
  PlanDay,
  PlanDayPoint,
  RoutePlan,
} from '../types/pipeline.types';
import type { FilteredPoi } from '../types/poi.types';

// TRI-108-2: Realistic visit durations (in minutes)
// Museums/Galleries need 2-3 hours, not 1.5
const VISIT_DURATION: Record<string, number> = {
  museum: 150,      // 2.5 hours (was 90)
  gallery: 120,     // 2 hours
  park: 90,         // 1.5 hours (was 60)
  monument: 45,     // 45 min quick visit
  restaurant: 75,   // 1.25 hours with drinks (was 60)
  cafe: 45,         // 45 min coffee + snack (was 30)
  attraction: 90,   // 1.5 hours (was 60)
  shopping: 60,     // 1 hour (was 45)
  entertainment: 120, // 2 hours
  viewpoint: 30,    // Quick photo stop
  theater: 180,     // 3 hours (show + breaks)
  market: 60,       // 1 hour browsing
};

// TRI-108-2: Transit times between locations (in minutes)
// Realistic for city navigation, not optimistic
const TRANSIT_DURATION_BY_DISTANCE: Record<string, number> = {
  same_location: 5,    // Within same POI area
  same_district: 15,   // Within same neighborhood
  adjacent_district: 30, // Next to current area
  across_city: 50,     // Metro/taxi across city
  far_distance: 80,    // Long distance travel
};

const DEFAULT_TRANSIT_DURATION_MIN = 30; // Conservative default (was 25)
const RESTAURANT_MIN_GAP_MIN = 4 * 60;
const CAFE_AFTER_MEAL_MIN = 60;
const TIME_SHIFT_ON_FOOD_CONFLICT_MIN = 30;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger('AI_PIPELINE:Scheduler');

  rebuildSingleDayPlan(
    pois: FilteredPoi[],
    intent: ParsedIntent,
    dayTemplate: Pick<PlanDay, 'day_number' | 'date'>,
  ): PlanDay {
    const singleDayBudget =
      intent.budget_per_day ??
      (intent.budget_total !== null
        ? Math.max(0, Math.round(intent.budget_total))
        : null);

    const singleDayIntent: ParsedIntent = {
      ...intent,
      days: 1,
      budget_total: singleDayBudget,
      budget_per_day: singleDayBudget,
    };

    const rebuilt = this.buildPlan(pois, singleDayIntent);
    const rebuiltDay = rebuilt.days[0] ?? {
      day_number: dayTemplate.day_number,
      date: dayTemplate.date,
      day_budget_estimated: 0,
      day_start_time: intent.start_time,
      day_end_time: intent.end_time,
      points: [],
    };

    return {
      ...rebuiltDay,
      day_number: dayTemplate.day_number,
      date: dayTemplate.date,
    };
  }

  buildPlan(pois: FilteredPoi[], intent: ParsedIntent): RoutePlan {
    this.logger.log(
      `Starting to build route plan for ${intent.days} days with ${pois.length} selected POIs...`,
    );
    const startMinutes = this.timeToMinutes(intent.start_time);
    const endMinutes = this.timeToMinutes(intent.end_time);
    const dayBudget =
      intent.budget_per_day ??
      (intent.budget_total
        ? Math.max(0, Math.round(intent.budget_total / intent.days))
        : 0);
    const preferences = intent.preferences_text.toLowerCase();
    const skipFoodByUser =
      preferences.includes('без еды') ||
      preferences.includes('не нужно есть') ||
      preferences.includes('без питания') ||
      preferences.includes('без кафе') ||
      preferences.includes('без ресторанов');

    // Минимальная целевая ёмкость маршрута
    const targetPoiCount = intent.days * 2;
    const availablePois = [...pois];
    const totalNonFood = availablePois.filter(
      (p) => p.category !== 'restaurant' && p.category !== 'cafe',
    ).length;

    const days: PlanDay[] = [];
    const usedPoiIds = new Set<string>();

    for (let dayNumber = 1; dayNumber <= intent.days; dayNumber += 1) {
      const points: PlanDayPoint[] = [];
      let currentTime = startMinutes;
      let dayCost = 0;
      let dayRestaurantPoints = 0;
      let dayCafePoints = 0;
      let lastRestaurantArrival: number | null = null;

      const daysRemaining = intent.days - dayNumber + 1;
      const remainingUnique = availablePois.filter(
        (p) => !usedPoiIds.has(p.id),
      );
      const pointsForThisDay = Math.max(
        2,
        Math.ceil(remainingUnique.length / daysRemaining),
      );

      const remainingNonFood = remainingUnique.filter(
        (p) => p.category !== 'restaurant' && p.category !== 'cafe',
      );
      const remainingFood = remainingUnique.filter(
        (p) => p.category === 'restaurant' || p.category === 'cafe',
      );
      const nonFoodQuotaForDay = Math.max(
        remainingNonFood.length > 0 ? 1 : 0,
        Math.ceil(totalNonFood / intent.days),
      );
      let dayNonFoodPoints = 0;

      const tryAddPoint = (poi: FilteredPoi, customStart?: number): boolean => {
        const lastPoi =
          points.length > 0
            ? (points[points.length - 1].poi as FilteredPoi)
            : undefined;
        let transitTime = DEFAULT_TRANSIT_DURATION_MIN;

        if (lastPoi) {
          const dist = this.haversineKm(
            lastPoi.coordinates.lat,
            lastPoi.coordinates.lon,
            poi.coordinates.lat,
            poi.coordinates.lon,
          );
          // TRI-108-2: Realistic travel time calculation
          const rawMinutes =
            dist < 1.0
              ? (dist / 5) * 60
              : (dist / 25) * 60 + 10;
          transitTime = Math.max(5, Math.min(90, Math.round(rawMinutes)));
        } else {
          transitTime = 0;
        }

        const arrival = customStart ?? currentTime + transitTime;
        const baseDuration = VISIT_DURATION[poi.category] ?? 90;
        const visitDuration = Math.max(30, baseDuration);
        const leaveTime = arrival + visitDuration;

        if (leaveTime > endMinutes + 120) return false;

        const pointCost = this.estimatePointCost(poi, dayBudget);

        // BUDGET GUARD (TRI-104-BUDGET): Prevent adding points that would exceed budget significantly.
        // We allow 10% overflow to handle rounding and essential points.
        if (dayBudget > 0 && points.length > 0 && dayCost + pointCost > dayBudget * 1.1) {
          this.logger.debug(
            `Skipping point ${poi.name} (cost ${pointCost}) - day budget reached (${dayCost}/${dayBudget})`,
          );
          return false;
        }

        points.push({
          poi_id: poi.id,
          poi,
          order: points.length + 1,
          arrival_time: this.minutesToTime(arrival),
          departure_time: this.minutesToTime(leaveTime),
          visit_duration_min: visitDuration,
          travel_from_prev_min: points.length === 0 ? undefined : transitTime,
          estimated_cost: pointCost,
        });

        dayCost += pointCost;
        currentTime = leaveTime;
        usedPoiIds.add(poi.id);

        if (poi.category === 'restaurant') {
          dayRestaurantPoints += 1;
          lastRestaurantArrival = arrival;
        } else if (poi.category === 'cafe') {
          dayCafePoints += 1;
        } else {
          dayNonFoodPoints += 1;
        }

        return true;
      };

      // Шаг 1: минимум 1 non-food (если доступно)
      const mandatoryNonFood = remainingNonFood[0];
      if (mandatoryNonFood) {
        tryAddPoint(mandatoryNonFood);
      }

      // Шаг 2: минимум 1 food (если не отключено пользователем)
      if (!skipFoodByUser && remainingFood.length > 0) {
        const mandatoryFood =
          remainingFood.find((p) => p.category === 'restaurant') ??
          remainingFood[0];
        if (mandatoryFood && !usedPoiIds.has(mandatoryFood.id)) {
          const mealStart = Math.max(currentTime, startMinutes + 3 * 60);
          tryAddPoint(mandatoryFood, mealStart);
        }
      }

      // Шаг 3: заполняем день до целевого объема, соблюдая ограничения питания
      while (points.length < pointsForThisDay && currentTime < endMinutes) {
        const candidates = availablePois.filter((p) => !usedPoiIds.has(p.id));
        if (candidates.length === 0) break;
        const hasFoodCandidates = candidates.some(
          (p) => p.category === 'restaurant' || p.category === 'cafe',
        );

        // Фильтруем кандидатов по бизнес-правилам
        const validCandidates = candidates.filter((poi) => {
          if (poi.category === 'restaurant') {
            if (dayRestaurantPoints >= 3) return false;
            if (
              lastRestaurantArrival !== null &&
              currentTime - lastRestaurantArrival < RESTAURANT_MIN_GAP_MIN
            ) {
              return false;
            }
          }

          if (poi.category === 'cafe') {
            if (dayCafePoints >= 2) return false;
            if (
              lastRestaurantArrival !== null &&
              currentTime - lastRestaurantArrival < CAFE_AFTER_MEAL_MIN
            ) {
              return false;
            }
          }

          if (
            poi.category !== 'restaurant' &&
            poi.category !== 'cafe' &&
            dayNonFoodPoints >= nonFoodQuotaForDay &&
            hasFoodCandidates
          ) {
            return false;
          }

          return true;
        });

        if (validCandidates.length === 0) {
          currentTime += TIME_SHIFT_ON_FOOD_CONFLICT_MIN;
          continue;
        }

        // TRI-108-5: Use geographic optimization to minimize backtracking
        const lastPoi =
          points.length > 0
            ? (points[points.length - 1].poi as FilteredPoi)
            : undefined;
        const optimizedOrder = this.optimizeRouteOrder(validCandidates, lastPoi);
        
        let added = false;
        for (const next of optimizedOrder) {
          if (tryAddPoint(next)) {
            added = true;
            break;
          }
        }

        if (!added) {
          break;
        }
      }

      // TRI-108-3: Fill remaining budget with food POIs if available
      const remainingBudget = dayBudget - dayCost;
      const budgetUtilization = dayBudget > 0 ? (dayCost / dayBudget) * 100 : 100;

      if (remainingBudget > 500 && currentTime < endMinutes - 60) {
        // Try to add food venues to fill remaining budget
        const MAX_RESTAURANTS = 3;
        const MAX_CAFES = 2;

        const foodCandidates = availablePois.filter(
          (p) =>
            !usedPoiIds.has(p.id) &&
            (p.category === 'restaurant' || p.category === 'cafe') &&
            (p.category !== 'cafe' || dayCafePoints < MAX_CAFES) &&
            (p.category !== 'restaurant' || dayRestaurantPoints < MAX_RESTAURANTS),
        );

        // Sort by price (budget ones first to maximize count)
        foodCandidates.sort((a, b) => {
          const costA = this.estimatePointCost(a, dayBudget);
          const costB = this.estimatePointCost(b, dayBudget);
          return costA - costB;
        });

        // Add food POIs until budget exhausted or time exhausted
        for (const foodPoi of foodCandidates) {
          if (!tryAddPoint(foodPoi, currentTime)) {
            break; // Can't fit this one
          }
          const newBudget = dayBudget - dayCost;
          if (newBudget < 300) {
            break; // Remaining budget too small
          }
        }
      }

      this.logger.log(
        `[TRI-108-3] Day ${dayNumber}: spent ${dayCost}/${dayBudget} (${budgetUtilization.toFixed(0)}%)`,
      );

      days.push({
        day_number: dayNumber,
        date: this.dayDateFromNow(dayNumber - 1),
        day_budget_estimated: dayCost,
        day_start_time: intent.start_time,
        day_end_time: intent.end_time,
        points,
      });
    }

    const totalBudgetEstimated = days.reduce(
      (acc, day) => acc + day.day_budget_estimated,
      0,
    );

    const plan = {
      city: intent.city,
      total_budget_estimated: totalBudgetEstimated,
      days,
      notes:
        usedPoiIds.size < availablePois.length
          ? 'Часть точек не попала в расписание из-за ограничения времени дня.'
          : pois.length < targetPoiCount
            ? 'В городе недостаточно уникальных мест для полного покрытия всех дней.'
            : undefined,
    };

    this.logger.log(
      `Route plan successfully generated. Total budget estimated: ${totalBudgetEstimated} rub.`,
    );
    plan.days.forEach((day) => {
      this.logger.log(`  Day ${day.day_number}: ${day.points.length} points`);
      day.points.forEach((point) => {
        this.logger.log(
          `    - [${point.arrival_time}-${point.departure_time}] ${point.poi.name}`,
        );
      });
    });

    return plan;
  }

  private estimatePointCost(poi: FilteredPoi, dayBudget: number): number {
    if (poi.price_segment === 'free') return 0;
    
    // If budget is not specified (0), use reasonable defaults
    const budget = dayBudget > 0 ? dayBudget : 5000;
    
    if (poi.price_segment === 'budget')
      return Math.max(150, Math.round(budget * 0.1));
    if (poi.price_segment === 'mid')
      return Math.max(400, Math.round(budget * 0.2));
    if (poi.price_segment === 'premium')
      return Math.max(1000, Math.round(budget * 0.35));
    return Math.max(300, Math.round(budget * 0.12));
  }

  private timeToMinutes(value: string): number {
    const [h, m] = value.split(':').map(Number);
    return h * 60 + m;
  }

  private minutesToTime(total: number): string {
    const normalized = Math.max(0, Math.min(total, 23 * 60 + 59));
    const h = String(Math.floor(normalized / 60)).padStart(2, '0');
    const m = String(normalized % 60).padStart(2, '0');
    return `${h}:${m}`;
  }

  private dayDateFromNow(offsetDays: number): string {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }

  private haversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRad = (value: number) => (value * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // TRI-108-5: Geographic clustering for route optimization
  private clusterPoisByZone(pois: FilteredPoi[]): Map<string, FilteredPoi[]> {
    const clusters = new Map<string, FilteredPoi[]>();

    for (const poi of pois) {
      // Create zone key: round coordinates to 0.1 degree (~11km) grid
      const latZone = Math.round(poi.coordinates.lat * 10) / 10;
      const lonZone = Math.round(poi.coordinates.lon * 10) / 10;
      const zoneKey = `${latZone},${lonZone}`;

      if (!clusters.has(zoneKey)) {
        clusters.set(zoneKey, []);
      }
      clusters.get(zoneKey)!.push(poi);
    }

    return clusters;
  }

  // TRI-108-5: Sort POIs to minimize backtracking using nearest-neighbor with zone awareness
  private optimizeRouteOrder(candidates: FilteredPoi[], lastPoi?: FilteredPoi): FilteredPoi[] {
    if (candidates.length === 0) return [];
    if (candidates.length === 1) return candidates;

    const clusters = this.clusterPoisByZone(candidates);
    const clusterCenters = Array.from(clusters.entries()).map(([key, pois]) => {
      const avgLat = pois.reduce((sum, p) => sum + p.coordinates.lat, 0) / pois.length;
      const avgLon = pois.reduce((sum, p) => sum + p.coordinates.lon, 0) / pois.length;
      return { key, lat: avgLat, lon: avgLon, pois };
    });

    // Sort clusters by proximity to last position
    let currentLat = lastPoi?.coordinates.lat ?? 0;
    let currentLon = lastPoi?.coordinates.lon ?? 0;

    const sortedClusters: typeof clusterCenters = [];
    const visitedKeys = new Set<string>();

    // Greedy TSP: visit nearest unvisited cluster
    while (visitedKeys.size < clusterCenters.length) {
      let nearestCluster: (typeof clusterCenters)[number] | null = null;
      let minDistance = Infinity;

      for (const cluster of clusterCenters) {
        if (visitedKeys.has(cluster.key)) continue;
        const dist = this.haversineKm(currentLat, currentLon, cluster.lat, cluster.lon);
        if (dist < minDistance) {
          minDistance = dist;
          nearestCluster = cluster;
        }
      }

      if (nearestCluster !== null) {
        sortedClusters.push(nearestCluster);
        visitedKeys.add(nearestCluster.key);
        currentLat = nearestCluster.lat;
        currentLon = nearestCluster.lon;
      }
    }

    // Flatten clusters into ordered POI list
    const optimized: FilteredPoi[] = [];
    for (const cluster of sortedClusters) {
      // Within cluster, sort by proximity to cluster center
      const sortedPois = cluster.pois.sort((a, b) => {
        const distA = this.haversineKm(cluster.lat, cluster.lon, a.coordinates.lat, a.coordinates.lon);
        const distB = this.haversineKm(cluster.lat, cluster.lon, b.coordinates.lat, b.coordinates.lon);
        return distA - distB;
      });
      optimized.push(...sortedPois);
    }

    return optimized;
  }
}

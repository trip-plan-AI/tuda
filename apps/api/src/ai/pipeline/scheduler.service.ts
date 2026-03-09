import { Injectable, Logger } from '@nestjs/common';
import type {
  ParsedIntent,
  PlanDay,
  PlanDayPoint,
  RoutePlan,
} from '../types/pipeline.types';
import type { FilteredPoi } from '../types/poi.types';

const VISIT_DURATION: Record<string, number> = {
  museum: 90,
  park: 60,
  restaurant: 60,
  cafe: 30,
  attraction: 60,
  shopping: 45,
  entertainment: 120,
};

const TRANSIT_DURATION_MIN = 25;
const RESTAURANT_MIN_GAP_MIN = 4 * 60;
const CAFE_AFTER_MEAL_MIN = 60;
const TIME_SHIFT_ON_FOOD_CONFLICT_MIN = 30;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger('AI_PIPELINE:Scheduler');

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
    const expandedPois = [...pois];

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
      const remainingUnique = expandedPois.filter((p) => !usedPoiIds.has(p.id));
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

      const tryAddPoint = (poi: FilteredPoi, customStart?: number): boolean => {
        const arrival = customStart ?? currentTime;
        const visitDuration = VISIT_DURATION[poi.category] ?? 60;
        const leaveTime = arrival + visitDuration;
        if (leaveTime > endMinutes) return false;

        const pointCost = this.estimatePointCost(poi, dayBudget);
        points.push({
          poi_id: poi.id,
          poi,
          order: points.length + 1,
          arrival_time: this.minutesToTime(arrival),
          departure_time: this.minutesToTime(leaveTime),
          visit_duration_min: visitDuration,
          travel_from_prev_min:
            points.length === 1 ? undefined : TRANSIT_DURATION_MIN,
          estimated_cost: pointCost,
        });

        dayCost += pointCost;
        currentTime = leaveTime + TRANSIT_DURATION_MIN;
        usedPoiIds.add(poi.id);

        if (poi.category === 'restaurant') {
          dayRestaurantPoints += 1;
          lastRestaurantArrival = arrival;
        } else if (poi.category === 'cafe') {
          dayCafePoints += 1;
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
        const candidates = expandedPois.filter((p) => !usedPoiIds.has(p.id));
        if (candidates.length === 0) break;

        const next = candidates.find((poi) => {
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

          return true;
        });

        if (!next) {
          currentTime += TIME_SHIFT_ON_FOOD_CONFLICT_MIN;
          continue;
        }

        if (!tryAddPoint(next)) {
          break;
        }
      }

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
        usedPoiIds.size < expandedPois.length
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
    if (poi.price_segment === 'budget')
      return Math.max(300, Math.round(dayBudget * 0.1));
    if (poi.price_segment === 'mid')
      return Math.max(700, Math.round(dayBudget * 0.2));
    if (poi.price_segment === 'premium')
      return Math.max(1500, Math.round(dayBudget * 0.35));
    return Math.max(400, Math.round(dayBudget * 0.12));
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
}

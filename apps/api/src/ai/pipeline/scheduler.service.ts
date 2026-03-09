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

    // Добавляем POI до необходимого минимума, дублируя если не хватает
    const targetPoiCount = intent.days * 2;
    const expandedPois = [...pois];
    if (expandedPois.length > 0 && expandedPois.length < targetPoiCount) {
      this.logger.warn(
        `Only ${expandedPois.length} POIs available, but ${targetPoiCount} needed. Duplicating points to ensure minimum 2 per day.`,
      );
      let cloneCursor = 0;
      while (expandedPois.length < targetPoiCount) {
        expandedPois.push(expandedPois[cloneCursor % pois.length]);
        cloneCursor++;
      }
    }

    const days: PlanDay[] = [];
    let poiCursor = 0;

    for (let dayNumber = 1; dayNumber <= intent.days; dayNumber += 1) {
      const points: PlanDayPoint[] = [];
      let currentTime = startMinutes;
      let dayCost = 0;

      // Выделяем POI для текущего дня
      // Либо равномерно, либо минимум 2
      const pointsRemaining = expandedPois.length - poiCursor;
      const daysRemaining = intent.days - dayNumber + 1;
      const pointsForThisDay = Math.max(
        2,
        Math.ceil(pointsRemaining / daysRemaining),
      );

      let currentDayPoints = 0;
      let dayFoodPoints = 0;

      let lastRestaurantArrival: number | null = null;

      while (
        poiCursor < expandedPois.length &&
        currentDayPoints < pointsForThisDay
      ) {
        const poi = expandedPois[poiCursor];
        const isRestaurant = poi.category === 'restaurant';
        const isCafe = poi.category === 'cafe';

        if (
          isRestaurant &&
          lastRestaurantArrival !== null &&
          currentTime - lastRestaurantArrival < RESTAURANT_MIN_GAP_MIN
        ) {
          currentTime += TIME_SHIFT_ON_FOOD_CONFLICT_MIN;
          if (currentTime >= endMinutes) break;
          continue;
        }

        if (
          isCafe &&
          lastRestaurantArrival !== null &&
          currentTime - lastRestaurantArrival < CAFE_AFTER_MEAL_MIN
        ) {
          currentTime += TIME_SHIFT_ON_FOOD_CONFLICT_MIN;
          if (currentTime >= endMinutes) break;
          continue;
        }

        const visitDuration = VISIT_DURATION[poi.category] ?? 60;
        const pointCost = this.estimatePointCost(poi, dayBudget);
        const leaveTime = currentTime + visitDuration;

        if (leaveTime > endMinutes) break;

        points.push({
          poi_id: poi.id,
          poi,
          order: points.length + 1,
          arrival_time: this.minutesToTime(currentTime),
          departure_time: this.minutesToTime(leaveTime),
          visit_duration_min: visitDuration,
          travel_from_prev_min:
            points.length === 0 ? undefined : TRANSIT_DURATION_MIN,
          estimated_cost: pointCost,
        });

        dayCost += pointCost;
        if (isRestaurant) {
          lastRestaurantArrival = currentTime;
        }
        if (isRestaurant || isCafe) {
          dayFoodPoints += 1;
        }
        poiCursor += 1;
        currentDayPoints += 1;
        currentTime = leaveTime + TRANSIT_DURATION_MIN;

        if (currentTime >= endMinutes && currentDayPoints >= 2) break; // Позволяем превысить время, если не набрали 2 точки
      }

      if (!skipFoodByUser && dayFoodPoints === 0) {
        const fallbackFoodPoi =
          expandedPois
            .slice(poiCursor)
            .find((p) => p.category === 'restaurant') ??
          expandedPois.find((p) => p.category === 'restaurant') ??
          expandedPois.slice(poiCursor).find((p) => p.category === 'cafe') ??
          expandedPois.find((p) => p.category === 'cafe');

        if (fallbackFoodPoi) {
          const visitDuration = VISIT_DURATION[fallbackFoodPoi.category] ?? 60;
          const baseStart =
            points.length > 0
              ? Math.max(currentTime, startMinutes + 4 * 60)
              : Math.max(startMinutes + 4 * 60, startMinutes);
          const leaveTime = baseStart + visitDuration;

          if (leaveTime <= endMinutes) {
            const pointCost = this.estimatePointCost(
              fallbackFoodPoi,
              dayBudget,
            );
            points.push({
              poi_id: fallbackFoodPoi.id,
              poi: fallbackFoodPoi,
              order: points.length + 1,
              arrival_time: this.minutesToTime(baseStart),
              departure_time: this.minutesToTime(leaveTime),
              visit_duration_min: visitDuration,
              travel_from_prev_min:
                points.length === 0 ? undefined : TRANSIT_DURATION_MIN,
              estimated_cost: pointCost,
            });
            dayCost += pointCost;
          }
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
        poiCursor < expandedPois.length
          ? 'Часть точек не попала в расписание из-за ограничения времени дня.'
          : pois.length < targetPoiCount
            ? 'Из-за недостатка мест в городе некоторые точки добавлены в маршрут повторно.'
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

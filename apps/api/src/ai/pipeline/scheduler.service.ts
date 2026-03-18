import { Injectable, Logger } from '@nestjs/common';
import type {
  ParsedIntent,
  PlanDay,
  PlanDayPoint,
  RoutePlan,
} from '../types/pipeline.types';
import type { FilteredPoi } from '../types/poi.types';

// TRI-108-2: Realistic visit durations (in minutes)
const VISIT_DURATION: Record<string, number> = {
  museum: 150,
  gallery: 120,
  park: 90,
  monument: 45,
  restaurant: 75,
  cafe: 45,
  attraction: 90,
  shopping: 60,
  entertainment: 120,
  viewpoint: 30,
  theater: 180,
  market: 60,
};

const DEFAULT_TRANSIT_DURATION_MIN = 30;
const RESTAURANT_MIN_GAP_MIN = 4 * 60;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger('AI_PIPELINE:Scheduler');

  private calculateAngle(
    p1: { lat: number; lon: number },
    p2: { lat: number; lon: number },
    p3: { lat: number; lon: number },
  ): number {
    const v1 = { x: p1.lat - p2.lat, y: p1.lon - p2.lon };
    const v2 = { x: p3.lat - p2.lat, y: p3.lon - p2.lon };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
    const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
    if (mag1 === 0 || mag2 === 0) return 0;
    const angle = Math.acos(Math.min(1, Math.max(-1, dot / (mag1 * mag2))));
    return (angle * 180) / Math.PI;
  }

  public injectPoints(
    existingPlan: RoutePlan,
    pointsToAdd: FilteredPoi[],
    intent: ParsedIntent,
  ): RoutePlan {
    this.logger.log(
      `Injecting ${pointsToAdd.length} new points into existing plan.`,
    );
    const existingPois = existingPlan.days.flatMap((day) =>
      day.points.map((p) => p.poi as FilteredPoi),
    );

    const combinedPois = [...existingPois, ...pointsToAdd];

    const seen = new Set<string>();
    const uniquePois = combinedPois.filter((p) => {
      if (!p || !p.id) return false;
      if (seen.has(p.id)) {
        return false;
      }
      seen.add(p.id);
      return true;
    });

    return this.buildPlan(uniquePois, intent);
  }

  private clusterizeByCentroid(
    pois: FilteredPoi[],
    days: number,
  ): Record<number, FilteredPoi[]> {
    if (days <= 1 || pois.length <= days) {
      return { 1: pois };
    }

    // 1. Сортируем по весу (score) или aiWeight
    const sortedPois = [...pois].sort((a, b) => {
      const scoreA = a.score || ((a as any).aiWeight ? (a as any).aiWeight / 100 : 0);
      const scoreB = b.score || ((b as any).aiWeight ? (b as any).aiWeight / 100 : 0);
      return scoreB - scoreA;
    });

    // 2. Выбираем якоря для каждого дня
    const anchors = [sortedPois[0]];
    const unselected = new Set(sortedPois.slice(1));

    for (let i = 1; i < days; i++) {
      let maxDist = -1;
      let nextAnchor: FilteredPoi | null = null;

      for (const poi of unselected) {
        let minDistToAnchor = Infinity;
        for (const anchor of anchors) {
          const dist = this.haversineKm(
            poi.coordinates.lat,
            poi.coordinates.lon,
            anchor.coordinates.lat,
            anchor.coordinates.lon,
          );
          if (dist < minDistToAnchor) minDistToAnchor = dist;
        }

        if (minDistToAnchor > maxDist) {
          maxDist = minDistToAnchor;
          nextAnchor = poi;
        }
      }

      if (nextAnchor) {
        anchors.push(nextAnchor);
        unselected.delete(nextAnchor);
      }
    }

    // 3. Распределяем остальные точки по ближайшим якорям
    const clusters: Record<number, FilteredPoi[]> = {};
    for (let i = 1; i <= days; i++) clusters[i] = [];

    for (const poi of pois) {
      let minDist = Infinity;
      let bestDay = 1;

      for (let i = 0; i < anchors.length; i++) {
        const dist = this.haversineKm(
          poi.coordinates.lat,
          poi.coordinates.lon,
          anchors[i].coordinates.lat,
          anchors[i].coordinates.lon,
        );
        if (dist < minDist) {
          minDist = dist;
          bestDay = i + 1;
        }
      }
      clusters[bestDay].push(poi);
    }

    return clusters;
  }

  public rebuildSingleDayPlan(
    poisForDay: FilteredPoi[],
    intent: ParsedIntent,
    dayInfo: { day_number: number; date: string },
  ): PlanDay {
    this.logger.log(
      `Rebuilding plan for day ${dayInfo.day_number} with ${poisForDay.length} points...`,
    );

    // --- Copy setup from buildPlan ---
    const startMinutes = this.timeToMinutes(intent.start_time);
    const endMinutes = this.timeToMinutes(intent.end_time);
    const dayBudget =
      intent.budget_per_day ??
      (intent.budget_total ? Math.round(intent.budget_total / intent.days) : 0);
    const preferences = intent.preferences_text.toLowerCase();
    const isRelaxMode =
      preferences.includes('расслабленно') ||
      preferences.includes('неспешно') ||
      preferences.includes('отдых');
    const lovesCoffee =
      preferences.includes('кофе') || preferences.includes('кофейн');
    const lovesNature =
      preferences.includes('природ') ||
      preferences.includes('парк') ||
      preferences.includes('лес');
    const dislikesMuseums =
      preferences.includes('без музеев') ||
      preferences.includes('не люблю музеи');

    const userProfile = intent.user_profile;
    const walkingSpeed = userProfile?.behavior?.walkingSpeed || 1.0;
    const stayMultipliers = userProfile?.behavior?.stayMultiplier || {};
    const categoryAffinity = userProfile?.categoryAffinity || {};
    const diversityPressure = 1.0; // High diversity for rebuild
    const isSmallSet = poisForDay.length < 15;

    // --- Day-specific state ---
    const points: PlanDayPoint[] = [];
    let currentTime = startMinutes;
    let energyLevel = 100;
    let dayCost = 0;
    let dayRestaurantPoints = 0;
    let dayCafePoints = 0;
    let lastFoodTime: number | null = null;
    let lastMealType: 'lunch' | 'dinner' | 'other' | null = null;

    const tryAddPoint = (
      poi: FilteredPoi,
      customStart?: number,
      force = false,
    ): boolean => {
      const lastPoint = points.length > 0 ? points[points.length - 1] : null;
      const lastPoi = lastPoint ? (lastPoint.poi as FilteredPoi) : undefined;
      let transitTime = DEFAULT_TRANSIT_DURATION_MIN;

      // RELAXATION
      const relaxAll = force || (isSmallSet && points.length < 4);

      if (lastPoi) {
        const dist = this.haversineKm(
          lastPoi.coordinates.lat,
          lastPoi.coordinates.lon,
          poi.coordinates.lat,
          poi.coordinates.lon,
        );
        if (dist > 50) {
          transitTime = Math.round((dist / 80) * 60);
        } else {
          const rawMinutes =
            dist < 1.0 ? (dist / 5) * 60 : (dist / 25) * 60 + 10;
          let finalTransit = Math.round(rawMinutes / walkingSpeed);
          if (isSmallSet) finalTransit = Math.round(finalTransit * 0.7);
          transitTime = Math.max(5, Math.min(90, finalTransit));
        }
      } else {
        transitTime = 0;
      }

      const arrival = customStart ?? currentTime + transitTime;
      const isFood = this.isFoodCategory(poi.category);
      const mealType = isFood ? this.getMealType(arrival) : null;
      const isHeavy =
        poi.category === 'museum' || ((poi as any).duration || 0) > 90;

      if (!relaxAll) {
        if (lastPoi && this.isFoodCategory(lastPoi.category) && isFood)
          return false;
        if (energyLevel < 35 && isHeavy && !isFood) return false;
        if (
          lastPoi &&
          this.isFoodCategory(lastPoi.category) &&
          this.getMealType(this.timeToMinutes(lastPoint?.arrival_time)) ===
            'dinner'
        ) {
          if (!this.isPostDinnerHighlight(poi) && !isFood) return false;
          if (
            this.haversineKm(
              lastPoi.coordinates.lat,
              lastPoi.coordinates.lon,
              poi.coordinates.lat,
              poi.coordinates.lon,
            ) > 1.2
          )
            return false;
        }
      }

      let visitDuration = VISIT_DURATION[poi.category] ?? 60;
      if (isFood) visitDuration = mealType === 'dinner' ? 90 : 50;

      const explanations: string[] = [];
      const stayMultiplier = stayMultipliers[poi.category || ''] || 1.0;
      if (stayMultiplier !== 1.0) {
        explanations.push(
          `Adjusted duration based on your typical stay time for ${poi.category}`,
        );
      }
      visitDuration *= stayMultiplier;

      if (isSmallSet) visitDuration *= 0.8;
      if (isRelaxMode || energyLevel < 40) visitDuration *= 1.2;
      visitDuration = Math.max(20, Math.round(visitDuration));

      if (walkingSpeed !== 1.0 && transitTime > 0) {
        explanations.push(
          `Calculated transit time adjusted for your walking pace`,
        );
      }

      const affinity = categoryAffinity[poi.category || ''] || 0;
      if (affinity > 0.4) {
        explanations.push(
          `Added because you often choose ${poi.category} places`,
        );
      }

      const leaveTime = arrival + visitDuration;
      if (!relaxAll && leaveTime > endMinutes + 60) return false;

      points.push({
        poi_id: poi.id,
        poi,
        order: points.length + 1,
        arrival_time: this.minutesToTime(arrival),
        departure_time: this.minutesToTime(leaveTime),
        visit_duration_min: visitDuration,
        travel_from_prev_min: points.length === 0 ? undefined : transitTime,
        estimated_cost: this.estimatePointCost(poi, dayBudget),
        ai_explanations: explanations.length > 0 ? explanations : undefined,
      });

      dayCost += points[points.length - 1].estimated_cost;
      currentTime = leaveTime;

      if (isFood) energyLevel = Math.min(100, energyLevel + 25);
      else {
        energyLevel -= isHeavy ? 15 : 8;
        energyLevel -= Math.round(transitTime / 5);
      }
      energyLevel = Math.max(0, energyLevel);

      if (isFood) {
        if (poi.category === 'restaurant') dayRestaurantPoints += 1;
        else dayCafePoints += 1;
        lastFoodTime = arrival;
        lastMealType = mealType;
      }
      return true;
    };

    const availablePois = [...poisForDay];
    const usedPoiIdsInDay = new Set<string>();

    const firstPoi =
      availablePois.find((p) => !this.isFoodCategory(p.category)) ||
      availablePois[0];
    if (firstPoi) {
      tryAddPoint(firstPoi);
      usedPoiIdsInDay.add(firstPoi.id);
    }

    const MIN_POINTS_PER_DAY = isSmallSet ? 4 : 3;

    while (points.length < poisForDay.length && currentTime < endMinutes) {
      const candidates = availablePois.filter(
        (p) => !usedPoiIdsInDay.has(p.id),
      );
      if (candidates.length === 0) break;

      const lastPoint = points.length > 0 ? points[points.length - 1] : null;
      const lastPoi = lastPoint ? (lastPoint.poi as FilteredPoi) : undefined;
      const prevPoi =
        points.length > 1 ? points[points.length - 2].poi : undefined;

      let validCandidates = candidates.filter((poi) => {
        const cat = poi.category || '';
        const isFood = this.isFoodCategory(cat);
        if (lastPoi && lastPoi.category === cat && !isFood) {
          if (Math.random() < diversityPressure) return false;
        }
        if (isFood) {
          if (lastPoi && this.isFoodCategory(lastPoi.category)) return false;
        }
        if (dislikesMuseums && cat === 'museum') return false;
        return true;
      });

      if (validCandidates.length === 0) {
        if (points.length < MIN_POINTS_PER_DAY) {
          validCandidates = candidates.slice(0, 3);
        } else {
          break;
        }
      }

      const optimizedOrder = validCandidates.sort((a, b) => {
        const distA = lastPoi
          ? this.haversineKm(
              lastPoi.coordinates.lat,
              lastPoi.coordinates.lon,
              a.coordinates.lat,
              a.coordinates.lon,
            )
          : 0;
        const distB = lastPoi
          ? this.haversineKm(
              lastPoi.coordinates.lat,
              lastPoi.coordinates.lon,
              b.coordinates.lat,
              b.coordinates.lon,
            )
          : 0;

        const weightA = (a as any).aiWeight || 0;
        const weightB = (b as any).aiWeight || 0;

        // DISTANCE PENALTY: нелинейный штраф за дальние переезды (> 10 км)
        const distPenaltyA = distA > 10 ? distA * 3 : distA;
        const distPenaltyB = distB > 10 ? distB * 3 : distB;

        let scoreA = distPenaltyA - weightA / 60;
        let scoreB = distPenaltyB - weightB / 60;

        if (prevPoi && lastPoi) {
          const angleA = this.calculateAngle(
            prevPoi.coordinates,
            lastPoi.coordinates,
            a.coordinates,
          );
          const angleB = this.calculateAngle(
            prevPoi.coordinates,
            lastPoi.coordinates,
            b.coordinates,
          );
          const pA = angleA > 115 ? 2.0 : 0;
          const pB = angleB > 115 ? 2.0 : 0;
          scoreA += pA * (weightA > 65 ? 0.2 : 1.0);
          scoreB += pB * (weightB > 65 ? 0.2 : 1.0);
        }

        const affinityA = categoryAffinity[a.category || ''] || 0;
        const affinityB = categoryAffinity[b.category || ''] || 0;
        const boostA = Math.min(affinityA, 0.8) * 1.5;
        const boostB = Math.min(affinityB, 0.8) * 1.5;
        scoreA -= boostA;
        scoreB -= boostB;

        if (lovesCoffee && a.category === 'cafe') scoreA -= 1;
        if (lovesCoffee && b.category === 'cafe') scoreB -= 1;
        if (
          lovesNature &&
          ['park', 'garden', 'forest'].includes(a.category || '')
        )
          scoreA -= 0.8;
        if (
          lovesNature &&
          ['park', 'garden', 'forest'].includes(b.category || '')
        )
          scoreB -= 0.8;

        return scoreA - scoreB;
      });

      let added = false;
      for (const next of optimizedOrder) {
        if (tryAddPoint(next)) {
          added = true;
          usedPoiIdsInDay.add(next.id);
          break;
        }
      }

      if (!added) {
        // Fallback
        if (points.length < MIN_POINTS_PER_DAY && candidates.length > 0) {
          const fallbackPoint = candidates.sort((a, b) => {
            const distA = lastPoi
              ? this.haversineKm(
                  lastPoi.coordinates.lat,
                  lastPoi.coordinates.lon,
                  a.coordinates.lat,
                  a.coordinates.lon,
                )
              : 0;
            const distB = lastPoi
              ? this.haversineKm(
                  lastPoi.coordinates.lat,
                  lastPoi.coordinates.lon,
                  b.coordinates.lat,
                  b.coordinates.lon,
                )
              : 0;
            return distA - distB;
          })[0];
          if (tryAddPoint(fallbackPoint, undefined, true)) {
            added = true;
            usedPoiIdsInDay.add(fallbackPoint.id);
          }
        }
      }

      if (!added) {
        break;
      }
    }

    return {
      day_number: dayInfo.day_number,
      date: dayInfo.date,
      day_budget_estimated: dayCost,
      day_start_time: intent.start_time,
      day_end_time: intent.end_time,
      points,
    };
  }

  buildPlan(
    pois: FilteredPoi[],
    intent: ParsedIntent & { city_from?: string; city_to?: string },
  ): RoutePlan {
    this.logger.log(
      `Building plan v7 (Contextual Wisdom) for ${intent.days} days...`,
    );

    const startMinutes = this.timeToMinutes(intent.start_time);
    const endMinutes = this.timeToMinutes(intent.end_time);
    const dayBudget =
      intent.budget_per_day ??
      (intent.budget_total ? Math.round(intent.budget_total / intent.days) : 0);
    const preferences = intent.preferences_text.toLowerCase();

    // Context Detection
    const isRelaxMode =
      preferences.includes('расслабленно') ||
      preferences.includes('неспешно') ||
      preferences.includes('отдых');
    const isExploreMode =
      preferences.includes('активно') ||
      preferences.includes('все посмотреть') ||
      preferences.includes('максимум');
    const lovesCoffee =
      preferences.includes('кофе') || preferences.includes('кофейн');
    const lovesNature =
      preferences.includes('природ') ||
      preferences.includes('парк') ||
      preferences.includes('лес');
    const dislikesMuseums =
      preferences.includes('без музеев') ||
      preferences.includes('не люблю музеи');
    const isRainy =
      preferences.includes('дождь') || preferences.includes('ливень');
    const isCold =
      preferences.includes('холодно') ||
      preferences.includes('мороз') ||
      preferences.includes('зима');

    const userProfile = intent.user_profile;
    const walkingSpeed = userProfile?.behavior?.walkingSpeed || 1.0;
    const stayMultipliers = userProfile?.behavior?.stayMultiplier || {};
    const categoryAffinity = userProfile?.categoryAffinity || {};

    const cityComplexity = pois.length;
    const isSmallTown = cityComplexity < 60;
    const diversityPressure = cityComplexity > 20 ? 1.0 : 0.4;
    const availablePois = [...pois];
    const totalPoisCount = availablePois.filter(
      (p) => !this.isFoodCategory(p.category) || ((p as any).aiWeight || 0) > 0,
    ).length;

    if (totalPoisCount > 0 && totalPoisCount < intent.days * 2) {
      this.logger.warn(
        `[Scheduler] Data Starvation detected for ${intent.city}. POIs: ${totalPoisCount}, Days: ${intent.days}`,
      );
      // Если точек критически мало, сокращаем количество дней до реалистичного минимума (1-2 точки на день)
      intent.days = Math.max(1, Math.floor(totalPoisCount / 2));
      this.logger.warn(`[Scheduler] Reduced planned days to ${intent.days}`);
    }

    const days: PlanDay[] = [];
    const usedPoiIds = new Set<string>();

    // Извлекаем существующие даты для корректного переноса из PlannerPage
    const preAssignedMap = new Map<string, FilteredPoi[]>();
    pois.forEach((p) => {
      const vDate =
        (p as any).visitDate || (p as any).visit_date || (p as any).date;
      if (vDate) {
        if (!preAssignedMap.has(vDate)) preAssignedMap.set(vDate, []);
        preAssignedMap.get(vDate)!.push(p);
      }
    });

    const uniqueDates = Array.from(preAssignedMap.keys()).sort();
    const totalDays = Math.max(intent.days, uniqueDates.length || 1);

    // Multi-city city assignments
    const cityAssignments = new Map<number, string>();
    const cities =
      intent.cities && intent.cities.length > 0
        ? intent.cities
        : intent.city_to
          ? [intent.city_from || intent.city, intent.city_to]
          : [intent.city];

    if (cities.length > 1) {
      const baseDays = Math.floor(totalDays / cities.length);
      const extraDays = totalDays % cities.length;
      let dayCursor = 1;

      cities.forEach((city, index) => {
        const daysForCity = baseDays + (index < extraDays ? 1 : 0);
        for (let i = 0; i < daysForCity; i++) {
          if (dayCursor <= totalDays) {
            cityAssignments.set(dayCursor++, city);
          }
        }
      });
    }

    // Оптимизация: Группировка POI по городам
    const poisByCity = new Map<string, FilteredPoi[]>();
    pois.forEach((p) => {
      const c = p.city_name || intent.city;
      if (!poisByCity.has(c)) poisByCity.set(c, []);
      poisByCity.get(c)!.push(p);
    });

    const dateStrings: string[] = [];
    for (let i = 0; i < totalDays; i++) {
      if (i < uniqueDates.length) {
        dateStrings.push(uniqueDates[i]);
      } else {
        const baseDate =
          dateStrings.length > 0
            ? new Date(dateStrings[dateStrings.length - 1])
            : new Date();
        if (dateStrings.length > 0) baseDate.setDate(baseDate.getDate() + 1);
        else baseDate.setDate(baseDate.getDate() + i);
        dateStrings.push(baseDate.toISOString().slice(0, 10));
      }
    }

    // Pre-compute geographic anchors for soft day affinity.
    // An anchor is the "center of gravity" for each day — determined by farthest-first selection.
    // Used in scoring as a soft penalty (not a hard filter).
    const dayAnchors = new Map<number, FilteredPoi>();
    if (cities.length === 1 && totalDays > 1 && preAssignedMap.size === 0 && availablePois.length > 0) {
      // ANCHOR QUALIFICATION: only isProtected or score > 0.9 can be anchors.
      // Prevents "Старый светофор" from dictating the day's geography.
      const qualifiedAnchors = availablePois.filter(
        (p) => (p as any).isProtected || p.score > 0.9,
      );
      // Fallback: if not enough qualified, fill up with top-scored non-food points
      const fallbackPool = availablePois
        .filter((p) => !this.isFoodCategory(p.category))
        .sort((a, b) => b.score - a.score);
      const anchorPool =
        qualifiedAnchors.length >= totalDays
          ? qualifiedAnchors.sort((a, b) => b.score - a.score)
          : fallbackPool;

      const sorted = anchorPool;
      const anchors: FilteredPoi[] = [sorted[0]];
      const unselected = new Set(sorted.slice(1));

      for (let i = 1; i < totalDays; i++) {
        let maxDist = -1;
        let nextAnchor: FilteredPoi | null = null;
        for (const poi of unselected) {
          let minDist = Infinity;
          for (const anchor of anchors) {
            const d = this.haversineKm(
              poi.coordinates.lat, poi.coordinates.lon,
              anchor.coordinates.lat, anchor.coordinates.lon,
            );
            if (d < minDist) minDist = d;
          }
          if (minDist > maxDist) { maxDist = minDist; nextAnchor = poi; }
        }
        if (nextAnchor) { anchors.push(nextAnchor); unselected.delete(nextAnchor); }
      }
      anchors.forEach((a, i) => dayAnchors.set(i + 1, a));
      this.logger.log(`[Scheduler] Day anchors: ${anchors.map((a, i) => `Day${i+1}=${a.name}`).join(', ')}`);
    }

    let lastPoiFromPrevDay: FilteredPoi | undefined;

    for (let dayNumber = 1; dayNumber <= totalDays; dayNumber += 1) {
      const points: PlanDayPoint[] = [];
      let currentTime = startMinutes;
      let energyLevel = 100;
      let dayCost = 0;
      let dayRestaurantPoints = 0;
      let dayCafePoints = 0;
      let lastFoodTime: number | null = null;
      let lastMealType: 'lunch' | 'dinner' | 'other' | null = null;

      const currentDateStr = dateStrings[dayNumber - 1];
      const targetCity = cityAssignments.get(dayNumber);

      // --- NEW CLUSTERING LOGIC (RELAXED) ---
      // If we only have one city and more than one day, use LOOSE geographic hints
      // but allow full POI pool to prevent "1 point per day" problem
      const isNewSingleCityPlan =
        cities.length === 1 && totalDays > 1 && preAssignedMap.size === 0;
      let availableForDay: FilteredPoi[] = [];

      if (isNewSingleCityPlan) {
        // TEMP FIX: Use full POI pool instead of strict clustering
        // to prevent single-point-per-day issue. Scheduler will handle geographic distribution.
        availableForDay = availablePois;
      } else {
        availableForDay = targetCity
          ? poisByCity.get(targetCity) || []
          : availablePois;
      }
      // ----------------------------

      const daysRemaining = totalDays - dayNumber + 1;

      // FATIGUE-AWARE BLENDING
      let pointsForThisDay =
        Math.round((totalPoisCount - usedPoiIds.size) / daysRemaining) || 3;
      if (isRelaxMode)
        pointsForThisDay = Math.max(2, Math.floor(pointsForThisDay * 0.7));
      if (isExploreMode) {
        const fatigueFactor = (energyLevel / 100) * 0.4 + 0.6; // Scale from 0.6x to 1.0x
        pointsForThisDay = Math.round(pointsForThisDay * 1.2 * fatigueFactor);
      }
      if (dayNumber === totalDays && totalDays > 1)
        pointsForThisDay = Math.max(2, Math.floor(pointsForThisDay * 0.8));

      const tryAddPoint = (
        poi: FilteredPoi,
        customStart?: number,
        force: boolean = false,
      ): boolean => {
        const lastPoint = points.length > 0 ? points[points.length - 1] : null;
        const lastPoi = lastPoint
          ? (lastPoint.poi as FilteredPoi)
          : lastPoiFromPrevDay?.city_name === targetCity
            ? lastPoiFromPrevDay
            : undefined;
        let transitTime = DEFAULT_TRANSIT_DURATION_MIN;

        // SMALL TOWN RELAXATION
        const relaxAll = force || (isSmallTown && points.length < 4);

        if (lastPoi) {
          const dist = this.haversineKm(
            lastPoi.coordinates.lat,
            lastPoi.coordinates.lon,
            poi.coordinates.lat,
            poi.coordinates.lon,
          );
          if (dist > 50) {
            // Переезд между городами! Принимаем среднюю скорость 80 км/ч
            transitTime = Math.round((dist / 80) * 60);
          } else {
            const rawMinutes =
              dist < 1.0 ? (dist / 5) * 60 : (dist / 25) * 60 + 10;
            let finalTransit = Math.round(rawMinutes / walkingSpeed);

            // In small towns, we assume things are closer or easier to reach
            if (isSmallTown) finalTransit = Math.round(finalTransit * 0.7);

            transitTime = Math.max(5, Math.min(90, finalTransit));
          }
        } else {
          transitTime = 0;
        }

        const arrival = customStart ?? currentTime + transitTime;
        const isFood = this.isFoodCategory(poi.category);
        const mealType = isFood ? this.getMealType(arrival) : null;

        const isHeavy =
          poi.category === 'museum' || ((poi as any).duration || 0) > 90;

        if (!relaxAll) {
          if (lastPoi && this.isFoodCategory(lastPoi.category) && isFood)
            return false;

          // ENERGY GUARD
          if (energyLevel < 35 && isHeavy && !isFood) return false;

          // POST-DINNER LOGIC
          if (
            lastPoi &&
            this.isFoodCategory(lastPoi.category) &&
            this.getMealType(this.timeToMinutes(lastPoint?.arrival_time)) ===
              'dinner'
          ) {
            if (!this.isPostDinnerHighlight(poi) && !isFood) return false;
            if (
              this.haversineKm(
                lastPoi.coordinates.lat,
                lastPoi.coordinates.lon,
                poi.coordinates.lat,
                poi.coordinates.lon,
              ) > 1.2
            )
              return false;
          }
        }

        let visitDuration = VISIT_DURATION[poi.category] ?? 60;
        if (isFood) visitDuration = mealType === 'dinner' ? 90 : 50;

        const explanations: string[] = [];

        // Apply user stay multiplier
        const stayMultiplier = stayMultipliers[poi.category || ''] || 1.0;
        if (stayMultiplier !== 1.0) {
          explanations.push(
            `Adjusted duration based on your typical stay time for ${poi.category}`,
          );
        }
        visitDuration *= stayMultiplier;

        if (isSmallTown) visitDuration *= 0.8; // Faster visits in small towns
        if (isRelaxMode || energyLevel < 40) visitDuration *= 1.2;
        visitDuration = Math.max(20, Math.round(visitDuration));

        if (walkingSpeed !== 1.0 && transitTime > 0) {
          explanations.push(
            `Calculated transit time adjusted for your walking pace`,
          );
        }

        const affinity = categoryAffinity[poi.category || ''] || 0;
        if (affinity > 0.4) {
          explanations.push(
            `Added because you often choose ${poi.category} places`,
          );
        }

        const leaveTime = arrival + visitDuration;
        if (!relaxAll && leaveTime > endMinutes + 60) return false;

        points.push({
          poi_id: poi.id,
          poi,
          order: points.length + 1,
          arrival_time: this.minutesToTime(arrival),
          departure_time: this.minutesToTime(leaveTime),
          visit_duration_min: visitDuration,
          travel_from_prev_min: points.length === 0 ? undefined : transitTime,
          estimated_cost: this.estimatePointCost(poi, dayBudget),
          ai_explanations: explanations.length > 0 ? explanations : undefined,
        });

        dayCost += points[points.length - 1].estimated_cost;
        currentTime = leaveTime;
        usedPoiIds.add(poi.id);

        // Update Energy
        if (isFood) energyLevel = Math.min(100, energyLevel + 25);
        else {
          energyLevel -= isHeavy ? 15 : 8;
          energyLevel -= Math.round(transitTime / 5);
        }
        energyLevel = Math.max(0, energyLevel);

        if (isFood) {
          if (poi.category === 'restaurant') dayRestaurantPoints += 1;
          else dayCafePoints += 1;
          lastFoodTime = arrival;
          lastMealType = mealType;
        }
        return true;
      };

      // Step 0: Сначала добавляем точки, которые пользователь сам закрепил за этой датой в Планировщике
      const dayPreAssigned = preAssignedMap.get(currentDateStr) || [];
      for (const prePoi of dayPreAssigned) {
        if (!usedPoiIds.has(prePoi.id)) {
          tryAddPoint(prePoi, undefined, true);
        }
      }

      // Step 1: First point
      const remainingUniqueInLoop = availableForDay.filter(
        (p) => !usedPoiIds.has(p.id),
      );
      const firstNonFood = remainingUniqueInLoop.find(
        (p) => !this.isFoodCategory(p.category),
      );
      if (firstNonFood) tryAddPoint(firstNonFood);

      // Main Loop
      const MIN_POINTS_PER_DAY = isSmallTown ? 4 : 3;

      while (points.length < pointsForThisDay + 2 && currentTime < endMinutes) {
        const candidates = availableForDay.filter((p) => !usedPoiIds.has(p.id));
        if (candidates.length === 0) break;

        const lastPoint = points.length > 0 ? points[points.length - 1] : null;
        const lastPoi = lastPoint ? (lastPoint.poi as FilteredPoi) : undefined;
        const prevPoi =
          points.length > 1 ? points[points.length - 2].poi : undefined;

        let validCandidates = candidates.filter((poi) => {
          const cat = poi.category || '';
          const isFood = this.isFoodCategory(cat);
          const meal = this.getMealType(currentTime + 20);

          // SMART SLOTS v3
          // 1. Обед (12:30-14:30) -> Жёстко требуем еду, если ещё не ели
          if (
            currentTime >= 12.5 * 60 &&
            currentTime <= 14.5 * 60 &&
            dayCafePoints + dayRestaurantPoints === 0
          ) {
            if (!isFood) {
              const hasFood = candidates.some((c) =>
                this.isFoodCategory(c.category),
              );
              if (hasFood) return false;
            }
          }

          // 1b. Ужин (18:30-20:30) -> Требуем ужин, если еда после 18:00 ещё не была
          if (currentTime >= 18.5 * 60 && currentTime <= 20.5 * 60) {
            const hadDinner =
              lastFoodTime !== null && lastFoodTime >= 18 * 60;
            if (!hadDinner && !isFood) {
              const hasFood = candidates.some((c) =>
                this.isFoodCategory(c.category),
              );
              if (hasFood) return false;
            }
          }

          // 2. Утро -> Приоритет культуре, если скоринг высокий
          if (currentTime < 12 * 60 && !isFood) {
            const weight = (poi as any).aiWeight || 0;
            if (cat === 'museum' && weight < 40) return false;
          }

          if (lastPoi && lastPoi.category === cat && !isFood) {
            const hasOthers = candidates.some(
              (c) => c.category !== cat && !this.isFoodCategory(c.category),
            );
            if (hasOthers && Math.random() < diversityPressure) return false;
          }

          if (isFood) {
            if (lastPoi && this.isFoodCategory(lastPoi.category)) return false;
            if (meal === 'lunch' && dayCafePoints + dayRestaurantPoints >= 1)
              return false;
            if (meal === 'dinner' && dayRestaurantPoints >= 1) return false;
          }

          if (dislikesMuseums && cat === 'museum') return false;
          return true;
        });

        if (validCandidates.length === 0) {
          // If we have few points, relax candidates filter
          if (points.length < MIN_POINTS_PER_DAY) {
            validCandidates = candidates.slice(0, 5);
          } else {
            break;
          }
        }

        // ADVANCED SCORING v7
        const optimizedOrder = validCandidates.sort((a, b) => {
          const distA = lastPoi
            ? this.haversineKm(
                lastPoi.coordinates.lat,
                lastPoi.coordinates.lon,
                a.coordinates.lat,
                a.coordinates.lon,
              )
            : 0;
          const distB = lastPoi
            ? this.haversineKm(
                lastPoi.coordinates.lat,
                lastPoi.coordinates.lon,
                b.coordinates.lat,
                b.coordinates.lon,
              )
            : 0;

          const meal = this.getMealType(currentTime + 20);
          let weightA = (a as any).aiWeight || 0;
          let weightB = (b as any).aiWeight || 0;

          // Еда получает критический буст в обеденное время, если еще не ели
          if (
            this.isFoodCategory(a.category) &&
            meal === 'lunch' &&
            dayCafePoints + dayRestaurantPoints === 0
          )
            weightA += 150;
          if (
            this.isFoodCategory(b.category) &&
            meal === 'lunch' &&
            dayCafePoints + dayRestaurantPoints === 0
          )
            weightB += 150;

          // Ужин: буст если еда после 18:00 ещё не была
          const hadDinner =
            lastFoodTime !== null && lastFoodTime >= 18 * 60;
          if (
            this.isFoodCategory(a.category) &&
            meal === 'dinner' &&
            !hadDinner
          )
            weightA += 120;
          if (
            this.isFoodCategory(b.category) &&
            meal === 'dinner' &&
            !hadDinner
          )
            weightB += 120;

          // DISTANCE PENALTY: нелинейный штраф за дальние переезды (> 10 км)
          const distPenaltyA = distA > 10 ? distA * 3 : distA;
          const distPenaltyB = distB > 10 ? distB * 3 : distB;

          // SOFT ANCHOR PENALTY: штраф за удалённость от якоря текущего дня (> 15 км)
          const dayAnchor = dayAnchors.get(dayNumber);
          let anchorPenaltyA = 0;
          let anchorPenaltyB = 0;
          if (dayAnchor) {
            const anchorDistA = this.haversineKm(
              dayAnchor.coordinates.lat, dayAnchor.coordinates.lon,
              a.coordinates.lat, a.coordinates.lon,
            );
            const anchorDistB = this.haversineKm(
              dayAnchor.coordinates.lat, dayAnchor.coordinates.lon,
              b.coordinates.lat, b.coordinates.lon,
            );
            anchorPenaltyA = anchorDistA > 15 ? anchorDistA * 0.5 : 0;
            anchorPenaltyB = anchorDistB > 15 ? anchorDistB * 0.5 : 0;
          }

          let scoreA = distPenaltyA + anchorPenaltyA - weightA / 60;
          let scoreB = distPenaltyB + anchorPenaltyB - weightB / 60;

          // PRIORITY-AWARE ZIGZAG
          if (prevPoi && lastPoi) {
            const angleA = this.calculateAngle(
              prevPoi.coordinates,
              lastPoi.coordinates,
              a.coordinates,
            );
            const angleB = this.calculateAngle(
              prevPoi.coordinates,
              lastPoi.coordinates,
              b.coordinates,
            );
            const pA = angleA > 115 ? 2.0 : 0;
            const pB = angleB > 115 ? 2.0 : 0;
            scoreA += pA * (weightA > 65 ? 0.2 : 1.0); // 80% discount for top priority
            scoreB += pB * (weightB > 65 ? 0.2 : 1.0);
          }

          // NEURAL AFFINITY BOOST
          // Category affinity acts as a negative penalty (boost).
          // We apply a saturation effect to cap the impact and prevent "filter bubbles".
          const affinityA = categoryAffinity[a.category || ''] || 0;
          const affinityB = categoryAffinity[b.category || ''] || 0;

          // Cap the effective affinity at 0.8 to leave room for exploration
          const boostA = Math.min(affinityA, 0.8) * 1.5;
          const boostB = Math.min(affinityB, 0.8) * 1.5;

          scoreA -= boostA;
          scoreB -= boostB;

          if (lovesCoffee && a.category === 'cafe') scoreA -= 1;
          if (lovesCoffee && b.category === 'cafe') scoreB -= 1;
          if (
            lovesNature &&
            ['park', 'garden', 'forest'].includes(a.category || '')
          )
            scoreA -= 0.8;
          if (
            lovesNature &&
            ['park', 'garden', 'forest'].includes(b.category || '')
          )
            scoreB -= 0.8;

          return scoreA - scoreB;
        });

        let added = false;
        for (const next of optimizedOrder) {
          if (tryAddPoint(next)) {
            added = true;
            break;
          }
        }

        if (!added) {
          // Fallback: try to add ANY candidate with 'force' if we have very few points
          if (points.length < MIN_POINTS_PER_DAY && candidates.length > 0) {
            const fallbackPoint = candidates.sort((a, b) => {
              const distA = lastPoi
                ? this.haversineKm(
                    lastPoi.coordinates.lat,
                    lastPoi.coordinates.lon,
                    a.coordinates.lat,
                    a.coordinates.lon,
                  )
                : 0;
              const distB = lastPoi
                ? this.haversineKm(
                    lastPoi.coordinates.lat,
                    lastPoi.coordinates.lon,
                    b.coordinates.lat,
                    b.coordinates.lon,
                  )
                : 0;
              return distA - distB;
            })[0];
            if (tryAddPoint(fallbackPoint, undefined, true)) {
              added = true;
            }
          }
        }

        if (!added) break;
      }

      // WEATHER-AWARE FALLBACK
      const lastPointFinal = points[points.length - 1];
      if (
        lastPointFinal &&
        this.isFoodCategory(lastPointFinal.poi.category) &&
        this.getMealType(this.timeToMinutes(lastPointFinal.arrival_time)) ===
          'dinner'
      ) {
        if (!isRainy && !isCold) {
          const nearby = availablePois.find(
            (p) =>
              !usedPoiIds.has(p.id) &&
              this.haversineKm(
                lastPointFinal.poi.coordinates.lat,
                lastPointFinal.poi.coordinates.lon,
                p.coordinates.lat,
                p.coordinates.lon,
              ) < 0.6,
          );
          if (nearby) tryAddPoint(nearby);
        } else {
          this.logger.log(
            `[Weather] Skipping micro-walk due to poor conditions.`,
          );
        }
      }

      // GEO-BALANCE: detect lone outlier points (> 20 km from day's centroid)
      // If a non-protected outlier has no neighbors in the pool → eject it.
      // If a protected outlier exists → pull up to 2 nearest neighbors from the global pool.
      if (points.length >= 2) {
        const nonFoodPoints = points.filter(
          (p) => !this.isFoodCategory(p.poi.category),
        );
        if (nonFoodPoints.length >= 2) {
          // Compute centroid of non-food points
          const centLat =
            nonFoodPoints.reduce((s, p) => s + p.poi.coordinates.lat, 0) /
            nonFoodPoints.length;
          const centLon =
            nonFoodPoints.reduce((s, p) => s + p.poi.coordinates.lon, 0) /
            nonFoodPoints.length;

          for (let pi = points.length - 1; pi >= 0; pi--) {
            const pt = points[pi];
            const d = this.haversineKm(
              centLat, centLon,
              pt.poi.coordinates.lat, pt.poi.coordinates.lon,
            );

            if (d > 20) {
              const poi = pt.poi as FilteredPoi;
              if ((poi as any).isProtected) {
                // Protected outlier: pull 2 nearest neighbors from global unused pool
                const neighbors = availablePois
                  .filter((p) => !usedPoiIds.has(p.id) && !this.isFoodCategory(p.category))
                  .sort((a, b) =>
                    this.haversineKm(poi.coordinates.lat, poi.coordinates.lon, a.coordinates.lat, a.coordinates.lon) -
                    this.haversineKm(poi.coordinates.lat, poi.coordinates.lon, b.coordinates.lat, b.coordinates.lon),
                  )
                  .slice(0, 2)
                  .filter((p) =>
                    this.haversineKm(poi.coordinates.lat, poi.coordinates.lon, p.coordinates.lat, p.coordinates.lon) < 8,
                  );
                for (const nb of neighbors) {
                  tryAddPoint(nb, undefined, true);
                }
                if (neighbors.length > 0) {
                  this.logger.log(
                    `[GeoBalance] Protected outlier "${poi.name}" pulled ${neighbors.length} neighbor(s)`,
                  );
                }
              } else {
                // Non-protected outlier with no neighbors → eject
                const hasNearbyUnused = availablePois.some(
                  (p) =>
                    !usedPoiIds.has(p.id) &&
                    this.haversineKm(poi.coordinates.lat, poi.coordinates.lon, p.coordinates.lat, p.coordinates.lon) < 5,
                );
                if (!hasNearbyUnused) {
                  this.logger.log(
                    `[GeoBalance] Ejecting lone outlier "${poi.name}" (${d.toFixed(1)} km from centroid, no neighbors)`,
                  );
                  usedPoiIds.delete(poi.id); // return to pool for next day
                  points.splice(pi, 1);
                }
              }
            }
          }
        }
      }

      if (points.length > 0) {
        lastPoiFromPrevDay = points[points.length - 1].poi as FilteredPoi;
      }

      days.push({
        day_number: dayNumber,
        date: currentDateStr,
        day_budget_estimated: dayCost,
        day_start_time: intent.start_time,
        day_end_time: intent.end_time,
        points,
      });
    }

    // Если маршрут мульти-городской, склеиваем название
    const finalCity =
      intent.cities && intent.cities.length > 1
        ? intent.cities.join(' - ')
        : intent.city_from && intent.city_to
          ? `${intent.city_from} - ${intent.city_to}`
          : intent.city;

    const totalBudget = days.reduce(
      (acc, d) => acc + d.day_budget_estimated,
      0,
    );
    return {
      city: finalCity,
      cities: intent.cities,
      route_type: intent.route_type,
      total_budget_estimated: totalBudget,
      days,
    };
  }

  private isFoodCategory(cat: string | undefined): boolean {
    const c = (cat || '').toLowerCase();
    return [
      'restaurant',
      'cafe',
      'bar',
      'pub',
      'fast_food',
      'food_court',
    ].includes(c);
  }

  private getMealType(minutes: number): 'lunch' | 'dinner' | 'other' {
    if (minutes >= 11 * 60 && minutes <= 16 * 60) return 'lunch';
    if (minutes >= 18 * 60) return 'dinner';
    return 'other';
  }

  private isPostDinnerHighlight(poi: FilteredPoi): boolean {
    const cat = (poi.category || '').toLowerCase();
    return (
      [
        'viewpoint',
        'embankment',
        'bridge',
        'square',
        'monument',
        'park',
      ].includes(cat) || ((poi as any).duration || 0) <= 30
    );
  }

  private estimatePointCost(poi: FilteredPoi, dayBudget: number): number {
    if (poi.price_segment === 'free') return 0;
    const budget = dayBudget > 0 ? dayBudget : 5000;
    if (poi.price_segment === 'budget')
      return Math.max(150, Math.round(budget * 0.1));
    if (poi.price_segment === 'mid')
      return Math.max(400, Math.round(budget * 0.2));
    if (poi.price_segment === 'premium')
      return Math.max(1000, Math.round(budget * 0.35));
    return Math.max(300, Math.round(budget * 0.12));
  }

  public timeToMinutes(value: string | undefined | null): number {
    if (!value || typeof value !== 'string') return 0;
    const parts = value.split(':').map(Number);
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  }

  public minutesToTime(total: number): string {
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
    const toRad = (v: number) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { RouteGraphService, RouteContext } from './route-graph.service';

export interface UserPreferences {
  culture: number; // 0.0 - 1.0
  nature: number;
  food: number;
  activity: number;
  shopping: number;
}

export interface PlanningContext {
  preferences: UserPreferences;
  isRaining: boolean;
  startLocation?: { lat: number; lon: number };
  timeBudget?: number; // В минутах
}

interface BeamNode {
  route: any[];
  totalScore: number;
  currentTimeSpent: number;
  unvisitedIds: Set<string>;
  categoryCounts: Record<string, number>;
  lastPoi: any;
  lastFoodTime?: number;
}

@Injectable()
export class ItineraryBuilderService {
  private readonly logger = new Logger(ItineraryBuilderService.name);
  private readonly DEFAULT_TIME_BUDGET = 480; // 8 часов

  constructor(private readonly graph: RouteGraphService) {}

  /**
   * Белый список категорий, чтобы отсечь города, районы и мусор
   */
  private readonly ALLOWED_CATEGORIES = [
    'museum',
    'arts_centre',
    'theatre',
    'place_of_worship',
    'historic',
    'memorial',
    'monument',
    'park',
    'garden',
    'nature_reserve',
    'viewpoint',
    'attraction',
    'restaurant',
    'cafe',
    'bar',
    'pub',
    'cinema',
    'entertainment',
    'water_park',
    'theme_park',
    'zoo',
    'shopping',
    'mall',
  ];

  private readonly CATEGORY_MAP: Record<string, keyof UserPreferences> = {
    museum: 'culture',
    arts_centre: 'culture',
    theatre: 'culture',
    place_of_worship: 'culture',
    historic: 'culture',
    memorial: 'culture',
    monument: 'culture',
    park: 'nature',
    garden: 'nature',
    nature_reserve: 'nature',
    viewpoint: 'nature',
    attraction: 'culture',
    restaurant: 'food',
    cafe: 'food',
    bar: 'food',
    pub: 'food',
    cinema: 'activity',
    entertainment: 'activity',
    water_park: 'activity',
    theme_park: 'activity',
    zoo: 'activity',
    shopping: 'shopping',
    mall: 'shopping',
  };

  public buildMultiDayRoute(
    pois: any[],
    clusters: any[],
    days: number,
    planningCtx: PlanningContext,
  ): any[] {
    const budget = planningCtx.timeBudget || this.DEFAULT_TIME_BUDGET;

    // Фильтруем мусор сразу
    const filteredPois = pois.filter((p) =>
      this.ALLOWED_CATEGORIES.includes(p.category),
    );

    const scoredClusters = clusters.map((cluster) => {
      const clusterPois = filteredPois.filter(
        (p) => p.clusterId === cluster.id,
      );
      const totalScore = clusterPois.reduce(
        (sum, p) => sum + this.calculateBaseScore(p, planningCtx),
        0,
      );
      return { ...cluster, totalScore, pois: clusterPois };
    });

    scoredClusters.sort((a, b) => b.totalScore - a.totalScore);

    const routeDays: any[] = [];
    const usedPoiIds = new Set<string>();

    for (let i = 0; i < days; i++) {
      const cluster = scoredClusters[i];
      const availablePois = cluster
        ? cluster.pois.filter((p) => !usedPoiIds.has(p.id))
        : filteredPois.filter((p) => !usedPoiIds.has(p.id));

      if (availablePois.length > 0) {
        const startLoc = i === 0 ? planningCtx.startLocation : undefined;

        const dayRoute = this.buildDayRouteBeam(
          availablePois,
          planningCtx,
          budget,
          startLoc,
        );

        const enrichedRoute = this.enrichWithTransitions(dayRoute, startLoc);

        routeDays.push({
          day_number: i + 1,
          points: enrichedRoute,
        });

        dayRoute.forEach((p) => usedPoiIds.add(p.id));
      }
    }

    return routeDays;
  }

  private calculateBaseScore(poi: any, ctx: PlanningContext): number {
    let score = poi.aiWeight || 1.0;

    // 1. Персонализация
    const interestKey = this.CATEGORY_MAP[poi.category];
    if (interestKey && ctx.preferences[interestKey] !== undefined) {
      score *= 0.5 + ctx.preferences[interestKey] * 1.5;
    }

    // 2. Погода
    if (ctx.isRaining) {
      const outdoor = [
        'park',
        'garden',
        'nature_reserve',
        'viewpoint',
        'monument',
      ];
      if (outdoor.includes(poi.category)) score *= 0.2;
    }

    return score;
  }

  public buildDayRouteBeam(
    dayPois: any[],
    ctx: PlanningContext,
    maxTimeMin: number,
    startLocation?: { lat: number; lon: number },
    beamWidth: number = 5,
  ): any[] {
    if (!dayPois.length) return [];

    // Инициализация начальных узлов
    let beam: BeamNode[] = dayPois
      .map((p) => {
        let travelFromStart = 0;
        if (startLocation) {
          const dist = this.graph.getGeoDistanceKm(
            startLocation.lat,
            startLocation.lon,
            p.lat,
            p.lon,
          );
          travelFromStart = Math.round((dist / 4) * 60) + 5; // 5 мин буфер
        }

        const duration = p.duration || 60;
        const isFood = this.CATEGORY_MAP[p.category] === 'food';
        return {
          route: [p],
          totalScore: this.calculateBaseScore(p, ctx),
          currentTimeSpent: travelFromStart + duration,
          unvisitedIds: new Set(
            dayPois.map((dp) => dp.id).filter((id) => id !== p.id),
          ),
          categoryCounts: { [p.category]: 1 },
          lastPoi: p,
          lastFoodTime: isFood ? travelFromStart + duration : undefined,
        };
      })
      .filter((node) => node.currentTimeSpent <= maxTimeMin)
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, beamWidth);

    if (beam.length === 0) return [];

    const routeContext: RouteContext = {
      averageSpeedKmH: 4,
      currentPoiIndex: 0,
    };
    const maxPoisPerDay = 8;
    const FOOD_COOLDOWN_MIN = 240; // 4 часа (Обед -> Ужин)

    for (let step = 1; step < maxPoisPerDay; step++) {
      const allCandidates: BeamNode[] = [];

      for (const node of beam) {
        let hasPotentialNext = false;

        for (const nextId of node.unvisitedIds) {
          const nextPoi = dayPois.find((p) => p.id === nextId);
          if (!nextPoi) continue;

          // Категории и тип точки
          const nextType = this.CATEGORY_MAP[nextPoi.category];
          const isFood = nextType === 'food';
          const lastType = this.CATEGORY_MAP[node.lastPoi.category];
          const lastIsFood = lastType === 'food';

          // Food Cooldown: Не едим чаще чем раз в 4 часа
          if (isFood && node.lastFoodTime !== undefined) {
            const timeSinceLastFood =
              node.currentTimeSpent - node.lastFoodTime;
            if (timeSinceLastFood < FOOD_COOLDOWN_MIN) continue;
          }

          // HARD CONSTRAINT: Никакой еды подряд!
          if (isFood && lastIsFood) {
            continue;
          }

          // Штраф за категорию
          const catCount = node.categoryCounts[nextPoi.category] || 0;
          if (isFood) {
            if (catCount >= 2) continue; // Максимум 2 еды в день
          } else if (catCount >= 3) continue;

          // Расчет времени перехода (Travel Time)
          const travelTime = this.graph.calculateEdgeWeight(
            {
              category: node.lastPoi.category,
              coordinates: { lat: node.lastPoi.lat, lon: node.lastPoi.lon },
            } as any,
            {
              category: nextPoi.category,
              coordinates: { lat: nextPoi.lat, lon: nextPoi.lon },
            } as any,
            { ...routeContext, currentPoiIndex: node.route.length },
          );

          const waitBuffer = 10; // 10 минут на «потупить»
          const totalTimeIfAdded =
            node.currentTimeSpent +
            travelTime +
            waitBuffer +
            (nextPoi.duration || 60);

          if (totalTimeIfAdded <= maxTimeMin) {
            // Штраф за расстояние
            const dist = this.graph.getGeoDistanceKm(
              node.lastPoi.lat,
              node.lastPoi.lon,
              nextPoi.lat,
              nextPoi.lon,
            );
            const distancePenalty = dist * 2;

            // Template Bonus: Поощряем разнообразие (не повторять тот же тип подряд)
            let diversityBonus = 0;
            if (nextType !== lastType) {
              diversityBonus += 5; // Бонус за смену типа активности (увеличено)
            }

            // Идеальное время для еды (Обед 12-14, Ужин 18-20)
            // Допустим старт в 09:00 (540 мин от начала дня)
            const absoluteCurrentTime = 540 + totalTimeIfAdded;
            let timeContextBonus = 0;
            if (isFood) {
              // Обед (12:00-14:00 = 720-840)
              if (absoluteCurrentTime >= 720 && absoluteCurrentTime <= 840) {
                timeContextBonus += 5;
              }
              // Ужин (18:00-21:00 = 1080-1260)
              if (absoluteCurrentTime >= 1080 && absoluteCurrentTime <= 1260) {
                timeContextBonus += 5;
              }
            }

            const nextUnvisited = new Set(node.unvisitedIds);
            nextUnvisited.delete(nextId);

            const nextCatCounts = { ...node.categoryCounts };
            nextCatCounts[nextPoi.category] =
              (nextCatCounts[nextPoi.category] || 0) + 1;

            allCandidates.push({
              route: [...node.route, nextPoi],
              totalScore:
                node.totalScore +
                this.calculateBaseScore(nextPoi, ctx) -
                distancePenalty +
                diversityBonus +
                timeContextBonus,
              currentTimeSpent: totalTimeIfAdded,
              unvisitedIds: nextUnvisited,
              categoryCounts: nextCatCounts,
              lastPoi: nextPoi,
              lastFoodTime: isFood ? totalTimeIfAdded : node.lastFoodTime,
            });
            hasPotentialNext = true;
          }
        }

        // Если некуда расширяться, сохраняем текущий узел как финальный вариант
        if (!hasPotentialNext) {
          allCandidates.push(node);
        }
      }

      if (allCandidates.length === 0) break;

      // Select Top-K candidates from ALL expansions (Correct Beam Search)
      beam = allCandidates
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, beamWidth);

      // Если бим не изменился (никто не добавил точку), выходим
      const anyProgress = beam.some((n) => n.route.length > step);
      if (!anyProgress) break;
    }

    return beam.length > 0 ? beam[0].route : [];
  }

  private enrichWithTransitions(
    route: any[],
    startLocation?: { lat: number; lon: number },
  ): any[] {
    const result: any[] = [];
    let currentTime = 540; // Старт в 09:00

    for (let idx = 0; idx < route.length; idx++) {
      const poi = route[idx];
      let travelTime = 0;
      let distToPrev = 0;

      if (idx === 0) {
        if (startLocation) {
          distToPrev = this.graph.getGeoDistanceKm(
            startLocation.lat,
            startLocation.lon,
            poi.lat,
            poi.lon,
          );
          travelTime = Math.round((distToPrev / 4) * 60);
        }
      } else {
        const prev = route[idx - 1];
        distToPrev = this.graph.getGeoDistanceKm(
          prev.lat,
          prev.lon,
          poi.lat,
          poi.lon,
        );
        travelTime = Math.round((distToPrev / 4) * 60);
      }

      currentTime += travelTime;
      const arrival = this.formatTime(currentTime);

      const duration = poi.duration || 60;
      const departure = this.formatTime(currentTime + duration);

      result.push({
        ...poi,
        arrival_time: arrival,
        departure_time: departure,
        dist_from_prev_m: Math.round(distToPrev * 1000),
        time_from_prev_min: travelTime,
      });

      currentTime += duration + 10; // +10 мин буфер после каждой точки
    }

    return result;
  }

  private formatTime(minutes: number): string {
    const h = Math.floor(minutes / 60) % 24;
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

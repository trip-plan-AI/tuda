import { Injectable, Inject } from '@nestjs/common';
import { CityIngestionService } from './city-ingestion.service';
import {
  ItineraryBuilderService,
  PlanningContext,
} from './itinerary-builder.service';
import { LlmExplainerService } from './llm-explainer.service';
import { DRIZZLE } from '../../db/db.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { cities, pois, clusters } from '../../db/city-dataset.schema';
import { eq, or, ilike } from 'drizzle-orm';

export interface GeneratedPopularRoute {
  title: string;
  description: string;
  budget: number;
  tags: string[];
  points: any[];
  route_plan: any;
}

@Injectable()
export class PopularGeneratorService {
  constructor(
    private readonly ingestion: CityIngestionService,
    private readonly builder: ItineraryBuilderService,
    private readonly explainer: LlmExplainerService,
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async generate(city: string): Promise<GeneratedPopularRoute> {
    const normalizedCity = city.trim();
    console.log(`[PopularGenerator] Generating for ${normalizedCity}...`);

    // 0. Пытаемся найти каноническое имя и координаты в популярных направлениях
    const popular = await this.db.query.popularDestinations.findFirst({
      where: (d) =>
        or(
          eq(d.nameRu, normalizedCity),
          ilike(d.nameRu, normalizedCity),
          ilike(d.aliases, `%${normalizedCity}%`),
        ),
    });

    const canonicalName = popular?.nameRu ?? normalizedCity;
    const lat = popular?.lat ?? 55.7558;
    const lon = popular?.lon ?? 37.6173;
    const countryCode = popular?.countryCode ?? 'RU';

    // 1. Пытаемся найти город в кэше AI датасетов
    let targetCity = await this.db.query.cities.findFirst({
      where: eq(cities.name, canonicalName),
    });

    // 2. Если нет в кэше — запускаем инджестинг
    if (!targetCity) {
      console.log(
        `[PopularGenerator] City ${canonicalName} not found in cache. Starting ingestion...`,
      );
      const bbox = {
        minLat: lat - 0.1,
        maxLat: lat + 0.1,
        minLon: lon - 0.1,
        maxLon: lon + 0.1,
      };

      const ingestResult = await this.ingestion.ingestCity(
        canonicalName,
        bbox,
        lat,
        lon,
        countryCode,
      );

      targetCity = await this.db.query.cities.findFirst({
        where: eq(cities.id, ingestResult.cityId),
      });
    }

    if (!targetCity) throw new Error(`Failed to ingest city ${canonicalName}`);

    // 3. Загружаем POIs и Кластеры
    const dbPois = await this.db.query.pois.findMany({
      where: eq(pois.cityId, targetCity.id),
    });

    const dbClusters = await this.db.query.clusters.findMany({
      where: eq(clusters.cityId, targetCity.id),
    });

    console.log(
      `[PopularGenerator] Loaded ${dbPois.length} POIs and ${dbClusters.length} clusters.`,
    );

    // 4. Строим маршрут (1 день)
    // Адаптируем dbPois под формат билдера
    const planningCtx: PlanningContext = {
      preferences: { culture: 1, nature: 1, food: 1, activity: 1, shopping: 1 },
      isRaining: false,
      startLocation: { lat: targetCity.lat, lon: targetCity.lon },
    };

    const routeDays: any[] = this.builder.buildMultiDayRoute(
      dbPois,
      dbClusters,
      1, // Для "популярного" обычно 1 день
      planningCtx,
    );

    const dayPoints = routeDays[0]?.points || [];

    // 5. Генерируем описание через LLM
    const explanation = await this.explainer.explainRoute(
      canonicalName,
      routeDays,
    );

    // 6. Генерируем метаданные (заголовок, бюджет)
    const metadata = await this.generateMetadata(canonicalName, dayPoints);

    return {
      title: metadata.title,
      description: explanation,
      budget: metadata.budget,
      tags: metadata.tags,
      points: dayPoints.map((p) => ({
        id: p.id,
        name: p.name,
        address: p.address,
        coordinates: { lat: p.lat, lon: p.lon },
        category: p.category,
      })),
      route_plan: {
        city: canonicalName,
        total_budget_estimated: metadata.budget,
        days: routeDays.map((d) => ({
          day_number: d.day_number,
          points: d.points.map((p, idx) => ({
            poi: { name: p.name, category: p.category, address: p.address },
            arrival_time: `${10 + idx}:00`,
            departure_time: `${11 + idx}:00`,
            estimated_cost: 500,
          })),
        })),
      },
    };
  }

  private async generateMetadata(city: string, points: any[]) {
    // В реальности тут может быть еще один вызов LLM для креативного заголовка
    return {
      title: `Лучшее в городе ${city}`,
      description: `Популярный маршрут по главным достопримечательностям ${city}.`,
      budget: points.length * 1000 + 2000,
      tags: ['Популярное', city],
    };
  }
}

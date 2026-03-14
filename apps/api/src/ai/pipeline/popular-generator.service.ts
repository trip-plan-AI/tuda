import { Injectable } from '@nestjs/common';
import { YandexFetchService } from './yandex-fetch.service';
import type {
  ParsedIntent,
  PoiCategory,
  RoutePlan,
} from '../types/pipeline.types';
import type { PoiItem } from '../types/poi.types';
import { LlmClientService } from './llm-client.service';

interface GeneratedPopularRoute {
  title: string;
  description: string;
  budget: number;
  tags: string[];
  cover_image_url: string | null;
  weather_temp: string | null;
  total_price_display: string;
  route_plan: RoutePlan;
  points: PoiItem[];
}

@Injectable()
export class PopularGeneratorService {
  constructor(
    private readonly yandexFetchService: YandexFetchService,
    private readonly llmClientService: LlmClientService,
  ) {}

  async generate(city: string): Promise<GeneratedPopularRoute> {
    const normalizedCity = city.trim();

    const intent: ParsedIntent = {
      city: normalizedCity,
      days: 2,
      budget_total: null,
      budget_per_day: null,
      budget_per_person: null,
      poi_count_requested: null,
      min_restaurants: null,
      min_cafes: null,
      max_poi: null,
      party_type: 'solo',
      party_size: 1,
      categories: this.defaultCategories(),
      excluded_categories: [],
      radius_km: 8,
      start_time: '10:00',
      end_time: '21:00',
      preferences_text: `Популярные места для туристов в городе ${normalizedCity}`,
    };

    const points = await this.yandexFetchService.fetchAndFilter(intent);

    const routePlan: RoutePlan = {
      city: normalizedCity,
      total_budget_estimated: 0,
      days: [
        {
          day_number: 1,
          date: new Date().toISOString().slice(0, 10),
          day_budget_estimated: 0,
          day_start_time: '10:00',
          day_end_time: '21:00',
          points: points.slice(0, 8).map((point, index) => ({
            poi_id: point.id,
            poi: point,
            order: index + 1,
            arrival_time: '10:00',
            departure_time: '11:00',
            visit_duration_min: 60,
            estimated_cost: this.estimateCost(point),
          })),
        },
      ],
      notes: 'Сгенерировано из популярных мест города',
    };

    const enriched = await this.generateMetadata(normalizedCity, points);

    return {
      title: enriched.title,
      description: enriched.description,
      budget: enriched.budget,
      tags: enriched.tags,
      cover_image_url: null,
      weather_temp: null,
      total_price_display: `${enriched.budget.toLocaleString('ru-RU')} ₽`,
      route_plan: routePlan,
      points,
    };
  }

  private defaultCategories(): PoiCategory[] {
    return ['attraction', 'museum', 'park', 'restaurant', 'cafe'];
  }

  private estimateCost(point: PoiItem): number {
    switch (point.price_segment) {
      case 'free':
        return 0;
      case 'budget':
        return 500;
      case 'mid':
        return 1200;
      case 'premium':
        return 2500;
      default:
        return 700;
    }
  }

  private async generateMetadata(
    city: string,
    points: PoiItem[],
  ): Promise<{
    title: string;
    description: string;
    budget: number;
    tags: string[];
  }> {
    const prompt = `Сгенерируй JSON для публичного маршрута.
Город: ${city}
Точки: ${JSON.stringify(points.slice(0, 10).map((p) => ({ name: p.name, category: p.category })))}

Верни только JSON:
{
  "title": string,
  "description": string,
  "budget": number,
  "tags": string[]
}`;

    try {
      const response =
        await this.llmClientService.client.chat.completions.create({
          model: this.llmClientService.model,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Ты помощник для генерации описаний популярных туристических маршрутов. Ответ только JSON.',
            },
            { role: 'user', content: prompt },
          ],
        });

      const content = response.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(content) as {
        title?: string;
        description?: string;
        budget?: number;
        tags?: string[];
      };

      return {
        title: parsed.title?.trim() || `Популярный маршрут: ${city}`,
        description:
          parsed.description?.trim() ||
          `Собрали популярные места в ${city}, чтобы быстро стартовать планирование поездки.`,
        budget:
          typeof parsed.budget === 'number' && Number.isFinite(parsed.budget)
            ? Math.max(0, Math.round(parsed.budget))
            : 15000,
        tags:
          Array.isArray(parsed.tags) && parsed.tags.length > 0
            ? parsed.tags.slice(0, 5)
            : ['Популярное', city],
      };
    } catch {
      return {
        title: `Популярный маршрут: ${city}`,
        description: `Собрали популярные места в ${city}, чтобы быстро стартовать планирование поездки.`,
        budget: 15000,
        tags: ['Популярное', city],
      };
    }
  }
}

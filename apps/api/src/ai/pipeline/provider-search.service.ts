import { Injectable, Logger } from '@nestjs/common';
import type {
  MassCollectionShadowMeta,
  MassCollectionShadowProviderStat,
  ParsedIntent,
} from '../types/pipeline.types';
import type { PoiItem } from '../types/poi.types';
import { KudagoClientService } from './kudago-client.service';
import { OverpassClientService } from './overpass-client.service';
import { LlmClientService } from './llm-client.service';
import { randomUUID } from 'crypto';

@Injectable()
export class ProviderSearchService {
  private readonly logger = new Logger(ProviderSearchService.name);

  constructor(
    private readonly kudagoClient: KudagoClientService,
    private readonly overpassClient: OverpassClientService,
    private readonly llmClientService: LlmClientService,
  ) {}

  private buildEmptyProviderStat(
    provider: MassCollectionShadowProviderStat['provider'],
  ): MassCollectionShadowProviderStat {
    return {
      provider,
      attempted: false,
      raw_count: 0,
      used_count: 0,
      failed: false,
    };
  }

  async fetchAndFilter(
    intent: ParsedIntent,
    fallbacks: string[] = [],
  ): Promise<{
    pois: PoiItem[];
    shadowDiagnostics?: MassCollectionShadowMeta;
  }> {
    this.logger.log(
      `[ProviderSearch] Started for city: "${intent.city}", categories: [${intent.categories.join(', ')}]`,
    );

    let pois: PoiItem[] = [];
    const providerStats: Record<
      MassCollectionShadowProviderStat['provider'],
      MassCollectionShadowProviderStat
    > = {
      kudago: this.buildEmptyProviderStat('kudago'),
      overpass: this.buildEmptyProviderStat('overpass'),
      llm_fill: this.buildEmptyProviderStat('llm_fill'),
    };

    // 1) Сначала обращаемся к приоритетному источнику (KudaGo)
    this.logger.log(`[ProviderSearch] Requesting KudaGo API...`);
    providerStats.kudago.attempted = true;
    let kudagoRaw: PoiItem[] = [];
    try {
      kudagoRaw = await this.kudagoClient.fetchByIntent(intent);
      providerStats.kudago.raw_count = kudagoRaw.length;
      providerStats.kudago.used_count = kudagoRaw.length;
    } catch (error: unknown) {
      providerStats.kudago.failed = true;
      providerStats.kudago.fail_reason =
        error instanceof Error ? error.message : String(error);
      throw error;
    }
    this.logger.log(
      `[ProviderSearch] KudaGo returned ${kudagoRaw.length} points.`,
    );

    if (kudagoRaw.length === 0) {
      this.logger.warn(
        `[ProviderSearch] KudaGo returned 0 points. Using fallback: KUDAGO_UNAVAILABLE_OVERPASS_ONLY`,
      );
      fallbacks.push('KUDAGO_UNAVAILABLE_OVERPASS_ONLY');
    }

    // 2) Если точек мало (< 15), добираем через Overpass
    let overpassRaw: PoiItem[] = [];
    if (kudagoRaw.length < 15) {
      this.logger.log(
        `[ProviderSearch] KudaGo POIs < 15. Calling Overpass API for supplement...`,
      );
      providerStats.overpass.attempted = true;
      try {
        overpassRaw = await this.overpassClient.fetchByIntent(intent);
        providerStats.overpass.raw_count += overpassRaw.length;
      } catch (error: unknown) {
        providerStats.overpass.failed = true;
        providerStats.overpass.fail_reason =
          error instanceof Error ? error.message : String(error);
        throw error;
      }
      this.logger.log(
        `[ProviderSearch] Overpass returned ${overpassRaw.length} points.`,
      );
    }

    // 3) Объединяем и дедуплицируем
    pois = [...kudagoRaw, ...overpassRaw];

    // Если после объединения все еще мало POI, пробуем расширить радиус поиска Overpass
    if (pois.length < 3) {
      this.logger.warn(
        `[ProviderSearch] Still low on POIs (${pois.length}). Retrying Overpass with radius * 1.3...`,
      );
      providerStats.overpass.attempted = true;
      let retryOverpass: PoiItem[] = [];
      try {
        retryOverpass = await this.overpassClient.fetchByIntent({
          ...intent,
          radius_km: intent.radius_km * 1.3,
        });
        providerStats.overpass.raw_count += retryOverpass.length;
      } catch (error: unknown) {
        providerStats.overpass.failed = true;
        providerStats.overpass.fail_reason =
          error instanceof Error ? error.message : String(error);
        throw error;
      }
      pois = [...kudagoRaw, ...retryOverpass];
      overpassRaw = retryOverpass;
      this.logger.log(
        `[ProviderSearch] After Overpass retry, total raw points: ${pois.length}`,
      );
    }

    providerStats.overpass.used_count = overpassRaw.length;

    const minRequired = intent.days * 2;

    // 4) Если точек всё ещё не хватает (меньше days * 2), генерируем недостающие через LLM
    if (pois.length < minRequired) {
      this.logger.warn(
        `[ProviderSearch] Only ${pois.length} points found, but ${minRequired} needed for ${intent.days} days. Requesting LLM to generate missing points...`,
      );
      const missingCount = minRequired - pois.length;
      providerStats.llm_fill.attempted = true;
      try {
        const generatedPois = await this.generateMissingPois(
          intent.city,
          missingCount,
          pois,
        );
        pois = [...pois, ...generatedPois];
        providerStats.llm_fill.raw_count = generatedPois.length;
        providerStats.llm_fill.used_count = generatedPois.length;
        fallbacks.push('LLM_GENERATED_MISSING_POIS');
        this.logger.log(
          `[ProviderSearch] Successfully generated ${generatedPois.length} missing points. Total now: ${pois.length}`,
        );
      } catch (error: any) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[ProviderSearch] Failed to generate missing points via LLM: ${errorMessage}`,
        );
        providerStats.llm_fill.failed = true;
        providerStats.llm_fill.fail_reason = errorMessage;
        fallbacks.push('LLM_POI_GENERATION_FAILED');
      }
    }

    if (pois.length === 0) {
      this.logger.error(
        `[ProviderSearch] ❌ FATAL: 0 points found for ${intent.city} across all providers and generators.`,
      );
      return {
        pois: [],
        shadowDiagnostics: {
          provider_stats: [
            providerStats.kudago,
            providerStats.overpass,
            providerStats.llm_fill,
          ],
          totals: {
            before_dedup: 0,
            after_dedup: 0,
            returned: 0,
          },
        },
      };
    }

    this.logger.log(
      `[ProviderSearch] Starting deduplication of ${pois.length} points...`,
    );
    const deduped = this.deduplicate(pois);
    this.logger.log(
      `[ProviderSearch] Deduplication complete. Unique points: ${deduped.length}`,
    );

    // 5) Pre-filter с квотированием:
    // Если просто отсортировать по рейтингу, еда (с дефолтом 4.5) вытеснит все музеи (с дефолтом 4.0).
    // Поэтому мы разделяем точки и берем Топ-50 не-еды и Топ-50 еды.
    const MAX_NON_FOOD_FOR_LLM = 50;
    const MAX_FOOD_FOR_LLM = 50;

    const nonFood = deduped.filter(
      (p) => p.category !== 'restaurant' && p.category !== 'cafe',
    );
    const food = deduped.filter(
      (p) => p.category === 'restaurant' || p.category === 'cafe',
    );

    const topNonFood = nonFood
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, MAX_NON_FOOD_FOR_LLM);

    const topFood = food
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, MAX_FOOD_FOR_LLM);

    const result = [...topNonFood, ...topFood];

    this.logger.log(
      `[ProviderSearch] Final pre-filter complete. Kept ${topNonFood.length} non-food and ${topFood.length} food points (Total: ${result.length}) for Semantic Filter.`,
    );
    return {
      pois: result,
      shadowDiagnostics: {
        provider_stats: [
          providerStats.kudago,
          providerStats.overpass,
          providerStats.llm_fill,
        ],
        totals: {
          before_dedup: pois.length,
          after_dedup: deduped.length,
          returned: result.length,
        },
      },
    };
  }

  private deduplicate(pois: PoiItem[]): PoiItem[] {
    const result: PoiItem[] = [];

    for (const poi of pois) {
      const duplicateIndex = result.findIndex(
        (candidate) =>
          this.haversineKm(
            candidate.coordinates.lat,
            candidate.coordinates.lon,
            poi.coordinates.lat,
            poi.coordinates.lon,
          ) < 0.05, // 50 метров радиус дубликата
      );

      if (duplicateIndex === -1) {
        result.push(poi);
        continue;
      }

      // Разрешение конфликтов при дублях:
      // В данном случае KudaGo дает более качественные данные,
      // но если у Overpass рейтинг выше (или у KudaGo нет) - берем его.
      // По умолчанию рейтинг KudaGo ставится 4.5, Overpass 4.0.
      const existing = result[duplicateIndex];
      const isPoiBetter = (poi.rating ?? 0) > (existing.rating ?? 0);

      if (isPoiBetter) {
        result[duplicateIndex] = poi;
      }
    }

    return result;
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

  private async generateMissingPois(
    city: string,
    count: number,
    existingPois: PoiItem[],
  ): Promise<PoiItem[]> {
    const existingNames = existingPois.map((p) => p.name).join(', ');
    const prompt = `Пользователь ищет интересные места (достопримечательности, парки, музеи, кафе) в городе "${city}".
Мы нашли только эти места: ${existingNames || 'ничего'}.
Нам нужно еще ${count} реальных интересных мест в этом городе.
Они должны реально существовать в городе ${city}.
Сгенерируй JSON с массивом из ${count} объектов:
{
  "points": [
    {
      "name": "Название места",
      "category": "attraction|museum|park|restaurant|cafe",
      "rating": 4.5,
      "address": "Примерный адрес в городе ${city}"
    }
  ]
}
Верни строго валидный JSON. Без markdown. Без ничего лишнего.`;

    const response = await this.llmClientService.client.chat.completions.create(
      {
        model: this.llmClientService.model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Ты эксперт по туризму. Твоя задача — подсказывать реально существующие места в заданном городе, если база данных пуста. Возвращай только JSON.',
          },
          { role: 'user', content: prompt },
        ],
      },
    );

    const content = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content) as {
      points?: Array<{
        name?: string;
        category?: string;
        rating?: number;
        address?: string;
      }>;
    };

    if (!Array.isArray(parsed.points)) {
      throw new Error('LLM returned invalid format (missing points array)');
    }

    return parsed.points
      .filter((p) => p.name && typeof p.name === 'string')
      .slice(0, count)
      .map((p) => {
        // Делаем фейковые координаты около центра города, так как LLM их не даст точно
        // В реальном проекте тут можно было бы вызвать геокодер Dadata/Yandex
        const lat =
          existingPois.length > 0
            ? existingPois[0].coordinates.lat + (Math.random() - 0.5) * 0.02
            : 55.75;
        const lon =
          existingPois.length > 0
            ? existingPois[0].coordinates.lon + (Math.random() - 0.5) * 0.02
            : 37.61;

        return {
          id: `llm-${randomUUID()}`,
          name: p.name!,
          address: p.address || city,
          category:
            (p.category as import('../types/pipeline.types').PoiCategory) ||
            'attraction',
          coordinates: { lat, lon },
          price_segment: 'mid',
          rating: p.rating ?? 4.0,
        };
      });
  }
}

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
      photon: this.buildEmptyProviderStat('photon'),
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

    // 3) TRI-108-6: If food focus detected and food POI count is low, search via Photon
    const hasFoodFocus = intent.categories.some(
      (cat) =>
        /cafe|кафе|restaurant|ресторан|bar|бар|food|еда|coffee|кофе/i.test(cat),
    );
    const foodCount = [...kudagoRaw, ...overpassRaw].filter(
      (p) => p.category === 'restaurant' || p.category === 'cafe',
    ).length;

    this.logger.log(
      `[ProviderSearch] TRI-108-6 DEBUG: hasFoodFocus=${hasFoodFocus}, foodCount=${foodCount}, intent.categories=[${intent.categories.join(', ')}]`,
    );

    let photonRaw: PoiItem[] = [];
    if (hasFoodFocus && foodCount < 2) {
      this.logger.log(
        `[ProviderSearch] TRI-108-6 TRIGGERED: Food focus detected with only ${foodCount} food POIs. Searching Photon for city: ${intent.city}`,
      );
      providerStats.photon = this.buildEmptyProviderStat('photon');
      providerStats.photon.attempted = true;
      try {
        photonRaw = await this.searchPhotonForFood(intent.city);
        providerStats.photon.raw_count = photonRaw.length;
        providerStats.photon.used_count = photonRaw.length;
        this.logger.log(
          `[ProviderSearch] ✅ Photon returned ${photonRaw.length} food venues: [${photonRaw.map(p => `${p.name}(${p.category})`).join(', ')}]`,
        );
        fallbacks.push('PHOTON_FOOD_SEARCH_SUPPLEMENT');
      } catch (error: unknown) {
        providerStats.photon.failed = true;
        providerStats.photon.fail_reason =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[ProviderSearch] ❌ Photon food search failed: ${providerStats.photon.fail_reason}`,
        );
      }
    } else {
      this.logger.log(
        `[ProviderSearch] TRI-108-6 SKIP: hasFoodFocus=${hasFoodFocus}, foodCount=${foodCount} (need both true and < 2)`,
      );
    }

    // 3a) Объединяем и дедуплицируем
    pois = [...kudagoRaw, ...overpassRaw, ...photonRaw];

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
    const finalFood = result.filter(
      (p) => p.category === 'restaurant' || p.category === 'cafe',
    );

    this.logger.log(
      `[ProviderSearch] FINAL: ${result.length} POIs (${finalFood.length} food) | Providers: K=${providerStats.kudago.raw_count} O=${providerStats.overpass.raw_count} P=${providerStats.photon.raw_count} L=${providerStats.llm_fill.raw_count}`,
    );

    return {
      pois: result,
      shadowDiagnostics: {
        provider_stats: [
          providerStats.kudago,
          providerStats.overpass,
          providerStats.photon,
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

  // TRI-108-6: Search Photon API for food venues (cafes, restaurants)
  private async searchPhotonForFood(city: string): Promise<PoiItem[]> {
    this.logger.log(`[Photon] Starting food venue search for city: ${city}`);
    const results: PoiItem[] = [];

    // Search for "кафе" and "ресторан" in the city
    const queries = [`кафе ${city}`, `ресторан ${city}`];

    for (const query of queries) {
      try {
        const url = new URL('https://photon.komoot.io/api/');
        url.searchParams.set('q', query);
        url.searchParams.set('limit', '10');
        url.searchParams.set('lang', 'ru');

        this.logger.log(`[Photon] Fetching: ${url.toString()}`);
        const response = await fetch(url.toString());

        if (!response.ok) {
          this.logger.error(
            `[Photon] ❌ HTTP ${response.status} for query "${query}"`,
          );
          continue;
        }

        const data = (await response.json()) as any;
        const features = data.features || [];
        this.logger.log(
          `[Photon] Query "${query}" returned ${features.length} features`,
        );

        for (const feature of features) {
          const props = feature.properties || {};
          const coords = feature.geometry?.coordinates;

          if (!coords || coords.length < 2) {
            this.logger.warn(
              `[Photon] Skipped ${props.name} - invalid coordinates`,
            );
            continue;
          }

          // Determine if it's a cafe or restaurant
          const name = props.name || 'Unnamed Food Venue';
          const amenity = props.amenity || '';

          let category: 'cafe' | 'restaurant' = 'cafe';
          if (/ресторан|rstoran|rest/i.test(name) || amenity === 'restaurant') {
            category = 'restaurant';
          }

          const poi: PoiItem = {
            id: `photon-${props.osm_id || randomUUID()}`,
            name,
            address: props.address || city,
            category,
            coordinates: { lat: coords[1], lon: coords[0] },
            price_segment: 'mid',
            rating: 4.2,
            website: props.website || undefined,
          };

          results.push(poi);
          this.logger.log(`[Photon] ✅ Added ${name} (${category})`);
        }
      } catch (error) {
        this.logger.error(
          `[Photon] ❌ Error for "${query}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(
      `[Photon] ✅ Search complete. Total results: ${results.length}`,
    );
    return results;
  }
}

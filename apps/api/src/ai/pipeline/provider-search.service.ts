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
import { GeosearchService } from '../../geosearch/geosearch.service';
import { randomUUID } from 'crypto';

@Injectable()
export class ProviderSearchService {
  private readonly logger = new Logger(ProviderSearchService.name);

  constructor(
    private readonly kudagoClient: KudagoClientService,
    private readonly overpassClient: OverpassClientService,
    private readonly llmClientService: LlmClientService,
    private readonly geosearch: GeosearchService,
  ) {}

  private normalizeCityName(rawCity: string): string {
    const city = rawCity
      .toLowerCase()
      .trim()
      .replace(/[^a-zа-яё0-9]/g, ' ');

    if (
      ['спб', 'питер', 'ленинград', 'petersburg', 'spb'].some((s) =>
        city.includes(s),
      )
    ) {
      return 'Санкт-Петербург';
    }
    if (['мск', 'москва', 'moscow'].some((s) => city.includes(s))) {
      return 'Москва';
    }
    if (
      ['екб', 'екатеринбург', 'свердловск', 'yekaterinburg'].some((s) =>
        city.includes(s),
      )
    ) {
      return 'Екатеринбург';
    }
    if (
      ['нск', 'новосиб', 'новосибирск', 'novosibirsk'].some((s) =>
        city.includes(s),
      )
    ) {
      return 'Новосибирск';
    }
    if (
      ['нн', 'нижний', 'nizhny novgorod', 'novgorod'].some((s) =>
        city.includes(s),
      ) &&
      !city.includes('великий')
    ) {
      return 'Нижний Новгород';
    }
    if (['крд', 'краснодар', 'krasnodar'].some((s) => city.includes(s))) {
      return 'Краснодар';
    }
    if (['казань', 'kazan'].some((s) => city.includes(s))) {
      return 'Казань';
    }
    if (['сочи', 'sochi'].some((s) => city.includes(s))) {
      return 'Сочи';
    }

    return rawCity;
  }

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
    // TRI-115: Нормализация названия города для стабильной работы провайдеров
    const originalCity = intent.city;
    intent.city = this.normalizeCityName(intent.city);

    if (originalCity !== intent.city) {
      this.logger.log(
        `[ProviderSearch] City normalized: "${originalCity}" -> "${intent.city}"`,
      );
    }

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
    const tKudaGo = Date.now();
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
      `[ProviderSearch] KudaGo returned ${kudagoRaw.length} points in ${Date.now() - tKudaGo}ms.`,
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
      const tOverpass = Date.now();
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
        `[ProviderSearch] Overpass returned ${overpassRaw.length} points in ${Date.now() - tOverpass}ms.`,
      );
    }

    // 3) TRI-108-6: If food focus detected, supplement with Photon + AI
    const hasFoodFocus = intent.categories.some(
      (cat) =>
        /cafe|кафе|restaurant|ресторан|bar|бар|food|еда|coffee|кофе/i.test(cat),
    );

    let photonRaw: PoiItem[] = [];
    let aiGeneratedFood: PoiItem[] = [];

    if (hasFoodFocus) {
      this.logger.log(
        `[ProviderSearch] TRI-108-6: Food focus detected. Attempting Photon + AI supplements for ${intent.city}...`,
      );

      // Try Photon first (real data from OSM)
      providerStats.photon = this.buildEmptyProviderStat('photon');
      providerStats.photon.attempted = true;
      const tPhoton = Date.now();
      try {
        photonRaw = await this.searchPhotonForFood(intent.city);
        providerStats.photon.raw_count = photonRaw.length;
        providerStats.photon.used_count = photonRaw.length;
        if (photonRaw.length > 0) {
          this.logger.log(
            `[ProviderSearch] ✅ Photon returned ${photonRaw.length} food venues in ${Date.now() - tPhoton}ms.`,
          );
          fallbacks.push('PHOTON_FOOD_SEARCH_SUPPLEMENT');
        }
      } catch (error: unknown) {
        providerStats.photon.failed = true;
        providerStats.photon.fail_reason =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[ProviderSearch] ⚠️ Photon search failed after ${Date.now() - tPhoton}ms: ${providerStats.photon.fail_reason}`,
        );
      }

      // If Photon returned < 2 food POIs, use AI as fallback
      const allFoodPois = [...kudagoRaw, ...overpassRaw, ...photonRaw];
      const allFood = allFoodPois.filter(
        (p) => p.category === 'restaurant' || p.category === 'cafe',
      ).length;

      if (allFood < 2) {
        this.logger.log(
          `[ProviderSearch] 🤖 TRI-108-6 AI FALLBACK TRIGGERED: Only ${allFood} food POIs. Intent: "${intent.preferences_text}"`,
        );
        const tAiFood = Date.now();
        try {
          aiGeneratedFood = await this.generateFoodVenuesWithAI(intent);
          this.logger.log(
            `[ProviderSearch] ✨ AI generated ${aiGeneratedFood.length} food venues in ${Date.now() - tAiFood}ms.`,
          );

          if (aiGeneratedFood.length > 0) {
            fallbacks.push('AI_GENERATED_FOOD_RECOMMENDATIONS');
          }
        } catch (error: unknown) {
          this.logger.warn(
            `[ProviderSearch] ⚠️ AI generation failed after ${Date.now() - tAiFood}ms: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

     const filterFn = (p: PoiItem) => {
       const lat = p.coordinates?.lat;
       const lon = p.coordinates?.lon;
       const isValid =
         lat !== undefined &&
         lon !== undefined &&
         Number.isFinite(lat) &&
         Number.isFinite(lon) &&
         (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001) &&
         !(lat === 0 && lon === 0);

       return isValid;
     };

    pois = [
      ...kudagoRaw.filter(filterFn),
      ...overpassRaw.filter(filterFn),
      ...photonRaw.filter(filterFn),
      ...aiGeneratedFood.filter(filterFn),
    ];

    // Если после объединения все еще мало POI, пробуем расширить радиус поиска Overpass
    if (pois.length < 3) {
      this.logger.warn(
        `[ProviderSearch] Still low on POIs (${pois.length}). Retrying Overpass with radius * 1.3...`,
      );
      providerStats.overpass.attempted = true;
      const tRetry = Date.now();
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
        `[ProviderSearch] After Overpass retry (${Date.now() - tRetry}ms), total raw points: ${pois.length}`,
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
      const tLlmFill = Date.now();
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
          `[ProviderSearch] Successfully generated ${generatedPois.length} missing points in ${Date.now() - tLlmFill}ms. Total now: ${pois.length}`,
        );
      } catch (error: any) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[ProviderSearch] Failed to generate missing points via LLM after ${Date.now() - tLlmFill}ms: ${errorMessage}`,
        );
        providerStats.llm_fill.failed = true;
        providerStats.llm_fill.fail_reason = errorMessage;
        fallbacks.push('LLM_POI_GENERATION_FAILED');
      }
    }

    const deduped = this.deduplicate(pois.filter(filterFn));
    const result = deduped.slice(0, 100);

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
          ) < 0.05,
      );
      if (duplicateIndex === -1) {
        result.push(poi);
        continue;
      }
      const existing = result[duplicateIndex];
      if ((poi.rating ?? 0) > (existing.rating ?? 0)) {
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
    const prompt = `Пользователь ищет интересные места в городе "${city}".
Мы нашли только эти места: ${existingNames || 'ничего'}.
Нам нужно еще ${count} реальных интересных мест.
Верни JSON: { "points": [ { "name": "Название", "category": "attraction", "rating": 4.5, "address": "Адрес" } ] }`;

    const response = await this.llmClientService.client.chat.completions.create(
      {
        model: this.llmClientService.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Ты эксперт по туризму. Возвращай только JSON.' },
          { role: 'user', content: prompt },
        ],
      },
    );

    const content = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content) as { points?: any[] };
    const results: PoiItem[] = [];

    for (const p of (parsed.points || []).slice(0, count)) {
      try {
        const query = `${p.name}, ${city}`;
        const suggestions = await this.geosearch.suggest(query);
         if (suggestions && suggestions.length > 0) {
           const best = suggestions[0];
           results.push({
             id: `llm-${randomUUID()}`,
             name: p.name,
             address: best.address || p.address || city,
             category: p.category || 'attraction',
             coordinates: { lat: best.lat, lon: best.lon },
             price_segment: 'mid',
             rating: p.rating ?? 4.0,
           });
         }
      } catch (err) {}
    }
    return results;
  }

  private async searchPhotonForFood(city: string): Promise<PoiItem[]> {
    const results: PoiItem[] = [];
    const isCyrillicCity = /[а-яА-ЯёЁ]/.test(city);
    const searchLang = isCyrillicCity ? 'ru' : 'en';
    const queries = isCyrillicCity ? [`кафе ${city}`, `ресторан ${city}`] : [`restaurant ${city}`, `cafe ${city}`];

    for (const query of queries) {
      try {
        const url = new URL('https://photon.komoot.io/api/');
        url.searchParams.set('q', query);
        url.searchParams.set('limit', '10');
        url.searchParams.set('lang', searchLang);
        const response = await fetch(url.toString(), {
          headers: { 'User-Agent': 'TravelPlanner/1.0 (AI pipeline)' },
        });
        if (!response.ok) continue;
        const data = (await response.json()) as any;
        for (const feature of (data.features || [])) {
          const props = feature.properties || {};
          const coords = feature.geometry?.coordinates;
          if (!coords || coords.length < 2) continue;
          results.push({
            id: `photon-${props.osm_id || randomUUID()}`,
            name: props.name || 'Unnamed',
            address: props.address || city,
            category: 'restaurant',
            coordinates: { lat: coords[1], lon: coords[0] },
            price_segment: 'mid',
            rating: 4.2,
          });
        }
      } catch (error) {}
    }
    return results;
  }

  private async generateFoodVenuesWithAI(
    intent: ParsedIntent,
  ): Promise<PoiItem[]> {
    const prompt = `Generate 5 realistic restaurant recommendations in ${intent.city} based on preferences: ${intent.preferences_text}. Return JSON: { "restaurants": [ { "name": "Name", "cuisine": "Type", "price_segment": "mid", "rating": 4.2 } ] }`;

    try {
      const response = await this.llmClientService.client.chat.completions.create(
        {
          model: this.llmClientService.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are a local food expert. Return JSON.' },
            { role: 'user', content: prompt },
          ],
        },
      );

      const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}') as { restaurants?: any[] };
      const results: PoiItem[] = [];
       for (const r of (parsed.restaurants || [])) {
         try {
           const suggestions = await this.geosearch.suggest(`${r.name}, ${intent.city}`);
           if (suggestions && suggestions.length > 0) {
             const best = suggestions[0];
             results.push({
               id: `ai-food-${randomUUID().slice(0, 8)}`,
               name: r.name,
               address: best.address || intent.city,
               category: 'restaurant',
               coordinates: { lat: best.lat, lon: best.lon },
               price_segment: 'mid',
               rating: r.rating || 4.2,
               ai_generated: true,
             });
           }
         } catch (error) {}
       }
      return results;
    } catch (error) {
      throw error;
    }
  }
}

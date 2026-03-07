import { Injectable, Logger } from '@nestjs/common';
import type { ParsedIntent } from '../types/pipeline.types';
import type { PoiItem } from '../types/poi.types';
import { KudagoClientService } from './kudago-client.service';
import { OverpassClientService } from './overpass-client.service';

@Injectable()
export class ProviderSearchService {
  private readonly logger = new Logger(ProviderSearchService.name);

  constructor(
    private readonly kudagoClient: KudagoClientService,
    private readonly overpassClient: OverpassClientService,
  ) {}

  async fetchAndFilter(
    intent: ParsedIntent,
    fallbacks: string[] = [],
  ): Promise<PoiItem[]> {
    this.logger.log(
      `[ProviderSearch] Started for city: "${intent.city}", categories: [${intent.categories.join(', ')}]`,
    );

    let pois: PoiItem[] = [];

    // 1) Сначала обращаемся к приоритетному источнику (KudaGo)
    this.logger.log(`[ProviderSearch] Requesting KudaGo API...`);
    const kudagoRaw = await this.kudagoClient.fetchByIntent(intent);
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
      overpassRaw = await this.overpassClient.fetchByIntent(intent);
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
      const retryOverpass = await this.overpassClient.fetchByIntent({
        ...intent,
        radius_km: intent.radius_km * 1.3,
      });
      pois = [...kudagoRaw, ...retryOverpass];
      this.logger.log(
        `[ProviderSearch] After Overpass retry, total raw points: ${pois.length}`,
      );
    }

    if (pois.length === 0) {
      this.logger.error(
        `[ProviderSearch] ❌ FATAL: 0 points found for ${intent.city} across all providers.`,
      );
      return [];
    }

    this.logger.log(
      `[ProviderSearch] Starting deduplication of ${pois.length} points...`,
    );
    const deduped = this.deduplicate(pois);
    this.logger.log(
      `[ProviderSearch] Deduplication complete. Unique points: ${deduped.length}`,
    );

    // 4) Pre-filter: оставляем не более 15, сортируем (приоритет: рейтинг)
    const result = deduped
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 15);

    this.logger.log(
      `[ProviderSearch] Final pre-filter complete. Returning top ${result.length} points for Semantic Filter.`,
    );
    return result;
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
}

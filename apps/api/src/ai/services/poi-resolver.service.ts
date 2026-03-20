import { Injectable, Logger } from '@nestjs/common';
import { ProviderSearchService } from '../pipeline/provider-search.service';
import type { FilteredPoi } from '../types/poi.types';
import type { ParsedIntent } from '../types/pipeline.types';

@Injectable()
export class PoiResolverService {
  private readonly logger = new Logger('AI:PoiResolver');
  private readonly cache = new Map<string, FilteredPoi>();

  constructor(private readonly providerSearch: ProviderSearchService) {}

  private normalize(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  /**
   * Find a specific POI by name within the city's POI pool.
   * Uses provider cache (Redis) so repeated calls for the same city are fast.
   */
  async resolve(params: {
    name: string;
    category?: string;
    city: string;
    intent?: Partial<ParsedIntent>;
  }): Promise<FilteredPoi | null> {
    const key = `${params.city}:${this.normalize(params.name)}`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    try {
      const searchIntent: ParsedIntent = {
        city: params.city,
        days: 1,
        budget_total: null,
        budget_per_day: null,
        budget_per_person: null,
        party_type: 'solo',
        party_size: 1,
        poi_count_requested: null,
        min_restaurants: null,
        min_cafes: null,
        max_poi: null,
        categories: params.category ? [params.category as any] : [],
        excluded_categories: [],
        radius_km: 15,
        start_time: '09:00',
        end_time: '22:00',
        preferences_text: params.name,
        country_code: null,
        ...(params.intent ?? {}),
      };

      const { pois } = await this.providerSearch.fetchAndFilter(searchIntent, []);
      const normTarget = this.normalize(params.name);

      const match =
        pois.find((p) => {
          const normName = this.normalize(p.name);
          return normName.includes(normTarget) || normTarget.includes(normName);
        }) ?? null;

      if (!match) return null;

      const coords = match.coordinates;
      const isInvalid =
        !coords ||
        !Number.isFinite(coords.lat) ||
        !Number.isFinite(coords.lon) ||
        (Math.abs(coords.lat) < 0.001 && Math.abs(coords.lon) < 0.001);
      if (isInvalid) return null;

      const filtered: FilteredPoi = {
        ...match,
        description: match.description || `Интересное место: ${match.name}.`,
      };
      this.cache.set(key, filtered);
      return filtered;
    } catch (e) {
      this.logger.error(`[PoiResolver] Failed to resolve "${params.name}": ${e}`);
      return null;
    }
  }
}

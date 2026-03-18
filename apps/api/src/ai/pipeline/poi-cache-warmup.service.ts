import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { ProviderSearchService } from './provider-search.service';
import type { ParsedIntent } from '../types/pipeline.types';

// Top Russian tourist cities — pre-warmed on server start so the first user
// request for any of these cities hits the cache rather than cold external APIs.
const POPULAR_CITIES: string[] = [
  'Москва',
  'Санкт-Петербург',
  'Казань',
  'Сочи',
  'Екатеринбург',
  'Нижний Новгород',
  'Новосибирск',
  'Краснодар',
];

// Minimal intent for warmup — only city matters; days/budget don't affect Stage 1 collection.
function buildWarmupIntent(city: string): ParsedIntent {
  return {
    city,
    days: 2,
    budget_total: null,
    budget_per_day: null,
    budget_per_person: null,
    party_type: 'solo',
    party_size: 1,
    poi_count_requested: null,
    min_restaurants: null,
    min_cafes: null,
    max_poi: null,
    categories: [],
    excluded_categories: [],
    radius_km: 15,
    start_time: '09:00',
    end_time: '21:00',
    preferences_text: '',
    country_code: 'RU',
  };
}

const WARMUP_DELAY_MS = 10_000;      // wait 10 s after startup before starting
const BETWEEN_CITIES_DELAY_MS = 8_000; // 8 s between cities (Overpass rate-limit)

@Injectable()
export class PoiCacheWarmupService implements OnApplicationBootstrap {
  private readonly logger = new Logger('POICache:Warmup');

  constructor(
    private readonly redis: RedisService,
    private readonly providerSearch: ProviderSearchService,
  ) {}

  onApplicationBootstrap() {
    // Non-blocking: runs in background after server is ready.
    // Startup time is not affected.
    setTimeout(() => void this.warmupAll(), WARMUP_DELAY_MS);
  }

  /** Called by the admin flush endpoint to force a single city refresh. */
  async flushCity(city: string): Promise<{ key: string; deleted: boolean }> {
    const key = `poi_pool:v2:${city.toLowerCase().replace(/\s+/g, '_')}`;
    await this.redis.del(key);
    this.logger.log(`[Flush] Cache invalidated for key: ${key}`);

    // Optionally re-warm immediately (fire-and-forget)
    void this.warmCity(city);

    return { key, deleted: true };
  }

  private async warmupAll(): Promise<void> {
    this.logger.log(`[Warmup] Starting pre-warm for ${POPULAR_CITIES.length} cities...`);

    for (const city of POPULAR_CITIES) {
      const cacheKey = `poi_pool:v2:${city.toLowerCase().replace(/\s+/g, '_')}`;
      const existing = await this.redis.get(cacheKey);

      if (existing) {
        this.logger.log(`[Warmup] "${city}" already in cache — skipping`);
      } else {
        await this.warmCity(city);
        // Rate-limit: pause between cities to avoid hammering Overpass/KudaGo
        await this.sleep(BETWEEN_CITIES_DELAY_MS);
      }
    }

    this.logger.log('[Warmup] Done.');
  }

  private async warmCity(city: string): Promise<void> {
    this.logger.log(`[Warmup] Fetching "${city}"...`);
    try {
      const intent = buildWarmupIntent(city);
      await this.providerSearch.fetchAndFilter(intent);
      this.logger.log(`[Warmup] "${city}" cached successfully`);
    } catch (err: any) {
      // Non-fatal: warmup failure only means the first real request will be cold
      this.logger.warn(`[Warmup] "${city}" failed: ${err?.message ?? err}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

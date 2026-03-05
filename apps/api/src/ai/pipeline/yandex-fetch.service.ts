import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ParsedIntent, PoiCategory } from '../types/pipeline.types';
import type { PoiItem, PriceSegment } from '../types/poi.types';

interface RawYandexFeature {
  geometry?: {
    coordinates?: [number, number];
  };
  properties?: {
    name?: string;
    description?: string;
    CompanyMetaData?: {
      Hours?: {
        text?: string;
      };
      Phones?: Array<{ formatted?: string }>;
      url?: string;
      Categories?: Array<{ name?: string }>;
      Reviews?: {
        rating?: number;
      };
    };
  };
}

interface YandexSearchResponse {
  features?: RawYandexFeature[];
}

@Injectable()
export class YandexFetchService {
  async fetchAndFilter(intent: ParsedIntent): Promise<PoiItem[]> {
    const results = await Promise.all(
      intent.categories.map((category) => this.fetchCategory(category, intent)),
    );

    let pois = this.applyPipeline(results.flat(), intent);

    if (pois.length < 3) {
      const retryRadius = Math.min(
        Number((intent.radius_km * 1.3).toFixed(2)),
        50,
      );
      const retryResults = await Promise.all(
        intent.categories.map((category) =>
          this.fetchCategory(category, { ...intent, radius_km: retryRadius }),
        ),
      );

      pois = this.applyPipeline(retryResults.flat(), {
        ...intent,
        radius_km: retryRadius,
      });
    }

    if (pois.length < 3) {
      throw new UnprocessableEntityException('Not enough POIs found (F-04)');
    }

    return pois;
  }

  private applyPipeline(pois: PoiItem[], intent: ParsedIntent): PoiItem[] {
    const valid = pois.filter((poi) =>
      this.isValidCoordinates(poi.coordinates.lat, poi.coordinates.lon),
    );
    const deduped = this.deduplicate(valid);

    return deduped
      .filter((poi) => !intent.excluded_categories.includes(poi.category))
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 15);
  }

  private async fetchCategory(
    category: PoiCategory,
    intent: ParsedIntent,
  ): Promise<PoiItem[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const apiKey = process.env.YANDEX_MAPS_API_KEY;
      if (!apiKey) return [];

      const url = new URL('https://search-maps.yandex.ru/v1/');
      url.searchParams.set(
        'text',
        `${this.categoryToSearchText(category)} ${intent.city}`,
      );
      url.searchParams.set('type', 'biz');
      url.searchParams.set('lang', 'ru_RU');
      url.searchParams.set('results', '12');
      url.searchParams.set('apikey', apiKey);

      const delta = Math.max(intent.radius_km / 111, 0.01);
      url.searchParams.set('spn', `${delta},${delta}`);

      const response = await fetch(url.toString(), {
        signal: controller.signal,
      });
      if (!response.ok) return [];

      const data = (await response.json()) as YandexSearchResponse;
      return (data.features ?? [])
        .map((feature) => this.normalize(feature, category, intent.city))
        .filter((item): item is PoiItem => item !== null);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private normalize(
    feature: RawYandexFeature,
    category: PoiCategory,
    city: string,
  ): PoiItem | null {
    const coordinates = feature.geometry?.coordinates;
    if (!coordinates || coordinates.length < 2) return null;

    const [lon, lat] = coordinates;
    const name = feature.properties?.name?.trim();
    if (!name) return null;

    const addressRaw = feature.properties?.description?.trim();
    const address = addressRaw ? `${city}, ${addressRaw}` : city;

    const company = feature.properties?.CompanyMetaData;
    const rating = this.toRating(company?.Reviews?.rating);
    const phone = company?.Phones?.[0]?.formatted?.trim();
    const website = company?.url?.trim();
    const workingHours = company?.Hours?.text?.trim();
    const categoryOverride = this.normalizeCategoryFromMeta(
      company?.Categories,
      category,
    );

    return {
      id: this.makePoiId(name, address, lat, lon),
      name,
      address,
      coordinates: { lat, lon },
      category: categoryOverride,
      rating,
      working_hours: workingHours,
      price_segment: this.toPriceSegment(categoryOverride, rating),
      phone,
      website,
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

  private isValidCoordinates(lat: number, lon: number): boolean {
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
    );
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

  private categoryToSearchText(category: PoiCategory): string {
    const map: Record<PoiCategory, string> = {
      museum: 'музей',
      park: 'парк',
      restaurant: 'ресторан',
      cafe: 'кафе',
      attraction: 'достопримечательность',
      shopping: 'торговый центр',
      entertainment: 'развлечения',
    };

    return map[category];
  }

  private normalizeCategoryFromMeta(
    categories: Array<{ name?: string }> | undefined,
    fallback: PoiCategory,
  ): PoiCategory {
    if (!categories || categories.length === 0) return fallback;

    const merged = categories
      .map((item) => item.name?.toLowerCase() ?? '')
      .join(' ');

    if (merged.includes('музе')) return 'museum';
    if (merged.includes('парк') || merged.includes('сквер')) return 'park';
    if (merged.includes('ресторан')) return 'restaurant';
    if (merged.includes('кафе') || merged.includes('кофейн')) return 'cafe';
    if (merged.includes('магазин') || merged.includes('торгов'))
      return 'shopping';
    if (
      merged.includes('кино') ||
      merged.includes('театр') ||
      merged.includes('развлеч')
    )
      return 'entertainment';

    return fallback;
  }

  private toRating(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
    return Math.min(5, Math.max(0, value));
  }

  private toPriceSegment(category: PoiCategory, rating?: number): PriceSegment {
    if (category === 'park' || category === 'attraction') return 'free';
    if ((rating ?? 0) >= 4.6) return 'premium';
    if ((rating ?? 0) >= 4.2) return 'mid';
    return 'budget';
  }

  private makePoiId(
    name: string,
    address: string,
    lat: number,
    lon: number,
  ): string {
    const raw = `${name}|${address}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 24);
  }
}

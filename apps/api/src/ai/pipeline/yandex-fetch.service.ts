import { Injectable, Logger } from '@nestjs/common';
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

interface NominatimItem {
  display_name?: string;
  lat?: string;
  lon?: string;
}

interface PhotonFeature {
  properties?: {
    name?: string;
    city?: string;
    country?: string;
    street?: string;
    housenumber?: string;
  };
  geometry?: { coordinates?: [number, number] };
}

@Injectable()
export class YandexFetchService {
  private readonly logger = new Logger(YandexFetchService.name);

  async fetchAndFilter(intent: ParsedIntent): Promise<PoiItem[]> {
    const results = await Promise.all(
      intent.categories.map((category) => this.fetchCategory(category, intent)),
    );

    const firstRaw = results.flat();
    let pois = this.applyPipeline(firstRaw, intent);

    this.logger.warn(
      `Yandex fetch pass=1 raw=${firstRaw.length} filtered=${pois.length} city=${intent.city} radius_km=${intent.radius_km}`,
    );

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

      this.logger.warn(
        `Yandex fetch pass=2 raw=${retryResults.flat().length} filtered=${pois.length} city=${intent.city} radius_km=${retryRadius}`,
      );
    }

    if (pois.length < 3) {
      this.logger.warn(
        `Yandex fetch low-result: returning partial list count=${pois.length} city=${intent.city}`,
      );
      return pois;
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
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const queries = this.categorySearchQueries(category, intent.city);

      for (const query of queries) {
        const photon = await this.searchPhotonFallback({
          q: query,
          category,
          city: intent.city,
          signal: controller.signal,
        });

        if (photon.length > 0) {
          this.logger.warn(
            `Found ${photon.length} POIs via Photon for query="${query}"`,
          );
          return photon;
        }

        const nominatim = await this.searchNominatimFallback({
          q: query,
          category,
          city: intent.city,
          signal: controller.signal,
        });

        if (nominatim.length > 0) {
          this.logger.warn(
            `Found ${nominatim.length} POIs via Nominatim for query="${query}"`,
          );
          return nominatim;
        }
      }

      return [];
    } catch (e) {
      this.logger.error(`Error fetching POIs for category=${category}:`, e);
      return [];
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async searchYandex(params: {
    apiKey: string;
    text: string;
    type: 'biz' | 'geo';
    city: string;
    signal: AbortSignal;
    spn?: string;
  }): Promise<PoiItem[]> {
    const url = new URL('https://search-maps.yandex.ru/v1/');
    url.searchParams.set('text', params.text);
    url.searchParams.set('type', params.type);
    url.searchParams.set('lang', 'ru_RU');
    url.searchParams.set('results', '15');
    url.searchParams.set('apikey', params.apiKey);

    if (params.spn) {
      url.searchParams.set('spn', params.spn);
    }

    const response = await fetch(url.toString(), {
      signal: params.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No body');
      this.logger.warn(
        `Yandex HTTP ${response.status} for text="${params.text}" type=${params.type}. Response: ${errorText.slice(0, 150)}`,
      );
      return [];
    }

    const data = (await response.json()) as YandexSearchResponse;

    const normalizedCategory = this.searchTextToCategory(params.text);
    return (data.features ?? [])
      .map((feature) =>
        this.normalize(feature, normalizedCategory, params.city),
      )
      .filter((item): item is PoiItem => item !== null);
  }

  private shouldTryGeoFallback(category: PoiCategory): boolean {
    return (
      category === 'attraction' ||
      category === 'museum' ||
      category === 'park' ||
      category === 'entertainment'
    );
  }

  private categorySearchQueries(category: PoiCategory, city: string): string[] {
    const unique = new Set<string>();
    const add = (value: string) => {
      const normalized = value.trim();
      if (normalized) unique.add(normalized);
    };

    switch (category) {
      case 'attraction':
        add(`достопримечательности ${city}`);
        add(`интересные места ${city}`);
        add(`что посмотреть ${city}`);
        break;
      case 'museum':
        add(`музей ${city}`);
        add(`музеи ${city}`);
        break;
      case 'park':
        add(`парк ${city}`);
        add(`сквер ${city}`);
        break;
      case 'restaurant':
        add(`ресторан ${city}`);
        add(`где поесть ${city}`);
        break;
      case 'cafe':
        add(`кафе ${city}`);
        add(`кофейня ${city}`);
        break;
      case 'shopping':
        add(`торговый центр ${city}`);
        add(`магазины ${city}`);
        break;
      case 'entertainment':
        add(`развлечения ${city}`);
        add(`театр ${city}`);
        add(`кинотеатр ${city}`);
        break;
      default:
        add(`${this.categoryToSearchText(category)} ${city}`);
        break;
    }

    add(city);
    return Array.from(unique).slice(0, 4);
  }

  private async searchPhotonFallback(params: {
    q: string;
    category: PoiCategory;
    city: string;
    signal: AbortSignal;
  }): Promise<PoiItem[]> {
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', params.q);
    url.searchParams.set('limit', '15');
    // Ограничиваем поиск Россией для начала, чтобы уменьшить мусор
    url.searchParams.set('bbox', '19.64,41.16,169.4,81.86');

    try {
      const response = await fetch(url.toString(), {
        signal: params.signal,
        headers: { 'User-Agent': 'TravelPlanner/1.0 (AI pipeline)' },
      });

      if (!response.ok) return [];

      const data = (await response.json()) as { features?: PhotonFeature[] };
      return (data.features ?? [])
        .map((feature, index) =>
          this.normalizePhoton(feature, params.category, params.city, index),
        )
        .filter((item): item is PoiItem => item !== null);
    } catch {
      return [];
    }
  }

  private normalizePhoton(
    feature: PhotonFeature,
    category: PoiCategory,
    requestCity: string,
    _index: number,
  ): PoiItem | null {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) return null;

    const [lon, lat] = coords;

    // Если Photon не вернул имя, пытаемся собрать из улицы и дома, иначе пропускаем
    let name = feature.properties?.name?.trim();
    if (!name) {
      const street = feature.properties?.street;
      const house = feature.properties?.housenumber;
      if (street && house) {
        name = `${street}, ${house}`;
      } else {
        return null; // Нам нужны именованные точки для маршрута
      }
    }

    const city = feature.properties?.city ?? requestCity;
    const address = `${city}, ${name}`;

    return {
      id: this.makePoiId(name, address, lat, lon),
      name,
      address,
      coordinates: { lat, lon },
      category,
      rating: undefined,
      working_hours: undefined,
      price_segment: this.toPriceSegment(category),
      phone: undefined,
      website: undefined,
    };
  }

  private async searchNominatimFallback(params: {
    q: string;
    category: PoiCategory;
    city: string;
    signal: AbortSignal;
  }): Promise<PoiItem[]> {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', params.q);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '15');
    url.searchParams.set('accept-language', 'ru');
    url.searchParams.set('countrycodes', 'ru');

    try {
      const response = await fetch(url.toString(), {
        signal: params.signal,
        headers: {
          'User-Agent': 'TravelPlanner/1.0 (AI pipeline)',
        },
      });

      if (!response.ok) return [];

      const items = (await response.json()) as NominatimItem[];
      return items
        .map((item, index) =>
          this.normalizeNominatim(item, params.category, index),
        )
        .filter((item): item is PoiItem => item !== null);
    } catch {
      return [];
    }
  }

  private normalizeNominatim(
    item: NominatimItem,
    category: PoiCategory,
    index: number,
  ): PoiItem | null {
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const display = item.display_name?.trim();
    if (!display) return null;

    const name = display.split(',')[0]?.trim() || `${category}-${index + 1}`;

    return {
      id: this.makePoiId(name, display, lat, lon),
      name,
      address: display,
      coordinates: { lat, lon },
      category,
      rating: undefined,
      working_hours: undefined,
      price_segment: this.toPriceSegment(category),
      phone: undefined,
      website: undefined,
    };
  }

  private fallbackSearchText(category: PoiCategory): string {
    const map: Record<PoiCategory, string> = {
      museum: 'музей',
      park: 'парк',
      restaurant: 'ресторан',
      cafe: 'кафе',
      attraction: 'достопримечательность',
      shopping: 'торговый центр',
      entertainment: 'театр',
    };

    return map[category];
  }

  private searchTextToCategory(text: string): PoiCategory {
    const lower = text.toLowerCase();
    if (lower.includes('музей')) return 'museum';
    if (lower.includes('парк')) return 'park';
    if (lower.includes('ресторан')) return 'restaurant';
    if (lower.includes('кафе')) return 'cafe';
    if (lower.includes('торгов')) return 'shopping';
    if (lower.includes('развлеч')) return 'entertainment';
    return 'attraction';
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

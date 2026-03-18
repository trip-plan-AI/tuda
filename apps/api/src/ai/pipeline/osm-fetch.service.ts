import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ParsedIntent, PoiCategory } from '../types/pipeline.types';
import type { PoiItem, PriceSegment } from '../types/poi.types';
import { LlmClientService } from './llm-client.service';

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
export class OsmFetchService {
  private readonly logger = new Logger(OsmFetchService.name);

  constructor(private readonly llmClientService: LlmClientService) {}

  async fetchAndFilter(intent: ParsedIntent): Promise<PoiItem[]> {
    // Для СНГ не запрашиваем Photon и Nominatim
    if (this.llmClientService.isCisRegion(intent.country_code, intent.city)) {
      this.logger.log(`Skipping OSM fetch for CIS region: ${intent.city}`);
      return [];
    }

    const results = await Promise.all(
      intent.categories.map((category) => this.fetchCategory(category, intent)),
    );

    const firstRaw = results.flat();
    let pois = this.applyPipeline(firstRaw, intent);

    this.logger.log(
      `Fetch pass=1 raw=${firstRaw.length} filtered=${pois.length} city=${intent.city}`,
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

      this.logger.log(
        `Fetch pass=2 raw=${retryResults.flat().length} filtered=${pois.length} city=${intent.city}`,
      );
    }

    return pois;
  }

  private applyPipeline(pois: PoiItem[], intent: ParsedIntent): PoiItem[] {
    const valid = pois.filter((poi) =>
      this.isValidCoordinates(poi.coordinates.lat, poi.coordinates.lon),
    );
    const deduped = this.deduplicate(valid);

    const TOXIC_TOURISM_KEYWORDS = [
      'ликвидаторам',
      'чернобыль',
      'афганцам',
      'погибшим',
      'жертвам',
      'аллея славы',
      'обелиск славы',
      'вечный огонь',
      'памятник ленину',
      'обелиск',
    ];

    return deduped
      .filter((poi) => !intent.excluded_categories.includes(poi.category))
      .filter(
        (poi) =>
          !TOXIC_TOURISM_KEYWORDS.some((kw) =>
            poi.name.toLowerCase().includes(kw),
          ),
      )
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 15);
  }

  private async fetchCategory(
    category: PoiCategory,
    intent: ParsedIntent,
  ): Promise<PoiItem[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const queries = this.categorySearchQueries(category, intent.city);

      for (const query of queries) {
        // 1. Photon (быстрее Nominatim)
        const photon = await this.searchPhotonFallback({
          q: query,
          category,
          city: intent.city,
          signal: controller.signal,
        });

        if (photon.length > 0) {
          this.logger.log(`Found ${photon.length} via Photon: "${query}"`);
          return photon;
        }

        // 2. Nominatim (медленный, но точный)
        const nominatim = await this.searchNominatimFallback({
          q: query,
          category,
          city: intent.city,
          signal: controller.signal,
        });

        if (nominatim.length > 0) {
          this.logger.log(
            `Found ${nominatim.length} via Nominatim: "${query}"`,
          );
          return nominatim;
        }
      }

      return [];
    } catch (e) {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private categorySearchQueries(category: PoiCategory, city: string): string[] {
    const unique = new Set<string>();
    const add = (value: string) => {
      const normalized = value.trim();
      if (normalized) unique.add(normalized);
    };

    switch (category) {
      case 'attraction':
        add(`attractions in ${city}`);
        add(`interesting places in ${city}`);
        break;
      case 'museum':
        add(`museum in ${city}`);
        break;
      case 'park':
        add(`park in ${city}`);
        break;
      case 'restaurant':
        add(`restaurant in ${city}`);
        break;
      case 'cafe':
        add(`cafe in ${city}`);
        break;
      case 'shopping':
        add(`shopping mall in ${city}`);
        break;
      case 'entertainment':
        add(`theater in ${city}`);
        add(`entertainment in ${city}`);
        break;
      default:
        add(`${category} in ${city}`);
        break;
    }

    return Array.from(unique).slice(0, 3);
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

    try {
      const response = await fetch(url.toString(), {
        signal: params.signal,
        headers: { 'User-Agent': 'TravelPlanner/1.0' },
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
    let name = feature.properties?.name?.trim();
    if (!name) {
      const street = feature.properties?.street;
      const house = feature.properties?.housenumber;
      if (street && house) name = `${street}, ${house}`;
      else return null;
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
      score: 0.4, // Default score for Photon data
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
    url.searchParams.set('accept-language', 'en');

    try {
      const response = await fetch(url.toString(), {
        signal: params.signal,
        headers: { 'User-Agent': 'TravelPlanner/1.0' },
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
      score: 0.4, // Default score for Nominatim data
      working_hours: undefined,
      price_segment: this.toPriceSegment(category),
      phone: undefined,
      website: undefined,
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
    const toRad = (v: number) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

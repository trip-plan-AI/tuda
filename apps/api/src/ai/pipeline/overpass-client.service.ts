import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ParsedIntent, PoiCategory } from '../types/pipeline.types';
import type { PoiItem, PriceSegment } from '../types/poi.types';

interface OverpassElement {
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: {
    name?: string;
    description?: string;
    amenity?: string;
    tourism?: string;
    leisure?: string;
    shop?: string;
    opening_hours?: string;
    website?: string;
    phone?: string;
  };
}

@Injectable()
export class OverpassClientService {
  private readonly logger = new Logger(OverpassClientService.name);
  private readonly baseUrl = 'https://overpass-api.de/api/interpreter';

  async fetchByIntent(intent: ParsedIntent): Promise<PoiItem[]> {
    // В реальном приложении здесь нужен геокодер для определения bbox или центра города по названию,
    // но в рамках MVP можно сделать допущение, что координаты города мы знаем
    // Для простоты, так как в ParsedIntent есть radius_km и city, но нет координат центра города,
    // используем geocoding через Nominatim (бесплатно) для нахождения центра
    const cityCoords = await this.geocodeCity(intent.city);
    if (!cityCoords) {
      this.logger.warn(`Overpass: Could not geocode city '${intent.city}'`);
      return [];
    }

    // Расширяем радиус для захвата максимального числа мест (минимум 15 км, максимум 30)
    const radiusMeters = Math.max(intent.radius_km * 1000, 15000);
    const center = `${radiusMeters},${cityCoords.lat},${cityCoords.lon}`;

    // Широкий поиск: берем вообще все популярные туристические/досуговые теги,
    // ИГНОРИРУЯ запрошенные юзером категории, чтобы отдать максимум данных на откуп LLM
    const query = `
      [out:json][timeout:15];
      (
        nwr["tourism"](around:${center});
        nwr["historic"](around:${center});
        nwr["leisure"~"park|garden|amusement_ride|water_park"](around:${center});
        nwr["amenity"~"restaurant|cafe|theatre|cinema|place_of_worship"](around:${center});
        nwr["shop"~"mall|department_store"](around:${center});
      );
      out center;
    `;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(`Overpass HTTP ${response.status}`);
        return [];
      }

      const data = (await response.json()) as { elements?: OverpassElement[] };
      const elements = data.elements ?? [];

      // Отключаем строгую фильтрацию по intent.categories,
      // оставляем только исключенные (по желанию, хотя LLM тоже с ними справится)
      return elements
        .map((el) => this.normalize(el, intent.city))
        .filter((item): item is PoiItem => item !== null)
        .filter((item) => !intent.excluded_categories.includes(item.category));
    } catch (e) {
      this.logger.error(`Error fetching from Overpass:`, e);
      return [];
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async geocodeCity(
    city: string,
  ): Promise<{ lat: number; lon: number } | null> {
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', city);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '1');

      const response = await fetch(url.toString(), {
        headers: { 'User-Agent': 'TravelPlanner/1.0' },
      });

      if (!response.ok) return null;

      const data = (await response.json()) as Array<{
        lat: string;
        lon: string;
      }>;
      if (data && data.length > 0 && data[0]) {
        return {
          lat: parseFloat(data[0].lat),
          lon: parseFloat(data[0].lon),
        };
      }
      return null;
    } catch (e) {
      this.logger.warn(`Geocoding failed for ${city}:`, e);
      return null;
    }
  }

  private normalize(item: OverpassElement, city: string): PoiItem | null {
    const lat = item.lat ?? item.center?.lat;
    const lon = item.lon ?? item.center?.lon;

    if (
      lat === undefined ||
      lon === undefined ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return null;
    }

    const name = item.tags?.name;
    if (!name) return null; // Безымянные объекты пропускаем

    const category = this.determineCategory(item.tags);
    if (!category) return null;

    const address = `${city}, ${name}`;

    return {
      id: this.makePoiId(name, address, lat, lon),
      name,
      address,
      coordinates: { lat, lon },
      category,
      rating: 4.0, // Дефолтный средний рейтинг для Overpass
      working_hours: item.tags?.opening_hours,
      price_segment: this.toPriceSegment(category),
      phone: item.tags?.phone,
      website: item.tags?.website,
    };
  }

  private determineCategory(tags: OverpassElement['tags']): PoiCategory | null {
    if (!tags) return null;
    if (tags.tourism === 'museum' || tags.tourism === 'gallery')
      return 'museum';
    if (tags.leisure === 'park' || tags.leisure === 'garden') return 'park';
    if (tags.amenity === 'restaurant') return 'restaurant';
    if (tags.amenity === 'cafe') return 'cafe';
    if (tags.shop === 'mall' || tags.shop === 'department_store')
      return 'shopping';
    if (
      tags.amenity === 'theatre' ||
      tags.amenity === 'cinema' ||
      tags.leisure === 'amusement_ride'
    )
      return 'entertainment';
    if (tags.tourism === 'attraction') return 'attraction';
    return null;
  }

  private toPriceSegment(category: PoiCategory): PriceSegment {
    if (category === 'park' || category === 'attraction') return 'free';
    if (category === 'restaurant') return 'premium';
    return 'mid';
  }

  private makePoiId(
    name: string,
    address: string,
    lat: number,
    lon: number,
  ): string {
    const raw = `overpass|${name}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 24);
  }
}

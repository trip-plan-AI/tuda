import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ParsedIntent, PoiCategory } from '../types/pipeline.types';
import type { PoiItem, PriceSegment } from '../types/poi.types';
import { GeosearchService } from '../../geosearch/geosearch.service';
import { RedisService } from '../../redis/redis.service';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: {
    name?: string;
    'name:ru'?: string;
    description?: string;
    amenity?: string;
    tourism?: string;
    leisure?: string;
    shop?: string;
    historic?: string;
    opening_hours?: string;
    website?: string;
    phone?: string;
    power?: string;
    man_made?: string;
    cuisine?: string;
    'diet:vegan'?: string;
    'dog:welcomed'?: string;
    wikidata?: string;
    heritage?: string;          // heritage=1/2/3/yes → protected cultural site
    'heritage:operator'?: string;
    protection_title?: string;  // e.g. "Объект культурного наследия"
    [key: string]: string | undefined;
  };
}

@Injectable()
export class OverpassClientService {
  private readonly logger = new Logger(OverpassClientService.name);
  // Round-robin зеркала Overpass с приоритетом на стабильные (lz4, kumi)
  private readonly baseUrls = [
    'https://lz4.overpass-api.de/api/interpreter',        // fast + reliable
    'https://overpass.kumi.systems/api/interpreter',       // very reliable
    'https://overpass-api.de/api/interpreter',             // main (может быть перегружен)
    'https://z.overpass-api.de/api/interpreter',           // backup France mirror
  ];
  private lastMirrorIndex = 0;

  constructor(
    private readonly geosearch: GeosearchService,
    private readonly redis: RedisService,
  ) {}

  async fetchByIntent(
    intent: ParsedIntent,
    location?: { lat: number; lon: number; radius: number },
  ): Promise<PoiItem[]> {
    const city = intent.city;
    const cacheKey = `overpass:v3:${city.toLowerCase().replace(/\s+/g, '_')}:${location?.lat ?? 'no'}_${location?.lon ?? 'no'}_${location?.radius ?? 'no'}`;

    // 1. Попытка взять из кэша
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        this.logger.log(`Using cached Overpass data for ${city}`);
        return JSON.parse(cached) as PoiItem[];
      } catch (e) {
        this.logger.error(`Failed to parse cached Overpass data: ${e}`);
      }
    }

    let cityCoords = location;

    // 2. Геокодинг если координаты не переданы
    if (!cityCoords) {
      const suggestions = await this.geosearch.suggest(city);
      const suggested =
        suggestions && suggestions.length > 0 ? suggestions[0] : null;

      if (!suggested) {
        this.logger.warn(`Overpass: Could not geocode city '${city}'`);
        return [];
      }
      cityCoords = {
        lat: suggested.lat,
        lon: suggested.lon,
        radius: 15000, // Default for cities
      };
    }

    // 3. Формируем запрос around (теперь это основной метод)
    const radiusSteps = [cityCoords.radius, 10000, 15000, 25000].filter(
      (r) => r >= cityCoords.radius,
    );
    const uniqueSteps = [...new Set(radiusSteps)].sort((a, b) => a - b);

    let elements: OverpassElement[] = [];

    for (const stepRadius of uniqueSteps) {
      this.logger.log(
        `Overpass: searching around ${city} with radius ${stepRadius}m...`,
      );
      const center = `${stepRadius},${cityCoords.lat},${cityCoords.lon}`;
      const query = `
        [out:json][timeout:25];
        (
          nwr["tourism"~"museum|viewpoint|attraction|gallery|artwork"](around:${center});
          nwr["historic"~"monument|memorial|castle"](around:${center});
          nwr["leisure"~"park|garden|marina|beach"](around:${center});
          nwr["amenity"~"restaurant|cafe|theatre|cinema"](around:${center});
          nwr["man_made"~"lighthouse|tower|dam|water_tower|bridge"](around:${center});
          nwr["power"~"plant"](around:${center});
        );
        out center;
      `.trim();

      elements = await this.executeOverpass(query);
      if (elements.length >= 10) break;
      if (stepRadius < uniqueSteps[uniqueSteps.length - 1]) {
        this.logger.log(
          `Overpass: only ${elements.length} points found, expanding radius...`,
        );
      }
    }

    // Fallback query по area только если это похоже на город и вокруг ничего не нашли
    const areaQuery = `
      [out:json][timeout:25];
      area["name:ru"="${city}"]->.searchArea;
      (
        nwr["tourism"~"museum|viewpoint|attraction|gallery|artwork"](area.searchArea);
        nwr["historic"~"monument|memorial|castle"](area.searchArea);
        nwr["leisure"~"park|garden|marina|beach"](area.searchArea);
        nwr["amenity"~"restaurant|cafe|theatre|cinema"](area.searchArea);
        nwr["man_made"~"lighthouse|tower|dam|water_tower|bridge"](area.searchArea);
        nwr["power"~"plant"](area.searchArea);
      );
      out center;
    `.trim();

    // Если around всё равно вернул 0 (или очень мало), пробуем area
    if (elements.length < 5 && cityCoords.radius >= 5000) {
      this.logger.log(
        `Around search for ${city} returned only ${elements.length}, trying area fallback...`,
      );
      const areaElements = await this.executeOverpass(areaQuery);
      if (areaElements.length > elements.length) {
        elements = areaElements;
      }
    }

    if (elements.length === 0) {
      this.logger.warn(
        `Overpass returned 0 points for ${city} even with fallback.`,
      );
      // В случае полного отсутствия данных и отсутствия кэша, мы не кидаем ошибку сразу,
      // но в ProviderSearchService это должно привести к "Hard Stop" если другие источники тоже пусты.
      return [];
    }

    const pois = elements
      .map((el) => this.normalize(el, city))
      .filter((item): item is PoiItem => item !== null)
      .filter((item) => !intent.excluded_categories.includes(item.category));

    this.logger.log(
      `Overpass: found ${elements.length} raw elements, normalized to ${pois.length} POIs for ${city}`,
    );

    // Сохраняем в кэш на 7 дней
    if (pois.length > 0) {
      await this.redis.set(cacheKey, JSON.stringify(pois), 60 * 60 * 24 * 7);
    }

    return pois;
  }

  private async executeOverpass(query: string): Promise<OverpassElement[]> {
    // Round-robin: начинаем со следующего зеркала после последнего удачного/неудачного
    let attempts = 0;
    let backoffMs = 1000;

    while (attempts < this.baseUrls.length) {
      const baseUrl = this.baseUrls[this.lastMirrorIndex % this.baseUrls.length];
      this.lastMirrorIndex++;
      attempts++;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            `Overpass API error from ${baseUrl}: ${response.status}`,
          );
          // Exponential backoff на ошибки (особенно 429, 503, 504)
          if ([429, 503, 504].includes(response.status)) {
            this.logger.log(
              `Rate/overload limiting detected (${response.status}), waiting ${backoffMs}ms before next mirror...`,
            );
            await new Promise((r) => setTimeout(r, backoffMs));
            backoffMs = Math.min(backoffMs * 1.5, 5000); // cap at 5s
          }
          continue;
        }

        const data = (await response.json()) as {
          elements?: OverpassElement[];
        };
        return data.elements ?? [];
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          this.logger.warn(`Overpass request timed out for ${baseUrl}`);
        } else {
          this.logger.error(`Error fetching from Overpass (${baseUrl}): ${e}`);
        }
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    this.logger.error(
      `All Overpass mirrors exhausted after ${attempts} attempts. Returning empty result.`,
    );
    return [];
  }

  private normalize(item: OverpassElement, city: string): PoiItem | null {
    const lat = item.lat ?? item.center?.lat;
    const lon = item.lon ?? item.center?.lon;

    if (lat === undefined || lon === undefined) return null;

    const name = item.tags?.['name:ru'] || item.tags?.name;
    if (!name) return null;

    const category = this.determineCategory(item.tags);
    if (!category) return null;

    const address = `${city}, ${name}`;

    // Формируем описание из тегов
    const descriptionParts: string[] = [];
    if (item.tags?.description) descriptionParts.push(item.tags.description);
    if (item.tags?.['diet:vegan'] === 'yes')
      descriptionParts.push('Веганское меню');
    if (item.tags?.['dog:welcomed'] === 'yes')
      descriptionParts.push('Можно с собаками');
    if (item.tags?.cuisine)
      descriptionParts.push(`Кухня: ${item.tags.cuisine}`);

    const description =
      descriptionParts.length > 0 ? descriptionParts.join('. ') : undefined;

    // TAG WISDOM: score from OSM significance signals
    const tags = item.tags ?? {};
    let tagScore = 0.5; // default
    let isProtected = false;

    // TECHNICAL PENALTY first — cap score before any boost
    // railway=*, man_made=signal/pipeline/mast, power=* (except plant) → utility objects
    const isTechnical =
      !!tags.railway ||
      tags.man_made === 'signal' ||
      tags.man_made === 'pipeline' ||
      tags.man_made === 'mast' ||
      tags.man_made === 'pole' ||
      (tags.power && tags.power !== 'plant') || // power plant is interesting, pole is not
      tags.amenity === 'parking' ||
      tags.amenity === 'fuel';

    if (isTechnical) {
      tagScore = 0.15; // hard cap — will not win anchor election or top-15
    } else {
      // Heritage tag → confirmed cultural significance, hard protect
      if (tags.heritage || tags.protection_title || tags['heritage:operator']) {
        tagScore += 0.4;
        isProtected = true;
      }
      // Wikidata link → global notability confirmed
      if (tags.wikidata) tagScore += 0.1;
      // tourism=attraction or tourism=museum → explicit tourist marker
      if (tags.tourism === 'attraction' || tags.tourism === 'museum') tagScore += 0.2;
      // Large city park
      if (tags.leisure === 'park') tagScore += 0.1;
    }

    tagScore = Math.min(tagScore, 1.0);

    return {
      id: this.makePoiId(name, address, lat, lon),
      name,
      address,
      provider: 'overpass',
      coordinates: { lat, lon },
      category,
      rating: 4.0,
      score: tagScore,
      isProtected: isProtected || undefined,
      working_hours: tags.opening_hours,
      price_segment: this.toPriceSegment(category),
      phone: tags.phone,
      website: tags.website,
      description,
      wikidata: tags.wikidata,
    };
  }

  private determineCategory(tags: OverpassElement['tags']): PoiCategory | null {
    if (!tags) return null;

    // Stage 1 фильтр: исключаем локальные мемориалы без wikidata
    if (tags.historic === 'memorial' && !tags.wikidata) {
      return null;
    }

    if (
      tags.tourism === 'museum' ||
      tags.tourism === 'gallery' ||
      tags.tourism === 'arts_centre'
    )
      return 'museum';
    if (
      tags.leisure === 'park' ||
      tags.leisure === 'garden' ||
      tags.leisure === 'marina' ||
      tags.leisure === 'beach'
    )
      return 'park';
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
    if (
      tags.tourism === 'attraction' ||
      tags.tourism === 'viewpoint' ||
      tags.power === 'plant' ||
      tags.man_made === 'lighthouse' ||
      tags.man_made === 'tower' ||
      tags.historic
    )
      return 'attraction';
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

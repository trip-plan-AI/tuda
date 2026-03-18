import { Injectable, Logger, Inject } from '@nestjs/common';
import { createHash } from 'crypto';
import { DRIZZLE } from '../../db/db.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { overpassCache } from '../../db/city-dataset.schema';
import { eq, and } from 'drizzle-orm';

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface RawOsmPoi {
  osmId: string;
  name: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

@Injectable()
export class OverpassFetchService {
  private readonly logger = new Logger(OverpassFetchService.name);
  private readonly OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';

  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Выгружает все потенциальные туристические POI в рамках BBox города
   * @param city Название города
   * @param bbox Координаты ограничивающего прямоугольника города
   */
  public async fetchPoisByBbox(
    city: string,
    bbox: BoundingBox,
  ): Promise<RawOsmPoi[]> {
    // Вычисляем центр и радиус из bbox
    const centerLat = (bbox.minLat + bbox.maxLat) / 2;
    const centerLon = (bbox.minLon + bbox.maxLon) / 2;

    const latDistKm = (bbox.maxLat - bbox.minLat) * 111;
    const lonDistKm =
      (bbox.maxLon - bbox.minLon) * 111 * Math.cos((centerLat * Math.PI) / 180);
    const radiusMeters = Math.ceil(Math.max(latDistKm, lonDistKm) * 500);

    const query = `
      [out:json][timeout:60];
      (
        nwr["tourism"](around:${radiusMeters},${centerLat},${centerLon});
        nwr["historic"](around:${radiusMeters},${centerLat},${centerLon});
        nwr["leisure"~"park|garden|nature_reserve|water_park|marina"](around:${radiusMeters},${centerLat},${centerLon});
        nwr["amenity"~"restaurant|cafe|theatre|cinema|place_of_worship|arts_centre"](around:${radiusMeters},${centerLat},${centerLon});
        nwr["natural"~"beach|peak|water|wood"](around:${radiusMeters},${centerLat},${centerLon});
        nwr["man_made"~"lighthouse|tower"](around:${radiusMeters},${centerLat},${centerLon});
        nwr["power"~"plant"](around:${radiusMeters},${centerLat},${centerLon});
      );
      out center;
    `.trim();

    const queryHash = createHash('md5').update(query).digest('hex');

    this.logger.log(
      `Fetching raw POIs for ${city} (center: [${centerLat}, ${centerLon}], radius: ${radiusMeters}m)`,
    );

    try {
      const pois = await this.fetchWithRetry(query, 3);
      if (pois.length > 0) {
        // Сохраняем в кэш
        await this.db
          .insert(overpassCache)
          .values({
            city,
            queryHash,
            responseJson: pois,
          })
          .onConflictDoUpdate({
            target: [overpassCache.city, overpassCache.queryHash],
            set: { responseJson: pois, createdAt: new Date() },
          });
      }
      return pois;
    } catch (error) {
      this.logger.warn(
        `Overpass failed for ${city}, trying to fallback to cache...`,
      );
      const cached = await this.db.query.overpassCache.findFirst({
        where: and(
          eq(overpassCache.city, city),
          eq(overpassCache.queryHash, queryHash),
        ),
      });
      if (cached) {
        this.logger.log(`Using cached Overpass data for ${city}`);
        return cached.responseJson as RawOsmPoi[];
      }
      return [];
    }
  }

  private async fetchWithRetry(
    query: string,
    attemptsLeft: number,
  ): Promise<RawOsmPoi[]> {
    try {
      const response = await fetch(this.OVERPASS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(query)}`,
      });

      // Handle rate limiting
      if (response.status === 429) {
        if (attemptsLeft > 0) {
          const delayMs = Math.pow(2, 4 - attemptsLeft) * 1000; // 1s, 2s, 4s
          this.logger.warn(
            `Overpass rate limited. Retrying in ${delayMs}ms (${attemptsLeft} attempts left)`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
          return this.fetchWithRetry(query, attemptsLeft - 1);
        }
        throw new Error('Overpass API rate limited after retries');
      }

      if (!response.ok) {
        throw new Error(
          `Overpass API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();

      if (data.remark) {
        this.logger.warn(`Overpass remark: ${data.remark}`);
      }

      const elements = data.elements || [];
      const pois: RawOsmPoi[] = [];

      for (const el of elements) {
        if (!el.tags || (!el.tags.name && !el.tags['name:ru'])) continue;

        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;

        if (lat === undefined || lon === undefined) continue;

        pois.push({
          osmId: `${el.type}/${el.id}`,
          name: el.tags['name:ru'] || el.tags.name,
          lat,
          lon,
          tags: el.tags,
        });
      }

      this.logger.log(`Successfully fetched ${pois.length} POIs from Overpass`);
      return pois;
    } catch (error) {
      if (attemptsLeft > 0) {
        this.logger.warn(`Overpass attempt failed: ${error}. Retrying...`);
        return this.fetchWithRetry(query, attemptsLeft - 1);
      }
      throw error;
    }
  }
}

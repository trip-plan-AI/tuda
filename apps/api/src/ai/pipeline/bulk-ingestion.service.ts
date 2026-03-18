import { Injectable, Logger, Inject } from '@nestjs/common';
import { CityIngestionService } from './city-ingestion.service';
import { DRIZZLE } from '../../db/db.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { cities } from '../../db/city-dataset.schema';
import { eq, desc } from 'drizzle-orm';

@Injectable()
export class BulkIngestionService {
  private readonly logger = new Logger(BulkIngestionService.name);

  constructor(
    private readonly ingestion: CityIngestionService,
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Проходит по топ-N популярным городам и запускает для них Ingestion, если их ещё нет в кэше.
   */
  public async ingestPopularCities(limit: number = 20) {
    this.logger.log(`Starting bulk ingestion for top ${limit} cities...`);

    const popular = await this.db.query.popularDestinations.findMany({
      where: eq(schema.popularDestinations.type, 'city'),
      orderBy: [desc(schema.popularDestinations.popularity)],
      limit,
    });

    this.logger.log(`Found ${popular.length} popular cities to check.`);

    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const dest of popular) {
      // Проверяем, есть ли город уже в ai_cities
      const existing = await this.db.query.cities.findFirst({
        where: eq(cities.name, dest.nameRu),
      });

      if (existing) {
        this.logger.log(
          `Skipping ${dest.nameRu}: already exists in AI datasets.`,
        );
        skipCount++;
        continue;
      }

      this.logger.log(`Ingesting ${dest.nameRu}...`);

      // Рассчитываем BBox (+/- 0.1 градуса ~ 11км)
      const bbox = {
        minLat: dest.lat - 0.1,
        maxLat: dest.lat + 0.1,
        minLon: dest.lon - 0.1,
        maxLon: dest.lon + 0.1,
      };

      try {
        await this.ingestion.ingestCity(
          dest.nameRu,
          bbox,
          dest.lat,
          dest.lon,
          dest.countryCode,
        );
        successCount++;
        this.logger.log(`Successfully ingested ${dest.nameRu}.`);

        // Небольшая пауза между городами, чтобы не перегружать API (Overpass, Wikidata)
        await new Promise((r) => setTimeout(r, 2000));
      } catch (error) {
        errorCount++;
        this.logger.error(
          `Failed to ingest ${dest.nameRu}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(
      `Bulk ingestion completed: ${successCount} new, ${skipCount} skipped, ${errorCount} errors.`,
    );
    return { successCount, skipCount, errorCount };
  }
}

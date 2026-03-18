import { Injectable, Logger, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OverpassFetchService, BoundingBox } from './overpass-fetch.service';
import { AiDiscoveryService } from './ai-discovery.service';
import { CityAnalyzerService } from './city-analyzer.service';
import { WikidataEnrichmentService } from './wikidata-enrichment.service';
import { FuzzyMatcherService } from './fuzzy-matcher.service';
import { PoiScoringService } from './poi-scoring.service';
import { ClusteringService } from './clustering.service';
import { GeosearchService } from '../../geosearch/geosearch.service';

import { DRIZZLE } from '../../db/db.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  cities,
  pois,
  clusters,
  cityDatasetMeta,
} from '../../db/city-dataset.schema';
import * as schema from '../../db/schema';

@Injectable()
export class CityIngestionService {
  private readonly logger = new Logger(CityIngestionService.name);

  constructor(
    private readonly overpass: OverpassFetchService,
    private readonly aiDiscovery: AiDiscoveryService,
    private readonly analyzer: CityAnalyzerService,
    private readonly wikidata: WikidataEnrichmentService,
    private readonly fuzzy: FuzzyMatcherService,
    private readonly scoring: PoiScoringService,
    private readonly clustering: ClusteringService,
    private readonly geosearch: GeosearchService,
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  private getDefaultDuration(category: string): number {
    const lower = category.toLowerCase();
    if (
      lower.includes('museum') ||
      lower.includes('arts_centre') ||
      lower.includes('theatre')
    )
      return 90;
    if (
      lower.includes('park') ||
      lower.includes('garden') ||
      lower.includes('beach')
    )
      return 60;
    if (lower.includes('restaurant') || lower.includes('cafe')) return 60;
    if (lower.includes('viewpoint') || lower.includes('peak')) return 20;
    if (lower.includes('cinema')) return 120;
    return 45; // default
  }

  public async ingestCity(
    cityName: string,
    bbox: BoundingBox,
    cityLat: number,
    cityLon: number,
    countryCode: string | null = null,
  ) {
    this.logger.log(
      `Starting ingestion pipeline for ${cityName} (Region: ${countryCode || 'WORLD'})`,
    );

    const [city] = await this.db
      .insert(cities)
      .values({
        name: cityName,
        lat: cityLat,
        lon: cityLon,
        country: countryCode,
        bbox: bbox,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: cities.name,
        set: {
          lat: cityLat,
          lon: cityLon,
          country: countryCode,
          bbox: bbox,
          updatedAt: new Date(),
        },
      })
      .returning();

    const rawPois = await this.overpass.fetchPoisByBbox(cityName, bbox);
    const cityProfile = this.analyzer.analyze(rawPois);

    this.logger.log(`City Profile for ${cityName}: ${cityProfile.description}`);

    // 1. Предварительный скоринг без Wikidata (только OSM + DNA)
    const candidates = rawPois.map((raw) => ({
      raw,
      score: this.scoring.calculateScore({
        sitelinksCount: 0,
        tags: raw.tags,
        cityProfile,
        hasOsmOnly: true,
      }),
      sitelinksCount: 0,
      wikidataId: raw.tags['wikidata'],
    }));

    // 2. Отбираем топ-200 для обогащения из Wikidata
    candidates.sort((a, b) => b.score - a.score);
    const topToEnrich = candidates.slice(0, 200);

    this.logger.log(`Enriching top 200 candidates with Wikidata...`);
    await Promise.all(
      topToEnrich.map(async (c) => {
        if (c.wikidataId) {
          try {
            const wdData = await this.wikidata.enrich(c.wikidataId);
            if (wdData) {
              c.sitelinksCount = wdData.sitelinksCount;
              // Пересчитываем скор с учетом популярности
              c.score = this.scoring.calculateScore({
                sitelinksCount: c.sitelinksCount,
                tags: c.raw.tags,
                cityProfile,
                hasOsmOnly: true,
              });
            }
          } catch (e) {}
        }
      }),
    );

    // 3. Отбираем Топ-100 для AI-курации (теперь уже с учетом Wikidata)
    const topCandidates = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);

    // 4. AI-куратор выбирает из РЕАЛЬНЫХ объектов
    const curatedResult = await this.aiDiscovery.curatePlaces(
      cityName,
      topCandidates.map((c) => c.raw),
      cityProfile,
    );

    const allAiPlaces = [
      ...(curatedResult?.iconic || []),
      ...(curatedResult?.hidden || []),
    ];

    // 5. Финальная сборка набора объектов с ограничением по категориям
    const processedPois: any[] = [];
    const POI_LIMIT = 500;
    const categoryCounts: Record<string, number> = {};
    const MAX_PER_CATEGORY = {
      restaurant: 5,
      cafe: 5,
      place_of_worship: 3,
      hotel: 0, // Не берем отели в POI если не просили
      poi: 10,
    };

    this.logger.log(
      `Processing final POI set (AI matched ${allAiPlaces.length} places)...`,
    );

    // Сначала добавляем те, что выбрал AI (они в приоритете)
    for (const aiPlace of allAiPlaces) {
      const candidate = candidates.find((c) => c.raw.name === aiPlace.name);
      if (!candidate) continue;

      const raw = candidate.raw;
      const category = raw.tags['tourism'] || raw.tags['amenity'] || 'poi';
      const aiRole = curatedResult?.iconic?.some((p) => p.name === aiPlace.name)
        ? 'iconic'
        : 'hidden';

      processedPois.push({
        osmId: raw.osmId,
        name: raw.name,
        category,
        lat: raw.lat,
        lon: raw.lon,
        score: candidate.score + (aiRole === 'iconic' ? 10 : 5),
        aiRole,
        wikidataId: candidate.wikidataId,
        importance: Math.log(candidate.sitelinksCount + 1),
        tags: raw.tags,
        openingHours: raw.tags['opening_hours'],
        duration: this.getDefaultDuration(category),
      });
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }

    // Добавляем остальные по скору, соблюдая баланс категорий
    for (const candidate of candidates) {
      if (processedPois.length >= POI_LIMIT) break;
      if (processedPois.some((p) => p.osmId === candidate.raw.osmId)) continue; // Уже добавили через AI

      const raw = candidate.raw;
      const category = raw.tags['tourism'] || raw.tags['amenity'] || 'poi';

      const limit =
        MAX_PER_CATEGORY[category as keyof typeof MAX_PER_CATEGORY] ?? 8;
      if ((categoryCounts[category] || 0) >= limit) continue;

      if (candidate.score >= 1) {
        processedPois.push({
          osmId: raw.osmId,
          name: raw.name,
          category,
          lat: raw.lat,
          lon: raw.lon,
          score: candidate.score,
          aiRole: null,
          wikidataId: candidate.wikidataId,
          importance: Math.log(candidate.sitelinksCount + 1),
          tags: raw.tags,
          openingHours: raw.tags['opening_hours'],
          duration: this.getDefaultDuration(category),
        });
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      }
    }

    const { clusters: dbscanClusters, noise } = this.clustering.clusterPois(
      processedPois.map((p) => ({
        id: p.osmId,
        coordinates: { lat: p.lat, lon: p.lon },
      })),
      rawPois.length > 5000 ? 3 : rawPois.length > 1000 ? 2 : 1,
    );

    // Apply Hidden Gems Boost for Noise
    noise.forEach((poiId) => {
      const poi = processedPois.find((p) => p.osmId === poiId);
      if (poi) poi.score += 3; // Hidden gems boost
    });

    this.logger.log(
      `Saving ${processedPois.length} POIs and ${dbscanClusters.length} clusters...`,
    );

    await this.db.delete(pois).where(sql`${pois.cityId} = ${city.id}`);
    await this.db.delete(clusters).where(sql`${clusters.cityId} = ${city.id}`);

    if (processedPois.length > 0) {
      const insertedPois = await this.db
        .insert(pois)
        .values(
          processedPois.map((p) => ({
            cityId: city.id,
            osmId: p.osmId,
            name: p.name,
            category: p.category,
            lat: p.lat,
            lon: p.lon,
            aiWeight: p.score,
            wikidataId: p.wikidataId,
            importance: p.importance,
            tags: p.tags,
            openingHours: p.openingHours,
            duration: p.duration,
            geom: sql`ST_SetSRID(ST_MakePoint(${p.lon}, ${p.lat}), 4326)::geography`,
          })),
        )
        .returning();

      for (const clusterData of dbscanClusters) {
        const clusterPois = insertedPois.filter((p) =>
          clusterData.poiIds.includes(p.osmId),
        );
        if (clusterPois.length < 3) continue; // Skip very small clusters

        const avgLat =
          clusterPois.reduce((sum, p) => sum + p.lat, 0) / clusterPois.length;
        const avgLon =
          clusterPois.reduce((sum, p) => sum + p.lon, 0) / clusterPois.length;
        const totalScore = clusterPois.reduce((sum, p) => sum + p.aiWeight, 0);

        const [newCluster] = await this.db
          .insert(clusters)
          .values({
            cityId: city.id,
            centerLat: avgLat,
            centerLon: avgLon,
            radius: 2,
            poiCount: clusterPois.length,
            totalScore: totalScore,
          })
          .returning();

        await this.db
          .update(pois)
          .set({ clusterId: newCluster.id })
          .where(sql`${pois.id} IN ${clusterPois.map((p) => p.id)}`);
      }
    }

    await this.db
      .insert(cityDatasetMeta)
      .values({
        cityId: city.id,
        poiCount: processedPois.length,
        clusterCount: dbscanClusters.length,
        generatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: cityDatasetMeta.cityId,
        set: {
          poiCount: processedPois.length,
          clusterCount: dbscanClusters.length,
          generatedAt: new Date(),
        },
      });

    return {
      cityId: city.id,
      poiCount: processedPois.length,
      clusterCount: dbscanClusters.length,
    };
  }
}

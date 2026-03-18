import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Inject,
  NotFoundException,
  UseGuards,
  Request,
} from '@nestjs/common';
import { CityIngestionService } from './city-ingestion.service';
import {
  ItineraryBuilderService,
  PlanningContext,
} from './itinerary-builder.service';
import { LlmExplainerService } from './llm-explainer.service';
import { BulkIngestionService } from './bulk-ingestion.service';
import { DRIZZLE } from '../../db/db.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { cities, pois, clusters } from '../../db/city-dataset.schema';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly ingestion: CityIngestionService,
    private readonly builder: ItineraryBuilderService,
    private readonly explainer: LlmExplainerService,
    private readonly bulkIngestion: BulkIngestionService,
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Post('ingest')
  async ingestCity(
    @Body() body: { city: string; bbox: any; lat: number; lon: number },
  ) {
    const result = await this.ingestion.ingestCity(
      body.city,
      body.bbox,
      body.lat,
      body.lon,
    );
    return { success: true, result };
  }

  @Post('ingest/popular')
  async ingestPopular(@Query('limit') limit?: string) {
    const result = await this.bulkIngestion.ingestPopularCities(
      limit ? parseInt(limit) : 20,
    );
    return { success: true, ...result };
  }

  @UseGuards(JwtAuthGuard)
  @Get('route')
  async generateRoute(
    @Query('city') city: string,
    @Query('days') days?: string,
    @Query('save') save?: string,
    @Query('weather') weather?: string,
    @Query('startLat') startLat?: string,
    @Query('startLon') startLon?: string,
    @Query('preferences') preferencesJson?: string,
    @Request() req?: any,
  ) {
    const targetCity = await this.db.query.cities.findFirst({
      where: eq(cities.name, city),
    });

    if (!targetCity) {
      throw new NotFoundException(
        `Датасет для города "${city}" не найден. Запустите Ingestion.`,
      );
    }

    const numDays = days ? parseInt(days) : 1;

    // Дефолтные предпочтения
    let preferences = {
      culture: 0.5,
      nature: 0.5,
      food: 0.5,
      activity: 0.5,
      shopping: 0.5,
    };

    if (preferencesJson) {
      try {
        preferences = { ...preferences, ...JSON.parse(preferencesJson) };
      } catch (e) {}
    }

    const planningCtx: PlanningContext = {
      preferences,
      isRaining: weather === 'rain',
      startLocation:
        startLat && startLon
          ? {
              lat: parseFloat(startLat),
              lon: parseFloat(startLon),
            }
          : undefined,
    };

    const dbPois = await this.db.query.pois.findMany({
      where: eq(pois.cityId, targetCity.id),
    });

    const dbClusters = await this.db.query.clusters.findMany({
      where: eq(clusters.cityId, targetCity.id),
    });

    const startTime = Date.now();

    // 1. Построение маршрута с учетом персонализации, погоды и точки старта
    const routeDays = this.builder.buildMultiDayRoute(
      dbPois,
      dbClusters,
      numDays,
      planningCtx,
    );

    // 2. Объяснение маршрута
    const explanation = await this.explainer.explainRoute(city, routeDays);

    const executionTimeMs = Date.now() - startTime;

    let createdTripId: string | null = null;

    if (save === 'true' && req?.user?.id) {
      const [newTrip] = await this.db
        .insert(schema.trips)
        .values({
          title: `Путешествие в ${city} (${numDays} дн.)`,
          description: explanation.slice(0, 1000),
          ownerId: req.user.id,
          isActive: true,
        })
        .returning();

      createdTripId = newTrip.id;

      const allPoints = routeDays.flatMap((d) => d.points);
      if (allPoints.length > 0) {
        await this.db.insert(schema.routePoints).values(
          allPoints.map((node, index) => ({
            tripId: newTrip.id,
            title: node.name,
            lat: node.lat,
            lon: node.lon,
            order: index,
            address: node.address || node.name,
          })),
        );
      }
    }

    return {
      city,
      numDays,
      planningContext: planningCtx,
      executionTimeMs,
      route: routeDays,
      explanation,
      tripId: createdTripId,
    };
  }
}

import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AppModule } from '../../app.module';
import { PopularGeneratorService } from '../pipeline/popular-generator.service';
import { DRIZZLE } from '../../db/db.module';
import * as schema from '../../db/schema';

async function bootstrap(): Promise<void> {
  const city = process.argv[2]?.trim();

  if (!city) {
    throw new Error('Usage: pnpm ai:generate-popular <city>');
  }

  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const generator = app.get(PopularGeneratorService);
    const db = app.get<NodePgDatabase<typeof schema>>(DRIZZLE);

    const owner = await db.query.users.findFirst({
      where: eq(schema.users.email, 'ai-seed@trip.local'),
    });

    const ownerId = owner
      ? owner.id
      : (
          await db
            .insert(schema.users)
            .values({
              email: 'ai-seed@trip.local',
              name: 'AI Seed',
              passwordHash: 'seed-not-for-login',
            })
            .returning({ id: schema.users.id })
        )[0].id;

    const generated = await generator.generate(city);

    const createdTrip = await db
      .insert(schema.trips)
      .values({
        title: generated.title,
        description: generated.description,
        budget: generated.budget,
        ownerId,
        isActive: false,
        isPredefined: true,
      })
      .returning({ id: schema.trips.id });

    const tripId = createdTrip[0].id;

    for (let index = 0; index < generated.points.length; index += 1) {
      const point = generated.points[index];
      await db.insert(schema.routePoints).values({
        tripId,
        title: point.name,
        lat: point.coordinates.lat,
        lon: point.coordinates.lon,
        budget:
          generated.route_plan.days[0]?.points[index]?.estimated_cost ?? 0,
        order: index,
        address: point.address,
      });
    }

    console.log(`Generated popular route for ${city}. trip_id=${tripId}`);
  } finally {
    await app.close();
  }
}

void bootstrap();

import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AppModule } from '../../app.module';
import { PopularGeneratorService } from '../pipeline/popular-generator.service';
import { DRIZZLE } from '../../db/db.module';
import * as schema from '../../db/schema';

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function bootstrap(): Promise<void> {
  const city = process.argv[2]?.trim();

  if (!city) {
    console.error('Usage: pnpm ai:generate-popular <city>');
    process.exit(1);
  }

  console.log(`Starting popular generation for ${city}...`);

  try {
    const app = await NestFactory.createApplicationContext(AppModule);
    console.log('Application context created.');

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

    console.log(`Using owner_id=${ownerId}. Generating route...`);
    const generated = await generator.generate(city);
    console.log(`Route generated: ${generated.title}`);

    const createdTrip = await db
      .insert(schema.trips)
      .values({
        title: generated.title,
        description: generated.description,
        budget: Math.round(generated.budget),
        ownerId,
        isActive: true,
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
    await app.close();
  } catch (error) {
    console.error('Fatal error in bootstrap:', error);
    process.exit(1);
  }
}

void bootstrap();

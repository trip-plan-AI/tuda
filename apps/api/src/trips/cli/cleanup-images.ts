


import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../db/schema';
import { eq, isNotNull } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

@Module({
  imports: [ConfigModule.forRoot()],
})
class CleanupModule {}

async function resolveImagesDir(): Promise<string> {
  const candidates = [
    resolve(process.cwd(), 'apps', 'web', 'public', 'assets', 'images'),
    resolve(process.cwd(), '..', 'web', 'public', 'assets', 'images'),
    resolve(__dirname, '..', '..', 'web', 'public', 'assets', 'images'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      console.log(`✅ Images directory found: ${candidate}`);
      return candidate;
    } catch {
    }
  }

  throw new Error('Images directory not found');
}

async function bootstrap() {
  console.log('🧹 Starting image cleanup...\n');

  const app = await NestFactory.createApplicationContext(CleanupModule);
  const configService = app.get(ConfigService);

  // Get database connection
  const databaseUrl = configService.get<string>('DATABASE_URL');
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL not found in environment');
    await app.close();
    return;
  }

  // Get images directory
  let imagesDir: string;
  try {
    imagesDir = await resolveImagesDir();
  } catch (error) {
    console.error('❌ Failed to find images directory:', error);
    await app.close();
    return;
  }

  // Connect to database
  const pool = new Pool({ connectionString: databaseUrl });
  const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

  try {
    // Get all trips with img field
    const trips = await db.query.trips.findMany({
      where: (trips, { isNotNull }) => isNotNull(trips.img),
      columns: {
        id: true,
        img: true,
        title: true,
      },
    });

    console.log(`📊 Found ${trips.length} trips with images\n`);

    let cleanedCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;

    for (const trip of trips) {
      if (!trip.img) continue;

      // Extract filename from path (e.g., /assets/images/parizh.jpg -> parizh.jpg)
      const filename = trip.img.replace('/assets/images/', '');
      const fullPath = join(imagesDir, filename);

      try {
        // Check if file exists
        await fs.access(fullPath);
        cleanedCount++;
        console.log(
          `✅ ${trip.title} (${trip.id}) - image exists: ${filename}`,
        );
      } catch (error) {
        // File doesn't exist, remove from database
        notFoundCount++;
        console.log(
          `❌ ${trip.title} (${trip.id}) - image NOT found: ${filename}`,
        );
        console.log(`   → Removing img reference from database...`);

        try {
          await db
            .update(schema.trips)
            .set({ img: null, updatedAt: new Date() })
            .where(eq(schema.trips.id, trip.id));

          console.log(`   ✅ Successfully removed img reference`);
        } catch (dbError) {
          errorCount++;
          console.error(`   ❌ Failed to update database: ${dbError}`);
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 Cleanup Summary:');
    console.log('='.repeat(60));
    console.log(`✅ Images found:      ${cleanedCount}`);
    console.log(`❌ Images removed:    ${notFoundCount}`);
    console.log(`⚠️  Errors:           ${errorCount}`);
    console.log(`📊 Total processed:   ${trips.length}`);
    console.log('='.repeat(60));

    if (notFoundCount > 0) {
      console.log(
        `\n🎉 Successfully cleaned ${notFoundCount} broken image references!`,
      );
    } else {
      console.log('\n✨ All image references are valid!');
    }
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  } finally {
    await pool.end();
    await app.close();
  }
}

bootstrap()
  .then(() => {
    console.log('\n✅ Cleanup completed!\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Cleanup failed:', error);
    process.exit(1);
  });

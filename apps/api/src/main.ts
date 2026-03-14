import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import * as path from 'path'
const logger = new Logger('Bootstrap');

async function runMigrations() {
  // __dirname resolves to apps/api/src at runtime (ts-node) and apps/api/dist/src when compiled
  const migrationsFolder = path.resolve(__dirname, 'db/migrations');
  logger.log(`Looking for migrations in: ${migrationsFolder}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const db = drizzle(pool);
    logger.log('Running database migrations...');
    await migrate(db, { migrationsFolder });
    logger.log('Migrations completed successfully');
  } catch (error) {
    logger.error(
      'Migration failed — server will start anyway. ' +
      'If tables already exist but __drizzle_migrations is empty, ' +
      'run the sync query from the README to register existing migrations.',
      error,
    );
    // Graceful fallback: do NOT rethrow — let the server boot regardless
  } finally {
    await pool.end();
  }
}

async function bootstrap() {
  // В production миграции применяются на этапе деплоя (db:push/db:seed в CI),
  // поэтому при старте API не запускаем migrate(), чтобы избежать конфликтов
  // с уже существующей схемой и дублирующими migration-файлами.
  if (process.env.NODE_ENV !== 'production') {
    await runMigrations();
  } else {
    logger.log('Skip runtime migrations in production');
  }

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
}
void bootstrap();

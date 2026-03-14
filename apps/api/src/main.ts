import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

async function runMigrations() {
  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle(pool);
    logger.log('Running database migrations...');
    const migrationsPath = process.env.NODE_ENV === 'production'
      ? '/app/apps/api/src/db/migrations'
      : 'apps/api/src/db/migrations';
    await migrate(db, { migrationsFolder: migrationsPath });
    logger.log('Migrations completed');
    await pool.end();
  } catch (error) {
    logger.error('Migration failed:', error);
    throw error;
  }
}

async function bootstrap() {
  // Run migrations before app initialization
  await runMigrations();

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

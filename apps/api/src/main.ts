import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import * as path from 'path';
import * as fs from 'fs';

const logger = new Logger('Bootstrap');

async function runMigrations() {
  // Try src (for development) or current directory (for dist)
  const migrationsFolder = fs.existsSync(
    path.resolve(__dirname, 'db/migrations'),
  )
    ? path.resolve(__dirname, 'db/migrations')
    : path.resolve(__dirname, '../db/migrations');

  logger.log(`Looking for migrations in: ${migrationsFolder}`);

  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    logger.warn(
      `No migration journal found at ${journalPath}. Skipping auto-migration. Run 'drizzle-kit generate' to create migrations.`,
    );
    return;
  }

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
  // В этом проекте мы используем 'drizzle-kit push' вручную или через CI,
  // поэтому отключаем автоматические миграции при старте, чтобы избежать
  // ошибок "relation already exists" при несовпадении журналов.
  logger.log(
    'Skip runtime migrations. Use "drizzle-kit push" for schema updates.',
  );

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

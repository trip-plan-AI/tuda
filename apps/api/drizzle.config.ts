import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

export default defineConfig({
  schema: ['./src/db/schema.ts', './src/db/city-dataset.schema.ts'],
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
  // Важно: prefix должен быть enum-значением drizzle-kit,
  // иначе `drizzle-kit migrate` падает на валидации конфига.
  migrations: {
    // Критично для прод-совместимости: явно фиксируем схему,
    // иначе drizzle может читать историю из schema `drizzle` по умолчанию.
    schema: 'public',
    table: '__drizzle_migrations',
    prefix: 'index',
  },
});

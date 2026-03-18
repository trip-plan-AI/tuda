import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import * as cityDatasetSchema from './city-dataset.schema';

export const DRIZZLE = Symbol('DRIZZLE');

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new Pool({ connectionString: config.get('DATABASE_URL') });
        const mergedSchema = { ...schema, ...cityDatasetSchema };
        return drizzle(pool, { schema: mergedSchema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DbModule {}

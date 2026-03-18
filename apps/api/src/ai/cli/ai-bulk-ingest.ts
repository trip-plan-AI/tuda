import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { BulkIngestionService } from '../pipeline/bulk-ingestion.service';

async function bootstrap(): Promise<void> {
  const limit = process.argv[2] ? parseInt(process.argv[2]) : 20;

  console.log(`Starting bulk ingestion for top ${limit} cities...`);
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const service = app.get(BulkIngestionService);
    const result = await service.ingestPopularCities(limit);
    console.log('Bulk ingestion result:', result);
  } catch (error) {
    console.error('Bulk ingestion failed:', error);
  } finally {
    await app.close();
  }
}

void bootstrap();

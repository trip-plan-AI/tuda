import { Controller, Get, Query } from '@nestjs/common';
import { GeosearchService } from './geosearch.service';

@Controller('geosearch')
export class GeosearchController {
  constructor(private readonly geosearchService: GeosearchService) {}

  @Get('suggest')
  async suggest(@Query('q') query?: string) {
    const results = await this.geosearchService.suggest(query ?? '');
    return { results };
  }
}

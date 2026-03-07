import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { GeosearchService } from './geosearch.service';

@Controller('geosearch')
export class GeosearchController {
  constructor(private readonly geosearchService: GeosearchService) {}

  @Get('suggest')
  async suggest(@Query('q') query?: string, @Req() req?: Request) {
    const results = await this.geosearchService.suggest(query ?? '', req);
    return { results };
  }
}

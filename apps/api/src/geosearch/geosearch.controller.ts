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

  @Get('reverse')
  async reverse(@Query('lat') lat: string, @Query('lon') lon: string) {
    const results = await this.geosearchService.reverse(
      parseFloat(lat),
      parseFloat(lon),
    );
    return results;
  }

  @Get('route')
  async route(@Query('profile') profile: string, @Query('coords') coords: string): Promise<any> {
    return this.geosearchService.osrmRoute(profile || 'driving', coords);
  }
}

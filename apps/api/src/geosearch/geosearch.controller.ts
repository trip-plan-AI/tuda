import { Controller, Get, Query } from '@nestjs/common';
import { GeosearchService } from './geosearch.service';

@Controller('geosearch')
export class GeosearchController {
  constructor(private readonly geosearchService: GeosearchService) {}

  @Get('suggest')
  async suggest(
    @Query('q') query?: string,
    @Query('lat') lat?: string,
    @Query('lon') lon?: string,
  ) {
    const userLat = lat ? parseFloat(lat) : undefined;
    const userLon = lon ? parseFloat(lon) : undefined;
    const results = await this.geosearchService.suggest(query ?? '', userLat, userLon);
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
  async route(
    @Query('profile') profile: string,
    @Query('coords') coords: string,
  ): Promise<any> {
    return this.geosearchService.osrmRoute(profile || 'driving', coords);
  }
}

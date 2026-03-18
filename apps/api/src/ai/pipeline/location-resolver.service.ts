import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GeosearchService } from '../../geosearch/geosearch.service';
import { PopularDestinationsService } from '../../geosearch/popular-destinations.service';

export interface ResolvedLocation {
  lat: number;
  lon: number;
  radius: number;
  displayName: string;
  countryCode: string | null;
  type: string;
}

@Injectable()
export class LocationResolverService {
  private readonly logger = new Logger(LocationResolverService.name);

  constructor(
    private readonly geosearch: GeosearchService,
    private readonly popularDestinations: PopularDestinationsService,
  ) {}

  async resolve(query: string): Promise<ResolvedLocation | null> {
    this.logger.log(`Resolving location for query: "${query}"`);

    let suggestions = await this.geosearch.suggest(query);

    // Fallback 1: Try fuzzy matching/cleaning if no suggestions
    if (!suggestions || suggestions.length === 0) {
      this.logger.warn(
        `No location found for query: "${query}", trying fuzzy cleanup...`,
      );
      // Убираем предлоги и лишние слова
      const cleanedQuery = query
        .replace(
          /(рядом с|возле|около|у|в|на|город|деревня|село|улица|поселок)\s+/i,
          '',
        )
        .trim();
      if (cleanedQuery !== query && cleanedQuery.length > 0) {
        suggestions = await this.geosearch.suggest(cleanedQuery);
      }
    }

    if (!suggestions || suggestions.length === 0) {
      this.logger.warn(`Still no location found for query: "${query}"`);
      // TRI-115: Если место совсем не найдено, выбрасываем ошибку для уточнения
      throw new UnprocessableEntityException({
        code: 'LOCATION_NOT_FOUND',
        message: `Не удалось найти место "${query}". Уточните, пожалуйста, город или область.`,
        query,
      });
    }

    // TRI-115: Приоритет типов (город > поселок > парк)
    const TYPE_PRIORITY = [
      'city',
      'town',
      'village',
      'hamlet',
      'administrative',
      'place',
      'locality',
    ];
    const best = [...suggestions].sort((a, b) => {
      const aType = a.type || 'unknown';
      const bType = b.type || 'unknown';
      const aIdx = TYPE_PRIORITY.indexOf(aType);
      const bIdx = TYPE_PRIORITY.indexOf(bType);

      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return 0;
    })[0];

    const type = best.type || 'unknown';
    const className = best.class || 'unknown';

    const radius = this.determineRadius(className, type);
    const countryCode = await this.popularDestinations.getCountryCode(
      best.displayName,
    );

    this.logger.log(
      `Resolved "${query}" to "${best.displayName}" (type: ${type}, class: ${className}) -> lat: ${best.lat}, lon: ${best.lon}, radius: ${radius}m`,
    );

    return {
      lat: best.lat,
      lon: best.lon,
      radius,
      displayName: best.displayName,
      countryCode,
      type,
    };
  }

  private determineRadius(className: string, type: string): number {
    // Города
    if (type === 'city') return 15000;
    if (type === 'town') return 10000;

    // Деревни, поселки
    if (type === 'village') return 7000;
    if (type === 'hamlet') return 5000;

    // Административные границы
    if (className === 'boundary') return 15000;

    // Районы города
    if (type === 'suburb' || type === 'city_district') return 5000;

    // Улицы и дороги
    if (className === 'highway' || type === 'street' || type === 'road')
      return 2000;

    // Конкретные объекты (POI)
    if (
      [
        'amenity',
        'tourism',
        'historic',
        'leisure',
        'man_made',
        'shop',
        'office',
        'craft',
      ].includes(className)
    ) {
      return 1500; // Increased from 1000
    }

    // Если это парк или природный объект, но мы его выбрали (значит города нет рядом)
    if (className === 'natural' || type === 'park' || type === 'forest') {
      return 5000; // Increased from default 3000
    }

    // По умолчанию для непонятных штук (unknown)
    return 12000;
  }
}

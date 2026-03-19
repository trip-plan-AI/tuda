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

  // Страны СНГ → примерный bounding box: lat 35–82, lon 19–192
  private static readonly CIS_COUNTRY_CODES = new Set([
    'RU', 'UA', 'BY', 'KZ', 'UZ', 'TM', 'TJ', 'KG', 'AM', 'AZ', 'GE', 'MD',
  ]);

  private static readonly CIS_COUNTRY_NAMES: Record<string, string> = {
    RU: 'Россия', UA: 'Украина', BY: 'Беларусь', KZ: 'Казахстан',
    UZ: 'Узбекистан', TM: 'Туркменистан', TJ: 'Таджикистан',
    KG: 'Кыргызстан', AM: 'Армения', AZ: 'Азербайджан',
    GE: 'Грузия', MD: 'Молдова',
  };

  private isCoordPlausible(lat: number, lon: number, countryCode?: string | null): boolean {
    if (!countryCode) return true;
    if (LocationResolverService.CIS_COUNTRY_CODES.has(countryCode)) {
      return lat >= 35 && lat <= 82 && lon >= 19 && lon <= 192;
    }
    return true;
  }

  async resolve(query: string, countryCode?: string | null): Promise<ResolvedLocation | null> {
    // Если кириллица + известная страна — добавляем страну к запросу,
    // чтобы геокодер не путал "Анапа" с "Anapu" в Бразилии
    const hasCyrillic = /[а-яёА-ЯЁ]/.test(query);
    const countryHint = countryCode ? LocationResolverService.CIS_COUNTRY_NAMES[countryCode] : null;
    const enrichedQuery =
      hasCyrillic && countryHint && !query.toLowerCase().includes(countryHint.toLowerCase())
        ? `${query}, ${countryHint}`
        : query;

    this.logger.log(
      `Resolving location: "${enrichedQuery}" (original: "${query}", country: ${countryCode ?? 'unknown'})`,
    );

    let suggestions = await this.geosearch.suggest(enrichedQuery);

    // Fallback 1: Try fuzzy matching/cleaning if no suggestions
    if (!suggestions || suggestions.length === 0) {
      this.logger.warn(
        `No location found for query: "${enrichedQuery}", trying fuzzy cleanup...`,
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

    // Валидация координат: если страна известна и bbox не совпадает — кидаем ошибку.
    // Пример: "Анапа" → Anapu (Бразилия, lat=-3.47) при RU должна быть отброшена.
    if (!this.isCoordPlausible(best.lat, best.lon, countryCode)) {
      this.logger.error(
        `Location "${best.displayName}" (lat=${best.lat}, lon=${best.lon}) is outside expected bbox for country "${countryCode}". Rejecting.`,
      );
      throw new UnprocessableEntityException({
        code: 'LOCATION_WRONG_COUNTRY',
        message: `Не удалось найти "${query}" в стране ${countryCode}. Геокодер вернул точку в другой стране — уточните запрос.`,
        query,
      });
    }

    const radius = this.determineRadius(className, type);
    const resolvedCountryCode = await this.popularDestinations.getCountryCode(
      best.displayName,
    );

    this.logger.log(
      `Resolved "${enrichedQuery}" to "${best.displayName}" (type: ${type}, class: ${className}) -> lat: ${best.lat}, lon: ${best.lon}, radius: ${radius}m`,
    );

    return {
      lat: best.lat,
      lon: best.lon,
      radius,
      displayName: best.displayName,
      countryCode: resolvedCountryCode,
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

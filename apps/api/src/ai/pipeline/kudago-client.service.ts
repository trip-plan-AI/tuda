import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ParsedIntent, PoiCategory } from '../types/pipeline.types';
import type { PoiItem, PriceSegment } from '../types/poi.types';

interface KudaGoPlace {
  id: number;
  title: string;
  address?: string;
  coords?: { lat: number; lon: number };
  is_closed?: boolean;
}

@Injectable()
export class KudagoClientService {
  private readonly logger = new Logger(KudagoClientService.name);
  private readonly baseUrl = 'https://kudago.com/public-api/v1.4';

  // Маппинг городов KudaGo. Если города нет, API вернет пустой результат, что нормально
  private readonly cityMap: Record<string, string> = {
    москва: 'msk',
    moscow: 'msk',
    мск: 'msk',
    'санкт-петербург': 'spb',
    'санкт петербург': 'spb',
    'saint petersburg': 'spb',
    'st petersburg': 'spb',
    спб: 'spb',
    spb: 'spb',
    питер: 'spb',
    новосибирск: 'nsk',
    novosibirsk: 'nsk',
    нск: 'nsk',
    екатеринбург: 'ekb',
    yekaterinburg: 'ekb',
    екб: 'ekb',
    'нижний новгород': 'nnv',
    'нижний новгород ': 'nnv',
    нижний: 'nnv',
    'nizhny novgorod': 'nnv',
    нн: 'nnv',
    казань: 'kzn',
    kazan: 'kzn',
    сочи: 'sochi',
    sochi: 'sochi',
    краснодар: 'krd',
    krasnodar: 'krd',
    крд: 'krd',
    самара: 'smr',
    samara: 'smr',
    смр: 'smr',
    тольятти: 'tlt',
    tolyatti: 'tlt',
    tlt: 'tlt',
    владивосток: 'vld',
    vladivostok: 'vld',
    уфа: 'ufa',
    ufa: 'ufa',
    воронеж: 'vrn',
    voronezh: 'vrn',
    челябинск: 'chel',
    chelyabinsk: 'chel',
    красноярск: 'krs',
    krasnoyarsk: 'krs',
    пермь: 'prm',
    perm: 'prm',
    волгоград: 'vlg',
    volgograd: 'vlg',
    тюмень: 'tyumen',
    tyumen: 'tyumen',
  };

  async fetchByIntent(intent: ParsedIntent): Promise<PoiItem[]> {
    // Улучшенный поиск города: убираем дефисы и лишние пробелы для маппинга
    const normalizedCity = intent.city
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]/g, ' ')
      .trim();

    // Сначала ищем точное совпадение, потом по частям
    const cityCode =
      this.cityMap[normalizedCity] ||
      this.cityMap[normalizedCity.replace(/\s+/g, '-')] ||
      this.cityMap[normalizedCity.replace(/\s+/g, '')];

    if (!cityCode) {
      this.logger.log(
        `KudaGo: City '${intent.city}' (normalized: '${normalizedCity}') not supported, skipping.`,
      );
      return [];
    }

    this.logger.log(
      `KudaGo: Fetching for city '${intent.city}' (code: ${cityCode})`,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const cleanCity = cityCode.replace(/\s+/g, '').trim();

      const params = new URLSearchParams();
      params.append('location', cleanCity);
      params.append('format', 'json');
      params.append('lang', 'ru');
      params.append('fields', 'id,title,address,coords,is_closed,categories');
      params.append('text_format', 'text');
      params.append('page_size', '100');

      const url = `${this.baseUrl}/places/?${params.toString()}`;

      // Логируем URL
      this.logger.log(`KudaGo: Request URL: ${JSON.stringify(url)}`);

      // Проверяем, нужен ли API ключ для KudaGo
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept-Language': 'ru',
          'User-Agent': 'TravelPlanner/1.0 (AI pipeline)',
          // 'X-API-Key': process.env.KUDAGO_API_KEY || '' // Раскомментировать, если потребуется API ключ
        },
      });

      if (!response.ok) {
        // Читаем тело ответа с ошибкой от KudaGo
        const errorText = await response.text();
        this.logger.warn(
          `KudaGo HTTP ${response.status}. Причина: ${errorText}`,
        );
        return [];
      }

      const data = (await response.json()) as { results?: KudaGoPlace[] };
      const items = data.results ?? [];

      return items
        .filter((item) => !item.is_closed)
        .map((item) => this.normalize(item, intent))
        .filter((item): item is PoiItem => item !== null);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        this.logger.warn('KudaGo request timed out');
      } else {
        this.logger.error(`Error fetching from KudaGo:`, e);
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private normalize(item: KudaGoPlace, intent: ParsedIntent): PoiItem | null {
    if (
      !item.coords ||
      typeof item.coords.lat !== 'number' ||
      typeof item.coords.lon !== 'number'
    ) {
      return null;
    }

    const lat = item.coords.lat;
    const lon = item.coords.lon;

    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return null;
    }

    // В KudaGo часто крутые места (музеи, парки, театры, рестораны).
    // Попробуем определить категорию из названия.
    const category = this.guessCategory(item.title);

    // Если категория в исключенных - пропускаем
    if (intent.excluded_categories.includes(category)) return null;

    // Снимаем строгую фильтрацию по запрошенным категориям,
    // чтобы отдавать LLM более широкий выбор
    // if (!intent.categories.includes(category)) return null;

    const name = item.title.charAt(0).toUpperCase() + item.title.slice(1);
    const address = item.address
      ? `${intent.city}, ${item.address}`
      : intent.city;

    return {
      id: this.makePoiId(name, address, lat, lon),
      name,
      address,
      provider: 'kudago',
      coordinates: { lat, lon },
      category,
      // В KudaGo нет четкого рейтинга в этом эндпоинте, ставим дефолтный хороший, так как KudaGo уже фильтрует интересное
      rating: 4.5,
      score: 0.6, // Default score for KudaGo data
      price_segment: this.toPriceSegment(category),
    };
  }

  private guessCategory(title: string): PoiCategory {
    const lower = title.toLowerCase();
    if (
      lower.includes('музей') ||
      lower.includes('галере') ||
      lower.includes('выставк')
    )
      return 'museum';
    if (
      lower.includes('парк') ||
      lower.includes('сад ') ||
      lower.includes('сквер')
    )
      return 'park';
    if (lower.includes('ресторан') || lower.includes('бар'))
      return 'restaurant';
    if (lower.includes('кафе') || lower.includes('кофейн')) return 'cafe';
    if (
      lower.includes('тц') ||
      lower.includes('торговый') ||
      lower.includes('магазин')
    )
      return 'shopping';
    if (
      lower.includes('театр') ||
      lower.includes('кино') ||
      lower.includes('квест') ||
      lower.includes('клуб')
    )
      return 'entertainment';
    return 'attraction';
  }

  private toPriceSegment(category: PoiCategory): PriceSegment {
    if (category === 'park') return 'free';
    if (category === 'restaurant') return 'premium';
    return 'mid';
  }

  private makePoiId(
    name: string,
    address: string,
    lat: number,
    lon: number,
  ): string {
    const raw = `kudago|${name}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 24);
  }
}

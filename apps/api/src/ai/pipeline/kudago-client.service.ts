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
    'санкт-петербург': 'spb',
    новосибирск: 'nsk',
    екатеринбург: 'ekb',
    'нижний новгород': 'nnv',
    казань: 'kzn',
    сочи: 'sochi',
  };

  async fetchByIntent(intent: ParsedIntent): Promise<PoiItem[]> {
    const cityCode = this.cityMap[intent.city.toLowerCase()];
    if (!cityCode) {
      this.logger.log(`KudaGo: City '${intent.city}' not supported, skipping.`);
      return [];
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      // TRI-108-1: Request food categories if food intent detected
      const url = new URL(`${this.baseUrl}/places/`);
      url.searchParams.set('location', cityCode);
      url.searchParams.set(
        'fields',
        'id,title,address,coords,is_closed,categories',
      );
      url.searchParams.set('text_format', 'text');
      url.searchParams.set('page_size', '100');

      // TRI-108-1: If food is in categories, request food-related places
      const foodCategories = intent.categories.filter((cat) =>
        /cafe|кафе|restaurant|ресторан|bar|бар|food|еда|coffee|кофе/i.test(cat),
      );
      if (foodCategories.length > 0) {
        url.searchParams.set('categories', 'cafe,restaurant,bar');
      }

      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { 'Accept-Language': 'ru' },
      });

      if (!response.ok) {
        this.logger.warn(`KudaGo HTTP ${response.status}`);
        return [];
      }

      const data = (await response.json()) as { results?: KudaGoPlace[] };
      const items = data.results ?? [];

      return items
        .filter((item) => !item.is_closed)
        .map((item) => this.normalize(item, intent))
        .filter((item): item is PoiItem => item !== null);
    } catch (e) {
      this.logger.error(`Error fetching from KudaGo:`, e);
      return [];
    } finally {
      clearTimeout(timer);
      controller.abort();
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
      coordinates: { lat, lon },
      category,
      // В KudaGo нет четкого рейтинга в этом эндпоинте, ставим дефолтный хороший, так как KudaGo уже фильтрует интересное
      rating: 4.5,
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

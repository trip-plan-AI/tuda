import { Injectable, Logger } from '@nestjs/common';

export interface WikidataEnrichmentResult {
  wikidataId: string;
  sitelinksCount: number;
  description?: string;
  wikipediaLink?: string;
  image?: string;
}

@Injectable()
export class WikidataEnrichmentService {
  private readonly logger = new Logger(WikidataEnrichmentService.name);
  private readonly WIKIDATA_API_URL = 'https://www.wikidata.org/w/api.php';

  /**
   * Обогащает POI данными из Wikidata по её Q-идентификатору.
   * @param wikidataId Идентификатор Wikidata (например, 'Q178470')
   */
  public async enrich(
    wikidataId: string,
  ): Promise<WikidataEnrichmentResult | null> {
    if (!wikidataId || !wikidataId.startsWith('Q')) {
      return null;
    }

    try {
      const url = new URL(this.WIKIDATA_API_URL);
      url.searchParams.append('action', 'wbgetentities');
      url.searchParams.append('ids', wikidataId);
      // Запрашиваем ссылки на википедию (sitelinks/urls), описания и клеймы (P18 - фото)
      url.searchParams.append('props', 'sitelinks/urls|descriptions|claims');
      url.searchParams.append('format', 'json');
      url.searchParams.append('languages', 'ru|en');

      const response = await fetch(url.toString(), {
        headers: {
          // Wikidata требует осмысленный User-Agent для своих API запросов
          'User-Agent': 'TripPlannerBot/1.0 (Contact: admin@example.com)',
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Wikidata API error for ${wikidataId}: ${response.statusText}`,
        );
        return null;
      }

      const data = await response.json();
      const entity = data.entities?.[wikidataId];

      if (!entity) return null;

      const sitelinksCount = entity.sitelinks
        ? Object.keys(entity.sitelinks).length
        : 0;
      const description =
        entity.descriptions?.ru?.value || entity.descriptions?.en?.value;
      const wikipediaLink =
        entity.sitelinks?.ruwiki?.url || entity.sitelinks?.enwiki?.url;

      // P18 - это свойство "изображение" (image) в Wikidata
      let image: string | undefined;
      const imageClaim = entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (imageClaim) {
        image = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageClaim)}`;
      }

      return {
        wikidataId,
        sitelinksCount,
        description,
        wikipediaLink,
        image,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch Wikidata for ${wikidataId}`, error);
      return null;
    }
  }
}

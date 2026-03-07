import { Injectable } from '@nestjs/common';

interface YandexSuggestion {
  title?: { text: string };
  subtitle?: { text: string };
  geometry?: { point: { lon: number; lat: number } };
}

interface NominatimItem {
  display_name: string;
  lon: number;
  lat: number;
}

@Injectable()
export class GeosearchService {
  private get yandexApiKey() {
    return (
      process.env.YANDEX_SUGGEST_KEY ??
      process.env.YANDEX_MAPS_API_KEY ??
      process.env.NEXT_PUBLIC_YANDEX_GEOSUGGEST_KEY
    );
  }

  async suggest(query: string) {
    const normalized = query.trim();
    if (normalized.length < 2) return [];

    const yandexResults = await this.getYandexSuggestions(normalized);
    if (yandexResults && yandexResults.length > 0) return yandexResults;

    return this.getNominatimSuggestions(normalized);
  }

  private async getYandexSuggestions(
    q: string,
  ): Promise<Array<{ displayName: string; uri: string }> | null> {
    if (!this.yandexApiKey) return null;

    try {
      const res = await fetch('https://suggest-maps.yandex.ru/v1/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: q,
          ll: '55.7558,37.6173',
          spn: '10,10',
          limit: 10,
          types: ['biz', 'geo'],
          apikey: this.yandexApiKey,
        }),
      });

      if (res.status === 429 || res.status === 403 || !res.ok) return null;

      const data = await res.json();
      const suggestions = Array.isArray(data?.suggestions)
        ? data.suggestions
        : [];

      return suggestions
        .map((item: YandexSuggestion) => {
          const coords = item.geometry?.point;
          if (!coords) return null;

          const title = item.title?.text ?? '';
          const subtitle = item.subtitle?.text ?? '';
          return {
            displayName: subtitle ? `${title}, ${subtitle}` : title,
            uri: `ymapsbm1://geo?ll=${coords.lon},${coords.lat}&z=12`,
          };
        })
        .filter(
          (item): item is { displayName: string; uri: string } => item !== null,
        );
    } catch {
      return null;
    }
  }

  private async getNominatimSuggestions(
    q: string,
  ): Promise<Array<{ displayName: string; uri: string }>> {
    try {
      const params = new URLSearchParams({
        q,
        format: 'json',
        limit: '10',
        countrycodes: 'ru',
        'accept-language': 'ru',
        dedupe: '1',
      });

      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
      );
      if (!res.ok) return [];

      const data = await res.json();
      if (!Array.isArray(data)) return [];

      return data.map((item: NominatimItem) => ({
        displayName: item.display_name,
        uri: `ymapsbm1://geo?ll=${item.lon},${item.lat}&z=12`,
      }));
    } catch {
      return [];
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { GeosearchService } from '../../geosearch/geosearch.service';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class GeocodingFallbackService {
  private readonly logger = new Logger(GeocodingFallbackService.name);

  // Справочник разрешенных под-регионов для крупных городов (Whitelist)
  private readonly CITY_REGIONS: Record<string, string[]> = {
    Сочи: [
      'Сочи',
      'Сириус',
      'Адлер',
      'Хоста',
      'Мацеста',
      'Дагомыс',
      'Лазаревское',
      'Красная Поляна',
      'Эсто-Садок',
      'Роза Хутор',
    ],
    МСК: [
      'Москва',
      'МСК',
      'Зеленоград',
      'Троицк',
      'Щербинка',
      'Московский',
      'Зеленоградский',
    ],
    Москва: [
      'Москва',
      'МСК',
      'Зеленоград',
      'Троицк',
      'Щербинка',
      'Московский',
      'Зеленоградский',
    ],
    СПб: [
      'Санкт-Петербург',
      'Пушкин',
      'Павловск',
      'Петергоф',
      'Кронштадт',
      'Ломоносов',
      'Колпино',
      'Сестрорецк',
    ],
    'Санкт-Петербург': [
      'Санкт-Петербург',
      'Пушкин',
      'Павловск',
      'Петергоф',
      'Кронштадт',
      'Ломоносов',
      'Колпино',
      'Сестрорецк',
    ],
    Екатеринбург: ['Екатеринбург', 'Верхняя Пышма', 'Березовский'],
    Казань: ['Казань', 'Иннополис'],
  };

  constructor(
    private readonly geosearchService: GeosearchService,
    private readonly redis: RedisService,
  ) {}

  async geocodePointsWithFallback(
    points: Array<{
      id: string;
      name: string;
      coordinates?: { lat: number; lon: number };
      city_name?: string;
    }>,
    defaultCity: string,
  ): Promise<Map<string, { lat: number; lon: number }>> {
    const geocodedPoints = new Map<string, { lat: number; lon: number }>();

    // nameToCoords — локальный кэш для текущего запроса (чтобы не дергать Redis/API для дублей в одном списке)
    const nameToCoords = new Map<string, { lat: number; lon: number }>();

    const cityCenters = new Map<string, { lat: number; lon: number } | null>();

    for (const point of points) {
      const city = point.city_name || defaultCity;

      // 1. Пропускаем, если координаты уже есть
      if (this.isValidCoord(point.coordinates?.lat, point.coordinates?.lon)) {
        geocodedPoints.set(point.id, point.coordinates!);
        nameToCoords.set(point.name, point.coordinates!);
        continue;
      }

      // 2. Локальный кэш (дубли в списке)
      if (nameToCoords.has(point.name)) {
        geocodedPoints.set(point.id, nameToCoords.get(point.name)!);
        continue;
      }

      if (!cityCenters.has(city)) {
        cityCenters.set(city, await this.getCityCenter(city));
      }
      const cityCenter = cityCenters.get(city) ?? null;

      // --- Rate Limiting: Небольшая пауза между точками для защиты от бана геокодеров ---
      await this.delay(200);

      try {
        let geocoded = false;

        // --- ШАГ 0: Глобальный кэш (Redis) ---
        const globalCacheKey = `geo:final:${city.toLowerCase()}:${point.name.toLowerCase().trim()}`;
        const cached = await this.redis.get(globalCacheKey);
        if (cached) {
          try {
            const coords = JSON.parse(cached);
            if (this.isValidCoord(coords.lat, coords.lon)) {
              this.logger.log(
                `[GEOCODING] 🚀 Global Cache hit: "${point.name}" in ${city}`,
              );
              geocodedPoints.set(point.id, coords);
              nameToCoords.set(point.name, coords);
              geocoded = true;
            }
          } catch (e) {
            this.logger.error(
              `[GEOCODING] Failed to parse Redis cache for ${globalCacheKey}`,
            );
          }
        }

        if (!geocoded) {
          // --- ШАГ 1: Быстрый первичный поиск ---
          this.logger.log(`[GEOCODING] ⚡ Fast search for "${point.name}"...`);
          const initialResults = await this.performRawSearch(
            point.name,
            city,
            cityCenter,
          );

          // --- ШАГ 2: Кодовая валидация (без ИИ) ---
          const bestValidResult = initialResults.find((res) =>
            this.isResultInExpectedRegion(res.displayName, city),
          );

          if (bestValidResult) {
            this.logger.log(
              `[GEOCODING] ✅ Fast success: "${point.name}" in ${city}`,
            );
            const coords = {
              lat: bestValidResult.lat,
              lon: bestValidResult.lon,
            };
            await this.saveToGlobalCache(globalCacheKey, coords);
            geocodedPoints.set(point.id, coords);
            nameToCoords.set(point.name, coords);
            geocoded = true;
          }
        }

        // --- ШАГ 3: AI-Нормализация (только если быстрый поиск провалился) ---
        if (!geocoded) {
          this.logger.log(
            `[GEOCODING] ⚠️ Fast search failed or rejected. Launching AI fallback for "${point.name}"...`,
          );
          const aiResult = await this.normalizePoiWithAI(point.name, city);

          if (aiResult && aiResult.isValid && aiResult.searchQuery) {
            const aiResults = await this.performRawSearch(
              aiResult.searchQuery,
              aiResult.city || city,
              cityCenter,
            );
            const bestAiMatch = aiResults[0];

            if (
              bestAiMatch &&
              this.isValidCoord(bestAiMatch.lat, bestAiMatch.lon)
            ) {
              this.logger.log(
                `[GEOCODING] ✅ AI-Refined success: "${aiResult.searchQuery}" → (${bestAiMatch.lat}, ${bestAiMatch.lon})`,
              );
              const coords = { lat: bestAiMatch.lat, lon: bestAiMatch.lon };
              await this.saveToGlobalCache(globalCacheKey, coords);
              geocodedPoints.set(point.id, coords);
              nameToCoords.set(point.name, coords);
              geocoded = true;
            }
          }
        }

        // --- ШАГ 4: DaData (Последний шанс для РФ) ---
        if (!geocoded) {
          const coords = await this.tryDaDataGeocoding(point.name, city);
          if (coords) {
            this.logger.log(
              `[GEOCODING] ✅ DaData success: "${point.name}" → (${coords.lat}, ${coords.lon})`,
            );
            await this.saveToGlobalCache(globalCacheKey, coords);
            geocodedPoints.set(point.id, coords);
            nameToCoords.set(point.name, coords);
            geocoded = true;
          }
        }

        // --- ШАГ 5: Исключение (Point not found) ---
        if (!geocoded) {
          this.logger.warn(
            `[GEOCODING] ❌ FAILED all strategies for "${point.name}". This point will be excluded.`,
          );
          // Мы просто не добавляем точку в geocodedPoints, контроллер сам отфильтрует её
        }
      } catch (error) {
        this.logger.error(
          `[GEOCODING] Error processing "${point.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return geocodedPoints;
  }

  private async saveToGlobalCache(
    key: string,
    coords: { lat: number; lon: number },
  ) {
    try {
      // Кэшируем на 30 дней
      await this.redis.set(key, JSON.stringify(coords), 60 * 60 * 24 * 30);
    } catch (e) {
      this.logger.error(
        `[GEOCODING] Failed to save to Redis cache: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isResultInExpectedRegion(
    displayName: string,
    expectedCity: string,
  ): boolean {
    const normalizedDisplay = displayName.toLowerCase();
    const allowedWords = this.CITY_REGIONS[expectedCity]
      ? this.CITY_REGIONS[expectedCity].map((w) => w.toLowerCase())
      : [expectedCity.toLowerCase().trim()];

    return allowedWords.some((word) => normalizedDisplay.includes(word));
  }

  private async performRawSearch(
    query: string,
    city: string,
    cityCenter: { lat: number; lon: number } | null,
  ): Promise<any[]> {
    const bbox = this.getCityBbox(city);
    let results: any[] = [];

    if (bbox) {
      results = await this.geosearchService.suggestWithBbox(
        query,
        bbox,
        cityCenter?.lat,
        cityCenter?.lon,
      );
    }

    if (!results || results.length === 0) {
      results = cityCenter
        ? await this.geosearchService.suggestWithBias(
            query,
            cityCenter.lat,
            cityCenter.lon,
          )
        : await this.geosearchService.suggest(query);
    }

    return results || [];
  }

  private isValidCoord(
    lat: number | undefined,
    lon: number | undefined,
  ): boolean {
    return (
      typeof lat === 'number' &&
      typeof lon === 'number' &&
      Math.abs(lat) > 0.001 &&
      Math.abs(lon) > 0.001 &&
      !isNaN(lat) &&
      !isNaN(lon)
    );
  }

  private async normalizePoiWithAI(
    name: string,
    city: string,
  ): Promise<{
    isValid: boolean;
    searchQuery: string | null;
    city: string | null;
  } | null> {
    try {
      const systemPrompt = `Ты — гео-ассистент. Твоя задача — преобразовать название места в идеальный поисковый запрос.
ПРАВИЛА:
1. Оставляй только официальное название.
2. Поле searchQuery ДОЛЖНО заканчиваться городом через запятую.
3. Для объектов Сириуса ВСЕГДА пиши "Сириус" вместо "Сочи".
4. Ответ СТРОГО JSON: {"isValid": boolean, "searchQuery": "Название, Город", "city": "Город"}`;

      if (process.env.YANDEX_GPT_API_KEY && process.env.YANDEX_FOLDER_ID) {
        const response = await fetch(
          'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
          {
            method: 'POST',
            headers: {
              Authorization: `Api-Key ${process.env.YANDEX_GPT_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              modelUri: `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-lite`,
              completionOptions: {
                stream: false,
                temperature: 0.1,
                maxTokens: 500,
              },
              messages: [
                {
                  role: 'system',
                  text: systemPrompt + `\n\nКонтекст: ${city}.`,
                },
                { role: 'user', text: name },
              ],
            }),
          },
        );

        if (response.ok) {
          const payload = await response.json();
          const rawText =
            payload.result?.alternatives?.[0]?.message?.text ?? '{}';
          return JSON.parse(rawText.replace(/```json\n?|\n?```/g, '').trim());
        }
      } else if (process.env.OPENAI_API_KEY) {
        const response = await fetch(
          'https://api.openai.com/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'system',
                  content: systemPrompt + `\n\nКонтекст: ${city}.`,
                },
                { role: 'user', content: name },
              ],
              temperature: 0.1,
            }),
          },
        );
        if (response.ok) {
          const data = await response.json();
          return JSON.parse(data.choices[0]?.message?.content || '{}');
        }
      }
    } catch (e) {
      this.logger.error(
        `[GEOCODING] AI Fallback failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return null;
  }

  private getCityBbox(city: string): string | null {
    const cityBboxes: Record<string, string> = {
      Сочи: '39.1,43.3,40.1,44.0',
      Москва: '37.0,55.4,38.0,56.0',
      СПб: '29.8,59.7,30.5,60.1',
      'Санкт-Петербург': '29.8,59.7,30.5,60.1',
    };
    const normalizedCity = city.toLowerCase().replace(/\s+/g, '');
    const matchedCity = Object.keys(cityBboxes).find(
      (key) => key.toLowerCase().replace(/\s+/g, '') === normalizedCity,
    );
    return matchedCity ? cityBboxes[matchedCity] : null;
  }

  private async getCityCenter(
    city: string,
  ): Promise<{ lat: number; lon: number } | null> {
    const cityCenters: Record<string, { lat: number; lon: number }> = {
      Сочи: { lat: 43.5855, lon: 39.723 },
      Москва: { lat: 55.7558, lon: 37.6176 },
      СПб: { lat: 59.9343, lon: 30.3351 },
      'Санкт-Петербург': { lat: 59.9343, lon: 30.3351 },
    };
    const normalizedCity = city.toLowerCase().replace(/\s+/g, '');
    const matchedCity = Object.keys(cityCenters).find(
      (key) => key.toLowerCase().replace(/\s+/g, '') === normalizedCity,
    );
    if (matchedCity) return cityCenters[matchedCity];
    return await this.getCityCenterFromLLM(city);
  }

  private async getCityCenterFromLLM(
    city: string,
  ): Promise<{ lat: number; lon: number } | null> {
    try {
      if (process.env.YANDEX_GPT_API_KEY && process.env.YANDEX_FOLDER_ID) {
        const response = await fetch(
          'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
          {
            method: 'POST',
            headers: {
              Authorization: `Api-Key ${process.env.YANDEX_GPT_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              modelUri: `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-lite`,
              completionOptions: {
                stream: false,
                temperature: 0.1,
                maxTokens: 100,
              },
              messages: [
                {
                  role: 'user',
                  text: `Координаты центра города "${city}". JSON: {"lat": число, "lon": число}.`,
                },
              ],
            }),
          },
        );
        if (response.ok) {
          const payload = await response.json();
          const rawText =
            payload.result?.alternatives?.[0]?.message?.text ?? '{}';
          const jsonText = rawText.replace(/```json\n?|\n?```/g, '').trim();
          const res = JSON.parse(jsonText);
          if (res.lat && res.lon)
            return { lat: Number(res.lat), lon: Number(res.lon) };
        }
      }
    } catch {}
    return null;
  }

  private async tryDaDataGeocoding(
    name: string,
    city: string,
  ): Promise<{ lat: number; lon: number } | null> {
    const dadataApiKey = process.env.DADATA_API_KEY;
    if (!dadataApiKey) return null;
    try {
      const cityBbox = this.getCityBbox(city);
      const cityCenter = await this.getCityCenter(city);
      const requestBody: any = { query: `${name}, ${city}`, count: 1 };
      if (cityBbox) {
        const [minLon, minLat, maxLon, maxLat] = cityBbox
          .split(',')
          .map(Number);
        requestBody.locations = [
          { bounded_by: [minLon, minLat, maxLon, maxLat] },
        ];
      } else if (cityCenter) {
        requestBody.locations = [
          {
            geolon: cityCenter.lon,
            geolat: cityCenter.lat,
            radius_meters: 50000,
          },
        ];
      }
      const res = await fetch(
        'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Token ${dadataApiKey}`,
          },
          body: JSON.stringify(requestBody),
        },
      );
      if (res.ok) {
        const json = await res.json();
        const d = json.suggestions?.[0]?.data;
        if (d?.geo_lat && d?.geo_lon)
          return { lat: parseFloat(d.geo_lat), lon: parseFloat(d.geo_lon) };
      }
    } catch {}
    return null;
  }
}

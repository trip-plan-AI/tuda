import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import OpenAI from 'openai';
import { RedisService } from '../redis/redis.service';

interface CityExtractionResult {
  city: string | null;
  region: string | null;
  confidence: number;
  comment: string;
}

@Injectable()
export class CityExtractionService implements OnModuleInit {
  private readonly logger = new Logger(CityExtractionService.name);
  private openai: OpenAI | null = null;
  private readonly redisAvailable: boolean = false;

  // TTL для кэша: 30 дней (города не меняются)
  private readonly CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

  private readonly CITY_EXTRACTION_PROMPT = `Ты — эксперт по извлечению названий городов и регионов из адресов и названий мест.

ЗАДАЧА:
1. Извлеки название города из предоставленного текста
2. Если город не определяется — определи регион/область/республику
3. Для региона верни его столицу/административный центр

ПРАВИЛА:
1. Возвращай ТОЛЬКО название города в именительном падеже.
2. Если это известный туристический объект — возвращай ближайший крупный город:
   - "Телецкое озеро" → "Горно-Алтайск"
   - "Кижи" → "Петрозаводск"
   - "Приэльбрусье" → "Тырныауз"
   - "Красная Поляна" → "Сочи"
   - "Эльбрус" → "Тырныауз"
   - "Чегемские водопады" → "Нальчик"
   - "Долина Нарзанов" → "Кисловодск"
   - "Безенгийская стена" → "Нальчик"
   - "Голубые озёра" → "Нальчик" (Кабардино-Балкария)
   - "Навалищенское ущелье" → "Сочи"
   - "Курайская степь" → "Горно-Алтайск" (Республика Алтай)
   - "Чуйский тракт" → "Горно-Алтайск"
   - "Гора Белуха" → "Горно-Алтайск"
   - "Катунь и Мультинские озёра" → "Горно-Алтайск"
   - "Долина Чулышман" → "Горно-Алтайск"
   - "Тисо-самшитовая роща" → "Сочи"
   - "Агурские водопады" → "Сочи"
   - "Олимпийский парк" → "Сочи"
   - "Дендрарий" → "Сочи"
3. Если указан регион без города — возвращай столицу региона:
   - "Республика Алтай" → "Горно-Алтайск"
   - "Кабардино-Балкария" → "Нальчик"
   - "Карачаево-Черкесия" → "Черкесск"
   - "Адыгея" → "Майкоп"
   - "Ингушетия" → "Магас"
   - "Северная Осетия" → "Владикавказ"
   - "Чечня" → "Грозный"
   - "Дагестан" → "Махачкала"
   - "Калмыкия" → "Элиста"
   - "Крым" → "Симферополь"
   - "Алтайский край" → "Барнаул"
   - "Краснодарский край" → "Краснодар"
   - "Ставропольский край" → "Ставрополь"
4. Если город не указан и не определяется — верни null.
5. Удаляй технические слова: "городской округ", "муниципальный округ", "район", "поселок", "село" и т.п.

ПРИМЕРЫ:
- "Сочи, Курортный проспект" → { city: "Сочи", region: null, confidence: 1.0 }
- "г Москва" → { city: "Москва", region: null, confidence: 1.0 }
- "г.о. Красногорск, пос. Нахабино" → { city: "Красногорск", region: null, confidence: 0.9 }
- "Телецкое озеро" → { city: "Горно-Алтайск", region: "Республика Алтай", confidence: 0.9 }
- "Курайская степь" → { city: "Горно-Алтайск", region: "Республика Алтай", confidence: 0.8 }
- "Навалищенское ущелье" → { city: "Сочи", region: "Краснодарский край", confidence: 0.8 }
- "Голубые озёра" → { city: "Нальчик", region: "Кабардино-Балкария", confidence: 0.7 }
- "ЦУМ" → { city: null, region: null, confidence: 0 } (не адрес)
- "Самолет" → { city: null, region: null, confidence: 0 } (не адрес)

ФОРМАТ ОТВЕТА:
Верни ТОЛЬКО JSON объект без markdown:
{
  "city": string | null,
  "region": string | null,
  "confidence": number (0-1),
  "comment": string (краткое пояснение)
}

ТЕКСТ ДЛЯ АНАЛИЗА:
`;

  constructor(private readonly redisService: RedisService) {
    this.redisAvailable = redisService.isAvailable;
  }

  async onModuleInit() {
    const provider =
      process.env.AI_PROVIDER?.trim().toLowerCase() || 'openrouter';
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const legacyOpenAiKey = process.env.OPENAI_API_KEY?.trim();
    const normalizedKey =
      apiKey ||
      (legacyOpenAiKey?.startsWith('sk-or-') ? legacyOpenAiKey : undefined);

    if (provider === 'openrouter' && normalizedKey) {
      const baseURL =
        process.env.OPENROUTER_BASE_URL?.trim() ||
        'https://openrouter.ai/api/v1';

      this.openai = new OpenAI({
        apiKey: normalizedKey,
        baseURL,
        defaultHeaders: {
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL?.trim() || undefined,
          'X-Title': process.env.OPENROUTER_APP_NAME?.trim() || undefined,
        },
      });

      this.logger.log('✅ CityExtractionService: OpenRouter initialized');
    } else {
      this.logger.warn(
        '⚠️  CityExtractionService: OPENROUTER_API_KEY not set, service unavailable',
      );
    }
  }

  /**
   * Извлекает город из текста с кэшированием в Redis
   */
  async extractCity(input: string): Promise<CityExtractionResult | null> {
    if (!input || input.trim().length < 2) {
      return null;
    }

    const normalizedInput = input.trim();
    const cacheKey = `city:extract:${this.hash(normalizedInput)}`;

    // Пробуем кэш
    if (this.redisAvailable) {
      try {
        const cached = await this.redisService.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          this.logger.debug(
            `🗃️  City cache HIT: "${normalizedInput}" → ${parsed.city}`,
          );
          return parsed;
        }
      } catch (error) {
        this.logger.warn(`Cache read error: ${error}`);
      }
    }

    // Запрос к GPT
    const result = await this.callGPT(normalizedInput);

    // Сохраняем в кэш
    if (result && this.redisAvailable) {
      try {
        await this.redisService.set(
          cacheKey,
          JSON.stringify(result),
          this.CACHE_TTL_SECONDS,
        );
        this.logger.debug(
          `💾 Cached: "${normalizedInput}" → ${result.city || 'null'}`,
        );
      } catch (error) {
        this.logger.warn(`Cache write error: ${error}`);
      }
    }

    return result;
  }

  /**
   * Вызов GPT-4o-mini для извлечения города
   */
  private async callGPT(input: string): Promise<CityExtractionResult | null> {
    if (!this.openai) {
      this.logger.warn('OpenAI client not available');
      return null;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: 'openai/gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'Ты извлекаешь названия городов из адресов. Возвращай ТОЛЬКО валидный JSON без markdown.',
          },
          {
            role: 'user',
            content: this.CITY_EXTRACTION_PROMPT + input,
          },
        ],
        temperature: 0.1,
        max_tokens: 250,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        return {
          city: null,
          region: null,
          confidence: 0,
          comment: 'Empty response',
        };
      }

      // Пытаемся распарсить JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn(`Failed to parse JSON from: ${content}`);
        return {
          city: null,
          region: null,
          confidence: 0,
          comment: 'Invalid JSON',
        };
      }

      const result = JSON.parse(jsonMatch[0]);
      return {
        city: result.city ?? null,
        region: result.region ?? null,
        confidence: result.confidence ?? 0,
        comment: result.comment ?? '',
      };
    } catch (error) {
      this.logger.error(`GPT request failed: ${error}`);
      return null;
    }
  }

  /**
   * Хэш для ключа кэша
   */
  private hash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Очистка кэша (для тестов)
   */
  async clearCache(): Promise<void> {
    if (!this.redisAvailable) return;

    try {
      const keys = (await this.redisService.executeCommand(
        'KEYS',
        'city:extract:*',
      )) as string[];
      if (keys && keys.length > 0) {
        await this.redisService.executeCommand('DEL', ...keys);
        this.logger.log(`🗑️  Cleared ${keys.length} cache entries`);
      }
    } catch (error) {
      this.logger.warn(`Cache clear error: ${error}`);
    }
  }

  /**
   * Статистика кэша
   */
  async getCacheStats(): Promise<{ keys: number; available: boolean }> {
    if (!this.redisAvailable) {
      return { keys: 0, available: false };
    }

    try {
      const keys = (await this.redisService.executeCommand(
        'KEYS',
        'city:extract:*',
      )) as string[];
      return { keys: keys?.length ?? 0, available: true };
    } catch {
      return { keys: 0, available: true };
    }
  }
}

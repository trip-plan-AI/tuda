import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';
import { RedisService } from '../redis/redis.service';
import { CityExtractionService } from './city-extraction.service';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, join, resolve } from 'node:path';

type PixabayHit = {
  largeImageURL?: string;
  webformatURL?: string;
  previewURL?: string;
};

type PixabayResponse = {
  hits?: PixabayHit[];
};

type GoogleSearchResponse = {
  items?: Array<{ link: string }>;
};

const LOCAL_IMAGE_EXTENSIONS = ['webp', 'avif', 'jpg', 'jpeg', 'png'];
const LOCK_TTL_MS = 15_000;
const MAX_DOWNLOAD_SIZE_BYTES = 8 * 1024 * 1024;

@Injectable()
export class TripImageService implements OnModuleInit {
  private readonly logger = new Logger(TripImageService.name);
  private imagesDir = '';
  private pixabayAvailable = false;
  private googleAvailable = false;

  constructor(
    @Inject(DRIZZLE)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly redisService: RedisService,
    private readonly cityExtractionService: CityExtractionService,
  ) {}

  async onModuleInit() {
    this.imagesDir = await this.resolveImagesDir();
    await fs.mkdir(this.imagesDir, { recursive: true });

    // Проверка доступности API ключей
    this.pixabayAvailable = !!process.env.PIXABAY_API_KEY;
    this.googleAvailable =
      !!process.env.GOOGLE_API_KEY && !!process.env.GOOGLE_SEARCH_CX;

    if (!this.googleAvailable) {
      this.logger.warn('⚠️  GOOGLE_API_KEY or GOOGLE_SEARCH_CX not set');
    } else {
      this.logger.log('✅ Google Custom Search API configured');
    }

    if (!this.pixabayAvailable) {
      this.logger.warn(
        '⚠️  PIXABAY_API_KEY not set — fallback will be unavailable',
      );
    } else {
      this.logger.log('✅ Pixabay API configured');
    }
  }

  async resolveTripCover(tripId: string): Promise<void> {
    const unlock = await this.acquireLock(tripId);
    if (!unlock) {
      this.logger.debug(`[${tripId}] lock not acquired — skipping`);
      return;
    }

    try {
      const trip = await this.db.query.trips.findFirst({
        where: eq(schema.trips.id, tripId),
      });
      if (!trip) {
        this.logger.warn(`[${tripId}] trip not found`);
        return;
      }

      const points = await this.db.query.routePoints.findMany({
        where: eq(schema.routePoints.tripId, tripId),
        orderBy: [asc(schema.routePoints.order)],
        columns: {
          id: true,
          order: true,
          lat: true,
          lon: true,
          title: true,
          address: true,
        },
      });
      if (points.length === 0) {
        this.logger.debug(`[${tripId}] no points — skip`);
        return;
      }

      const selectedPoint = this.pickPoint(points, tripId);
      if (!selectedPoint) return;

      this.logger.debug(
        `[${tripId}] selected point: "${selectedPoint.title}" (address="${selectedPoint.address}", lat=${selectedPoint.lat}, lon=${selectedPoint.lon})`,
      );

      // ============================================
      // КОНТУР 1: Reverse Geocoding по координатам
      // ============================================
      let cityForSearch: string | null = null;

      try {
        // Примитивный reverse geocoding через Nominatim
        const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${selectedPoint.lat}&lon=${selectedPoint.lon}&zoom=10&accept-language=ru`;
        const response = await fetch(nominatimUrl, {
          headers: { 'User-Agent': 'TravelPlanner/1.0' },
        });

        if (response.ok) {
          const data = await response.json();
          const addr = data?.address;
          // Каскад: city → town → village → state_district
          cityForSearch =
            addr?.city ||
            addr?.town ||
            addr?.village ||
            addr?.state_district ||
            addr?.county ||
            null;

          if (cityForSearch) {
            this.logger.debug(
              `[${tripId}] Reverse geocoding success: ${cityForSearch}`,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `[${tripId}] Reverse geocoding failed: ${error}, trying GPT fallback`,
        );
      }

      // ============================================
      // КОНТУР 2: GPT-4o-mini (fallback)
      // ============================================
      if (!cityForSearch) {
        const input = selectedPoint.title || selectedPoint.address || '';
        if (input) {
          this.logger.debug(
            `[${tripId}] Reverse geocoding failed, trying GPT with: "${input}"`,
          );

          const gptResult = await this.cityExtractionService.extractCity(input);
          if (gptResult?.city) {
            cityForSearch = gptResult.city;
            this.logger.log(
              `[${tripId}] ✅ GPT extracted city: ${cityForSearch} (region: ${gptResult.region || 'N/A'}, confidence: ${(gptResult.confidence * 100).toFixed(0)}%)`,
            );
          } else {
            this.logger.warn(
              `[${tripId}] ❌ GPT failed to extract city (input: "${input}")`,
            );
          }
        }
      }

      if (!cityForSearch) {
        this.logger.warn(
          `[${tripId}] No city found via reverse geocoding or GPT`,
        );
        return;
      }

      // Для поиска API используем оригинальное название (без транслитерации)
      const cleanedCity = this.cleanCityName(cityForSearch);
      // Для имени файла используем транслитерированный slug
      const slug = this.toSlug(cleanedCity);

      this.logger.debug(
        `[${tripId}] city="${cityForSearch}" cleaned="${cleanedCity}" slug="${slug}"`,
      );
      if (!slug) return;

      const localPath = await this.findLocalImage(slug);
      if (localPath) {
        this.logger.debug(`[${tripId}] local image found: ${localPath}`);
        await this.updateTripImageIfChanged(tripId, localPath);
        return;
      }

      this.logger.debug(`[${tripId}] no local image, querying APIs`);

      let downloaded: string | null = null;

      if (this.googleAvailable) {
        downloaded = await this.downloadFromGoogle(slug, cleanedCity);
        if (downloaded) {
          this.logger.log(
            `📸  [${tripId}] Image found via Google: ${downloaded}`,
          );
          await this.updateTripImageIfChanged(tripId, downloaded);
          return;
        }
      }

      if (this.pixabayAvailable) {
        this.logger.debug(`[${tripId}] Trying Pixabay fallback`);
        downloaded = await this.downloadFromPixabay(slug, cleanedCity);
        if (downloaded) {
          this.logger.log(
            `📸  [${tripId}] Image found via Pixabay: ${downloaded}`,
          );
          await this.updateTripImageIfChanged(tripId, downloaded);
          return;
        }
      }

      this.logger.warn(
        `🚫  [${tripId}] No image sources available or all failed for "${cleanedCity}"`,
      );
    } finally {
      await unlock();
    }
  }

  private pickPoint(
    points: Array<{
      id: string;
      order: number;
      lat: number;
      lon: number;
      title: string | null;
      address: string | null;
    }>,
    tripId: string,
  ): {
    id: string;
    order: number;
    lat: number;
    lon: number;
    title: string | null;
    address: string | null;
  } | null {
    if (points.length === 1) {
      return points[0] ?? null;
    }

    // При >1 точках исключаем первую (индекс 0) и выбираем детерминированно.
    const hash = createHash('sha256').update(tripId).digest();
    const seed = hash.readUInt32BE(0);
    const index = 1 + (seed % (points.length - 1));
    return points[index] ?? points[1] ?? null;
  }

  private cleanCityName(city: string): string {
    if (!city) return city;

    let cleaned = city.trim();

    // Удаляем "технические" слова Nominatim (округа, районы)
    const cleanPatterns = [
      /городской\s+округ\s+/gi,
      /муниципальный\s+округ\s+/gi,
      /административный\s+округ\s+/gi,
      /городской\s+округ$/gi,
      /муниципальный\s+округ$/gi,
      /административный\s+округ$/gi,
      /\s+район$/gi, // "Чегемский район" → "Чегемский"
      /^район\s+/gi, // "район Сочи" → "Сочи"
      /\s+город$/gi, // "Москва город" → "Москва"
      /^город\s+/gi, // "город Москва" → "Москва"
    ];

    for (const pattern of cleanPatterns) {
      cleaned = cleaned.replace(pattern, '').trim();
    }

    return cleaned;
  }

  private toSlug(value: string): string {
    // Полная карта транслитерации кириллицы в латиницу
    // Обрабатывает все русские буквы перед удалением спецсимволов
    const translitMap: Record<string, string> = {
      а: 'a',
      б: 'b',
      в: 'v',
      г: 'g',
      д: 'd',
      е: 'e',
      ё: 'e',
      ж: 'zh',
      з: 'z',
      и: 'i',
      й: 'y',
      к: 'k',
      л: 'l',
      м: 'm',
      н: 'n',
      о: 'o',
      п: 'p',
      р: 'r',
      с: 's',
      т: 't',
      у: 'u',
      ф: 'f',
      х: 'kh',
      ц: 'ts',
      ч: 'ch',
      ш: 'sh',
      щ: 'shch',
      ъ: '',
      ы: 'y',
      ь: '',
      э: 'e',
      ю: 'yu',
      я: 'ya',
    };

    // Порядок: lowercase → нормализация → транслитерация → очистка спецсимволов
    const normalized = value
      .toLowerCase()
      .normalize('NFKD')
      .split('')
      .map((ch) => translitMap[ch] ?? ch)
      .join('')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    return normalized;
  }

  private async findLocalImage(slug: string): Promise<string | null> {
    for (const ext of LOCAL_IMAGE_EXTENSIONS) {
      const filename = `${slug}.${ext}`;
      const absolutePath = join(this.imagesDir, filename);

      try {
        await fs.access(absolutePath);
        return `/assets/images/${filename}`;
      } catch {
        // Переходим к следующему расширению.
      }
    }

    return null;
  }

  private async downloadFromGoogle(
    slug: string,
    city: string,
  ): Promise<string | null> {
    if (!this.googleAvailable) {
      return null;
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    const cx = process.env.GOOGLE_SEARCH_CX;

    if (!apiKey || !cx) {
      this.logger.error('Google API key not available at runtime');
      return null;
    }

    // Google лучше работает с латиницей + английский запрос
    const query = `beautiful cityscape of ${slug}`;

    // Построение URL с корректным кодированием
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', query);
    url.searchParams.set('searchType', 'image');
    url.searchParams.set('num', '1');
    url.searchParams.set('imgSize', 'large');
    url.searchParams.set('imgType', 'photo');

    this.logger.log(`🔍  Searching Google: "${query}"`);

    // Лог URL со скрытым ключом для отладки
    const debugUrl = url.toString().replace(apiKey, '***');
    this.logger.debug(`   Request URL: ${debugUrl}`);

    let response: GoogleSearchResponse | null = null;
    try {
      response = await this.fetchWithRetry<GoogleSearchResponse>(
        url.toString(),
        { timeoutMs: 6000, retries: 1 },
        'Google',
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
      );
    } catch (error) {
      this.logger.error(`Google request failed: ${String(error)}`);
      return null;
    }

    const imageUrl = response?.items?.[0]?.link;
    if (!imageUrl) {
      this.logger.warn(`❌  Google: No image found for "${slug}"`);
      return null;
    }

    this.logger.log(`🖼️   Google: ${imageUrl}`);

    const parsedUrl = this.safeHttpsUrl(imageUrl);
    if (!parsedUrl) return null;

    return this.saveRemoteImage(parsedUrl, slug, 'Google');
  }

  private async downloadFromPixabay(
    slug: string,
    city: string,
  ): Promise<string | null> {
    if (!this.pixabayAvailable) {
      return null;
    }

    const apiKey = process.env.PIXABAY_API_KEY;
    if (!apiKey) {
      this.logger.error('Pixabay API key not available at runtime');
      return null;
    }

    // Pixabay требует латиницу, используем slug
    // per_page мин=3, макс=100
    const query = `beautiful cityscape ${slug}`;
    const params = new URLSearchParams({
      key: apiKey,
      q: query,
      image_type: 'photo',
      safesearch: 'true',
      orientation: 'horizontal',
      order: 'popular',
      per_page: '3', // Минимальное значение для Pixabay
    });

    const pixabayUrl = `https://pixabay.com/api/?${params.toString()}`;
    this.logger.log(`🔍  Searching Pixabay: "${query}"`);
    this.logger.debug(`   Pixabay URL: ${pixabayUrl.replace(apiKey, '***')}`);
    this.logger.debug(
      `   Headers: User-Agent=Mozilla/5.0..., Accept=application/json, Referer=pixabay.com`,
    );

    let response: PixabayResponse | null = null;
    try {
      response = await this.fetchWithRetry<PixabayResponse>(
        pixabayUrl,
        { timeoutMs: 6000, retries: 1 },
        'Pixabay',
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json',
            Referer: 'https://pixabay.com/',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
      );
    } catch (error) {
      this.logger.error(`Pixabay request failed: ${error}`);
      return null;
    }

    const imageUrl =
      response?.hits?.[0]?.largeImageURL ?? response?.hits?.[0]?.webformatURL;
    if (!imageUrl) {
      this.logger.warn(`❌  Pixabay: No image found for "${city}"`);
      return null;
    }

    this.logger.log(`🖼️   Pixabay: ${imageUrl}`);

    const parsedUrl = this.safeHttpsUrl(imageUrl);
    if (!parsedUrl) return null;

    return this.saveRemoteImage(parsedUrl, slug, 'Pixabay');
  }

  private async saveRemoteImage(
    url: URL,
    slug: string,
    provider: string,
  ): Promise<string | null> {
    const fileExtension = this.detectFileExtension(url);
    const filename = `${slug}.${fileExtension}`;
    const finalPath = join(this.imagesDir, filename);

    try {
      await fs.access(finalPath);
      return `/assets/images/${filename}`;
    } catch {
      // Файл отсутствует, продолжаем скачивание.
    }

    const temporaryPath = `${finalPath}.${Date.now()}.tmp`;

    const download = await this.fetchBinary(url, 8000);
    if (!download) return null;

    if (!download.contentType.startsWith('image/')) {
      this.logger.warn(`${provider} mime rejected: ${download.contentType}`);
      return null;
    }

    if (download.buffer.length > MAX_DOWNLOAD_SIZE_BYTES) {
      this.logger.warn(
        `${provider} file too large: ${download.buffer.length} bytes for ${slug}`,
      );
      return null;
    }

    await fs.writeFile(temporaryPath, download.buffer);
    try {
      await fs.rename(temporaryPath, finalPath);
    } catch {
      await fs.unlink(temporaryPath).catch(() => {
        // ignore cleanup errors
      });

      try {
        await fs.access(finalPath);
        return `/assets/images/${filename}`;
      } catch {
        return null;
      }
    }

    return `/assets/images/${filename}`;
  }

  private async updateTripImageIfChanged(
    tripId: string,
    imagePath: string,
  ): Promise<void> {
    const current = await this.db.query.trips.findFirst({
      where: eq(schema.trips.id, tripId),
      columns: { img: true },
    });

    if (!current) return;
    if (current.img === imagePath) return;

    await this.db
      .update(schema.trips)
      .set({ img: imagePath, updatedAt: new Date() })
      .where(eq(schema.trips.id, tripId));
  }

  private async resolveImagesDir(): Promise<string> {
    const candidates = [
      resolve(process.cwd(), 'apps', 'web', 'public', 'assets', 'images'),
      resolve(process.cwd(), '..', 'web', 'public', 'assets', 'images'),
      resolve(__dirname, '..', '..', '..', 'web', 'public', 'assets', 'images'),
    ];

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Пробуем следующий вариант.
      }
    }

    return candidates[0];
  }

  private safeHttpsUrl(raw: string): URL | null {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private detectFileExtension(url: URL): string {
    const fromPath = extname(url.pathname).replace('.', '').toLowerCase();
    if (LOCAL_IMAGE_EXTENSIONS.includes(fromPath)) {
      return fromPath;
    }
    return 'jpg';
  }

  private async fetchWithRetry<T>(
    url: string,
    options: { timeoutMs: number; retries: number },
    provider = 'API',
    fetchOptions?: { headers?: Record<string, string> },
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: fetchOptions?.headers,
        });

        if (res.status === 429) {
          this.logger.warn(`${provider} rate limited (429), skipping`);
          return null;
        }

        if (res.status === 403) {
          const errorBody = await res.text().catch(() => '');
          this.logger.error(
            `${provider} forbidden (403): ${errorBody.slice(0, 200)}`,
          );
          return null;
        }

        if (res.status >= 500) {
          if (attempt < options.retries) continue;
          return null;
        }

        if (!res.ok) {
          this.logger.warn(`${provider} responded with status ${res.status}`);
          return null;
        }

        return (await res.json()) as T;
      } catch (error) {
        if (attempt >= options.retries) {
          this.logger.warn(`${provider} request failed: ${String(error)}`);
          return null;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    return null;
  }

  private async fetchBinary(
    url: URL,
    timeoutMs: number,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url.toString(), { signal: controller.signal });
      if (!res.ok) return null;

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const contentLength = Number(res.headers.get('content-length') ?? '0');
      if (contentLength > MAX_DOWNLOAD_SIZE_BYTES) return null;

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return { buffer, contentType };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async acquireLock(
    tripId: string,
  ): Promise<(() => Promise<void>) | null> {
    if (!this.redisService.isAvailable) {
      return async () => Promise.resolve();
    }

    const key = `trip-image:${tripId}`;
    const token = randomUUID();

    try {
      const result = await this.redisService.executeCommand(
        'SET',
        key,
        token,
        'NX',
        'PX',
        LOCK_TTL_MS,
      );

      if (result !== 'OK') {
        return null;
      }
    } catch {
      return null;
    }

    return async () => {
      try {
        await this.redisService.executeCommand(
          'EVAL',
          'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
          1,
          key,
          token,
        );
      } catch {
        // ignore unlock errors
      }
    };
  }
}

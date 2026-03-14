import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';
import { GeosearchService } from '../geosearch/geosearch.service';
import { RedisService } from '../redis/redis.service';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, join, resolve } from 'node:path';

type ReverseAddress = {
  city?: string;
  town?: string;
  village?: string;
  settlement?: string;
  suburb?: string;
  state_district?: string;
  state?: string;
};

type ReverseResult = {
  address?: ReverseAddress;
  title?: string;
  displayName?: string;
};

type PixabayHit = {
  largeImageURL?: string;
  webformatURL?: string;
  previewURL?: string;
};

type PixabayResponse = {
  hits?: PixabayHit[];
};

const LOCAL_IMAGE_EXTENSIONS = ['webp', 'avif', 'jpg', 'jpeg', 'png'];
const LOCK_TTL_MS = 15_000;
const MAX_DOWNLOAD_SIZE_BYTES = 8 * 1024 * 1024;

@Injectable()
export class TripImageService implements OnModuleInit {
  private readonly logger = new Logger(TripImageService.name);
  private imagesDir = '';

  constructor(
    @Inject(DRIZZLE)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly geosearchService: GeosearchService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit() {
    this.imagesDir = await this.resolveImagesDir();
    await fs.mkdir(this.imagesDir, { recursive: true });
  }

  async resolveTripCover(tripId: string): Promise<void> {
    const unlock = await this.acquireLock(tripId);
    if (!unlock) return;

    try {
      const trip = await this.db.query.trips.findFirst({
        where: eq(schema.trips.id, tripId),
      });
      if (!trip) return;

      const points = await this.db.query.routePoints.findMany({
        where: eq(schema.routePoints.tripId, tripId),
        orderBy: [asc(schema.routePoints.order)],
      });
      if (points.length === 0) return;

      const selectedPoint = this.pickPoint(points, tripId);
      if (!selectedPoint) return;

      const reverse = (await this.geosearchService.reverse(
        selectedPoint.lat,
        selectedPoint.lon,
      )) as ReverseResult | null;

      const city = this.extractCity(reverse);
      if (!city) return;

      const slug = this.toSlug(city);
      if (!slug) return;

      const localPath = await this.findLocalImage(slug);
      if (localPath) {
        await this.updateTripImageIfChanged(tripId, localPath);
        return;
      }

      const downloaded = await this.downloadFromPixabay(slug, city);
      if (downloaded) {
        await this.updateTripImageIfChanged(tripId, downloaded);
      }
    } finally {
      await unlock();
    }
  }

  private pickPoint(
    points: Array<{ id: string; order: number; lat: number; lon: number }>,
    tripId: string,
  ): { id: string; order: number; lat: number; lon: number } | null {
    if (points.length === 1) {
      return points[0] ?? null;
    }

    // При >1 точках исключаем первую (индекс 0) и выбираем детерминированно.
    const hash = createHash('sha256').update(tripId).digest();
    const seed = hash.readUInt32BE(0);
    const index = 1 + (seed % (points.length - 1));
    return points[index] ?? points[1] ?? null;
  }

  private extractCity(reverse: ReverseResult | null): string | null {
    const addr = reverse?.address;
    if (!addr) {
      const fallbackText = reverse?.title ?? reverse?.displayName;
      if (!fallbackText) return null;
      const firstToken = fallbackText.split(',')[0]?.trim() ?? '';
      return firstToken || null;
    }

    return (
      addr.city ??
      addr.town ??
      addr.village ??
      addr.settlement ??
      addr.suburb ??
      addr.state_district ??
      addr.state ??
      null
    );
  }

  private toSlug(value: string): string {
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

  private async downloadFromPixabay(
    slug: string,
    city: string,
  ): Promise<string | null> {
    const apiKey = process.env.PIXABAY_API_KEY;
    if (!apiKey) {
      this.logger.warn('PIXABAY_API_KEY is not set, skip Pixabay fallback');
      return null;
    }

    const params = new URLSearchParams({
      key: apiKey,
      q: slug || city,
      image_type: 'photo',
      safesearch: 'true',
      per_page: '10',
      orientation: 'horizontal',
    });

    const response = await this.fetchWithRetry<PixabayResponse>(
      `https://pixabay.com/api/?${params.toString()}`,
      { timeoutMs: 5000, retries: 2 },
    );

    const hit = response?.hits?.[0];
    const imageUrl = hit?.largeImageURL ?? hit?.webformatURL ?? hit?.previewURL;
    if (!imageUrl) return null;

    const parsedUrl = this.safeHttpsUrl(imageUrl);
    if (!parsedUrl) return null;

    const fileExtension = this.detectFileExtension(parsedUrl);
    const filename = `${slug}.${fileExtension}`;
    const finalPath = join(this.imagesDir, filename);

    try {
      await fs.access(finalPath);
      return `/assets/images/${filename}`;
    } catch {
      // Файл отсутствует, продолжаем скачивание.
    }

    const temporaryPath = `${finalPath}.${Date.now()}.tmp`;

    const download = await this.fetchBinary(parsedUrl, 8000);
    if (!download) return null;

    if (!download.contentType.startsWith('image/')) {
      this.logger.warn(`Pixabay mime rejected: ${download.contentType}`);
      return null;
    }

    if (download.buffer.length > MAX_DOWNLOAD_SIZE_BYTES) {
      this.logger.warn(
        `Pixabay file too large: ${download.buffer.length} bytes for ${slug}`,
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
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

      try {
        const res = await fetch(url, { signal: controller.signal });

        if (res.status === 429) {
          this.logger.warn('Pixabay rate limited (429), fallback skipped');
          return null;
        }

        if (res.status >= 500) {
          if (attempt < options.retries) continue;
          return null;
        }

        if (!res.ok) {
          return null;
        }

        return (await res.json()) as T;
      } catch (error) {
        if (attempt >= options.retries) {
          this.logger.warn(`Pixabay request failed: ${String(error)}`);
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

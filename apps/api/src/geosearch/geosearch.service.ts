/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PopularDestinationsService } from './popular-destinations.service';

interface NominatimItem {
  display_name: string;
  lon: number;
  lat: number;
  class: string;
  type: string;
  importance?: number;
}

type RouteProvider =
  | 'locationiq'
  | 'geoapify'
  | 'openrouteservice'
  | 'project_osrm';

interface RoutePoint {
  lon: number;
  lat: number;
}

interface ProviderWindowLimit {
  maxRequests: number;
  windowMs: number;
}

// Классы Nominatim которые исключаем в RU-поиске (только geographic)
const NOMINATIM_GEO_EXCLUDED = new Set([
  'amenity',
  'building',
  'shop',
  'office',
  'craft',
]);

/**
 * Нормализует для нечёткого сравнения:
 * ё→е (часто не ставят точки), э→е (иностранные названия: Лэнд→Ленд, Питерлэнд→Питерленд)
 */
function yo(s: string): string {
  return s.replace(/[ёэ]/g, 'е').replace(/[ЁЭ]/g, 'Е');
}

/**
 * Расстояние Левенштейна между двумя строками.
 * Early-exit если разница длин > maxDist — ускоряет фильтрацию.
 */
function levenshtein(a: string, b: string, maxDist: number): number {
  if (Math.abs(a.length - b.length) > maxDist) return 99;
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] ?? 0)
          : 1 + Math.min(prev[j] ?? 99, curr[j - 1] ?? 99, prev[j - 1] ?? 99);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length] ?? 99;
}

/**
 * Проверяет вхождение слова в текст с учётом опечаток:
 * - точное includes (быстрый путь)
 * - для слов ≥ 4 символов: Левенштейн ≤ 1 (строго — чтобы не было ложных срабатываний)
 */
function fuzzyIncludes(text: string, word: string): boolean {
  if (text.includes(word)) return true;
  if (word.length < 4) return false;
  const tokens = text
    .split(/[\s,«»"'.;()/\\-]+/)
    .filter((t) => Math.abs(t.length - word.length) <= 1);
  return tokens.some((t) => levenshtein(t, word, 1) <= 1);
}

/**
 * Приводит адрес к формату "Улица, дом, город".
 * Nominatim иногда возвращает "8 к1, Купчинская улица, ..." — переставляем.
 */
function normalizeAddress(displayName: string): string {
  const [first, second, ...rest] = displayName.split(',').map((p) => p.trim());
  if (!first || !second) return displayName;

  // Если первый сегмент — это номер дома (начинается с цифры),
  // а второй — улица (содержит буквы) — переставляем
  if (/^\d/.test(first) && /[а-яА-Яa-zA-Z]/.test(second)) {
    return [`${second}, ${first}`, ...rest].join(', ');
  }
  return displayName;
}

@Injectable()
export class GeosearchService {
  constructor(
    private readonly redis: RedisService,
    private readonly popularDestinations: PopularDestinationsService,
  ) {}

  private readonly providerWindowLimits: Partial<
    Record<RouteProvider, ProviderWindowLimit>
  > = {
    locationiq: { maxRequests: 2, windowMs: 1000 },
    geoapify: { maxRequests: 5, windowMs: 1000 },
    openrouteservice: { maxRequests: 40, windowMs: 60_000 },
  };

  private readonly providerRequestTimestamps: Partial<
    Record<RouteProvider, number[]>
  > = {};

  private get dadataApiKey() {
    return process.env.DADATA_API_KEY;
  }

  private get yandexSuggestApiKey() {
    return process.env.YANDEX_GEOSUGGEST_API_KEY;
  }

  async suggest(query: string, userLat?: number, userLon?: number) {
    return this.suggestInternal(query, userLat, userLon);
  }

  async suggestWithBias(query: string, biasLat: number, biasLon: number) {
    return this.suggestInternal(query, biasLat, biasLon);
  }

  async suggestWithBbox(
    query: string,
    bbox: string,
    userLat?: number,
    userLon?: number,
  ) {
    const results = await this.suggestInternalWithBbox(
      query,
      bbox,
      userLat,
      userLon,
    );

    // TRI-115: Hard validation after geocoding
    const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number);
    const centerLat = (minLat + maxLat) / 2;
    const centerLon = (minLon + maxLon) / 2;

    return results.filter((item) => {
      const isInside =
        item.lat >= minLat - 0.05 &&
        item.lat <= maxLat + 0.05 &&
        item.lon >= minLon - 0.05 &&
        item.lon <= maxLon + 0.05;

      if (!isInside) return false;

      // Distance sanity check: max 50km from center (to avoid jumping to other cities in same region)
      const d = this.distInKm(item.lat, item.lon, centerLat, centerLon);
      return d < 50;
    });
  }

  private distInKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private async suggestInternalWithBbox(
    query: string,
    bbox: string,
    userLat?: number,
    userLon?: number,
  ) {
    const normalized = query.trim();
    if (normalized.length < 2) return [];

    const isCis = /[а-яА-ЯёЁ]/.test(normalized);

    // Tier 1: Redis cache (TTL 7 дней)
    const cacheKey = `geo:suggest:bbox:${normalized.toLowerCase()}:${bbox}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached).map((item: any) => {
        // TRI-115: Fix potentially broken coordinates (null, 0, undefined, NaN)
        const latVal = Number(item.lat);
        const lonVal = Number(item.lon);
        const isInvalid =
          !item.lat ||
          !item.lon ||
          isNaN(latVal) ||
          isNaN(lonVal) ||
          (Math.abs(latVal) < 0.001 && Math.abs(lonVal) < 0.001);

        if (isInvalid) {
          const match = item.uri?.match(/ll=([^&]+)/);
          if (match) {
            const raw = decodeURIComponent(match[1]);
            const [lon, lat] = raw.split(',').map(Number);
            if (
              !isNaN(lon) &&
              !isNaN(lat) &&
              (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001)
            ) {
              return { ...item, lat, lon };
            }
          }
        }
        return item;
      });
      return this.applyProximity(parsed, userLat, userLon);
    }

    // Tier 0 (DB) + Tier 2: DaData (RU) + Yandex + Nominatim WW with bbox, parallel, timeout 800ms
    const [tier0Res, dadataRes, yandexRes, nominatimBboxRes] =
      await Promise.allSettled([
        this.withTimeout(this.popularDestinations.search(normalized), 800),
        this.dadataApiKey
          ? this.withTimeout(this.getDaDataSuggestions(normalized), 800)
          : Promise.resolve(null),
        this.yandexSuggestApiKey
          ? this.withTimeout(
              this.getYandexSuggestions(normalized, userLat, userLon),
              800,
            )
          : Promise.resolve(null),
        !isCis
          ? this.withTimeout(
              this.getNominatimSuggestionsWithBbox(
                normalized,
                bbox,
                'ru,en',
                false,
              ),
              800,
            )
          : Promise.resolve(null),
      ]);

    const tier0Items =
      tier0Res.status === 'fulfilled' ? (tier0Res.value ?? []) : [];
    const dadataItems =
      dadataRes.status === 'fulfilled' ? (dadataRes.value ?? []) : [];
    const yandexItems =
      yandexRes.status === 'fulfilled' ? (yandexRes.value ?? []) : [];
    const nominatimBboxItems =
      nominatimBboxRes.status === 'fulfilled'
        ? (nominatimBboxRes.value ?? [])
        : [];

    // Score сначала — чтобы dedup оставлял наиболее релевантный результат в ячейке
    const allScored = [
      ...tier0Items,
      ...dadataItems,
      ...yandexItems,
      ...nominatimBboxItems,
    ]
      .map((item) => {
        if (
          'score' in item &&
          typeof (item as any).score === 'number' &&
          isFinite((item as any).score)
        ) {
          return item as any;
        }
        return {
          ...item,
          score:
            this.scoreResult(item.displayName, normalized) +
            ((item as any).source === 'yandex' ? 10 : 0),
        };
      })
      .sort((a, b) => b.score - a.score);

    // Dedup pass 1: координаты (0.002° ≈ 200м) — highest-scored в ячейке
    const seenCoords = new Set<string>();
    const coordDeduped = allScored.filter((item) => {
      let lat = Number(item.lat);
      let lon = Number(item.lon);
      if (!lat || !lon || (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001)) {
        const match = item.uri?.match(/ll=([^&]+)/);
        if (match) {
          const coords = decodeURIComponent(match[1]).split(',').map(Number);
          lon = coords[0];
          lat = coords[1];
        }
      }
      if (isNaN(lon) || isNaN(lat)) return true;
      if (Math.abs(lon) < 0.001 && Math.abs(lat) < 0.001) return true;
      // Используем множитель 500 для ячейки ~200м, чтобы не удалять разные объекты рядом
      const key = `${Math.round(lon * 500)},${Math.round(lat * 500)}`;
      if (seenCoords.has(key)) return false;
      seenCoords.add(key);
      return true;
    });

    // Dedup pass 2: имя
    // Для бизнесов ключ = название (без типа — "Кафе"/"Магазин") + адрес
    // Яндекс использует · (U+00B7), не • (U+2022)
    const seenName = new Set<string>();
    const scored = coordDeduped
      .filter((item) => {
        let coreName = item.displayName;
        if (item.isBusiness && coreName.includes('·')) {
          const parts = coreName.split('·');
          const left = parts[0].trim(); // "Джаганнат, Кафе"
          const right = parts.slice(1).join('·').trim(); // "Москва, улица Кузнецкий Мост, 11с1"
          // берём только название (до первой запятой), игнорируем тип заведения
          const name = left.split(',')[0].trim(); // "Джаганнат"
          coreName = name + ' · ' + right;
        } else if (!item.isBusiness) {
          coreName = coreName.split(',')[0];
        }

        const nameKey = yo(coreName.trim().toLowerCase());
        if (!nameKey) return true;
        if (seenName.has(nameKey)) return false;
        seenName.add(nameKey);
        return true;
      })
      .slice(0, 10);

    if (scored.length > 0 && scored[0].score >= 2) {
      const filtered = scored.filter((item) => {
        const match = item.uri?.match(/ll=([^&]+)/);
        if (match) {
          const raw = decodeURIComponent(match[1]);
          const [lon, lat] = raw.split(',').map(Number);
          if (lat === 0 && lon === 0) return false;
        }
        return true;
      });

      if (filtered.length > 0) {
        await this.redis.set(
          cacheKey,
          JSON.stringify(filtered),
          60 * 60 * 24 * 7,
        );
        return this.applyProximity(filtered, userLat, userLon);
      }
    }

    if (isCis) {
      return this.applyProximity((scored as any) ?? [], userLat, userLon);
    }

    // Tier 3: Photon
    const photonResults = await this.getPhotonSuggestions(
      normalized,
      undefined,
      bbox,
    );
    if (photonResults && photonResults.length > 0) {
      const filteredPhoton = photonResults.filter((item) => {
        const match = item.uri?.match(/ll=([^&]+)/);
        if (match) {
          const raw = decodeURIComponent(match[1]);
          const [lon, lat] = raw.split(',').map(Number);
          if (lat === 0 && lon === 0) return false;
        }
        return true;
      });

      if (filteredPhoton.length > 0) {
        await this.redis.set(
          cacheKey,
          JSON.stringify(filteredPhoton),
          60 * 60 * 24 * 7,
        );
        return this.applyProximity(filteredPhoton, userLat, userLon);
      }
    }

    return this.applyProximity(photonResults ?? [], userLat, userLon);
  }

  private async suggestInternal(
    query: string,
    userLat?: number,
    userLon?: number,
  ) {
    const normalized = query.trim();
    if (normalized.length < 2) return [];

    const cacheKey = `geo:suggest:${normalized.toLowerCase()}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached).map((item: any) => {
        const latVal = Number(item.lat);
        const lonVal = Number(item.lon);
        const isInvalid =
          !item.lat ||
          !item.lon ||
          isNaN(latVal) ||
          isNaN(lonVal) ||
          (Math.abs(latVal) < 0.001 && Math.abs(lonVal) < 0.001);

        if (isInvalid) {
          const match = item.uri?.match(/ll=([^&]+)/);
          if (match) {
            const raw = decodeURIComponent(match[1]);
            const [lon, lat] = raw.split(',').map(Number);
            if (
              !isNaN(lon) &&
              !isNaN(lat) &&
              (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001)
            ) {
              return { ...item, lat, lon };
            }
          }
        }
        return item;
      });
      return this.applyProximity(parsed, userLat, userLon);
    }

    const [tier0Res, dadataRes, yandexRes, nominatimWwRes] =
      await Promise.allSettled([
        this.withTimeout(this.popularDestinations.search(normalized), 800),
        this.dadataApiKey
          ? this.withTimeout(this.getDaDataSuggestions(normalized), 800)
          : Promise.resolve(null),
        this.yandexSuggestApiKey
          ? this.withTimeout(this.getYandexSuggestions(normalized), 800)
          : Promise.resolve(null),
        userLat && userLon
          ? this.withTimeout(
              this.getNominatimSuggestionsWithBias(
                normalized,
                userLat,
                userLon,
                'ru,en',
                false,
              ),
              800,
            )
          : this.withTimeout(
              this.getNominatimSuggestions(
                normalized,
                undefined,
                'ru,en',
                false,
              ),
              800,
            ),
      ]);

    const tier0Items =
      tier0Res.status === 'fulfilled' ? (tier0Res.value ?? []) : [];
    const dadataItems =
      dadataRes.status === 'fulfilled' ? (dadataRes.value ?? []) : [];
    const yandexItems =
      yandexRes.status === 'fulfilled' ? (yandexRes.value ?? []) : [];
    const nominatimWwItems =
      nominatimWwRes.status === 'fulfilled' ? (nominatimWwRes.value ?? []) : [];

    const allScored = [
      ...tier0Items,
      ...dadataItems,
      ...yandexItems,
      ...nominatimWwItems,
    ]
      .map((item) => {
        if (
          'score' in item &&
          typeof (item as any).score === 'number' &&
          isFinite((item as any).score)
        ) {
          return item as any;
        }
        return {
          ...item,
          score:
            this.scoreResult(item.displayName, normalized) +
            ((item as any).source === 'yandex' ? 10 : 0),
        };
      })
      .sort((a, b) => b.score - a.score);

    const seenCoords = new Set<string>();
    const coordDeduped = allScored.filter((item) => {
      let lat = Number(item.lat);
      let lon = Number(item.lon);
      if (!lat || !lon || (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001)) {
        const match = item.uri?.match(/ll=([^&]+)/);
        if (match) {
          const coords = decodeURIComponent(match[1]).split(',').map(Number);
          lon = coords[0];
          lat = coords[1];
        }
      }
      if (isNaN(lon) || isNaN(lat)) return true;
      if (Math.abs(lon) < 0.001 && Math.abs(lat) < 0.001) return true;
      // Используем множитель 500 для ячейки ~200м
      const key = `${Math.round(lon * 500)},${Math.round(lat * 500)}`;
      if (seenCoords.has(key)) return false;
      seenCoords.add(key);
      return true;
    });

    const seenName = new Set<string>();
    const scored = coordDeduped
      .filter((item) => {
        let coreName = item.displayName;
        if (item.isBusiness && coreName.includes('·')) {
          const parts = coreName.split('·');
          const left = parts[0].trim();
          const right = parts.slice(1).join('·').trim();
          const name = left.split(',')[0].trim();
          coreName = name + ' · ' + right;
        } else if (!item.isBusiness) {
          coreName = coreName.split(',')[0];
        }

        const nameKey = yo(coreName.trim().toLowerCase());
        if (!nameKey) return true;
        if (seenName.has(nameKey)) return false;
        seenName.add(nameKey);
        return true;
      })
      .slice(0, 10);

    if (scored.length > 0 && scored[0].score >= 2) {
      const filtered = scored.filter((item) => {
        const match = item.uri?.match(/ll=([^&]+)/);
        if (match) {
          const raw = decodeURIComponent(match[1]);
          const [lon, lat] = raw.split(',').map(Number);
          if (lat === 0 && lon === 0) return false;
        }
        return true;
      });

      if (filtered.length > 0) {
        await this.redis.set(
          cacheKey,
          JSON.stringify(filtered),
          60 * 60 * 24 * 7,
        );
        return this.applyProximity(filtered, userLat, userLon);
      }
    }

    const photonResults =
      userLat && userLon
        ? await this.getPhotonSuggestionsWithBias(normalized, userLon, userLat)
        : await this.getPhotonSuggestions(normalized);

    if (photonResults && photonResults.length > 0) {
      const filteredPhoton = photonResults.filter((item) => {
        const match = item.uri?.match(/ll=([^&]+)/);
        if (match) {
          const raw = decodeURIComponent(match[1]);
          const [lon, lat] = raw.split(',').map(Number);
          if (lat === 0 && lon === 0) return false;
        }
        return true;
      });

      if (filteredPhoton.length > 0) {
        await this.redis.set(
          cacheKey,
          JSON.stringify(filteredPhoton),
          60 * 60 * 24 * 7,
        );
        return this.applyProximity(filteredPhoton, userLat, userLon);
      }
    }

    const yandexResults = await this.getYandexSuggestions(normalized);
    if (yandexResults && yandexResults.length > 0) {
      const filteredYandex = yandexResults.filter((item) => {
        const match = item.uri?.match(/ll=([^&]+)/);
        if (match) {
          const raw = decodeURIComponent(match[1]);
          const [lon, lat] = raw.split(',').map(Number);
          if (lat === 0 && lon === 0) return false;
        }
        return true;
      });

      if (filteredYandex.length > 0) {
        await this.redis.set(
          cacheKey,
          JSON.stringify(filteredYandex),
          60 * 60 * 24 * 7,
        );
      }
      return this.applyProximity(filteredYandex, userLat, userLon);
    }
    return this.applyProximity(yandexResults ?? [], userLat, userLon);
  }

  private applyProximity(
    results: any[],
    userLat?: number,
    userLon?: number,
  ): any[] {
    if (userLat === undefined || userLon === undefined) return results;
    return results
      .map((item) => {
        const match = (item.uri as string | undefined)?.match(/ll=([^&]+)/);
        if (!match) return item;
        const [lon, lat] = decodeURIComponent(match[1]).split(',').map(Number);
        if (isNaN(lon) || isNaN(lat)) return item;
        const distDeg = Math.sqrt((lon - userLon) ** 2 + (lat - userLat) ** 2);
        const proximityBonus = 2.0 * Math.exp(-distDeg / 5);
        return { ...item, score: (item.score || 0) + proximityBonus };
      })
      .sort((a, b) => b.score - a.score);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  }

  private scoreResult(displayName: string, query: string): number {
    const dn = yo(displayName.toLowerCase());
    const words = yo(query.toLowerCase())
      .split(/\s+/)
      .filter((w) => w.length >= 3 || /^\d+[а-яa-z]?$/.test(w));

    let textScore = 0;
    for (const w of words) {
      if (dn.startsWith(w)) textScore += 3.0;
      else if (new RegExp(`\\b${w}\\b`).test(dn)) textScore += 2.5;
      else if (dn.includes(w)) textScore += 1.5;
      else if (fuzzyIncludes(dn, w)) textScore += 1.0;
    }

    const houseNums = words.filter((w) => /^\d+[а-яa-z]?$/.test(w));
    let houseBonus = 0;
    for (const num of houseNums) {
      const strictRe = new RegExp(
        `(д\\.?\\s*|дом\\s*|,\\s*|/\\s*)${num}(\\s|,|к\\s*\\d|$)`,
      );
      const startRe = new RegExp(`^${num}(\\s|,|к\\s*\\d)`);
      if (strictRe.test(dn) || startRe.test(dn)) {
        houseBonus = 2.5;
        break;
      } else if (new RegExp(`\\b${num}\\b`).test(dn)) {
        houseBonus = Math.max(houseBonus, 0.5);
      }
    }

    let typeBonus = 0;
    if (/\b(аэропорт|airport|aerodrome|aeroporto)\b/i.test(dn)) typeBonus = 2.0;
    else if (/\b(город|г\.|city|town|capitale|столица|capital)\b/i.test(dn))
      typeBonus = 2.0;
    else if (/\b(курорт|resort|остров|island|île)\b/i.test(dn)) typeBonus = 1.5;
    else if (
      /\b(улица|ул\.|проспект|пр-т|переулок|шоссе|street|avenue|road)\b/i.test(
        dn,
      )
    )
      typeBonus = -0.5;

    return textScore * 2 + houseBonus + typeBonus;
  }

  private async getNominatimSuggestionsWithBbox(
    q: string,
    bbox: string,
    acceptLanguage = 'ru',
    excludeAmenity = false,
  ): Promise<
    Array<{ displayName: string; uri: string; lat: number; lon: number }>
  > {
    try {
      const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number);
      const params = new URLSearchParams({
        q,
        format: 'json',
        limit: '10',
        viewbox: `${minLon},${minLat},${maxLon},${maxLat}`,
        bounded: '1',
        'accept-language': acceptLanguage,
        dedupe: '1',
      });

      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        {
          headers: { 'User-Agent': 'TravelPlanner/1.0' },
        },
      );
      if (!res.ok) return [];

      const data = await res.json();
      if (!Array.isArray(data)) return [];

      const matchWords = yo(q.toLowerCase())
        .split(/\s+/)
        .filter((w) => w.length >= 3);
      return data
        .filter((item: NominatimItem) => {
          if (excludeAmenity && NOMINATIM_GEO_EXCLUDED.has(item.class))
            return false;
          const dn = yo(item.display_name.toLowerCase());
          return (
            matchWords.length === 0 ||
            matchWords.every((w) => fuzzyIncludes(dn, w))
          );
        })
        .map((item: NominatimItem) => ({
          displayName: normalizeAddress(item.display_name),
          uri: `ymapsbm1://geo?ll=${item.lon},${item.lat}&z=12`,
          lat: Number(item.lat),
          lon: Number(item.lon),
          class: item.class,
          type: item.type,
        }));
    } catch {
      return [];
    }
  }

  private async getYandexSuggestions(
    q: string,
    userLat?: number,
    userLon?: number,
  ): Promise<
    Array<{
      displayName: string;
      uri: string;
      lat: number;
      lon: number;
      source?: string;
    }>
  > {
    const apiKey = this.yandexSuggestApiKey;
    if (!apiKey) return [];

    try {
      const url = new URL('https://suggest-maps.yandex.ru/v1/suggest');
      url.searchParams.set('apikey', apiKey);
      url.searchParams.set('text', q);
      url.searchParams.set('lang', 'ru_RU');
      url.searchParams.set('results', '10');
      url.searchParams.set('types', 'biz,geo');
      url.searchParams.set('attrs', 'uri');
      if (userLat !== undefined && userLon !== undefined) {
        url.searchParams.set('ll', `${userLon},${userLat}`);
        url.searchParams.set('spn', '1,1');
      }

      const res = await fetch(url.toString());
      if (!res.ok) return [];

      const data = await res.json();
      const items = data?.results || data?.suggestions || [];

      if (!Array.isArray(items)) return [];

      console.log(`[YandexSuggest] Query: "${q}", Count: ${items.length}`);

      // Дедупликация по названию + типу (без адреса: координаты, город, улица и т.д.)
      const seenPlaces = new Set<string>();

      const mapped = items.map((item: any) => {
        const title = item?.title?.text || item?.value || '';
        const subtitle = item?.subtitle?.text || '';
        const displayName = subtitle ? `${title}, ${subtitle}` : title;
        const tags = item?.tags || [];
        const isBusiness = tags.includes('business');

        let lat = 0;
        let lon = 0;

        if (item?.geometry?.point) {
          lat = Number(item.geometry.point.lat);
          lon = Number(item.geometry.point.lon);
        } else if (item?.uri) {
          const match = item.uri.match(/[?&]ll=([^&]+)/);
          if (match) {
            const [lonStr, latStr] = decodeURIComponent(match[1]).split(',');
            lat = Number(latStr);
            lon = Number(lonStr);
          }
        }

        return {
          displayName,
          title,
          uri: item?.uri || `ymapsbm1://geo?ll=${lon},${lat}&z=12`,
          lat,
          lon,
          source: 'yandex',
          isBusiness,
          needsGeocoding: lat === 0 && lon === 0,
        };
      });

      // Геокодировать результаты без координат (обычно бизнесы)
      const needGeocoding = mapped.filter((item) => item.needsGeocoding);
      if (needGeocoding.length > 0) {
        const geocoded = await Promise.allSettled(
          needGeocoding.map((item) =>
            this.getNominatimSuggestions(item.displayName, undefined, 'ru,en', false),
          ),
        );

        geocoded.forEach((result, idx) => {
          if (result.status === 'fulfilled' && result.value?.length > 0) {
            const first = result.value[0];
            if (first?.lat && first?.lon) {
              const idx_mapped = mapped.findIndex(
                (m) => m.title === needGeocoding[idx].title,
              );
              if (idx_mapped !== -1) {
                mapped[idx_mapped].lat = first.lat;
                mapped[idx_mapped].lon = first.lon;
              }
            }
          }
        });
      }

      return mapped
        .filter((item) => {
          // Исключить результаты без координат (неудачное геокодирование)
          if (item.lat === 0 && item.lon === 0) return false;

          // Дедупликация по названию
          if (seenPlaces.has(item.title)) return false;
          seenPlaces.add(item.title);
          return true;
        });
    } catch {
      return [];
    }
  }

  private async getDaDataSuggestions(
    q: string,
  ): Promise<
    Array<{ displayName: string; uri: string; lat: number; lon: number }>
  > {
    if (!this.dadataApiKey) return [];
    try {
      const res = await fetch(
        'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Token ${this.dadataApiKey}`,
          },
          body: JSON.stringify({ query: q, count: 10 }),
        },
      );
      if (!res.ok) return [];
      const data = await res.json();
      const suggestions = Array.isArray(data?.suggestions)
        ? data.suggestions
        : [];
      return suggestions
        .filter((item: any) => item.data.geo_lon && item.data.geo_lat)
        .map((item: any) => ({
          displayName: item.value,
          uri: `ymapsbm1://geo?ll=${item.data.geo_lon},${item.data.geo_lat}&z=12`,
          lat: Number(item.data.geo_lat),
          lon: Number(item.data.geo_lon),
        }));
    } catch {
      return [];
    }
  }

  private async geolocateDaData(lat: number, lon: number): Promise<any | null> {
    if (!this.dadataApiKey) return null;
    try {
      const res = await fetch(
        'https://suggestions.dadata.ru/suggestions/api/4_1/rs/geolocate/address',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Token ${this.dadataApiKey}`,
          },
          body: JSON.stringify({ lat, lon, count: 1 }),
        },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.suggestions?.[0] || null;
    } catch {
      return null;
    }
  }

  private async getPhotonSuggestions(
    q: string,
    lonLat?: [number, number],
    bbox?: string,
  ): Promise<
    Array<{ displayName: string; uri: string; lat: number; lon: number }>
  > {
    try {
      const params = new URLSearchParams({ q, limit: '10', lang: 'en' });
      if (lonLat) {
        params.append('lon', String(lonLat[0]));
        params.append('lat', String(lonLat[1]));
      }
      if (bbox) {
        params.append('bbox', bbox);
      }
      const res = await fetch(`https://photon.komoot.io/api/?${params}`, {
        headers: { 'User-Agent': 'TravelPlanner/1.0' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      if (!data || !data.features) return [];
      const matchWords = yo(q.toLowerCase())
        .split(/\s+/)
        .filter((w) => w.length >= 3);
      return data.features
        .map((f: any) => {
          const p = f.properties;
          const displayParts = [p.name, p.city, p.street, p.housenumber].filter(
            Boolean,
          );
          return {
            displayName: displayParts.join(', ') || p.state || p.country,
            uri: `ymapsbm1://geo?ll=${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}&z=12`,
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
          };
        })
        .filter((item: any) => {
          const dn = yo(item.displayName.toLowerCase());
          return (
            matchWords.length === 0 ||
            matchWords.every((w) => fuzzyIncludes(dn, w))
          );
        });
    } catch {
      return [];
    }
  }

  private async getPhotonSuggestionsWithBias(
    q: string,
    lon: number,
    lat: number,
  ): Promise<
    Array<{ displayName: string; uri: string; lat: number; lon: number }>
  > {
    return this.getPhotonSuggestions(q, [lon, lat]);
  }

  private async reversePhoton(lat: number, lon: number): Promise<any | null> {
    try {
      const params = new URLSearchParams({
        lat: lat.toString(),
        lon: lon.toString(),
        lang: 'ru',
      });
      const res = await fetch(`https://photon.komoot.io/reverse?${params}`, {
        headers: { 'User-Agent': 'TravelPlanner/1.0' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.features?.[0] || null;
    } catch {
      return null;
    }
  }

  async reverse(lat: number, lon: number) {
    try {
      const params = new URLSearchParams({
        lat: lat.toString(),
        lon: lon.toString(),
        format: 'json',
        'accept-language': 'ru',
        zoom: '18',
      });
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?${params}`,
        { headers: { 'User-Agent': 'TravelPlanner/1.0' } },
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.address) return null;
      const addr = data.address;
      const poi =
        data.name ||
        addr.historic ||
        addr.amenity ||
        addr.shop ||
        addr.tourism ||
        addr.office ||
        addr.leisure ||
        addr.man_made ||
        addr.ruins;
      let street =
        addr.road ||
        addr.street ||
        addr.pedestrian ||
        addr.footway ||
        addr.cycleway ||
        addr.path ||
        addr.square ||
        addr.place ||
        addr.allotments;
      const houseParts: string[] = [];
      if (addr.house_number) houseParts.push(addr.house_number);
      if (
        addr.building &&
        addr.building !== addr.house_number &&
        !/^(yes|static|industrial)$/.test(addr.building)
      )
        houseParts.push(addr.building);
      if (addr.house_name) houseParts.push(addr.house_name);

      if (houseParts.length === 0) {
        const photonRes = await this.reversePhoton(lat, lon);
        if (photonRes?.properties) {
          const p = photonRes.properties;
          if (p.housenumber) {
            if (p.street) street = p.street;
            houseParts.push(p.housenumber);
            if (!addr.city && p.city) addr.city = p.city;
          }
        }
      }

      if (houseParts.length === 0) {
        const dadataRes = await this.geolocateDaData(lat, lon);
        if (dadataRes?.data) {
          const d = dadataRes.data;
          if (d.house || d.block || d.struc) {
            if (d.street_with_type || d.street)
              street = d.street_with_type || d.street;
            if (d.house) houseParts.push(d.house);
            if (d.block) houseParts.push(`${d.block_type || 'к'} ${d.block}`);
            if (d.struc) houseParts.push(`${d.struc_type || 'стр'} ${d.struc}`);
            if (!addr.city && d.city) addr.city = d.city;
          }
        }
      }

      const houseInfo = houseParts.join(', ');
      const settlement =
        addr.village ||
        addr.town ||
        addr.hamlet ||
        addr.allotments ||
        addr.suburb ||
        addr.city_district;
      const city = addr.city;
      let title = '';
      if (poi && poi !== street && poi !== settlement && poi !== city)
        title = poi;
      else if (street && houseInfo) title = `${street}, ${houseInfo}`;
      else if (settlement && houseInfo) title = `${settlement}, ${houseInfo}`;
      else if (street) title = street;
      else if (settlement) title = settlement;
      else if (city) title = houseInfo ? `${city}, ${houseInfo}` : city;
      else
        title = houseInfo
          ? `${addr.state || data.display_name.split(',')[0]}, ${houseInfo}`
          : addr.state || data.display_name.split(',')[0];

      const finalParts: string[] = [];
      if (poi && poi !== street && poi !== settlement && !houseInfo)
        finalParts.push(street ? `${poi}, ${street}` : poi);
      else if (street)
        finalParts.push(houseInfo ? `${street}, ${houseInfo}` : street);
      else if (settlement)
        finalParts.push(houseInfo ? `${settlement}, ${houseInfo}` : settlement);
      else if (houseInfo) finalParts.push(houseInfo);

      const district = addr.suburb || addr.city_district || addr.neighbourhood;
      if (district && !finalParts.some((p) => p.includes(district)))
        finalParts.push(district);
      if (settlement && !finalParts.some((p) => p.includes(settlement)))
        finalParts.push(settlement);
      if (
        city &&
        city !== settlement &&
        !finalParts.some((p) => p.includes(city))
      )
        finalParts.push(city);
      if (addr.country) finalParts.push(addr.country);

      return { displayName: finalParts.join(', ').trim(), title: title.trim() };
    } catch {
      return null;
    }
  }

  async osrmRoute(profile: string, coords: string) {
    if (
      coords.includes('0,0') ||
      coords.includes('NaN') ||
      coords.includes('undefined')
    ) {
      const points = this.parseCoords(coords);
      const validPoints = points.filter(
        (p) => p.lat !== 0 && p.lon !== 0 && !isNaN(p.lat) && !isNaN(p.lon),
      );
      if (validPoints.length >= 2) {
        let totalDistance = 0,
          totalDuration = 0;
        for (let i = 0; i < validPoints.length - 1; i++) {
          const p1 = validPoints[i],
            p2 = validPoints[i + 1];
          const R = 6371e3,
            f1 = (p1.lat * Math.PI) / 180,
            f2 = (p2.lat * Math.PI) / 180,
            df = ((p2.lat - p1.lat) * Math.PI) / 180,
            dl = ((p2.lon - p1.lon) * Math.PI) / 180;
          const a =
            Math.sin(df / 2) ** 2 +
            Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)),
            d = R * c;
          totalDistance += d;
          totalDuration += d / 11.11;
        }
        return {
          code: 'Ok',
          routes: [
            {
              geometry: {
                type: 'LineString',
                coordinates: validPoints.map((p) => [p.lon, p.lat]),
              },
              distance: totalDistance,
              duration: totalDuration,
            },
          ],
        };
      }
      return {
        code: 'Ok',
        routes: [
          {
            geometry: { type: 'LineString', coordinates: [] },
            distance: 0,
            duration: 0,
          },
        ],
      };
    }
    const normalizedProfile = profile || 'driving';
    const routeCacheKey = `route:${normalizedProfile}:${coords}`;
    const cachedRoute = await this.redis.get(routeCacheKey);
    if (cachedRoute) return JSON.parse(cachedRoute);

    if (normalizedProfile !== 'driving') {
      const mode = normalizedProfile === 'bike' ? 'bike' : 'foot';
      const fallbackUrl = `https://routing.openstreetmap.de/routed-${mode}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
      try {
        const res = await fetch(fallbackUrl, {
          headers: { 'User-Agent': 'TravelPlanner/1.0' },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.code === 'Ok') {
            await this.redis.set(
              routeCacheKey,
              JSON.stringify(data),
              60 * 60 * 24 * 30,
            );
            return data;
          }
        }
      } catch {
        // ignore
      }
    }

    const points = this.parseCoords(coords);
    const waypoints = points.map((p) => `${p.lat},${p.lon}`).join('|');
    const locationIqKey = process.env.LOCATIONIQ_API_KEY;
    const geoapifyKey = process.env.GEOAPIFY_API_KEY;
    const orsKey = process.env.ORS_API_KEY;

    const providers: Array<{
      name: RouteProvider;
      request: () => Promise<Response>;
    }> = [
      ...(locationIqKey
        ? [
            {
              name: 'locationiq' as const,
              request: () =>
                fetch(
                  `https://us1.locationiq.com/v1/directions/driving/${coords}?key=${locationIqKey}&overview=full&geometries=geojson`,
                ),
            },
          ]
        : []),
      ...(geoapifyKey
        ? [
            {
              name: 'geoapify' as const,
              request: () =>
                fetch(
                  `https://api.geoapify.com/v1/routing?waypoints=${waypoints}&mode=drive&details=instruction_details&apiKey=${geoapifyKey}`,
                ),
            },
          ]
        : []),
      ...(orsKey
        ? [
            {
              name: 'openrouteservice' as const,
              request: () =>
                fetch(
                  `https://api.openrouteservice.org/v2/directions/driving-car/geojson`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: orsKey,
                    },
                    body: JSON.stringify({
                      coordinates: points.map((p) => [p.lon, p.lat]),
                    }),
                  },
                ),
            },
          ]
        : []),
      {
        name: 'project_osrm' as const,
        request: () =>
          fetch(
            `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`,
            { headers: { 'User-Agent': 'TravelPlanner/1.0' } },
          ),
      },
    ];

    for (const provider of providers) {
      try {
        if (!this.canUseProviderNow(provider.name)) continue;
        this.markProviderUsage(provider.name);
        const res = await provider.request();
        if (!res.ok) continue;
        const data = await res.json();
        const normalizedData = this.normalizeRouteResponse(provider.name, data);
        if (normalizedData) {
          await this.redis.set(
            routeCacheKey,
            JSON.stringify(normalizedData),
            60 * 60 * 24 * 30,
          );
          return normalizedData;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private canUseProviderNow(provider: RouteProvider) {
    const limit = this.providerWindowLimits[provider];
    if (!limit) return true;
    const now = Date.now();
    const timestamps = this.providerRequestTimestamps[provider] ?? [];
    const active = timestamps.filter((ts) => now - ts < limit.windowMs);
    this.providerRequestTimestamps[provider] = active;
    return active.length < limit.maxRequests;
  }

  private markProviderUsage(provider: RouteProvider) {
    const arr = this.providerRequestTimestamps[provider] ?? [];
    arr.push(Date.now());
    this.providerRequestTimestamps[provider] = arr;
  }

  private parseCoords(coords: string): RoutePoint[] {
    return coords.split(';').map((item) => {
      const [lon, lat] = item.split(',').map(Number);
      return { lon, lat };
    });
  }

  private normalizeRouteResponse(provider: RouteProvider, data: any) {
    if (
      data?.code === 'Ok' &&
      Array.isArray(data?.routes) &&
      data.routes[0]?.geometry
    )
      return data;
    if (provider === 'geoapify' || provider === 'openrouteservice') {
      const feature = data?.features?.[0];
      const geometry = feature?.geometry;
      const distance =
        feature?.properties?.distance ?? feature?.properties?.summary?.distance;
      const duration =
        feature?.properties?.time ?? feature?.properties?.summary?.duration;
      if (
        geometry &&
        typeof distance === 'number' &&
        typeof duration === 'number'
      ) {
        return { code: 'Ok', routes: [{ geometry, distance, duration }] };
      }
    }
    return null;
  }

  private async getNominatimSuggestions(
    q: string,
    userLonLat?: [number, number],
    acceptLanguage = 'ru',
    excludeAmenity = true,
  ): Promise<
    Array<{ displayName: string; uri: string; lat: number; lon: number }>
  > {
    try {
      const params = new URLSearchParams({
        q,
        format: 'json',
        addressdetails: '1',
        limit: '10',
        'accept-language': acceptLanguage,
      });
      if (userLonLat) {
        params.append('lon', String(userLonLat[0]));
        params.append('lat', String(userLonLat[1]));
        params.append('zoom', '12');
      }
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        { headers: { 'User-Agent': 'TravelPlanner/1.0' } },
      );
      if (!res.ok) return [];
      const data = await res.json();
      const matchWords = yo(q.toLowerCase())
        .split(/\s+/)
        .filter((w) => w.length >= 3);
      return data
        .filter((item: NominatimItem) => {
          if (excludeAmenity && NOMINATIM_GEO_EXCLUDED.has(item.class))
            return false;
          const dn = yo(item.display_name.toLowerCase());
          return (
            matchWords.length === 0 ||
            matchWords.every((w) => fuzzyIncludes(dn, w))
          );
        })
        .map((item: NominatimItem) => ({
          displayName: normalizeAddress(item.display_name),
          uri: `ymapsbm1://geo?ll=${item.lon},${item.lat}&z=12`,
          lat: Number(item.lat),
          lon: Number(item.lon),
          class: item.class,
          type: item.type,
        }));
    } catch {
      return [];
    }
  }

  private async getNominatimSuggestionsWithBias(
    q: string,
    lat: number,
    lon: number,
    acceptLanguage = 'ru',
    excludeAmenity = false,
  ): Promise<
    Array<{ displayName: string; uri: string; lat: number; lon: number }>
  > {
    const buffer = 0.5;
    const bbox = `${lon - buffer},${lat - buffer},${lon + buffer},${lat + buffer}`;
    return this.getNominatimSuggestionsWithBbox(
      q,
      bbox,
      acceptLanguage,
      excludeAmenity,
    );
  }

  private async getPopularDestinationsSuggestions(
    q: string,
  ): Promise<
    Array<{ displayName: string; uri: string; lat: number; lon: number }>
  > {
    try {
      const results = await this.popularDestinations.search(q);
      return results.map((item) => ({
        displayName: item.displayName,
        uri: item.uri,
        lat: item.lat,
        lon: item.lon,
      }));
    } catch {
      return [];
    }
  }
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PopularDestinationsService } from './popular-destinations.service';

interface YandexSuggestion {
  title?: { text: string };
  subtitle?: { text: string };
  geometry?: { point: { lon: number; lat: number } };
}

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

  private get yandexApiKey() {
    return (
      process.env.YANDEX_SUGGEST_KEY ??
      process.env.YANDEX_MAPS_API_KEY ??
      process.env.NEXT_PUBLIC_YANDEX_GEOSUGGEST_KEY
    );
  }

  private get dadataApiKey() {
    return process.env.DADATA_API_KEY;
  }

  async suggest(query: string, userLat?: number, userLon?: number) {
    const normalized = query.trim();
    if (normalized.length < 2) return [];

    // Tier 1: Redis cache (TTL 7 дней)
    const cacheKey = `geo:suggest:${normalized.toLowerCase()}`;
    const cached = await this.redis.get(cacheKey);
    if (cached)
      return this.applyProximity(JSON.parse(cached), userLat, userLon);

    // Tier 0 (DB) + Tier 2: DaData (RU) + Nominatim WW параллельно, timeout 800ms
    const [tier0Res, dadataRes, nominatimWwRes] = await Promise.allSettled([
      this.withTimeout(this.popularDestinations.search(normalized), 800),
      this.dadataApiKey
        ? this.withTimeout(this.getDaDataSuggestions(normalized), 800)
        : Promise.resolve(null),
      this.withTimeout(
        this.getNominatimSuggestions(normalized, undefined, 'ru,en', false),
        800,
      ),
    ]);

    const tier0Items =
      tier0Res.status === 'fulfilled' ? (tier0Res.value ?? []) : [];
    const dadataItems =
      dadataRes.status === 'fulfilled' ? (dadataRes.value ?? []) : [];
    const nominatimWwItems =
      nominatimWwRes.status === 'fulfilled' ? (nominatimWwRes.value ?? []) : [];

    // Score сначала — чтобы dedup оставлял наиболее релевантный результат в ячейке
    const allScored = [...tier0Items, ...dadataItems, ...nominatimWwItems]
      .map((item) => {
        // Tier0 items имеют score из DB; если он невалидный (NaN/null) — пересчитываем
        if (
          'score' in item &&
          typeof (item as any).score === 'number' &&
          isFinite((item as any).score)
        ) {
          return item as any;
        }
        return {
          ...item,
          score: this.scoreResult(item.displayName, normalized),
        };
      })
      .sort((a, b) => b.score - a.score);

    // Dedup pass 1: координаты (0.02° ≈ 2км) — highest-scored в ячейке
    const seenCoords = new Set<string>();
    const coordDeduped = allScored.filter((item) => {
      const match = item.uri.match(/ll=([^&]+)/);
      if (!match) return true;
      const [lon, lat] = match[1].split(',').map(Number);
      if (isNaN(lon) || isNaN(lat)) return true;
      const key = `${Math.round(lon * 50)},${Math.round(lat * 50)}`;
      if (seenCoords.has(key)) return false;
      seenCoords.add(key);
      return true;
    });

    // Dedup pass 2: имя (первый сегмент до запятой) — убирает сегменты одной улицы
    // на границе координатных ячеек (напр. два фрагмента "Купчинской улицы" в СПб)
    const seenName = new Set<string>();
    const scored = coordDeduped
      .filter((item) => {
        const firstName = yo(
          item.displayName.split(',')[0].trim().toLowerCase(),
        );
        if (!firstName) return true;
        if (seenName.has(firstName)) return false;
        seenName.add(firstName);
        return true;
      })
      .slice(0, 10);

    if (scored.length > 0 && scored[0].score >= 2) {
      await this.redis.set(cacheKey, JSON.stringify(scored), 60 * 60 * 24 * 7);
      return this.applyProximity(scored, userLat, userLon);
    }

    // Tier 3: Photon → Yandex (если Tier 2 ничего не нашёл или score слабый)
    const photonResults = await this.getPhotonSuggestions(normalized);
    if (photonResults && photonResults.length > 0) {
      await this.redis.set(
        cacheKey,
        JSON.stringify(photonResults),
        60 * 60 * 24 * 7,
      );
      return this.applyProximity(photonResults, userLat, userLon);
    }

    const yandexResults = await this.getYandexSuggestions(normalized);
    if (yandexResults && yandexResults.length > 0) {
      await this.redis.set(
        cacheKey,
        JSON.stringify(yandexResults),
        60 * 60 * 24 * 7,
      );
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
        const [lon, lat] = match[1].split(',').map(Number);
        if (isNaN(lon) || isNaN(lat)) return item;
        // Евклидово расстояние в градусах; decay ≈ 5° ~ 500км
        const distDeg = Math.sqrt((lon - userLon) ** 2 + (lat - userLat) ** 2);
        const proximityBonus = 2.0 * Math.exp(-distDeg / 5);
        return { ...item, score: item.score + proximityBonus };
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
    // Числа (номера домов "8", "12а") не фильтруем по длине — они специфичны
    const words = yo(query.toLowerCase())
      .split(/\s+/)
      .filter((w) => w.length >= 3 || /^\d+[а-яa-z]?$/.test(w));

    let textScore = 0;
    for (const w of words) {
      if (dn.startsWith(w)) textScore += 3.0;
      else if (new RegExp(`\\b${w}\\b`).test(dn)) textScore += 2.5;
      else if (dn.includes(w)) textScore += 1.5;
      else if (fuzzyIncludes(dn, w)) textScore += 1.0; // опечатка 1-2 символа
      // слово не найдено — вклад 0 (неявно штрафует частичные совпадения)
    }

    // Бонус за совпадение номера дома: если в запросе есть число и оно есть в результате
    // рядом с маркерами дома (д., дом, , 8, / 8) или в начале строки — точный адрес
    const houseNums = words.filter((w) => /^\d+[а-яa-z]?$/.test(w));
    let houseBonus = 0;
    for (const num of houseNums) {
      const strictRe = new RegExp(
        `(д\\.?\\s*|дом\\s*|,\\s*|/\\s*)${num}(\\s|,|к\\s*\\d|$)`,
      );
      const startRe = new RegExp(`^${num}(\\s|,|к\\s*\\d)`); // "8 к1, улица..." (Nominatim)
      if (strictRe.test(dn) || startRe.test(dn)) {
        houseBonus = 2.5; // точный адрес — сильный буст
        break;
      } else if (new RegExp(`\\b${num}\\b`).test(dn)) {
        // число есть как отдельный токен, но не как явный номер дома — слабый буст
        houseBonus = Math.max(houseBonus, 0.5);
      }
    }

    // type_bonus по ключевым словам
    let typeBonus = 0;
    if (/\b(аэропорт|airport|aerodrome|aeroporto)\b/i.test(dn)) typeBonus = 2.0;
    else if (/\b(город|г\.|city|town|capitale|столица|capital)\b/i.test(dn))
      typeBonus = 2.0;
    else if (/\b(курорт|resort|остров|island|île)\b/i.test(dn)) typeBonus = 1.5;
    else if (
      /\b(село|деревня|village|посёлок|хутор|аул|урочище|территория)\b/i.test(
        dn,
      )
    )
      typeBonus = 0.3;
    else if (
      /\b(улица|ул\.|проспект|пр-т|переулок|шоссе|street|avenue|road)\b/i.test(
        dn,
      )
    )
      typeBonus = -0.5;
    else if (
      /\b(сельское поселение|муниципальный округ|городской округ)\b/i.test(dn)
    )
      typeBonus = 0.5;

    return textScore * 2 + houseBonus + typeBonus;
  }

  private async getDaDataSuggestions(
    q: string,
  ): Promise<Array<{ displayName: string; uri: string }> | null> {
    if (!this.dadataApiKey) return null;

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

      if (!res.ok) return null;

      const data = await res.json();
      const suggestions = Array.isArray(data?.suggestions)
        ? data.suggestions
        : [];

      const matchWords = yo(q.toLowerCase())
        .split(/\s+/)
        .filter((w) => w.length >= 3);
      return suggestions
        .filter((item: any) => {
          if (!item.data.geo_lon || !item.data.geo_lat) return false;
          // Проверяем только географические поля (city, settlement, region, street)
          // чтобы не матчить названия бизнесов ("ресторан Токио в Москве")
          const d = item.data;
          // city/settlement/region/area — fuzzy includes (опечатки в названии города)
          const geoFields = [d.city, d.settlement, d.region, d.area]
            .filter(Boolean)
            .map((f: string) => yo(f.toLowerCase()));
          // street — fuzzy совпадение (DaData сам делает fuzzy, мы не должны его блокировать)
          // "париж" не матчит "Парижской Коммуны": lev("парижской", "париж") = 4 > 1 → false ✓
          const streetField = d.street ? yo(d.street.toLowerCase()) : '';
          return (
            matchWords.length === 0 ||
            matchWords.some(
              (w) =>
                geoFields.some((field: string) => fuzzyIncludes(field, w)) ||
                (streetField && fuzzyIncludes(streetField, w)),
            )
          );
        })
        .map((item: any) => ({
          displayName: item.value,
          uri: `ymapsbm1://geo?ll=${item.data.geo_lon},${item.data.geo_lat}&z=12`,
        }));
    } catch (error) {
      console.error('[GeosearchService] DaData error:', error);
      return null;
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
    } catch (error) {
      console.error('[GeosearchService] DaData Geolocate error:', error);
      return null;
    }
  }

  private async getPhotonSuggestions(
    q: string,
  ): Promise<Array<{ displayName: string; uri: string }> | null> {
    try {
      const params = new URLSearchParams({ q, limit: '10', lang: 'en' });
      const res = await fetch(`https://photon.komoot.io/api/?${params}`);
      if (!res.ok) return null;

      const data = await res.json();
      if (!data || !data.features) return null;

      const matchWords = yo(q.toLowerCase())
        .split(/\s+/)
        .filter((w) => w.length >= 3);
      return data.features
        .map((f: any) => {
          const p = f.properties;
          const displayParts = [p.name, p.city, p.street, p.housenumber].filter(
            Boolean,
          );
          const displayName = displayParts.join(', ') || p.state || p.country;
          return {
            displayName,
            uri: `ymapsbm1://geo?ll=${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}&z=12`,
          };
        })
        .filter((item: { displayName: string }) => {
          const dn = yo(item.displayName.toLowerCase());
          return (
            matchWords.length === 0 ||
            matchWords.every((w) => fuzzyIncludes(dn, w))
          );
        });
    } catch {
      return null;
    }
  }

  private async reversePhoton(lat: number, lon: number): Promise<any | null> {
    try {
      const params = new URLSearchParams({
        lat: lat.toString(),
        lon: lon.toString(),
        lang: 'ru',
      });

      const res = await fetch(`https://photon.komoot.io/reverse?${params}`);
      if (!res.ok) return null;

      const data = await res.json();
      console.log(
        `[Geosearch] Photon raw response for ${lat}, ${lon}:`,
        JSON.stringify(data, null, 2),
      );
      return data.features?.[0] || null;
    } catch {
      return null;
    }
  }

  async reverse(lat: number, lon: number) {
    // Используем Nominatim для обратного геокодирования
    try {
      const params = new URLSearchParams({
        lat: lat.toString(),
        lon: lon.toString(),
        format: 'json',
        'accept-language': 'ru',
        zoom: '18', // 18 — уровень дома/улицы (было 10 — уровень города)
      });

      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?${params}`,
        {
          headers: {
            'User-Agent': 'TravelPlanner/1.0',
          },
        },
      );

      if (!res.ok) return null;

      const data = await res.json();

      if (!data || !data.address) return null;

      const addr = data.address;

      // 1. Пытаемся найти название конкретного объекта (POI)
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

      // 2. Собираем всё, что относится к улице
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

      // 3. Собираем всё, что относится к номеру дома/зданию (строгий адрес)
      const houseParts: string[] = [];
      if (addr.house_number) houseParts.push(addr.house_number);
      if (
        addr.building &&
        addr.building !== addr.house_number &&
        !/^(yes|static|industrial)$/.test(addr.building)
      ) {
        houseParts.push(addr.building);
      }
      if (addr.house_name) houseParts.push(addr.house_name);

      // 4. ВТОРОЙ КОНТУР: Если Nominatim не нашел номер дома, идем в Photon
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

      // ТРЕТИЙ КОНТУР: Если всё ещё нет номера дома, пробуем DaData
      if (houseParts.length === 0) {
        const dadataRes = await this.geolocateDaData(lat, lon);
        if (dadataRes) {
          if (dadataRes.data) {
            const d = dadataRes.data;
            if (d.house || d.block || d.struc) {
              if (d.street_with_type || d.street) {
                street = d.street_with_type || d.street;
              }
              if (d.house) houseParts.push(d.house);
              if (d.block) houseParts.push(`${d.block_type || 'к'} ${d.block}`);
              if (d.struc)
                houseParts.push(`${d.struc_type || 'стр'} ${d.struc}`);
              if (!addr.city && d.city) addr.city = d.city;
              if (
                !addr.suburb &&
                (d.city_district || d.suburb || d.settlement)
              ) {
                addr.suburb = d.city_district || d.suburb || d.settlement;
              }
            }
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

      // 5. Формируем заголовок (короткое название) по СТРОГИМ приоритетам пользователя
      let title = '';

      if (poi && poi !== street && poi !== settlement && poi !== city) {
        // Приоритет 1: Название места (без адреса)
        title = poi;
      } else if (street && houseInfo) {
        // Приоритет 2: Улица + Номер дома
        title = `${street}, ${houseInfo}`;
      } else if (settlement && houseInfo) {
        // Приоритет 3: Поселение + Номер дома (выше улицы без номера)
        title = `${settlement}, ${houseInfo}`;
      } else if (street) {
        // Приоритет 4: Просто улица
        title = street;
      } else if (settlement) {
        // Приоритет 5: Поселение
        title = settlement;
      } else if (city) {
        // Приоритет 6: Город
        title = houseInfo ? `${city}, ${houseInfo}` : city;
      } else {
        // Резерв
        const fallback =
          addr.state_district || addr.state || data.display_name.split(',')[0];
        title = houseInfo ? `${fallback}, ${houseInfo}` : fallback;
      }

      // 6. Формируем полный адрес (displayName) по нашему порядку
      const finalParts: string[] = [];

      // Блок 1: Самая точная информация (Объект / Улица / Поселение + Дом)
      if (poi && poi !== street && poi !== settlement && !houseInfo) {
        finalParts.push(street ? `${poi}, ${street}` : poi);
      } else if (street) {
        finalParts.push(houseInfo ? `${street}, ${houseInfo}` : street);
      } else if (settlement) {
        finalParts.push(houseInfo ? `${settlement}, ${houseInfo}` : settlement);
      } else if (houseInfo) {
        finalParts.push(houseInfo);
      }

      // Блок 2: Район / Округ (если он отличается от уже добавленного)
      const district = addr.suburb || addr.city_district || addr.neighbourhood;
      if (district && !finalParts.some((p) => p.includes(district))) {
        finalParts.push(district);
      }

      // Блок 3: Поселение (если его еще не было в Блоке 1)
      if (settlement && !finalParts.some((p) => p.includes(settlement))) {
        finalParts.push(settlement);
      }

      // Блок 4: Город
      if (
        city &&
        city !== settlement &&
        !finalParts.some((p) => p.includes(city))
      ) {
        finalParts.push(city);
      }

      // Блок 5: Регион
      const region = addr.state_district || addr.state;
      if (region && region !== city && region !== settlement) {
        finalParts.push(region);
      }

      // Блок 6: Страна
      if (addr.country) finalParts.push(addr.country);

      let displayName = finalParts.join(', ');

      // ФИНАЛЬНЫЙ ПРЕДОХРАНИТЕЛЬ:
      // Если адрес всё еще начинается с цифр (напр. "10-12 к4, Тихвинский переулок")
      // Мы принудительно меняем местами первые два элемента
      const checkParts = displayName.split(',').map((p) => p.trim());
      if (
        checkParts.length > 1 &&
        /^(\d+|[A-Z]?\d+([- /]\d+)?)/.test(checkParts[0])
      ) {
        // Проверяем, не является ли первый элемент номером дома
        const potentialHouse = checkParts[0];
        const potentialStreet = checkParts[1];

        // Если во втором элементе есть слова (улица, переулок и т.д.) или это просто текст
        if (/[а-яА-Яa-zA-Z]/.test(potentialStreet)) {
          checkParts.shift(); // убираем номер
          checkParts.shift(); // убираем улицу
          displayName = [
            `${potentialStreet}, ${potentialHouse}`,
            ...checkParts,
          ].join(', ');
        }
      }

      // Если массив был пуст, берем оригинал
      if (!displayName) displayName = data.display_name;

      return {
        displayName: displayName.trim(),
        title: title.trim(),
      };
    } catch (error) {
      console.error('[GeosearchService] Reverse error:', error);
      return null;
    }
  }

  async osrmRoute(profile: string, coords: string) {
    const normalizedProfile = profile || 'driving';

    // Redis cache для маршрутов (TTL 30 дней — дороги меняются редко)
    const routeCacheKey = `route:${normalizedProfile}:${coords}`;
    const cachedRoute = await this.redis.get(routeCacheKey);
    if (cachedRoute) return JSON.parse(cachedRoute);

    if (normalizedProfile !== 'driving') {
      const mode = normalizedProfile === 'bike' ? 'bike' : 'foot';
      const fallbackUrl = `https://routing.openstreetmap.de/routed-${mode}/route/v1/driving/${coords}?overview=full&geometries=geojson`;

      try {
        const res = await fetch(fallbackUrl);
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
        console.warn(
          `[GeosearchService] OSRM ${mode} routing failed with status ${res.status}, falling back to direct line`,
        );
      } catch (err) {
        console.error(`[GeosearchService] OSRM ${mode} routing error:`, err);
      }

      // Fallback: Direct line (Haversine-based simplified route)
      const pts = this.parseCoords(coords);
      let totalDist = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        if (p1 && p2) {
          const R = 6371e3; // meters
          const φ1 = (p1.lat * Math.PI) / 180;
          const φ2 = (p2.lat * Math.PI) / 180;
          const Δφ = ((p2.lat - p1.lat) * Math.PI) / 180;
          const Δλ = ((p2.lon - p1.lon) * Math.PI) / 180;
          const a =
            Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          totalDist += R * c;
        }
      }

      const speed = normalizedProfile === 'bike' ? 15 / 3.6 : 5 / 3.6; // m/s
      const duration = totalDist / speed;

      const directRoute = {
        code: 'Ok',
        routes: [
          {
            geometry: {
              type: 'LineString',
              coordinates: pts.map((p) => [p.lon, p.lat]),
            },
            distance: totalDist,
            duration: duration,
          },
        ],
      };

      // Cache the fallback for a shorter period (1 hour) to retry OSRM later
      await this.redis.set(routeCacheKey, JSON.stringify(directRoute), 60 * 60);
      return directRoute;
    }

    const points = this.parseCoords(coords);
    const waypoints = points.map((p) => `${p.lat},${p.lon}`).join('|');
    const orsCoordinates = points.map((p) => [p.lon, p.lat]);
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
                    body: JSON.stringify({ coordinates: orsCoordinates }),
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
          ),
      },
    ];

    for (const provider of providers) {
      try {
        if (!this.canUseProviderNow(provider.name)) {
          console.warn(
            `[GeosearchService] Routing provider fallback: ${provider.name} skipped due to local rate-limit window`,
          );
          continue;
        }

        this.markProviderUsage(provider.name);
        const startedAt = Date.now();
        console.log(
          `[GeosearchService] Routing request -> provider=${provider.name} profile=${normalizedProfile} coords=${coords}`,
        );

        const res = await provider.request();
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `[GeosearchService] Routing response <- provider=${provider.name} status=${res.status} elapsedMs=${elapsedMs}`,
        );

        if (!res.ok) {
          if (res.status === 429 || res.status >= 500) {
            console.warn(
              `[GeosearchService] Routing provider fallback: ${provider.name} returned ${res.status}`,
            );
            continue;
          }
          throw new Error(`Provider ${provider.name} returned ${res.status}`);
        }

        const data = await res.json();
        const normalized = this.normalizeRouteResponse(provider.name, data);
        if (normalized) {
          const route = normalized.routes?.[0];
          const pointsCount = route?.geometry?.coordinates?.length ?? 0;
          console.log(
            `[GeosearchService] Routing success provider=${provider.name} distance=${route?.distance ?? 'n/a'} duration=${route?.duration ?? 'n/a'} points=${pointsCount}`,
          );
          await this.redis.set(
            routeCacheKey,
            JSON.stringify(normalized),
            60 * 60 * 24 * 30,
          );
          return normalized;
        }

        console.warn(
          `[GeosearchService] Routing provider fallback: ${provider.name} returned unsupported response format`,
        );
      } catch (error) {
        console.warn(
          `[GeosearchService] Routing provider fallback: ${provider.name} failed`,
          error,
        );
      }
    }

    throw new Error('All routing providers failed');
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
    if (!this.providerWindowLimits[provider]) return;

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
    ) {
      return data;
    }

    if (provider === 'geoapify') {
      const feature = data?.features?.[0];
      const geometry = feature?.geometry;
      const distance = feature?.properties?.distance;
      const duration = feature?.properties?.time;

      if (
        geometry &&
        typeof distance === 'number' &&
        typeof duration === 'number'
      ) {
        return {
          code: 'Ok',
          routes: [{ geometry, distance, duration }],
        };
      }
    }

    if (provider === 'openrouteservice') {
      const feature = data?.features?.[0];
      const geometry = feature?.geometry;
      const distance = feature?.properties?.summary?.distance;
      const duration = feature?.properties?.summary?.duration;

      if (
        geometry &&
        typeof distance === 'number' &&
        typeof duration === 'number'
      ) {
        return {
          code: 'Ok',
          routes: [{ geometry, distance, duration }],
        };
      }
    }

    return null;
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
          (
            item: { displayName: string; uri: string } | null,
          ): item is { displayName: string; uri: string } => item !== null,
        );
    } catch {
      return null;
    }
  }

  private async getNominatimSuggestions(
    q: string,
    countrycodes?: string,
    acceptLanguage = 'ru',
    excludeAmenity = false,
  ): Promise<Array<{ displayName: string; uri: string }>> {
    try {
      const params = new URLSearchParams({
        q,
        format: 'json',
        limit: '10',
        'accept-language': acceptLanguage,
        dedupe: '1',
      });
      if (countrycodes) params.set('countrycodes', countrycodes);

      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
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
        }));
    } catch {
      return [];
    }
  }
}

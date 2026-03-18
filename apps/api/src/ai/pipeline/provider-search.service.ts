import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  MassCollectionShadowMeta,
  MassCollectionShadowProviderStat,
  ParsedIntent,
} from '../types/pipeline.types';
import type { PoiItem } from '../types/poi.types';
import { KudagoClientService } from './kudago-client.service';
import { OverpassClientService } from './overpass-client.service';
import { OsmFetchService } from './osm-fetch.service';
import { LlmClientService } from './llm-client.service';
import { GeosearchService } from '../../geosearch/geosearch.service';
import { AiDiscoveryService } from './ai-discovery.service';
import { FuzzyMatcherService } from './fuzzy-matcher.service';
import { CityAnalyzerService } from './city-analyzer.service';
import { ClusteringService } from './clustering.service';
import { LocationResolverService } from './location-resolver.service';
import { randomUUID } from 'crypto';

interface GeosearchResult {
  lat: number;
  lon: number;
  displayName: string;
  type?: string;
  class?: string;
}

@Injectable()
export class ProviderSearchService {
  private readonly logger = new Logger('AI_PIPELINE:ProviderSearch');

  constructor(
    private readonly kudagoClient: KudagoClientService,
    private readonly overpassClient: OverpassClientService,
    private readonly osmFetchClient: OsmFetchService,
    private readonly llmClientService: LlmClientService,
    private readonly geosearch: GeosearchService,
    private readonly aiDiscovery: AiDiscoveryService,
    private readonly fuzzyMatcher: FuzzyMatcherService,
    private readonly cityAnalyzer: CityAnalyzerService,
    private readonly clusteringService: ClusteringService,
    private readonly locationResolver: LocationResolverService,
  ) {}

  private normalizeCityName(rawCity: string): string {
    const city = rawCity
      .toLowerCase()
      .trim()
      .replace(/[^a-zа-яё0-9]/g, ' ');

    const tokens = city.split(/\s+/).filter(Boolean);

    if (
      ['спб', 'питер', 'ленинград', 'petersburg', 'spb'].some((s) =>
        tokens.includes(s),
      )
    )
      return 'Санкт-Петербург';
    if (['мск', 'москва', 'moscow'].some((s) => tokens.includes(s)))
      return 'Москва';
    if (
      ['екб', 'екатеринбург', 'свердловск', 'yekaterinburg'].some((s) =>
        tokens.includes(s),
      )
    )
      return 'Екатеринбург';
    if (
      ['нск', 'новосиб', 'новосибирск', 'novosibirsk'].some((s) =>
        tokens.includes(s),
      )
    )
      return 'Новосибирск';
    if (
      ['нн', 'нижний', 'nizhny novgorod', 'novgorod'].some((s) =>
        tokens.includes(s),
      ) &&
      !tokens.includes('великий')
    )
      return 'Нижний Новгород';
    if (['крд', 'краснодар', 'krasnodar'].some((s) => tokens.includes(s)))
      return 'Краснодар';
    if (['казань', 'kazan'].some((s) => tokens.includes(s))) return 'Казань';
    if (['сочи', 'sochi'].some((s) => tokens.includes(s))) return 'Сочи';
    return rawCity;
  }

  private buildEmptyProviderStat(
    provider: string,
  ): MassCollectionShadowProviderStat {
    return {
      provider: provider as any,
      attempted: false,
      raw_count: 0,
      used_count: 0,
      failed: false,
    };
  }

  async fetchAndFilter(
    intent: ParsedIntent,
    _fallbacks: string[] = [],
  ): Promise<{
    pois: PoiItem[];
    shadowDiagnostics?: MassCollectionShadowMeta;
  }> {
    const city = this.normalizeCityName(intent.city || 'Москва');

    const stats = {
      kudago: this.buildEmptyProviderStat('kudago'),
      overpass: this.buildEmptyProviderStat('overpass'),
      osm_fetch: this.buildEmptyProviderStat('osm_fetch'),
      discovery: this.buildEmptyProviderStat('discovery'),
    };

    // --- STAGE 0: Location Resolution ---
    const resolvedLocation = await this.locationResolver.resolve(city);
    const searchRadius = resolvedLocation?.radius ?? 15000;
    const searchLocation = resolvedLocation
      ? {
          lat: resolvedLocation.lat,
          lon: resolvedLocation.lon,
          radius: searchRadius,
        }
      : undefined;

    this.logger.log(
      `[Stage 0] Location resolved: ${resolvedLocation?.displayName ?? 'None'}, radius: ${searchRadius}m`,
    );

    // --- STAGE 1: Hard Data Collection ---
    const locationStr = searchLocation ? `(${searchLocation.lat.toFixed(4)}, ${searchLocation.lon.toFixed(4)})` : '(no coords)';
    this.logger.log(`[Stage 1] Collecting hard data for city: ${city} ${locationStr}...`);

    let allHardPois: PoiItem[] = [];
    const isCis = this.llmClientService.isCisRegion(intent.country_code, city);

    const [overpassRaw, kudagoRaw, osmRaw] = await Promise.all([
      this.overpassClient
        .fetchByIntent(intent, searchLocation)
        .catch((err: any) => {
          this.logger.error(`Overpass failed for ${city}: ${err.message}`);
          return [] as PoiItem[];
        }),
      isCis
        ? this.kudagoClient
            .fetchByIntent(intent)
            .catch(() => [] as PoiItem[])
        : Promise.resolve([] as PoiItem[]),
      !isCis
        ? this.osmFetchClient
            .fetchAndFilter(intent)
            .catch(() => [] as PoiItem[])
        : Promise.resolve([] as PoiItem[]),
    ]);

    stats.overpass.raw_count = overpassRaw.length;
    stats.kudago.raw_count = kudagoRaw.length;
    stats.osm_fetch.raw_count = osmRaw.length;
    allHardPois = [...overpassRaw, ...kudagoRaw, ...osmRaw];

    stats.overpass.attempted = true;
    stats.kudago.attempted = isCis;
    stats.osm_fetch.attempted = !isCis;

    // Filter by geographic awareness using resolved center or fallback geosearch
    const center =
      searchLocation || (await this.geosearch.suggest(city))?.[0];

    const hardPois = this.deduplicate(allHardPois).filter((p) => {
      if (this.isToxicPoi(p.name)) return false;
      if (center) {
        const d = this.haversineKm(
          center.lat,
          center.lon,
          p.coordinates.lat,
          p.coordinates.lon,
        );
        // Use resolved radius + buffer (2km) to avoid hard cutoffs, or default 15km
        const limitKm = (searchRadius + 2000) / 1000;
        if (d > limitKm) return false;
      }
      return true;
    });

    this.logger.log(`[Stage 1] Collected ${hardPois.length} hard points.`);

    // --- STAGE 1.5: Smart Enrichment ---
    const enrichedPois = await this.applySmartEnrichment(hardPois, city);
    this.logger.log(`[Stage 1.5] After enrichment: ${enrichedPois.length} points (was ${hardPois.length})`);

    // --- STAGE 2: AI Selection (Selector Mode) ---
    this.logger.log(`[Stage 2] AI Selection (Selector Mode)...`);

    // Dynamic City Context based on actual data (or default if no data)
    let cityContext = `Индустриальный город, важна промышленная мощь, набережные и местный колорит.`;
    if (enrichedPois.length > 0) {
      const cityProfile = this.cityAnalyzer.analyze(
        enrichedPois.map((p) => ({ tags: { tourism: p.category, ...p } })),
      );
      cityContext = cityProfile.description;
    }

    // Pre-clustering for geographic awareness
    const clusterResult = this.clusteringService.clusterPois(enrichedPois, 1.0);
    const poiToClusterId = new Map<string, number>();
    clusterResult.clusters.forEach((c) => {
      c.poiIds.forEach((pid) => poiToClusterId.set(pid, c.id));
    });

    const formatPoiForLlm = (p: PoiItem) => {
      const cid = poiToClusterId.get(p.id);
      const clusterTag = cid !== undefined ? `[Clstr:${cid}] ` : '';
      return `${p.id}: ${clusterTag}${p.name}`;
    };

    // 1. Prepare clusters for LLM with IDs
    const cultureList = enrichedPois
      .filter((p) =>
        [
          'museum',
          'arts_centre',
          'theatre',
          'historic',
          'memorial',
          'monument',
          'gallery',
          'castle',
          'fortress',
        ].includes(p.category),
      )
      .slice(0, 40);
    const natureList = enrichedPois
      .filter((p) =>
        [
          'park',
          'garden',
          'nature_reserve',
          'viewpoint',
          'beach',
          'water',
        ].includes(p.category),
      )
      .slice(0, 20);
    const foodList = enrichedPois
      .filter((p) =>
        ['restaurant', 'cafe', 'bar', 'pub', 'fast_food'].includes(p.category),
      )
      .slice(0, 30);

    const systemPrompt = `### ROLE
Ты — экспертный travel-аналитик и гид-сомелье мирового уровня. Твоя задача — отобрать лучшие точки интереса (POI) для города.

### TASK
1. ОПРЕДЕЛИ 3 главных архетипа этого города (напр.: 'Индустриальный гигант', 'Портовый узел', 'Университетский центр', 'Купеческий городок'). 
2. ВЫБЕРИ из предоставленного списка (с ID) те объекты, которые являются "лицом" этих архетипов.
3. ПРОВЕРЬ ГЕОГРАФИЮ: Игнорируй объекты, которые явно находятся в других регионах или странах, даже если названия похожи.
4. ВЫЯВИ "Hidden Gems": Если ты знаешь уникальный объект, которого нет в списке, добавь его.

### SELECTION CRITERIA (Strict Rules)
1. ПРИНЦИП "АНТИ-ТИПОВОЙ": 
   - Игнорируй типовые советские мемориалы (ВОВ, локальные катастрофы, обелиски, танки на постаментах), если они не являются объектами ЮНЕСКО или шедеврами мирового значения.
   - Игнорируй рядовые памятники политическим деятелям (Ленин, Киров) и мемориальные доски.
   - Обычные парки и скверы без уникальной "фишки" (например, аттракционов 19 века или уникальной флоры) — в бан.

2. ПРИОРИТЕТ "УНИКАЛЬНЫЕ МАРКЕРЫ":
   - Инженерная эстетика (ГЭС, шлюзы, мосты, маяки).
   - Архитектурная идентичность (модерн, брутализм, деревянное зодчество).
   - Объекты, создающие "дух места" (Genius Loci).

3. БАЛАНС КАТЕГОРИЙ (60/20/20):
   - Культура/Технологии (ГЭС, Музеи, Усадьбы).
   - Природа/Набережные/Виды.
   - Уникальный гастро-опыт (с историей).

### OUTPUT
Верни СТРОГО JSON. Для каждого выбранного объекта укажи, к какому АРХЕТИПУ он относится.`;

    const isSmallCity = enrichedPois.length < 10;
    const hiddenGemsTarget = isSmallCity ? '10-15' : '3-5';

    const selectionPrompt = `Город: ${city}
Контекст: ${cityContext}

ВЫБЕРИ ИЗ СПИСКА (ID: Название):

КУЛЬТУРА:
${cultureList.length > 0 ? cultureList.map((p) => formatPoiForLlm(p)).join('\n') : 'Список пуст'}

ПРИРОДА:
${natureList.length > 0 ? natureList.map((p) => formatPoiForLlm(p)).join('\n') : 'Список пуст'}

ЕДА:
${foodList.length > 0 ? foodList.map((p) => formatPoiForLlm(p)).join('\n') : 'Список пуст'}

ЗАДАЧА:
1. Выбери до 15 лучших объектов из списка.
2. Обязательно предложи ${hiddenGemsTarget} лучших мест ("Hidden Gems"), которых НЕТ в списке.

Верни JSON:
{
  "selected": [{"id": "ID объекта", "archetype": "соответствующий архетип"}],
  "hidden_gems": [{"name": "название", "reason": "почему это Must-see", "archetype": "архетип"}]
}`;

    let selectedIds: string[] = [];
    let hiddenHypotheses: any[] = [];

    try {
      const content = await this.llmClientService.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: selectionPrompt },
        ],
        {
          temperature: 0.2,
          jsonMode: true,
          isCis,
        },
      );

      const parsed = JSON.parse(content || '{}');
      selectedIds = (parsed.selected || []).map((s: any) => s.id);
      hiddenHypotheses = parsed.hidden_gems || [];

      if (selectedIds.length === 0 && enrichedPois.length > 0) {
        this.logger.warn(`[Stage 2] LLM Selection returned 0 IDs. Falling back to top 15 from enrichedPois.`);
        selectedIds = [...cultureList, ...natureList, ...foodList]
          .slice(0, 15)
          .map((p) => p.id);
      }

      stats.discovery.attempted = true;
      stats.discovery.raw_count = hiddenHypotheses.length;
    } catch (e: any) {
      this.logger.error(`[Stage 2] LLM Selection failed: ${e.message}`);
      selectedIds = [...cultureList, ...natureList, ...foodList]
        .slice(0, 15)
        .map((p) => p.id);
    }

    // Safety Filter: оставляем только те ID, которые реально были в источнике
    const validIdSet = new Set(enrichedPois.map((p) => p.id));
    const verifiedIds = selectedIds.filter((id) => validIdSet.has(id));

    const curatedPois = enrichedPois.filter((p) => verifiedIds.includes(p.id));
    this.logger.log(
      `[Stage 2] Curated ${curatedPois.length} points from Ground Truth.`,
    );

    // --- STAGE 3: Hidden Gems & Geocoding ---
    this.logger.log(
      `[Stage 3] Processing ${hiddenHypotheses.length} Hidden Gems...`,
    );

    let cityBbox = '';
    const citySuggestions = await this.geosearch.suggest(city); // Bbox якорим за город
    if (citySuggestions && citySuggestions.length > 0) {
      const firstSuggestion = citySuggestions[0] as GeosearchResult;
      const { lat, lon } = firstSuggestion;
      const delta = 0.1; // ~10-12km
      cityBbox = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;
    }

    const verifiedHiddenPois: PoiItem[] = [];
    if (cityBbox && hiddenHypotheses.length > 0) {
      for (const hypo of hiddenHypotheses) {
        if (
          !hypo.name ||
          [city].some((c) =>
            this.isAnotherCityName(hypo.name as string, c),
          ) ||
          this.isToxicPoi(hypo.name as string)
        )
          continue;

        // Check if already in curated to avoid duplicates
        if (
          curatedPois.some(
            (p) =>
              this.fuzzyMatcher.calculateMatchScore(
                hypo.name as string,
                p.name,
                0,
              ) > 0.85,
          )
        )
          continue;

        const geoRes = await this.geosearch.suggestWithBbox(
          hypo.name as string,
          cityBbox,
        );
        if (geoRes && geoRes.length > 0) {
          const best = geoRes[0] as GeosearchResult;
          if (this.isExcludedType(best)) continue;

          this.logger.log(
            `[Stage 3] Hidden Gem "${String(hypo.name)}" -> Verified via Geocoding`,
          );
          verifiedHiddenPois.push({
            id: `geo-${randomUUID().slice(0, 8)}`,
            name: hypo.name as string,
            address: best.displayName,
            coordinates: { lat: best.lat, lon: best.lon },
            category: 'attraction',
            provider: 'geosearch_verified',
            rating: 4.8,
            description: hypo.reason as string,
            price_segment: 'mid',
          });
        }
      }
    }

    stats.discovery.used_count = verifiedHiddenPois.length;

    // --- STAGE 4: Synthesis & Final Quota ---
    const allCandidates = this.deduplicate([
      ...verifiedHiddenPois,
      ...curatedPois,
    ]);

    // If result is too small, refill from enrichedPois to have a healthy pool for downstream
    if (allCandidates.length < 20 && enrichedPois.length > allCandidates.length) {
      const extra = enrichedPois
        .filter((p) => !allCandidates.some((r) => r.id === p.id))
        .slice(0, 30);
      allCandidates.push(...extra);
    }

    // Quota: 50 non-food + 50 food
    const foodCategories = [
      'restaurant',
      'cafe',
      'bar',
      'pub',
      'fast_food',
      'food_court',
    ];
    const foodPois = allCandidates
      .filter((p) => foodCategories.includes(p.category))
      .slice(0, 50);
    const nonFoodPois = allCandidates
      .filter((p) => !foodCategories.includes(p.category))
      .slice(0, 50);

    const resultPois = [...nonFoodPois, ...foodPois];

    // CRITICAL: Hard stop check only at the end
    if (resultPois.length === 0) {
      this.logger.error(
        `[Pipeline] Critical failure: No points found even after synthesis for ${intent.city}`,
      );
      throw new UnprocessableEntityException({
        code: 'CITY_DATA_UNAVAILABLE',
        message: `Данные для города ${intent.city} временно недоступны.`,
      });
    }

    this.logger.log(
      `[Stage 4] Pipeline finished. Total points: ${resultPois.length} (Food: ${foodPois.length}, Non-Food: ${nonFoodPois.length})`,
    );

    return {
      pois: resultPois,
      shadowDiagnostics: {
        provider_stats: [
          stats.kudago,
          stats.overpass,
          stats.osm_fetch,
          stats.discovery,
        ],
        totals: {
          before_dedup: enrichedPois.length + verifiedHiddenPois.length,
          after_dedup: allCandidates.length,
          returned: resultPois.length,
        },
      },
    };
  }

  private deduplicate(pois: PoiItem[]): PoiItem[] {
    const result: PoiItem[] = [];
    for (const poi of pois) {
      const duplicateIndex = result.findIndex(
        (candidate) =>
          this.haversineKm(
            candidate.coordinates.lat,
            candidate.coordinates.lon,
            poi.coordinates.lat,
            poi.coordinates.lon,
          ) < 0.07, // 70m
      );
      if (duplicateIndex === -1) {
        result.push(poi);
        continue;
      }
      const existing = result[duplicateIndex];
      // Prefer higher quality sources
      if (
        poi.provider === 'overpass' ||
        poi.provider === 'geosearch_verified' ||
        (poi.rating ?? 0) > (existing.rating ?? 0)
      ) {
        result[duplicateIndex] = poi;
      }
    }
    return result;
  }

  private haversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRad = (v: number) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // --- Smart Enrichment (Stage 1.5) ---
  // Group A: pure category words → drop immediately
  private readonly GENERIC_NAMES = new Set([
    'кафе', 'ресторан', 'бар', 'паб', 'столовая', 'буфет', 'закусочная',
    'пиццерия', 'суши', 'шаурма', 'фастфуд', 'магазин', 'супермаркет',
    'аптека', 'банк', 'банкомат', 'отель', 'гостиница', 'хостел', 'мотель',
    'парковка', 'заправка', 'автомойка', 'прачечная', 'химчистка',
    'салон', 'парикмахерская', 'пляж', 'парк', 'сквер', 'стадион',
    'спортзал', 'фитнес', 'кинотеатр', 'клуб', 'бар', 'кальянная',
  ]);

  // Group B: short (≤6) or single-word brands that look uninformative
  private isUninformativeName(name: string): boolean {
    const n = name.trim();
    if (n.length <= 6) return true;
    // Single word that doesn't look like a proper place name
    if (!n.includes(' ') && !/[A-ZА-ЯЁ]{2,}/.test(n) && n.length <= 10) return true;
    return false;
  }

  /**
   * Попытка обогатить POI через Yandex suggest по координатам + названию.
   * Возвращает enriched name или null.
   */
  private async enrichPoiName(
    poi: PoiItem,
    city: string,
  ): Promise<string | null> {
    try {
      const results = await this.geosearch.suggestWithBias(
        `${poi.name} ${city}`,
        poi.coordinates.lat,
        poi.coordinates.lon,
      );
      if (!results || results.length === 0) return null;

      const best = results[0] as { displayName?: string; title?: string };
      const fullName: string =
        (best.title as string) || (best.displayName as string) || '';

      // Only use if the enriched name is actually better (longer and contains original)
      if (
        fullName &&
        fullName.length > poi.name.length + 3 &&
        fullName.toLowerCase().includes(poi.name.toLowerCase())
      ) {
        return fullName.split(',')[0].trim(); // take first part before comma
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Stage 1.5: Smart Enrichment
   * - Group A (generic names like "Кафе", "Пляж") → drop
   * - Group B (uninformative short names like "Визит") → try Yandex enrich
   *   If enrich fails and pool is large enough → drop; else keep
   */
  private async applySmartEnrichment(
    pois: PoiItem[],
    city: string,
  ): Promise<PoiItem[]> {
    const ENRICH_THRESHOLD = 12; // only enrich if pool < this
    const shouldEnrich = pois.length < ENRICH_THRESHOLD;

    const groupA: PoiItem[] = [];
    const groupB: PoiItem[] = [];
    const clean: PoiItem[] = [];

    for (const poi of pois) {
      const lower = poi.name.toLowerCase().trim();
      if (this.GENERIC_NAMES.has(lower)) {
        groupA.push(poi);
      } else if (this.isUninformativeName(poi.name)) {
        groupB.push(poi);
      } else {
        clean.push(poi);
      }
    }

    this.logger.debug(
      `[Stage 1.5] Smart Enrichment: ${clean.length} clean, ${groupA.length} generic (drop), ${groupB.length} to enrich`,
    );

    if (groupB.length === 0) return [...clean];

    // Enrich Group B in parallel
    const enriched: PoiItem[] = [];
    if (shouldEnrich) {
      const results = await Promise.all(
        groupB.map((poi) => this.enrichPoiName(poi, city)),
      );
      for (let i = 0; i < groupB.length; i++) {
        const poi = groupB[i];
        const newName = results[i];
        if (newName) {
          enriched.push({ ...poi, name: newName });
          this.logger.debug(
            `[Stage 1.5] Enriched: "${poi.name}" → "${newName}"`,
          );
        } else if (clean.length < 8) {
          // Pool is too small — keep as is
          enriched.push(poi);
        } else {
          this.logger.debug(`[Stage 1.5] Dropped uninformative: "${poi.name}"`);
        }
      }
    } else {
      // Pool large — just drop Group B
      this.logger.debug(
        `[Stage 1.5] Pool large (${pois.length}), dropping ${groupB.length} uninformative names`,
      );
    }

    return [...clean, ...enriched];
  }

  private isToxicPoi(name: string): boolean {
    const TOXIC = [
      'ликвидаторам',
      'чернобыль',
      'афганцам',
      'погибшим',
      'жертвам',
      'участникам',
      'обелиск славы',
      'вечный огонь',
    ];
    const lower = name.toLowerCase();
    return TOXIC.some((kw) => lower.includes(kw));
  }

  private isAnotherCityName(name: string, currentCity: string): boolean {
    const n = name.toLowerCase().trim();
    const c = currentCity.toLowerCase().trim();
    if (n === c) return true;

    const commonCities = [
      'москва',
      'санкт-петербург',
      'мурманск',
      'казань',
      'сочи',
      'париж',
      'лондон',
      'берлин',
      'вена',
      'рим',
      'moscow',
      'london',
      'paris',
      'berlin',
      'rome',
      'vienna',
    ];

    return commonCities.includes(n) && n !== c;
  }

  private isExcludedType(best: GeosearchResult): boolean {
    const dn = best.displayName.toLowerCase();
    const type = (best.type || '').toLowerCase();
    const cls = (best.class || '').toLowerCase();

    const excludedKeywords = [
      'город',
      'г.',
      'city',
      'town',
      'поселок',
      'деревня',
      'село',
      'область',
      'район',
      'край',
      'республика',
      'village',
      'settlement',
      'district',
      'region',
      'state',
      'province',
      'municipality',
    ];

    const excludedTypes = [
      'city',
      'town',
      'village',
      'hamlet',
      'suburb',
      'district',
      'administrative',
      'locality',
    ];
    if (excludedTypes.includes(type) || excludedTypes.includes(cls))
      return true;

    return excludedKeywords.some((kw) => {
      if (dn === kw) return true;
      if (dn.startsWith(kw + ',')) return true;
      if (dn.startsWith(kw + ' ')) return true;
      return false;
    });
  }
}

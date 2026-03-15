import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  ParsedIntent,
  PoiCategory,
  SessionMessage,
} from '../types/pipeline.types';
import { LlmClientService } from './llm-client.service';

interface PartialIntent {
  city?: unknown;
  days?: unknown;
  budget_total?: unknown;
  budget_per_day?: unknown;
  budget_rub?: unknown;
  party_type?: unknown;
  party_size?: unknown;
  categories?: unknown;
  excluded_categories?: unknown;
  radius_km?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  preferences_text?: unknown;
}

const SYSTEM_PROMPT = `You are a travel planning assistant. Parse the user's request into JSON.
Return ONLY valid JSON with this structure:
{
  "city": string,
  "days": number,
  "budget_total": number | null,
  "budget_per_day": number | null,
  "party_type": "solo" | "couple" | "family" | "group",
  "party_size": number,
  "categories": Array<"museum"|"park"|"restaurant"|"cafe"|"attraction"|"shopping"|"entertainment">,
  "excluded_categories": Array<"museum"|"park"|"restaurant"|"cafe"|"attraction"|"shopping"|"entertainment">,
  "radius_km": number,
  "start_time": string,
  "end_time": string,
  "preferences_text": string
}`;

const DEFAULT_CATEGORIES: PoiCategory[] = ['attraction', 'restaurant'];
const ALL_CATEGORIES: PoiCategory[] = [
  'museum',
  'park',
  'restaurant',
  'cafe',
  'attraction',
  'shopping',
  'entertainment',
];

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger('AI_PIPELINE:Orchestrator');

  constructor(private readonly llmClientService: LlmClientService) {}

  async parseIntent(
    query: string,
    history: SessionMessage[],
  ): Promise<ParsedIntent> {
    const normalizedQuery = query.trim();

    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: ранний guard для первого "недоописанного" запроса,
    //    чтобы не строить маршрут из случайного контекста и сразу просить город.
    // 3) Если убрать: LLM может догадаться город по шуму/истории и вернуть нерелевантный маршрут.
    // 4) Возможен конфликт с ветками, где правила pre-LLM валидации intent вынесены в отдельный сервис.
    if (this.isNeedCityClarification(normalizedQuery, history)) {
      this.logger.warn(
        `[IntentClarification] NEED_CITY due to underspecified first query: "${normalizedQuery}"`,
      );
      throw new UnprocessableEntityException({
        code: 'NEED_CITY',
        message:
          'Недостаточно данных для построения маршрута. Укажите, пожалуйста, город.',
      });
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.slice(-8).map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: 'user', content: normalizedQuery },
    ];

    this.logger.log(
      `Calling LLM model=${this.llmClientService.model} for intent parsing...`,
    );
    const parsed = await this.callWithTimeout(messages, 20_000);

    const intent = this.normalizeIntent(parsed);
    this.logger.log(
      `LLM returned city: "${intent.city}", budget: ${intent.budget_total}`,
    );

    if (!intent.city) {
      // TRI-106 / MERGE-GUARD
      // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
      // 2) Потребность: даже после LLM парсинга enforce контракт NEED_CITY,
      //    чтобы frontend обрабатывал отсутствие города единообразно.
      // 3) Если убрать: часть сценариев уйдет в generic 422 и сломает UX уточнения города.
      // 4) Возможен конфликт с ветками, где normalizeIntent гарантирует city и считает этот блок недостижимым.
      this.logger.warn(
        `[IntentClarification] NEED_CITY due to parse result without city. Query: "${normalizedQuery}"`,
      );
      throw new UnprocessableEntityException({
        code: 'NEED_CITY',
        message:
          'Недостаточно данных для построения маршрута. Укажите, пожалуйста, город.',
      });
    }

    return intent;
  }

  private isNeedCityClarification(
    query: string,
    history: SessionMessage[],
  ): boolean {
    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: не блокировать валидные однословные города (например, "Казань"),
    //    но отсеивать шум на первом сообщении без city.
    // 3) Если убрать: снова появятся ложные NEED_CITY для городов ИЛИ ложные маршруты для шумовых токенов.
    // 4) Возможен конфликт с ветками, где city-детектор использует словарь гео-сущностей/NER.
    const userHistoryCount = history.filter(
      (item) => item.role === 'user' && item.content.trim().length > 0,
    ).length;
    if (userHistoryCount > 0) return false;

    const words = query
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean);

    if (words.length === 0) return true;

    // Однословный запрос может быть валидным городом (например, "Казань"),
    // поэтому уточнение города запрашиваем только для явного шума.
    if (words.length === 1) {
      const token = words[0]?.toLowerCase() ?? '';
      const hasLetters = /[a-zа-яё]/i.test(token);
      const looksLikeNoise = /[^a-zа-яё-]/i.test(token);
      return !hasLetters || looksLikeNoise;
    }

    return false;
  }

  private async callWithTimeout(
    messages: ChatCompletionMessageParam[],
    timeoutMs: number,
    isRetry = false,
  ): Promise<PartialIntent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const retryMessages: ChatCompletionMessageParam[] = isRetry
        ? [
            ...messages,
            {
              role: 'user',
              content: 'Respond ONLY with valid JSON, no markdown and no prose',
            },
          ]
        : messages;

      const response =
        await this.llmClientService.client.chat.completions.create({
          model: this.llmClientService.model,
          messages: retryMessages,
          response_format: { type: 'json_object' },
        });

      const content = response.choices[0]?.message?.content ?? '{}';
      return JSON.parse(content) as PartialIntent;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'unknown error';
      this.logger.error(`Failed to parse intent: ${message}`);
      if (!isRetry) {
        this.logger.warn('Retrying intent parsing...');
        return this.callWithTimeout(messages, timeoutMs, true);
      }

      throw new ServiceUnavailableException('AI orchestrator unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private normalizeIntent(parsed: PartialIntent): ParsedIntent {
    const categories = this.normalizeCategories(parsed.categories);
    const excluded = this.normalizeCategories(parsed.excluded_categories);
    const days = this.toPositiveInt(parsed.days, 1);
    const partySize = this.toPositiveInt(parsed.party_size, 1);
    const budgetTotal = this.toNullableNumber(
      parsed.budget_total ?? parsed.budget_rub,
    );
    const budgetPerDay =
      this.toNullableNumber(parsed.budget_per_day) ??
      (budgetTotal !== null ? Math.round(budgetTotal / days) : null);
    const budgetPerPerson =
      budgetTotal !== null ? Math.round(budgetTotal / partySize) : null;

    const preferencesText = this.toTrimmedString(parsed.preferences_text);
    const poiCountRequested = this.extractPoiCount(preferencesText);
    const minRestaurants = this.extractMinRestaurants(preferencesText);
    const minCafes = this.extractMinCafes(preferencesText);
    const maxPoi = this.extractMaxPoi(preferencesText);

    return {
      city: this.toTrimmedString(parsed.city),
      days,
      budget_total: budgetTotal,
      budget_per_day: budgetPerDay,
      budget_per_person: budgetPerPerson,
      party_type: this.normalizePartyType(parsed.party_type),
      party_size: partySize,
      poi_count_requested: poiCountRequested,
      min_restaurants: minRestaurants,
      min_cafes: minCafes,
      max_poi: maxPoi,
      categories: categories.length > 0 ? categories : DEFAULT_CATEGORIES,
      excluded_categories: excluded,
      radius_km: this.toPositiveNumber(parsed.radius_km, 5),
      start_time: this.normalizeTime(parsed.start_time, '10:00'),
      end_time: this.normalizeTime(parsed.end_time, '21:00'),
      preferences_text: preferencesText,
    };
  }

  private normalizePartyType(value: unknown): ParsedIntent['party_type'] {
    if (
      value === 'solo' ||
      value === 'couple' ||
      value === 'family' ||
      value === 'group'
    ) {
      return value;
    }

    return 'solo';
  }

  private normalizeCategories(value: unknown): PoiCategory[] {
    if (!Array.isArray(value)) return [];

    const valid = new Set<PoiCategory>();

    for (const item of value) {
      if (typeof item !== 'string') continue;
      if (ALL_CATEGORIES.includes(item as PoiCategory)) {
        valid.add(item as PoiCategory);
      }
    }

    return Array.from(valid);
  }

  private normalizeTime(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;

    const trimmed = value.trim();
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(trimmed) ? trimmed : fallback;
  }

  private toTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private toPositiveInt(value: unknown, fallback: number): number {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.round(num);
    return fallback;
  }

  private toPositiveNumber(value: unknown, fallback: number): number {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
    return fallback;
  }

  private toNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  // Quantity extraction from user preferences
  private extractPoiCount(text: string): number | null {
    // Match patterns like "3 места", "3 интересных места", "find 5 places", "3 лучших", "5 достопримечательностей"
    const matches = text.match(
      /(\d+)\s+(?:[а-яёa-z]+\s+)*(мест|место|places?|достопримечательностей?|points?|point)/i,
    );
    return matches ? Math.max(1, Math.min(20, parseInt(matches[1], 10))) : null;
  }

  private extractMinRestaurants(text: string): number | null {
    // Match patterns like "2 ресторана", "2 best restaurants", "2 хороших ресторана"
    const matches = text.match(
      /(\d+)\s+(?:[а-яёa-z]+\s+)*(best\s+)?рестора(ны?|нов)|(\d+)\s+(?:[а-яёa-z]+\s+)*restaurant/i,
    );
    return matches ? Math.max(1, parseInt(matches[1] || matches[4], 10)) : null;
  }

  private extractMinCafes(text: string): number | null {
    // Match patterns like "2 кафе", "2 хороших кафе", "2 cafes"
    const matches = text.match(
      /(\d+)\s+(?:[а-яёa-z]+\s+)*(best\s+)?кафе|(\d+)\s+(?:[а-яёa-z]+\s+)*cafe?s?/i,
    );
    return matches ? Math.max(1, parseInt(matches[1] || matches[3], 10)) : null;
  }

  private extractMaxPoi(text: string): number | null {
    // Match patterns like "not more than 5", "не более 5", "максимум 5"
    const matches = text.match(
      /(не\s+более|максимум|не\s+больше|not\s+more\s+than|max)\s+(\d+)/i,
    );
    return matches ? Math.max(1, Math.min(20, parseInt(matches[2], 10))) : null;
  }
}

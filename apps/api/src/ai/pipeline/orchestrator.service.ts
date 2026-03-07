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
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.slice(-8).map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: 'user', content: query },
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
      throw new UnprocessableEntityException(
        'Could not parse city from request',
      );
    }

    return intent;
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
    } catch (e: any) {
      this.logger.error(`Failed to parse intent: ${e.message}`);
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
    const budgetTotal = this.toNullableNumber(
      parsed.budget_total ?? parsed.budget_rub,
    );
    const budgetPerDay =
      this.toNullableNumber(parsed.budget_per_day) ??
      (budgetTotal !== null ? Math.round(budgetTotal / days) : null);

    return {
      city: this.toTrimmedString(parsed.city),
      days,
      budget_total: budgetTotal,
      budget_per_day: budgetPerDay,
      party_type: this.normalizePartyType(parsed.party_type),
      party_size: this.toPositiveInt(parsed.party_size, 1),
      categories: categories.length > 0 ? categories : DEFAULT_CATEGORIES,
      excluded_categories: excluded,
      radius_km: this.toPositiveNumber(parsed.radius_km, 5),
      start_time: this.normalizeTime(parsed.start_time, '10:00'),
      end_time: this.normalizeTime(parsed.end_time, '21:00'),
      preferences_text: this.toTrimmedString(parsed.preferences_text),
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
}

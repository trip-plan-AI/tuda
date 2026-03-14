import { Injectable, Logger } from '@nestjs/common';
import { LlmClientService } from './llm-client.service';
import type { FoodMode, PoiCategory } from '../types/pipeline.types';

export interface LogicalIdSelectorCandidate {
  id: string;
  name: string;
  category: PoiCategory;
}

export interface LogicalIdSelectorInput {
  candidates: LogicalIdSelectorCandidate[];
  required_capacity: number;
  food_policy: {
    food_mode: FoodMode;
    food_interval_hours: number;
  };
}

export interface LogicalIdSelectorResult {
  selected_ids: string[];
  target: number;
  selected_count: number;
  fallback_reason?: string;
}

@Injectable()
export class LogicalIdSelectorService {
  private readonly logger = new Logger('AI_PIPELINE:LogicalIdSelector');
  private readonly model = 'openai/gpt-4o-mini';

  constructor(private readonly llmClientService: LlmClientService) {}

  async selectIds(
    input: LogicalIdSelectorInput,
  ): Promise<LogicalIdSelectorResult> {
    const hasPoolShortage = input.candidates.length < input.required_capacity;
    const target = Math.min(
      Math.max(0, Math.floor(input.required_capacity)),
      input.candidates.length,
    );

    if (target === 0) {
      return {
        selected_ids: [],
        target,
        selected_count: 0,
        ...(hasPoolShortage ? { fallback_reason: 'POOL_SHORTAGE' } : {}),
      };
    }

    try {
      const response =
        await this.llmClientService.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'user', content: this.buildPrompt(input, target) },
          ],
          temperature: 0,
        });

      const rawText = response.choices[0]?.message?.content ?? '[]';
      const selectedIds = this.validateModelOutput(
        rawText,
        input.candidates,
        target,
      );

      return {
        selected_ids: selectedIds,
        target,
        selected_count: selectedIds.length,
        ...(hasPoolShortage ? { fallback_reason: 'POOL_SHORTAGE' } : {}),
      };
    } catch (error) {
      const reason =
        error instanceof Error && error.message
          ? `LOGICAL_SELECTOR_INVALID:${error.message}`
          : 'LOGICAL_SELECTOR_INVALID:UNKNOWN';

      this.logger.warn(`Logical selector fallback: ${reason}`);
      return this.buildFallback(input.candidates, target, reason);
    }
  }

  private buildPrompt(input: LogicalIdSelectorInput, target: number): string {
    const candidateLines = input.candidates
      .map(
        (candidate, index) =>
          `${index + 1}. id=${candidate.id}; name=${candidate.name}; category=${candidate.category}`,
      )
      .join('\n');

    return [
      'Ты выполняешь строгий логический отбор id для тревел-плана.',
      `Нужно выбрать ровно ${target} id из списка кандидатов, если кандидатов достаточно.`,
      'Если кандидатов меньше цели — выбери максимально возможное количество.',
      `required_capacity=${input.required_capacity}`,
      `food_policy.food_mode=${input.food_policy.food_mode}`,
      `food_policy.food_interval_hours=${input.food_policy.food_interval_hours}`,
      'Верни СТРОГО JSON-массив строковых id, без markdown, без комментариев, без дополнительных полей.',
      'Каждый id должен быть только из входного пула и без дублей.',
      'Кандидаты:',
      candidateLines,
    ].join('\n');
  }

  private validateModelOutput(
    rawText: string,
    candidates: LogicalIdSelectorCandidate[],
    target: number,
  ): string[] {
    const normalizedText = rawText.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(normalizedText) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error('NON_ARRAY_RESPONSE');
    }

    if (parsed.length !== target) {
      throw new Error(`INVALID_LENGTH:${parsed.length}`);
    }

    const allowedIds = new Set(candidates.map((candidate) => candidate.id));
    const uniqueIds = new Set<string>();

    for (const item of parsed) {
      if (typeof item !== 'string') {
        throw new Error('NON_STRING_ID');
      }

      if (!allowedIds.has(item)) {
        throw new Error(`UNKNOWN_ID:${item}`);
      }

      if (uniqueIds.has(item)) {
        throw new Error(`DUPLICATE_ID:${item}`);
      }

      uniqueIds.add(item);
    }

    return parsed;
  }

  private buildFallback(
    candidates: LogicalIdSelectorCandidate[],
    target: number,
    reason: string,
  ): LogicalIdSelectorResult {
    const selectedIds = candidates
      .slice(0, target)
      .map((candidate) => candidate.id);

    return {
      selected_ids: selectedIds,
      target,
      selected_count: selectedIds.length,
      fallback_reason: reason,
    };
  }
}

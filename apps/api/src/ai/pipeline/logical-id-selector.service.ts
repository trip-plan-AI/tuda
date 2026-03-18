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
      const content = await this.llmClientService.chat(
        [{ role: 'user', content: this.buildPrompt(input, target) }],
        {
          temperature: 0,
          jsonMode: false, // Output is a JSON array string directly
        },
      );

      const selectedIds = this.validateModelOutput(
        content || '[]',
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

    const foodMode = input.food_policy.food_mode;
    const foodCategories = ['restaurant', 'cafe'];
    const foodCount = input.candidates.filter((c) =>
      foodCategories.includes(c.category),
    ).length;

    // Explicit food quota based on food_mode
    let foodRule: string;
    if (foodMode === 'gastrotour') {
      const minFood = Math.max(1, Math.floor(target * 0.6));
      foodRule = `ОБЯЗАТЕЛЬНО включи минимум ${minFood} мест с category=restaurant или cafe (food_mode=gastrotour).`;
    } else if (foodMode === 'default' && foodCount > 0) {
      const minFood = Math.max(1, Math.floor(target * 0.3));
      foodRule = `Включи минимум ${minFood} мест с category=restaurant или cafe (food_mode=default).`;
    } else if (foodMode === 'none') {
      foodRule =
        'НЕ включай места с category=restaurant или cafe (food_mode=none).';
    } else {
      foodRule = 'Выбирай разнообразные места.';
    }

    return [
      'Ты выполняешь строгий логический отбор id для тревел-плана.',
      `Нужно выбрать ровно ${target} id из списка кандидатов, если кандидатов достаточно.`,
      'Если кандидатов меньше цели — выбери максимально возможное количество.',
      foodRule,
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

    const allowedIds = new Set(candidates.map((candidate) => candidate.id));
    const uniqueIds = new Set<string>();
    const resolvedIds: string[] = [];

    for (const item of parsed) {
      if (typeof item !== 'string' && typeof item !== 'number') {
        continue; // Soft fail: просто игнорируем мусор
      }

      const strItem = String(item);

      let resolvedId = strItem;
      if (!allowedIds.has(strItem) && /^\d+$/.test(strItem)) {
        const index = Number(strItem) - 1;
        if (index >= 0 && index < candidates.length) {
          resolvedId = candidates[index].id;
        }
      }

      if (allowedIds.has(resolvedId) && !uniqueIds.has(resolvedId)) {
        uniqueIds.add(resolvedId);
        resolvedIds.push(resolvedId);
      }
    }

    // Soft Recovery: добиваем остаток лучшими кандидатами, если LLM выдал слишком мало
    if (resolvedIds.length < target) {
      for (const c of candidates) {
        if (!uniqueIds.has(c.id)) {
          resolvedIds.push(c.id);
          uniqueIds.add(c.id);
          if (resolvedIds.length === target) break;
        }
      }
    }

    return resolvedIds.slice(0, target);
  }

  private buildFallback(
    candidates: LogicalIdSelectorCandidate[],
    target: number,
    reason: string,
  ): LogicalIdSelectorResult {
    return {
      selected_ids: candidates.slice(0, target).map((c) => c.id),
      target,
      selected_count: Math.min(candidates.length, target),
      fallback_reason: reason,
    };
  }
}

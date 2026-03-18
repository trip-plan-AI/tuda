import { Injectable, Logger } from '@nestjs/common';
import { LlmClientService } from './llm-client.service';
import type { FilteredPoi } from '../types/poi.types';
import type { ParsedIntent } from '../types/pipeline.types';

@Injectable()
export class LlmBatchRefinementService {
  private readonly logger = new Logger('AI_PIPELINE:LlmBatchRefinement');

  constructor(private readonly llmClientService: LlmClientService) {}

  async refineSelectedInBatches(
    selected: FilteredPoi[],
    personaSummary: string,
    context: { intent: ParsedIntent },
  ): Promise<{ refined: FilteredPoi[]; diagnostics: any }> {
    const isCis = this.llmClientService.isCisRegion(
      context.intent.country_code,
      context.intent.city,
    );

    const prompt = this.buildRefinementPrompt(
      selected,
      personaSummary,
      context.intent.city,
    );

    try {
      const content = await this.llmClientService.chat(
        [{ role: 'user', content: prompt }],
        {
          jsonMode: true,
          isCis,
          maxTokens: 4000,
        },
      );

      const parsed = JSON.parse(content || '{}');
      const refined = selected.map((poi) => {
        const match = (parsed.refinedPois || []).find(
          (r: any) => r.id === poi.id,
        );
        return match ? { ...poi, description: match.description } : poi;
      });

      return {
        refined,
        diagnostics: {
          provider: isCis ? 'yandex-preferred' : 'openrouter-preferred',
        },
      };
    } catch (error: any) {
      this.logger.error(`Refinement failed: ${error.message}`);
      return { refined: selected, diagnostics: { error: error.message } };
    }
  }

  async chooseReplacementAlternative(
    alternatives: FilteredPoi[],
    persona: string,
    context: { city: string; targetName: string },
  ): Promise<FilteredPoi | null> {
    const isCis = this.llmClientService.isCisRegion(null, context.city);
    const prompt = `Ты — локальный гид по городу ${context.city}. Турист хочет заменить место "${context.targetName}". Его интересы: "${persona}".
Выбери ОДНО лучшее место из списка ниже:
${alternatives.map((p, i) => `${i + 1}: ${p.name} (${p.category})`).join('\n')}

Верни ТОЛЬКО JSON: {"best_id": "номер_из_списка"}`;

    try {
      const content = await this.llmClientService.chat(
        [{ role: 'user', content: prompt }],
        {
          jsonMode: true,
          isCis,
          maxTokens: 1000,
        },
      );

      const parsed = JSON.parse(content || '{}');
      const idx = parseInt(parsed.best_id, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= alternatives.length)
        return alternatives[idx - 1];
    } catch (e: any) {
      this.logger.error(`chooseReplacementAlternative failed: ${e.message}`);
    }

    return alternatives[0] || null;
  }

  private buildRefinementPrompt(
    selected: FilteredPoi[],
    persona: string,
    city: string,
  ): string {
    return `Ты — локальный гид по городу ${city}. Твоя задача — написать живые, короткие (15 слов) описания для выбранных мест, учитывая интересы туриста: "${persona}".

СПИСОК МЕСТ (ID: Название):
${selected.map((p) => `${p.id}: ${p.name} (${p.category})`).join('\n')}

ВЕРНИ ТОЛЬКО JSON:
{
  "refinedPois": [
    { "id": "ID_из_списка", "description": "Живое описание с акцентом на интересы туриста." }
  ]
}`;
  }
}

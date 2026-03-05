import { Injectable } from '@nestjs/common';
import type { ParsedIntent } from '../types/pipeline.types';
import type {
  FilteredPoi,
  FilteredPoiResponse,
  PoiItem,
} from '../types/poi.types';

@Injectable()
export class SemanticFilterService {
  async select(
    pois: PoiItem[],
    intent: ParsedIntent,
    fallbacks: string[],
  ): Promise<FilteredPoi[]> {
    const prompt = this.buildPrompt(pois, intent);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const apiKey = process.env.YANDEX_GPT_API_KEY;
      const folderId = process.env.YANDEX_FOLDER_ID;

      if (!apiKey || !folderId) {
        throw new Error('Missing YandexGPT env');
      }

      const response = await fetch(
        'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
        {
          method: 'POST',
          headers: {
            Authorization: `Api-Key ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            modelUri: `gpt://${folderId}/yandexgpt-lite`,
            completionOptions: {
              stream: false,
              temperature: 0.2,
              maxTokens: 2000,
            },
            messages: [{ role: 'user', text: prompt }],
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`YandexGPT HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        result?: { alternatives?: Array<{ message?: { text?: string } }> };
      };

      const rawText = payload.result?.alternatives?.[0]?.message?.text ?? '{}';
      const jsonText = rawText.replace(/```json\n?|\n?```/g, '');
      const parsed = JSON.parse(jsonText) as FilteredPoiResponse;

      const selected = parsed.selected
        .map((item) => {
          const original = pois.find((poi) => poi.id === item.id);
          if (!original) return null;

          return {
            ...original,
            description: item.description,
          };
        })
        .filter((item): item is FilteredPoi => item !== null);

      if (selected.length < 5) {
        throw new Error('Semantic output too small');
      }

      return selected.slice(0, 10);
    } catch {
      fallbacks.push('SEMANTIC_FILTER_SKIPPED');

      return pois.slice(0, 8).map((poi) => ({
        ...poi,
        description: '',
      }));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private buildPrompt(pois: PoiItem[], intent: ParsedIntent): string {
    return `Выбери 5-10 самых подходящих мест для посещения.
Предпочтения: ${intent.preferences_text}
Тип группы: ${intent.party_type}
Бюджет: ${intent.budget_total ?? 'не указан'} руб.

Список мест (JSON):
${JSON.stringify(pois.map((poi) => ({ id: poi.id, name: poi.name, category: poi.category, rating: poi.rating })))}

Верни только JSON:
{
  "selected": [
    { "id": "...", "description": "1-2 предложения на русском" }
  ]
}`;
  }
}

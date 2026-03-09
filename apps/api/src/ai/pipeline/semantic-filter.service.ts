import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ParsedIntent } from '../types/pipeline.types';
import type {
  FilteredPoi,
  FilteredPoiResponse,
  PoiItem,
} from '../types/poi.types';
import { LlmClientService } from './llm-client.service';

@Injectable()
export class SemanticFilterService {
  private readonly logger = new Logger('AI_PIPELINE:SemanticFilter');

  constructor(private readonly llmClientService: LlmClientService) {}

  async select(
    pois: PoiItem[],
    intent: ParsedIntent,
    fallbacks: string[],
  ): Promise<FilteredPoi[]> {
    this.logger.log(`Starting semantic filter for ${pois.length} points...`);
    const prompt = this.buildPrompt(pois, intent);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      this.logger.log(`Calling YandexGPT API...`);
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

      this.logger.log(
        `YandexGPT responded successfully. Processing results...`,
      );

      const payload = (await response.json()) as {
        result?: { alternatives?: Array<{ message?: { text?: string } }> };
      };

      const rawText = payload.result?.alternatives?.[0]?.message?.text ?? '{}';
      const jsonText = rawText.replace(/```json\n?|\n?```/g, '');
      const parsed = JSON.parse(jsonText) as FilteredPoiResponse;

      const selectedRaw = Array.isArray(parsed.selected) ? parsed.selected : [];

      const selected = selectedRaw
        .map((item) => {
          const original = this.resolvePoiByModelId(pois, item.id);
          if (!original) return null;

          return {
            ...original,
            description: item.description,
          };
        })
        .filter((item): item is FilteredPoi => item !== null);

      this.logger.log(
        `Semantic Yandex selected ${selectedRaw.length} points, successfully mapped ${selected.length} out of original ${pois.length}:`,
      );
      selected.forEach((poi, i) => {
        this.logger.log(`  ${i + 1}. ${poi.name} - ${poi.description}`);
      });

      const minRequired = Math.min(intent.days * 2, pois.length);
      if (selected.length < minRequired) {
        throw new Error('Semantic output too small');
      }

      return selected.slice(0, Math.max(minRequired, 15));
    } catch (yandexError: any) {
      const yErrMessage =
        yandexError instanceof Error
          ? yandexError.message
          : String(yandexError);
      this.logger.warn(
        `YandexGPT failed: ${yErrMessage}. Falling back to OpenRouter...`,
      );
      try {
        return await this.selectWithOpenRouter(pois, intent);
      } catch (openRouterError: any) {
        const oErrMessage =
          openRouterError instanceof Error
            ? openRouterError.message
            : String(openRouterError);
        this.logger.error(
          `OpenRouter fallback also failed: ${oErrMessage}. Skipping semantic filter.`,
        );
        const yandexReason = this.toFallbackReason('YANDEX', yandexError);
        const openRouterReason = this.toFallbackReason(
          'OPENROUTER',
          openRouterError,
        );

        fallbacks.push(yandexReason, openRouterReason);
        fallbacks.push('SEMANTIC_FILTER_SKIPPED');

        return pois
          .slice()
          .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
          .slice(0, 8)
          .map((poi) => ({
            ...poi,
            description: `Рекомендуем посетить: ${poi.name}.`,
          }));
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async selectWithOpenRouter(
    pois: PoiItem[],
    intent: ParsedIntent,
  ): Promise<FilteredPoi[]> {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'Ты отбираешь POI для маршрута. Верни только JSON формата {"selected":[{"id":"...","description":"..."}]} без markdown.',
      },
      {
        role: 'user',
        content: this.buildPrompt(pois, intent),
      },
    ];

    const response = await this.llmClientService.client.chat.completions.create(
      {
        model: this.llmClientService.model,
        messages,
        response_format: { type: 'json_object' },
      },
    );

    const rawText = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(rawText) as FilteredPoiResponse;

    const selectedRaw = Array.isArray(parsed.selected) ? parsed.selected : [];

    const selected = selectedRaw
      .map((item) => {
        const original = this.resolvePoiByModelId(pois, item.id);
        if (!original) return null;

        return {
          ...original,
          description: item.description,
        };
      })
      .filter((item): item is FilteredPoi => item !== null);

    this.logger.warn(
      `Semantic OpenRouter selected_raw=${selectedRaw.length} mapped=${selected.length} pois=${pois.length}`,
    );

    const minRequired = Math.min(intent.days * 2, pois.length);
    if (selected.length < minRequired) {
      throw new Error('Semantic output too small');
    }

    return selected.slice(0, Math.max(minRequired, 15));
  }

  private toFallbackReason(provider: 'YANDEX' | 'OPENROUTER', error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'UNKNOWN';

    return `SEMANTIC_FILTER_${provider}_FAILED:${message}`;
  }

  private resolvePoiByModelId(
    pois: PoiItem[],
    rawId: string,
  ): PoiItem | undefined {
    const normalized = this.normalizeModelId(rawId);
    if (!normalized) return undefined;

    const byId = pois.find((poi) => poi.id.toLowerCase() === normalized);
    if (byId) return byId;

    if (/^\d+$/.test(normalized)) {
      const index = Number(normalized);
      if (Number.isInteger(index) && index >= 1 && index <= pois.length) {
        return pois[index - 1];
      }
    }

    return undefined;
  }

  private normalizeModelId(rawId: string): string | null {
    if (typeof rawId !== 'string') return null;

    const trimmed = rawId.trim().toLowerCase();
    const hexMatch = trimmed.match(/[a-f0-9]{24}/);
    if (hexMatch) return hexMatch[0];

    const compact = trimmed.replace(/[`'"\s]/g, '');
    return compact.length > 0 ? compact : null;
  }

  private buildPrompt(pois: PoiItem[], intent: ParsedIntent): string {
    const minPlaces = Math.min(intent.days * 4, pois.length);
    const maxPlaces = Math.min(
      Math.max(minPlaces, intent.days * 6),
      pois.length,
    );
    const preferences = intent.preferences_text.toLowerCase();
    const hasFoodFocus =
      preferences.includes('гастро') ||
      preferences.includes('ресторан') ||
      preferences.includes('кофе') ||
      preferences.includes('еда') ||
      preferences.includes('дегустац');
    const maxRestaurants = intent.days * 3;
    const maxCafes = intent.days * 2;

    return `Мы собрали список из ${pois.length} мест вокруг. Выбери из них от ${minPlaces} до ${maxPlaces} самых интересных и подходящих мест для туристического маршрута.

Критерии выбора:
1. Запрос пользователя: ${intent.preferences_text}
2. Тип компании: ${intent.party_type}
3. Бюджет: ${intent.budget_total ?? 'не указан'} руб.
4. Категории: постарайся найти места, соответствующие категориям [${intent.categories.join(', ')}].
5. Избегай категорий: [${intent.excluded_categories.join(', ')}].
6. Выбирай разнообразные места, чтобы маршрут был интересным.
7. Правила по питанию (anti-food-spam и гарантия еды):
   - Явный гастро-фокус в запросе: ${hasFoodFocus ? 'ДА' : 'НЕТ'}.
   - Если гастро-фокуса НЕТ, соблюдай строгие рамки:
     - category="restaurant": ОБЯЗАТЕЛЬНО не менее ${intent.days} (минимум 1 в день) и не более ${maxRestaurants} на весь маршрут;
     - category="cafe": не более ${maxCafes} на весь маршрут.
   - Если гастро-фокус ЕСТЬ, лимиты можно ослабить, но минимум ${intent.days} restaurant все равно обязателен.

Список мест (JSON):
${JSON.stringify(
  pois.map((poi, index) => ({
    id: String(index + 1),
    name: poi.name,
    category: poi.category,
    rating: poi.rating,
  })),
)}

КРИТИЧЕСКИ ВАЖНО:
1. Используй ТОЛЬКО значение поля "id" из списка мест выше (это строка с числом от "1" до "${pois.length}").
2. В итоговом JSON массив "selected" должен содержать объекты, где "id" строго совпадает с выданным номером.
3. ОБЯЗАТЕЛЬНО верни РОВНО от ${minPlaces} до ${maxPlaces} мест. Не сокращай список по своей инициативе, маршрут должен быть максимально насыщенным.

Верни только JSON без markdown (без \`\`\`json):
{
  "selected": [
    { "id": "1", "description": "1-2 предложения на русском о месте" }
  ]
}`;
  }
}

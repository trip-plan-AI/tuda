import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ParsedIntent } from '../types/pipeline.types';
import type {
  FilteredPoi,
  LlmGeneratedPoiResponse,
  PoiItem,
} from '../types/poi.types';
import { LlmClientService } from './llm-client.service';

interface LlmPoiSelection {
  id: string;
  description?: string;
  reason?: string;
}

interface ExtendedFilteredPoiResponse {
  selected?: LlmPoiSelection[];
  rankedPois?: LlmPoiSelection[];
}

@Injectable()
export class SemanticFilterService {
  private readonly logger = new Logger('AI_PIPELINE:SemanticFilter');

  constructor(private readonly llmClientService: LlmClientService) {}

  async compareProviders(
    pois: PoiItem[],
    intent: ParsedIntent,
  ): Promise<{
    yandex: { pois: FilteredPoi[]; error?: string; duration_ms: number };
    openrouter: { pois: FilteredPoi[]; error?: string; duration_ms: number };
  }> {
    const [yandexResult, openrouterResult] = await Promise.allSettled([
      (async () => {
        const t0 = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
          const apiKey = process.env.YANDEX_GPT_API_KEY;
          const folderId = process.env.YANDEX_FOLDER_ID;
          if (!apiKey || !folderId) throw new Error('Missing YandexGPT env');

          const prompt = this.buildPrompt(pois, intent);
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
          if (!response.ok)
            throw new Error(`YandexGPT HTTP ${response.status}`);

          const payload = (await response.json()) as {
            result?: { alternatives?: Array<{ message?: { text?: string } }> };
          };
          const rawText =
            payload.result?.alternatives?.[0]?.message?.text ?? '{}';
          const jsonText = rawText.replace(/```json\n?|\n?```/g, '');
          const parsed = JSON.parse(jsonText) as ExtendedFilteredPoiResponse;

          const selectedRaw = Array.isArray(parsed.selected)
            ? parsed.selected
            : Array.isArray(parsed.rankedPois)
              ? parsed.rankedPois
              : [];

          const selected = selectedRaw
            .map((item) => {
              const original = this.resolvePoiByModelId(pois, item.id);
              if (!original) return null;
              return {
                ...original,
                description: item.description || item.reason || '',
              };
            })
            .filter((item): item is FilteredPoi => item !== null);

          return { pois: selected, duration_ms: Date.now() - t0 };
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') {
            throw new Error('YandexGPT request timed out');
          }
          throw e;
        } finally {
          clearTimeout(timer);
        }
      })(),
      (async () => {
        const t0 = Date.now();
        const result = await this.selectWithOpenRouter(pois, intent);
        return { pois: result, duration_ms: Date.now() - t0 };
      })(),
    ]);

    const toResult = (
      r: PromiseSettledResult<{ pois: FilteredPoi[]; duration_ms: number }>,
    ) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            pois: [],
            error: String((r as PromiseRejectedResult).reason),
            duration_ms: 0,
          };

    return {
      yandex: toResult(yandexResult),
      openrouter: toResult(openrouterResult),
    };
  }

  async select(
    pois: PoiItem[],
    intent: ParsedIntent,
    fallbacks: string[],
  ): Promise<FilteredPoi[]> {
    this.logger.log(
      `Starting semantic filter for ${pois.length} points (Reserve Pool mode)...`,
    );
    const prompt = this.buildPrompt(pois, intent);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    const t0 = Date.now();
    try {
      this.logger.log(`Calling YandexGPT API for ranked selection...`);
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
              maxTokens: 3000,
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
      const parsed = JSON.parse(jsonText) as ExtendedFilteredPoiResponse;

      const selectedRaw = Array.isArray(parsed.selected)
        ? parsed.selected
        : Array.isArray(parsed.rankedPois)
          ? parsed.rankedPois
          : [];

      const selected = selectedRaw
        .map((item) => {
          const original = this.resolvePoiByModelId(pois, item.id);
          if (!original) return null;

          return {
            ...original,
            description: item.description || item.reason || '',
          };
        })
        .filter((item): item is FilteredPoi => item !== null);

      const duration = Date.now() - t0;
      this.logger.log(
        `Mapped ${selected.length} ranked points for geocoding pipeline in ${duration}ms.`,
      );
      return selected;
    } catch (yandexError: any) {
      const duration = Date.now() - t0;
      const message =
        yandexError instanceof Error && yandexError.name === 'AbortError'
          ? 'YandexGPT request timed out'
          : yandexError.message;
      this.logger.warn(
        `YandexGPT failed after ${duration}ms: ${message}. Falling back to OpenRouter...`,
      );
      try {
        const tOr = Date.now();
        const result = await this.selectWithOpenRouter(pois, intent);
        this.logger.log(`OpenRouter fallback completed in ${Date.now() - tOr}ms.`);
        return result;
      } catch (openRouterError: any) {
        this.logger.error(
          `OpenRouter fallback also failed. Skipping semantic filter.`,
        );
        fallbacks.push('SEMANTIC_FILTER_FAILED');
        return pois
          .slice(0, 15)
          .map((poi) => ({ ...poi, description: poi.name }));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async generatePoiFromScratch(intent: ParsedIntent): Promise<FilteredPoi[]> {
    const target = intent.poi_count_requested ?? Math.min(intent.days * 6, 20);
    const maxTarget = Math.min(intent.max_poi ?? 20, 20);
    const actualTarget = Math.min(target, maxTarget);

    const prompt = `Ты рекомендуешь туристические места в городе ${intent.city}.
Предпочтения: ${intent.preferences_text}
Нужно мест: ${actualTarget}

Верни ТОЛЬКО JSON:
{
  "selected": [
    {"id": "unique_id", "name": "Название места", "category": "attraction", "rating": 4.5, "description": "Описание"},
    ...
  ]
}`;

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: 'Ты рекомендуешь реальные места для туристов. Верни JSON.',
      },
      { role: 'user', content: prompt },
    ];

    const t0 = Date.now();
    try {
      const response =
        await this.llmClientService.client.chat.completions.create({
          model: this.llmClientService.model,
          messages,
          temperature: 0.3,
          max_tokens: 2000,
        });

      const rawText = response.choices[0]?.message?.content ?? '{}';
      const jsonText = rawText.replace(/```json\n?|\n?```/g, '');
      const parsed = JSON.parse(jsonText) as LlmGeneratedPoiResponse;
      const selectedRaw = Array.isArray(parsed.selected) ? parsed.selected : [];

      const result = selectedRaw
        .map(
          (item) =>
            ({
              id: item.id,
              name: item.name || 'Unknown POI',
              category: item.category || 'attraction',
              rating: item.rating ?? 4.0,
              description: item.description || '',
              address: 'Generated by LLM',
              coordinates: { lat: 0, lon: 0 },
              ai_generated: true,
              needs_geocoding: true,
            }) as FilteredPoi,
        )
        .slice(0, target);

      this.logger.log(`Generated ${result.length} POIs from scratch in ${Date.now() - t0}ms.`);
      return result;
    } catch (error) {
      this.logger.error(`[generatePoiFromScratch] Error after ${Date.now() - t0}ms: ${error}`);
      return [];
    }
  }

  async selectWithOpenRouter(
    pois: PoiItem[],
    intent: ParsedIntent,
  ): Promise<FilteredPoi[]> {
    if (pois.length === 0) {
      return this.generatePoiFromScratch(intent);
    }

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'Ты — эксперт-планировщик. Твоя задача — отобрать и отранжировать лучшие места для туриста.',
      },
      {
        role: 'user',
        content: this.buildPrompt(pois, intent),
      },
    ];

    const t0 = Date.now();
    const response = await this.llmClientService.client.chat.completions.create(
      {
        model: this.llmClientService.model,
        messages,
        response_format: { type: 'json_object' },
      },
    );

    const rawText = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(rawText) as ExtendedFilteredPoiResponse;
    const selectedRaw = Array.isArray(parsed.selected)
      ? parsed.selected
      : Array.isArray(parsed.rankedPois)
        ? parsed.rankedPois
        : [];

    const result = selectedRaw
      .map((item) => {
        const original = this.resolvePoiByModelId(pois, item.id);
        if (!original) return null;
        return {
          ...original,
          description: item.description || item.reason || '',
        };
      })
      .filter((item): item is FilteredPoi => item !== null);

    this.logger.log(`OpenRouter selection for ${pois.length} pois took ${Date.now() - t0}ms.`);
    return result;
  }

  private buildPrompt(pois: PoiItem[], intent: ParsedIntent): string {
    const targetPerDay = 4;
    const days = intent.days || 1;
    // Формула: (Дни * 4) + 8 резерв
    const targetCount = days * targetPerDay + 8;
    
    const preferences = intent.preferences_text;
    const city = intent.city;

    return `Ты — эксперт по туризму. Твоя задача — выбрать лучшие места из предложенного списка для поездки в город ${city}.

ПРАВИЛА RESERVE POOL:
1. Выбери ровно ${targetCount} лучших мест (если их столько есть в списке, иначе выбери все доступные).
2. Первые ${days * targetPerDay} мест должны быть твоим идеальным выбором.
3. Остальные места — это РЕЗЕРВНЫЙ ПУЛ на случай, если основные места окажутся недоступны (например, закрыты или не прошли валидацию).
4. Отранжируй их от самого важного (rank 1) до менее важных.

УЧИТЫВАЙ ПРЕДПОЧТЕНИЯ: "${preferences}"
ДНЕЙ: ${days}
БЮДЖЕТ: ${intent.budget_total || 'не указан'}

СПИСОК МЕСТ (ID: Название):
${pois.map((p, i) => `${i + 1}: ${p.name} (${p.category}, рейтинг ${p.rating})`).join('\n')}

ВЕРНИ ТОЛЬКО JSON:
{
  "rankedPois": [
    { "id": "номер_из_списка", "rank": 1, "reason": "Краткое (10-15 слов) живое описание фишки этого места. Без клише 'хороший рейтинг'." }
    ...
  ]
}`;
  }

  private resolvePoiByModelId(
    pois: PoiItem[],
    rawId: string,
  ): PoiItem | undefined {
    const id = String(rawId).trim();
    const index = parseInt(id, 10);
    if (!isNaN(index) && index >= 1 && index <= pois.length) {
      return pois[index - 1];
    }
    return pois.find((p) => p.id === id);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type {
  YandexBatchRefinementDiagnostics,
  ParsedIntent,
} from '../types/pipeline.types';
import type { FilteredPoi, FilteredPoiResponse } from '../types/poi.types';

interface RefineSelectedOptions {
  intent?: ParsedIntent;
}

@Injectable()
export class YandexBatchRefinementService {
  private readonly logger = new Logger('AI_PIPELINE:YandexBatchRefinement');

  async chooseReplacementAlternative(
    candidates: FilteredPoi[],
    userPersonaSummary: string,
    context?: { city?: string; targetName?: string },
  ): Promise<FilteredPoi | null> {
    if (candidates.length === 0) return null;

    const apiKey = process.env.YANDEX_GPT_API_KEY;
    const folderId = process.env.YANDEX_FOLDER_ID;
    if (!apiKey || !folderId) {
      return candidates[0];
    }

    const prompt = this.buildReplacementPrompt(
      candidates,
      userPersonaSummary,
      context,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.resolveTimeoutMs());

    try {
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
              temperature: 0.1,
              maxTokens: 300,
            },
            messages: [{ role: 'user', text: prompt }],
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`YANDEX_HTTP_${response.status}`);
      }

      const payload = (await response.json()) as {
        result?: { alternatives?: Array<{ message?: { text?: string } }> };
      };
      const rawText = payload.result?.alternatives?.[0]?.message?.text ?? '{}';
      const jsonText = rawText.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(jsonText) as { id?: string };
      const resolved = this.resolvePoiByModelId(candidates, parsed.id ?? '');
      return resolved ?? candidates[0];
    } catch (error) {
      this.logger.warn(
        `Replacement alternative selection fallback: ${String(error)}`,
      );
      return candidates[0];
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async refineSelectedInBatches(
    selectedPois: FilteredPoi[],
    userPersonaSummary: string,
    options?: RefineSelectedOptions,
  ): Promise<{
    refined: FilteredPoi[];
    diagnostics: YandexBatchRefinementDiagnostics;
  }> {
    const batchSize = this.resolveBatchSize();
    const batches = this.splitIntoBatches(selectedPois, batchSize);
    const refined: FilteredPoi[] = [];
    const fallbackReasons: string[] = [];
    let failedBatches = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];

      try {
        const refinedBatch = await this.refineBatch(
          batch,
          userPersonaSummary,
          options,
        );
        refined.push(...refinedBatch);
      } catch (error) {
        failedBatches += 1;
        const reason = this.toFallbackReason(error);
        fallbackReasons.push(`batch_${batchIndex + 1}:${reason}`);
        this.logger.warn(
          `Batch ${batchIndex + 1}/${batches.length} fallback: ${reason}`,
        );
        refined.push(...batch);
      }
    }

    return {
      refined,
      diagnostics: {
        batch_count: batches.length,
        failed_batches: failedBatches,
        fallback_reasons: fallbackReasons,
      },
    };
  }

  private splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
    if (items.length === 0) return [];

    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += batchSize) {
      chunks.push(items.slice(index, index + batchSize));
    }
    return chunks;
  }

  private resolveBatchSize(): number {
    const parsed = Number.parseInt(process.env.YANDEX_BATCH_SIZE ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 24;
    }

    return parsed;
  }

  private resolveTimeoutMs(): number {
    const parsed = Number.parseInt(
      process.env.YANDEX_BATCH_TIMEOUT_MS ?? '',
      10,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 8_000;
    }

    return parsed;
  }

  private async refineBatch(
    batch: FilteredPoi[],
    userPersonaSummary: string,
    options?: RefineSelectedOptions,
  ): Promise<FilteredPoi[]> {
    const apiKey = process.env.YANDEX_GPT_API_KEY;
    const folderId = process.env.YANDEX_FOLDER_ID;

    if (!apiKey || !folderId) {
      throw new Error('MISSING_YANDEX_ENV');
    }

    const prompt = this.buildPrompt(batch, userPersonaSummary, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.resolveTimeoutMs());

    try {
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
        throw new Error(`YANDEX_HTTP_${response.status}`);
      }

      const payload = (await response.json()) as {
        result?: { alternatives?: Array<{ message?: { text?: string } }> };
      };
      const rawText = payload.result?.alternatives?.[0]?.message?.text ?? '{}';
      const jsonText = rawText.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(jsonText) as FilteredPoiResponse;
      const selectedRaw = Array.isArray(parsed.selected) ? parsed.selected : [];

      if (selectedRaw.length === 0) {
        throw new Error('EMPTY_SELECTED');
      }

      const mapped = selectedRaw
        .map((item) => {
          const original = this.resolvePoiByModelId(batch, item.id);
          if (!original || typeof item.description !== 'string') {
            return null;
          }

          return {
            ...original,
            description: item.description,
          };
        })
        .filter((item): item is FilteredPoi => item !== null);

      if (mapped.length < Math.ceil(batch.length * 0.5)) {
        throw new Error('REFINEMENT_OUTPUT_TOO_SMALL');
      }

      return mapped;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('TIMEOUT');
      }

      if (error instanceof SyntaxError) {
        throw new Error('INVALID_JSON');
      }

      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private resolvePoiByModelId(
    pois: FilteredPoi[],
    rawId: string,
  ): FilteredPoi | undefined {
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

  private toFallbackReason(error: unknown): string {
    if (error instanceof Error && typeof error.message === 'string') {
      return error.message;
    }

    return 'UNKNOWN';
  }

  private buildPrompt(
    batch: FilteredPoi[],
    userPersonaSummary: string,
    options?: RefineSelectedOptions,
  ): string {
    const cityHint = options?.intent?.city
      ? `Город: ${options.intent.city}.`
      : '';
    return `Ты улучшаешь описания уже отобранных POI для маршрута. ${cityHint}
Контекст пользователя: ${userPersonaSummary}

Верни только JSON без markdown в формате:
{
  "selected": [
    { "id": "1", "description": "1-2 предложения на русском" }
  ]
}

Используй только id из списка ниже.

Список POI:
${JSON.stringify(
  batch.map((poi, index) => ({
    id: String(index + 1),
    source_id: poi.id,
    name: poi.name,
    category: poi.category,
    description: poi.description,
  })),
)}`;
  }

  private buildReplacementPrompt(
    candidates: FilteredPoi[],
    userPersonaSummary: string,
    context?: { city?: string; targetName?: string },
  ): string {
    const cityHint = context?.city ? `Город: ${context.city}.` : '';
    const targetHint = context?.targetName
      ? `Нужно заменить точку: ${context.targetName}.`
      : '';

    return `Ты выбираешь одну лучшую альтернативу POI для маршрута. ${cityHint} ${targetHint}
Контекст пользователя: ${userPersonaSummary}

Верни только JSON без markdown в формате:
{
  "id": "1"
}

Выбирай только id из списка ниже:
${JSON.stringify(
  candidates.map((poi, index) => ({
    id: String(index + 1),
    source_id: poi.id,
    name: poi.name,
    category: poi.category,
    description: poi.description,
  })),
)}`;
  }
}

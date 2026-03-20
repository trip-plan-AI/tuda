import { Injectable, Logger } from '@nestjs/common';
import { LlmClientService } from './llm-client.service';
import type { FilteredPoi } from '../types/poi.types';
import type { ParsedIntent } from '../types/pipeline.types';

@Injectable()
export class LlmBatchRefinementService {
  private readonly logger = new Logger('AI_PIPELINE:LlmBatchRefinement');

  constructor(private readonly llmClientService: LlmClientService) {}

  private async enrichPoiNameViaReverseGeocoding(
    poi: FilteredPoi,
  ): Promise<string | null> {
    try {
      // Skip if name is already detailed (more than 3 words or contains proper nouns)
      const words = poi.name.split(/\s+/).length;
      if (words > 3) return null;

      // Skip if no coordinates
      if (!poi.coordinates?.lat || !poi.coordinates?.lon) return null;

      const { lat, lon } = poi.coordinates;

      // Try Nominatim reverse geocoding (open-source, no API key needed)
      const nominatimResponse = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
        {
          headers: {
            'User-Agent': 'TravelPlanner/1.0',
          },
        },
      );

      if (nominatimResponse.ok) {
        const data = await nominatimResponse.json();

        // Try to extract business/place name from address
        const address = data.address || {};
        const poiName =
          address.amenity ||
          address.shop ||
          address.tourism ||
          address.leisure ||
          address.restaurant ||
          address.cafe ||
          address.pub;

        if (poiName && typeof poiName === 'string' && poiName.length > 0) {
          this.logger.debug(
            `[REVERSE_GEOCODING] Enriched "${poi.name}" → "${poiName}"`,
          );
          return poiName;
        }
      }
    } catch (error) {
      this.logger.debug(`[REVERSE_GEOCODING] Failed for ${poi.name}: ${error}`);
    }

    return null;
  }

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
      let refined = selected.map((poi) => {
        const match = (parsed.refinedPois || []).find(
          (r: any) => r.id === poi.id,
        );
        if (!match) return poi;

        // LLM может вернуть улучшенное имя для generic POI
        const updatedPoi = {
          ...poi,
          description: match.description,
        };

        // Если LLM предложил улучшенное имя и оно отличается от исходного, используй его
        if (match.name && match.name !== poi.name && match.name.trim().length > 0) {
          updatedPoi.name = match.name;
          this.logger.debug(
            `[REFINEMENT] LLM improved name: "${poi.name}" → "${match.name}"`,
          );
        }

        return updatedPoi;
      });

      // Дополнительное обогащение через reverse geocoding для оставшихся generic имён
      const enrichedPois: FilteredPoi[] = [];
      for (const poi of refined) {
        // Проверяем, остаётся ли имя generic (если LLM его не улучшил)
        const words = poi.name.split(/\s+/).length;
        if (words <= 2) {
          const enrichedName = await this.enrichPoiNameViaReverseGeocoding(poi);
          if (enrichedName) {
            enrichedPois.push({
              ...poi,
              name: enrichedName,
            });
            continue;
          }
        }
        enrichedPois.push(poi);
      }

      return {
        refined: enrichedPois,
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
    return `Ты — локальный гид по городу ${city}. Твоя задача — обогатить информацию о выбранных местах, учитывая интересы туриста: "${persona}".

СПИСОК МЕСТ (ID: Название):
${selected.map((p) => `${p.id}: ${p.name} (${p.category})`).join('\n')}

ПРАВИЛА:
1. Если название generic (одно слово типа "Кафе", "Ресторан", "Визит"), предложи более конкретное имя.
2. Если имя уже конкретное, оставь как есть.
3. Если название НЕ на русском языке — переведи его на русский и добавь оригинал в скобках. Например: "Парк Гуэль (Park Güell)", "Саграда Фамилия (Sagrada Família)", "Тауэрский мост (Tower Bridge)". Если название уже на русском — оставь как есть.
4. Напиши живое, короткое описание (10-15 слов) на русском языке с акцентом на интересы туриста.

ВЕРНИ ТОЛЬКО JSON:
{
  "refinedPois": [
    { "id": "ID_из_списка", "name": "Уточненное или исходное имя", "description": "Живое описание." }
  ]
}`;
  }
}

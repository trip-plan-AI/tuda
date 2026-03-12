import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import type { VectorPrefilterShadowMeta } from '../types/pipeline.types';
import type { PoiItem } from '../types/poi.types';

@Injectable()
export class VectorPrefilterService {
  private readonly vectorIndexName =
    process.env.AI_VECTOR_INDEX_NAME?.trim() || 'idx:poi_vector';

  constructor(private readonly redisService: RedisService) {}

  async runShadowPrefilter(
    personaSummary: string,
    candidates: PoiItem[],
    topK: number,
  ): Promise<VectorPrefilterShadowMeta> {
    const normalizedTopK = Math.max(1, Math.floor(topK));
    const selectedCount = Math.min(normalizedTopK, candidates.length);

    // Shadow-режим: на этом шаге не используем embeddings,
    // но оставляем аргумент для будущей векторной интеграции.
    void personaSummary;

    if (!this.redisService.isAvailable) {
      return {
        status: 'fallback',
        reason: 'REDISEARCH_UNAVAILABLE',
        total_candidates: candidates.length,
        selected_count: selectedCount,
        top_k: normalizedTopK,
      };
    }

    try {
      await this.redisService.executeCommand(
        'FT.SEARCH',
        this.vectorIndexName,
        '*',
        'LIMIT',
        '0',
        '0',
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : String(error);

      if (message.includes('unknown index name')) {
        return {
          status: 'fallback',
          reason: 'VECTOR_INDEX_MISSING',
          total_candidates: candidates.length,
          selected_count: selectedCount,
          top_k: normalizedTopK,
        };
      }

      return {
        status: 'fallback',
        reason: 'REDISEARCH_UNAVAILABLE',
        total_candidates: candidates.length,
        selected_count: selectedCount,
        top_k: normalizedTopK,
      };
    }

    return {
      status: 'ok',
      total_candidates: candidates.length,
      selected_count: selectedCount,
      top_k: normalizedTopK,
    };
  }
}

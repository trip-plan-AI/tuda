import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { LlmClientService } from './llm-client.service';
import type { VectorPrefilterShadowMeta } from '../types/pipeline.types';
import type { PoiItem } from '../types/poi.types';

@Injectable()
export class VectorPrefilterService {
  private readonly vectorIndexName =
    process.env.AI_VECTOR_INDEX_NAME?.trim() || 'idx:ai:poi';
  private readonly vectorPrefix = 'ai:poi:vec:';
  private readonly embeddingModel = 'text-embedding-3-small';
  private readonly embeddingDimensions = 1536;
  private readonly embeddingCacheTtlSeconds = 30 * 24 * 60 * 60;
  private indexReady = false;

  constructor(
    private readonly redisService: RedisService,
    private readonly llmClientService: LlmClientService,
  ) {}

  async runShadowPrefilter(
    personaSummary: string,
    candidates: PoiItem[],
    topK: number,
  ): Promise<VectorPrefilterShadowMeta> {
    const normalizedTopK = Math.max(1, Math.floor(topK));
    const fallbackSelectedCount = Math.min(normalizedTopK, candidates.length);

    if (!this.redisService.isAvailable) {
      return {
        status: 'fallback',
        reason: 'REDISEARCH_UNAVAILABLE',
        total_candidates: candidates.length,
        selected_count: fallbackSelectedCount,
        top_k: normalizedTopK,
      };
    }

    try {
      await this.ensureVectorIndex();
      await this.ensureCandidateEmbeddings(candidates);

      const queryEmbedding = await this.embedText(personaSummary);
      const queryBuffer = this.toFloat32Buffer(queryEmbedding);

      const searchResponse = await this.redisService.executeCommand(
        'FT.SEARCH',
        this.vectorIndexName,
        `*=>[KNN ${normalizedTopK} @embedding $query_vec AS score]`,
        'PARAMS',
        2,
        'query_vec',
        queryBuffer,
        'SORTBY',
        'score',
        'NOCONTENT',
        'DIALECT',
        2,
      );

      const returnedCount = this.extractReturnedDocsCount(searchResponse);

      return {
        status: 'ok',
        total_candidates: candidates.length,
        selected_count: Math.min(
          returnedCount,
          normalizedTopK,
          candidates.length,
        ),
        top_k: normalizedTopK,
      };
    } catch (error) {
      const reason = this.resolveFallbackReason(error);

      return {
        status: 'fallback',
        reason,
        total_candidates: candidates.length,
        selected_count: fallbackSelectedCount,
        top_k: normalizedTopK,
      };
    }
  }

  private async ensureVectorIndex(): Promise<void> {
    if (this.indexReady) {
      return;
    }

    try {
      await this.redisService.executeCommand('FT.INFO', this.vectorIndexName);
      this.indexReady = true;
      return;
    } catch (error) {
      if (!this.isMissingIndexError(error)) {
        throw error;
      }
    }

    try {
      await this.redisService.executeCommand(
        'FT.CREATE',
        this.vectorIndexName,
        'ON',
        'HASH',
        'PREFIX',
        1,
        this.vectorPrefix,
        'SCHEMA',
        'category',
        'TAG',
        'name',
        'TEXT',
        'text',
        'TEXT',
        'tags',
        'TAG',
        'embedding',
        'VECTOR',
        'HNSW',
        6,
        'TYPE',
        'FLOAT32',
        'DIM',
        this.embeddingDimensions,
        'DISTANCE_METRIC',
        'COSINE',
      );
      this.indexReady = true;
    } catch (error) {
      if (this.isIndexAlreadyExistsError(error)) {
        this.indexReady = true;
        return;
      }

      throw error;
    }
  }

  private async ensureCandidateEmbeddings(
    candidates: PoiItem[],
  ): Promise<void> {
    for (const poi of candidates) {
      const key = `${this.vectorPrefix}${poi.id}`;

      const existingEmbedding = await this.redisService.executeCommand(
        'HGET',
        key,
        'embedding',
      );

      if (Buffer.isBuffer(existingEmbedding)) {
        continue;
      }

      if (
        typeof existingEmbedding === 'string' &&
        existingEmbedding.length > 0
      ) {
        continue;
      }

      const text = this.buildPoiEmbeddingText(poi);
      const embedding = await this.embedText(text);
      const embeddingBuffer = this.toFloat32Buffer(embedding);

      await this.redisService.executeCommand(
        'HSET',
        key,
        'id',
        poi.id,
        'category',
        poi.category,
        'name',
        poi.name,
        'tags',
        poi.category,
        'text',
        text,
        'embedding',
        embeddingBuffer,
      );

      await this.redisService.executeCommand(
        'EXPIRE',
        key,
        this.embeddingCacheTtlSeconds,
      );
    }
  }

  private buildPoiEmbeddingText(poi: PoiItem): string {
    const category = poi.category || 'unknown';
    const name = poi.name || 'unknown';
    const tags: string[] = [];

    if (poi.rating !== undefined) {
      tags.push(`rating:${poi.rating}`);
    }

    if (poi.price_segment) {
      tags.push(`price:${poi.price_segment}`);
    }

    return `[${category}] ${name} (${tags.join(', ')})`;
  }

  private async embedText(text: string): Promise<number[]> {
    const response = await this.llmClientService.client.embeddings.create({
      model: this.embeddingModel,
      input: text,
    });

    return response.data[0]?.embedding ?? [];
  }

  private toFloat32Buffer(values: number[]): Buffer {
    return Buffer.from(new Float32Array(values).buffer);
  }

  private extractReturnedDocsCount(searchResponse: unknown): number {
    if (!Array.isArray(searchResponse)) {
      return 0;
    }

    return Math.max(0, searchResponse.length - 1);
  }

  private resolveFallbackReason(
    error: unknown,
  ): 'VECTOR_INDEX_MISSING' | 'REDISEARCH_UNAVAILABLE' {
    if (this.isMissingIndexError(error)) {
      return 'VECTOR_INDEX_MISSING';
    }

    return 'REDISEARCH_UNAVAILABLE';
  }

  private isMissingIndexError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);

    return message.includes('unknown index name');
  }

  private isIndexAlreadyExistsError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);

    return message.includes('index already exists');
  }
}

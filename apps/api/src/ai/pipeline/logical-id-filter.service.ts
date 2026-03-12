import { Injectable } from '@nestjs/common';
import type { PoiItem } from '../types/poi.types';

export interface LogicalIdDuplicateGroup {
  logical_id: string;
  count: number;
  ids: string[];
}

@Injectable()
export class LogicalIdFilterService {
  attachLogicalIds(candidates: PoiItem[], city?: string): PoiItem[] {
    return candidates.map((candidate) => ({
      ...candidate,
      logical_id: this.buildLogicalId(candidate, city),
    }));
  }

  analyzeDuplicatesByLogicalId(
    candidates: PoiItem[],
  ): LogicalIdDuplicateGroup[] {
    const groups = new Map<string, string[]>();

    for (const candidate of candidates) {
      if (!candidate.logical_id) continue;

      const ids = groups.get(candidate.logical_id);
      if (ids) {
        ids.push(candidate.id);
        continue;
      }

      groups.set(candidate.logical_id, [candidate.id]);
    }

    return Array.from(groups.entries())
      .filter(([, ids]) => ids.length > 1)
      .map(([logicalId, ids]) => ({
        logical_id: logicalId,
        count: ids.length,
        ids,
      }));
  }

  private buildLogicalId(candidate: PoiItem, city?: string): string {
    const sourceAndId = this.extractSourceAndSourceId(candidate.id);
    if (sourceAndId) {
      return `lid:${sourceAndId.source}:${sourceAndId.source_id}`;
    }

    const normalizedName = this.normalizeToken(candidate.name);
    const coarseLat = this.coarseCoordinate(candidate.coordinates.lat);
    const coarseLon = this.coarseCoordinate(candidate.coordinates.lon);
    const normalizedCity = this.normalizeToken(city ?? candidate.address);

    return `lid:fb:${normalizedName}:${coarseLat}:${coarseLon}:${normalizedCity}`;
  }

  private extractSourceAndSourceId(
    id: string,
  ): { source: string; source_id: string } | null {
    const [rawSource, ...rest] = id.split('-');
    const rawSourceId = rest.join('-').trim();
    const source = this.normalizeToken(rawSource ?? '');
    const sourceId = this.normalizeToken(rawSourceId);

    if (!source || !sourceId) {
      return null;
    }

    return {
      source,
      source_id: sourceId,
    };
  }

  private normalizeToken(value: string): string {
    const normalized = value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');

    return normalized;
  }

  private coarseCoordinate(value: number): string {
    return Number.isFinite(value) ? value.toFixed(3) : '0.000';
  }
}

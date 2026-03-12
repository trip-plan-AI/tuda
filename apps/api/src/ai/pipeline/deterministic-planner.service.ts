import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { FilteredPoi } from '../types/poi.types';
import type {
  DeterministicPlannerDecisionSummary,
  ParsedIntent,
  RoutePlan,
} from '../types/pipeline.types';

@Injectable()
export class DeterministicPlannerService {
  buildInputHash(
    parsedIntent: ParsedIntent,
    selectedPois: FilteredPoi[],
  ): string {
    const sortedSelectedPois = [...selectedPois].sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    const normalizedPayload = {
      parsed_intent: this.normalizeValue(parsedIntent),
      selected_pois: this.normalizeValue(sortedSelectedPois),
    };

    const canonicalJson = JSON.stringify(normalizedPayload);
    return createHash('sha256').update(canonicalJson).digest('hex');
  }

  buildDecisionLogSummary(
    routePlan: RoutePlan,
  ): DeterministicPlannerDecisionSummary {
    const points = routePlan.days.flatMap((day) => day.points);
    const uniquePoiCount = new Set(points.map((point) => point.poi_id)).size;

    return {
      days_count: routePlan.days.length,
      points_total: points.length,
      unique_poi_count: uniquePoiCount,
      duplicate_poi_count: points.length - uniquePoiCount,
    };
  }

  private normalizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeValue(item));
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).sort(
        ([leftKey], [rightKey]) => leftKey.localeCompare(rightKey),
      );

      return entries.reduce<Record<string, unknown>>((acc, [key, item]) => {
        acc[key] = this.normalizeValue(item);
        return acc;
      }, {});
    }

    return value;
  }
}

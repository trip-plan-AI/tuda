import { Injectable } from '@nestjs/common';
import type {
  IntentRouterDecision,
  SessionMessage,
} from '../types/pipeline.types';

@Injectable()
export class IntentRouterService {
  route(
    message: string,
    _history: SessionMessage[],
    currentRoutePois?: Array<{ poi_id: string; title?: string | null }>,
  ): IntentRouterDecision {
    const query = message.trim().toLowerCase();

    let decision: IntentRouterDecision = {
      action_type: 'NEW_ROUTE',
      confidence: 0.85,
      target_poi_id: null,
      route_mode: 'full_rebuild',
    };

    if (this.looksLikeAddDays(query)) {
      decision = {
        action_type: 'ADD_DAYS',
        confidence: 0.75,
        target_poi_id: null,
        route_mode: 'targeted_mutation',
      };
    } else if (this.looksLikeGlobalFilter(query)) {
      decision = {
        action_type: 'APPLY_GLOBAL_FILTER',
        confidence: 0.74,
        target_poi_id: null,
        route_mode: 'targeted_mutation',
      };
    } else if (this.looksLikeRemovePoi(query)) {
      decision = {
        action_type: 'REMOVE_POI',
        confidence: 0.65,
        target_poi_id: this.extractTargetPoiId(query, currentRoutePois),
        route_mode: 'targeted_mutation',
      };
    } else if (this.looksLikeReplacePoi(query)) {
      decision = {
        action_type: 'REPLACE_POI',
        confidence: 0.68,
        target_poi_id: this.extractTargetPoiId(query, currentRoutePois),
        route_mode: 'targeted_mutation',
      };
    }

    return this.applyLowConfidenceGuard(decision);
  }

  private applyLowConfidenceGuard(
    decision: IntentRouterDecision,
  ): IntentRouterDecision {
    if (decision.action_type !== 'NEW_ROUTE' && decision.confidence < 0.7) {
      return {
        ...decision,
        route_mode: 'full_rebuild',
        fallback_reason: 'LOW_CONFIDENCE',
      };
    }

    return decision;
  }

  private looksLikeAddDays(query: string): boolean {
    return /добав(ь|ить).*дн|ещ[её].*д(е|ё)н|продл(и|ить).*маршрут/u.test(
      query,
    );
  }

  private looksLikeGlobalFilter(query: string): boolean {
    return /без\s+|исключ(и|ить)|только\s+|избег(ай|ать)|не\s+нужн(ы|о)/u.test(
      query,
    );
  }

  private looksLikeRemovePoi(query: string): boolean {
    return /удал(и|ить)|убер(и|и?те)|исключ(и|ить)\s+(точк|мест|локац)/u.test(
      query,
    );
  }

  private looksLikeReplacePoi(query: string): boolean {
    return /замен(и|ить)|вместо\s+|поменя(й|ть)/u.test(query);
  }

  private extractTargetPoiId(
    query: string,
    currentRoutePois?: Array<{ poi_id: string; title?: string | null }>,
  ): string | null {
    const explicitIdMatch = query.match(/poi[_-]?id[:=\s]+([a-z0-9_-]+)/i);
    if (explicitIdMatch?.[1]) {
      return explicitIdMatch[1];
    }

    if (!currentRoutePois || currentRoutePois.length === 0) {
      return null;
    }

    for (const poi of currentRoutePois) {
      const title = poi.title?.trim().toLowerCase();
      if (title && query.includes(title)) {
        return poi.poi_id;
      }
    }

    return null;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  IntentRouterActionType,
  IntentRouterDecision,
  SessionMessage,
} from '../types/pipeline.types';
import { LlmClientService } from './llm-client.service';

interface IntentRouterLlmResponse {
  action_type: unknown;
  confidence: unknown;
  target_poi_id: unknown;
}

const INTENT_ROUTER_MODEL = 'openai/gpt-4o-mini';
const ALLOWED_ACTION_TYPES: IntentRouterActionType[] = [
  'REMOVE_POI',
  'REPLACE_POI',
  'ADD_POI',
  'ADD_DAYS',
  'APPLY_GLOBAL_FILTER',
  'REDUCE_BUDGET',
  'ADD_CATEGORY',
  'REMOVE_BORING',
  'NEW_ROUTE',
  'OFF_TOPIC',
  'SMALL_TALK',
];

const SYSTEM_PROMPT = `You are an intent router for travel route edits.
Analyze the user message with optional history and current route POIs.
Return ONLY valid JSON with this exact structure:
{ "action_type": "REMOVE_POI"|"REPLACE_POI"|"ADD_POI"|"ADD_DAYS"|"APPLY_GLOBAL_FILTER"|"REDUCE_BUDGET"|"ADD_CATEGORY"|"REMOVE_BORING"|"NEW_ROUTE"|"OFF_TOPIC"|"SMALL_TALK", "confidence": number, "target_poi_id": string|null }

Action type rules:
- NEW_ROUTE: use when (a) currentRoutePois is empty and user asks about a city/destination/trip, OR (b) user explicitly wants to start over / build a completely new route ("заново", "с нуля", "новый маршрут"). This is the DEFAULT for travel requests when there is no existing route.
- REMOVE_POI: user wants to delete a specific place from the CURRENT route (e.g. "удали X", "убери X", "исключи X"). Always REMOVE_POI if X is in currentRoutePois.
- ADD_POI: user wants to add a new place to the CURRENT route (e.g. "добавь кафе", "включи музей", "добавь X"). The new point is appended without changing existing points order.
- REPLACE_POI: user wants to swap/change a specific point in the CURRENT route (e.g. "замени X", "поменяй X на что-то другое", "вместо X поставь Y").
- ADD_DAYS: user wants to extend the trip with more days.
- REDUCE_BUDGET: user wants a cheaper route (e.g. "сделай дешевле", "снизь бюджет").
- ADD_CATEGORY: user wants more items of a category added to the CURRENT route (e.g. "добавь больше музеев", "найди кино").
- REMOVE_BORING: user wants to remove dull or low-rated POIs from the CURRENT route (e.g. "удали скучное", "убери неинтересное").
- OFF_TOPIC: request is NOT related to travel, routes, places, food, or cities at all.
- SMALL_TALK: user is just greeting or chatting without any travel intent.

Critical rules:
- If currentRoutePois is NOT empty and the user asks to add/remove/change a specific point — use ADD_POI/REMOVE_POI/REPLACE_POI, NOT NEW_ROUTE. Mutations preserve existing route order.
- If currentRoutePois is empty and the request mentions a city or destination — always NEW_ROUTE.
- For REMOVE_POI/REPLACE_POI, target_poi_id is the ID from currentRoutePois that best matches the user's request.
- confidence must be a number between 0 and 1.
- target_poi_id must be a string ID or null.`;

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger('AI_PIPELINE:IntentRouter');
  private recentQueries: string[] = [];
  private readonly MAX_RECENT_QUERIES = 10;

  constructor(private readonly llmClientService: LlmClientService) {}

  private calculateLevenshteinDistance(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix: number[][] = Array(len2 + 1)
      .fill(null)
      .map(() => Array(len1 + 1).fill(0));

    for (let i = 0; i <= len1; i++) matrix[0][i] = i;
    for (let j = 0; j <= len2; j++) matrix[j][0] = j;

    for (let j = 1; j <= len2; j++) {
      for (let i = 1; i <= len1; i++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + cost,
        );
      }
    }

    return matrix[len2][len1];
  }

  private isSemanticSpam(text: string): boolean {
    const normalized = text.toLowerCase().trim();
    const threshold = Math.max(3, Math.floor(normalized.length * 0.2)); // 20% difference threshold

    for (const recentQuery of this.recentQueries) {
      const distance = this.calculateLevenshteinDistance(
        normalized,
        recentQuery.toLowerCase(),
      );
      if (distance <= threshold) {
        this.logger.warn(
          `Semantic spam detected: "${text}" is similar to recent query (distance: ${distance})`,
        );
        return true;
      }
    }

    return false;
  }

  private recordQuery(text: string): void {
    this.recentQueries.push(text);
    if (this.recentQueries.length > this.MAX_RECENT_QUERIES) {
      this.recentQueries.shift();
    }
  }

  private getSpamScore(text: string): number {
    let score = 0;
    if (text.length < 3) score += 1;
    if (/^[a-zA-Z0-9]+$/.test(text)) score += 1;
    if (/(.)\1{5,}/.test(text)) score += 2;
    if (/https?:\/\//.test(text)) score += 2;
    // Add semantic spam detection to score
    if (this.isSemanticSpam(text)) score += 3;
    return score;
  }

  private isTravelRelatedRuleBased(text: string): boolean {
    const travelKeywords = [
      'маршрут',
      'поездка',
      'город',
      'сходить',
      'достопримечательности',
      'еда',
      'ресторан',
      'кафе',
      'музей',
      'парк',
      'план',
      'поехать',
      'найти',
      'удали',
      'замени',
      'добавь',
      'завтрак',
      'обед',
      'ужин',
      'тур',
      'день',
      'бюджет',
    ];
    return travelKeywords.some((kw) => text.toLowerCase().includes(kw));
  }

  async route(
    message: string,
    history: SessionMessage[],
    currentRoutePois?: Array<{ poi_id: string; title?: string | null }>,
  ): Promise<IntentRouterDecision> {
    const query = message.trim();

    // 1. Anti-Spam Check
    const spamScore = this.getSpamScore(query);
    if (spamScore >= 3) {
      this.logger.warn(
        `Spam detected for query: "${query}" (spam score: ${spamScore})`,
      );
      return {
        action_type: 'OFF_TOPIC',
        confidence: 1,
        target_poi_id: null,
        route_mode: 'full_rebuild',
        fallback_reason:
          spamScore >= 5 ? 'SEMANTIC_SPAM_BLOCKED' : 'SPAM_BLOCKED',
      };
    }

    // Record query for future semantic spam detection
    this.recordQuery(query);

    const llmPayload = {
      message: query,
      history: history.slice(-10),
      currentRoutePois: currentRoutePois ?? [],
    };

    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify(llmPayload),
        },
      ];

      const content = await this.llmClientService.chat(messages, {
        jsonMode: true,
      });

      const parsed = this.parseAndValidateLlmResponse(content || '{}');

      // 2. Rule-based + LLM Combo for OFF_TOPIC
      const isTravelRelated = this.isTravelRelatedRuleBased(query);
      if (
        !isTravelRelated &&
        parsed.confidence < 0.7 &&
        parsed.action_type !== 'OFF_TOPIC' &&
        parsed.action_type !== 'SMALL_TALK'
      ) {
        parsed.action_type = 'OFF_TOPIC';
      }

      const targetPoiId = this.resolveTargetPoiId(
        query,
        parsed.action_type,
        parsed.target_poi_id,
        currentRoutePois,
      );
      const hasCurrentRoute = (currentRoutePois?.length ?? 0) > 0;
      const normalizedActionType = this.normalizeActionTypeForSessionState(
        parsed.action_type,
        hasCurrentRoute,
      );

      return this.applyDeterministicPostProcessing({
        action_type: normalizedActionType,
        confidence: parsed.confidence,
        target_poi_id:
          normalizedActionType === 'NEW_ROUTE' ||
          normalizedActionType === 'OFF_TOPIC' ||
          normalizedActionType === 'SMALL_TALK'
            ? null
            : targetPoiId,
        route_mode:
          normalizedActionType === 'REMOVE_POI' ||
          normalizedActionType === 'REPLACE_POI' ||
          normalizedActionType === 'ADD_POI' ||
          normalizedActionType === 'ADD_DAYS'
            ? 'targeted_mutation'
            : 'full_rebuild',
      });
    } catch (error) {
      this.logger.warn(
        `Intent router LLM failed, fallback to NEW_ROUTE: ${String(error)}`,
      );

      return {
        action_type: 'NEW_ROUTE',
        confidence: 0,
        target_poi_id: null,
        route_mode: 'full_rebuild',
      };
    }
  }

  private parseAndValidateLlmResponse(payload: string): {
    action_type: IntentRouterActionType;
    confidence: number;
    target_poi_id: string | null;
  } {
    const parsed = JSON.parse(payload) as IntentRouterLlmResponse;

    if (
      !ALLOWED_ACTION_TYPES.includes(
        parsed.action_type as IntentRouterActionType,
      )
    ) {
      throw new Error('Intent router returned unknown action_type');
    }

    if (
      typeof parsed.confidence !== 'number' ||
      !Number.isFinite(parsed.confidence)
    ) {
      throw new Error('Intent router returned invalid confidence');
    }

    if (
      parsed.target_poi_id !== null &&
      typeof parsed.target_poi_id !== 'string'
    ) {
      throw new Error('Intent router returned invalid target_poi_id');
    }

    return {
      action_type: parsed.action_type as IntentRouterActionType,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      target_poi_id: parsed.target_poi_id,
    };
  }

  private applyDeterministicPostProcessing(
    decision: IntentRouterDecision,
  ): IntentRouterDecision {
    if (decision.action_type !== 'NEW_ROUTE' && decision.confidence < 0.4) {
      return {
        ...decision,
        route_mode: 'full_rebuild',
        fallback_reason: 'LOW_CONFIDENCE',
      };
    }

    return {
      ...decision,
      route_mode:
        decision.action_type === 'NEW_ROUTE'
          ? 'full_rebuild'
          : 'targeted_mutation',
      fallback_reason: undefined,
    };
  }

  private normalizeActionTypeForSessionState(
    actionType: IntentRouterActionType,
    hasCurrentRoute: boolean,
  ): IntentRouterActionType {
    if (hasCurrentRoute) {
      return actionType;
    }

    if (
      actionType === 'REMOVE_POI' ||
      actionType === 'REPLACE_POI' ||
      actionType === 'ADD_DAYS' ||
      actionType === 'APPLY_GLOBAL_FILTER'
    ) {
      return 'NEW_ROUTE';
    }

    return actionType;
  }

  private resolveTargetPoiId(
    query: string,
    actionType: IntentRouterActionType,
    llmTargetPoiId: string | null,
    currentRoutePois?: Array<{ poi_id: string; title?: string | null }>,
  ): string | null {
    const explicitId = this.extractExplicitPoiId(query);
    if (explicitId) {
      return explicitId;
    }

    if (
      typeof llmTargetPoiId === 'string' &&
      llmTargetPoiId.trim().length > 0
    ) {
      return llmTargetPoiId.trim();
    }

    if (actionType !== 'REMOVE_POI' && actionType !== 'REPLACE_POI') {
      return null;
    }

    return this.matchPoiByTitle(query, currentRoutePois);
  }

  private extractExplicitPoiId(query: string): string | null {
    const explicitIdMatch = query.match(/poi[_-]?id[:=\s]+([a-z0-9_-]+)/i);
    if (explicitIdMatch?.[1]) {
      return explicitIdMatch[1];
    }

    return null;
  }

  private matchPoiByTitle(
    query: string,
    currentRoutePois?: Array<{ poi_id: string; title?: string | null }>,
  ): string | null {
    if (!currentRoutePois || currentRoutePois.length === 0) {
      return null;
    }

    const normalizedQuery = query.trim().toLowerCase();

    for (const poi of currentRoutePois) {
      const title = poi.title?.trim().toLowerCase();
      if (title && normalizedQuery.includes(title)) {
        return poi.poi_id;
      }
    }

    return null;
  }
}

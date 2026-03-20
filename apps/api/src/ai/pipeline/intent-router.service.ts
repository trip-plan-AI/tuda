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
  'TRAVEL_CHAT',
  'OFF_TOPIC',
  'SMALL_TALK',
];

const SYSTEM_PROMPT = `You are an intent router for travel route edits.
Analyze the user message with optional history and current route POIs.
Return ONLY valid JSON with this exact structure:
{ "action_type": "REMOVE_POI"|"REPLACE_POI"|"ADD_POI"|"ADD_DAYS"|"APPLY_GLOBAL_FILTER"|"REDUCE_BUDGET"|"ADD_CATEGORY"|"REMOVE_BORING"|"NEW_ROUTE"|"TRAVEL_CHAT"|"OFF_TOPIC"|"SMALL_TALK", "confidence": number, "target_poi_id": string|null }

Action type rules:
- NEW_ROUTE: use when (a) currentRoutePois is empty and user asks about a city/destination/trip with enough specifics to build a route, OR (b) user explicitly wants to start over / build a completely new route ("заново", "с нуля", "новый маршрут"). NEVER use NEW_ROUTE for deletion requests ("удали", "убери", "очисти", "сотри") even if currentRoutePois is empty.
- REMOVE_POI: user wants to delete a SINGLE specific named place from the CURRENT route ("удали X", "убери X", "исключи X") — set target_poi_id to the matching ID. OR all places at once ("удали весь маршрут", "очисти маршрут", "убери все точки", "сотри всё", "удали все места") — set target_poi_id to "ALL". For multi-point positional requests ("удали первые 3 точки", "оставь только последние 2", "убери 2 первых") use TRAVEL_CHAT instead — it can handle complex route edits.
- ADD_POI: user wants to add a new place to the CURRENT route (e.g. "добавь кафе", "включи музей", "добавь X"). The new point is appended without changing existing points order.
- REPLACE_POI: user wants to swap/change a specific point in the CURRENT route (e.g. "замени X", "поменяй X на что-то другое", "вместо X поставь Y").
- ADD_DAYS: user wants to extend the trip with more days.
- REDUCE_BUDGET: user wants a cheaper route (e.g. "сделай дешевле", "снизь бюджет").
- ADD_CATEGORY: user wants more items of a category added to the CURRENT route (e.g. "добавь больше музеев", "найди кино").
- REMOVE_BORING: user wants to remove dull or low-rated POIs from the CURRENT route (e.g. "удали скучное", "убери неинтересное").
- TRAVEL_CHAT: use for (a) conversational travel talk without a clear actionable request — vague preferences, general travel advice, comparing destinations; (b) when currentRoutePois is NOT empty and user asks general questions about the route; (c) multi-point positional edits like "удали первые 3 точки", "оставь только последние 2", "поменяй местами 1 и 3 точки" — complex operations that require understanding the route structure.
- OFF_TOPIC: request is NOT related to travel, routes, places, food, or cities at all (e.g. math, coding, recipes unrelated to travel).
- SMALL_TALK: user is just greeting or chatting without any travel intent ("привет", "как дела", "спасибо").

Critical rules:
- If currentRoutePois is NOT empty and the user asks to add/remove/change a specific point — use ADD_POI/REMOVE_POI/REPLACE_POI, NOT NEW_ROUTE. Mutations preserve existing route order.
- If currentRoutePois is empty and the request mentions a specific city clearly — use NEW_ROUTE.
- If currentRoutePois is empty and the destination is vague/unclear — use TRAVEL_CHAT to gather more info.
- For REMOVE_POI/REPLACE_POI, target_poi_id is the ID from currentRoutePois that best matches the user's request.
- confidence must be a number between 0 and 1.
- target_poi_id must be a string ID or null.

When in doubt between a specific mutation and TRAVEL_CHAT — prefer TRAVEL_CHAT. It can handle any free-form route edit. Examples of TRAVEL_CHAT:
- "сделай маршрут покороче" (ambiguous: remove points? shorten times?)
- "мне не нравятся первые точки" (which ones exactly?)
- "переставь местами" (reorder)
- "удали половину" (positional)
- "оставь только музеи" (filter by category across entire route)
- "сделай маршрут поспортивнее" (subjective replacement)
- "убери 2 первых" / "удали последнюю" (positional, not by name)
- "можно без ресторанов?" (category removal across route)
- Any request about multiple points by position, number, or category — not by specific POI name.`;

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger('AI_PIPELINE:IntentRouter');

  constructor(private readonly llmClientService: LlmClientService) {}

  private getSpamScore(text: string): number {
    let score = 0;
    if (text.length < 3) score += 1;
    if (/^[a-zA-Z0-9]+$/.test(text)) score += 1;
    if (/(.)\1{5,}/.test(text)) score += 2;
    if (/https?:\/\//.test(text)) score += 2;
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
        parsed.action_type !== 'SMALL_TALK' &&
        parsed.action_type !== 'TRAVEL_CHAT'
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
    // ADD_CATEGORY and REMOVE_BORING are always targeted mutations regardless of confidence:
    // falling back to full_rebuild would rebuild the whole route with all POI categories,
    // adding unrelated points (e.g. food + attractions when user only asked for museums).
    const alwaysTargetedMutation: IntentRouterActionType[] = [
      'ADD_CATEGORY',
      'REMOVE_BORING',
      'REDUCE_BUDGET',
    ];

    if (
      decision.action_type !== 'NEW_ROUTE' &&
      !alwaysTargetedMutation.includes(decision.action_type) &&
      decision.confidence < 0.4
    ) {
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

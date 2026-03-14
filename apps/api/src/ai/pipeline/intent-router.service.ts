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
  'NEW_ROUTE',
];

const SYSTEM_PROMPT = `You are an intent router for travel route edits.
Analyze the user message with optional history and current route POIs.
Return ONLY valid JSON with this exact structure:
{ "action_type": "REMOVE_POI"|"REPLACE_POI"|"ADD_POI"|"ADD_DAYS"|"APPLY_GLOBAL_FILTER"|"NEW_ROUTE", "confidence": number, "target_poi_id": string|null }
Rules:
- action_type must be one of allowed values.
- confidence must be a number between 0 and 1.
- target_poi_id must be a string ID or null.
- Use NEW_ROUTE when user wants to create a COMPLETELY new trip or start over.
- Use REMOVE_POI when user wants to delete a specific place from the CURRENT route.
- Use ADD_POI when user wants to add a new place or category (e.g. "add a cafe", "find a museum") to the CURRENT route.
- If the user says "Удали точку X" or "Убери X", and X is in currentRoutePois, it is ALWAYS REMOVE_POI.
- If currentRoutePois is empty (no existing route in this session), treat the request as NEW_ROUTE.
- For REMOVE_POI/REPLACE_POI, target_poi_id is the ID from currentRoutePois that best matches the user's request.
- Be biased towards mutations (REMOVE/REPLACE/ADD_POI) if there is an existing route.`;

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger('AI_PIPELINE:IntentRouter');

  constructor(private readonly llmClientService: LlmClientService) {}

  async route(
    message: string,
    history: SessionMessage[],
    currentRoutePois?: Array<{ poi_id: string; title?: string | null }>,
  ): Promise<IntentRouterDecision> {
    const query = message.trim();
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

      const response =
        await this.llmClientService.client.chat.completions.create({
          model: INTENT_ROUTER_MODEL,
          response_format: { type: 'json_object' },
          messages,
        });

      const content = response.choices[0]?.message?.content ?? '{}';
      const parsed = this.parseAndValidateLlmResponse(content);
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
          normalizedActionType === 'NEW_ROUTE' ? null : targetPoiId,
        route_mode:
          normalizedActionType === 'REMOVE_POI' ||
          normalizedActionType === 'REPLACE_POI' ||
          normalizedActionType === 'ADD_POI'
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

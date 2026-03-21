import { Injectable, Logger } from '@nestjs/common';

const ORDINAL_DAY_MAP: Record<string, number> = {
  перв: 1, втор: 2, трет: 3, четв: 4, пят: 5,
  шест: 6, седьм: 7, восьм: 8, девят: 9, десят: 10,
};

/**
 * Deterministically extracts the ORDINAL POSITION number from a query like
 * "удали 3-ю точку" → 3, "убери 5-е место" → 5, "удали вторую" → 2.
 * Returns null if no ordinal position is found.
 * Used to override the LLM's positional_count when direction="exact".
 */
function extractOrdinalPosition(query: string): number | null {
  const q = query.toLowerCase();

  // Numeric ordinal with explicit hyphen: "3-ю", "5-е", "2-й", "1-я", "4-го" etc.
  // Note: \b works for the leading digit (ASCII \w), but Cyrillic ordinal suffixes
  // are \W in JS regex — so we skip trailing \b and require the hyphen to avoid
  // false positives like "3 едой" matching "е".
  const numericOrdinal = q.match(/\b(\d+)-(?:ю|е|й|я|го|му|х|ой|ей|ую)/);
  if (numericOrdinal) {
    const n = parseInt(numericOrdinal[1], 10);
    if (n >= 1 && n <= 50) return n;
  }

  // Word ordinals: split on whitespace — Cyrillic chars are \W in JS regex, so
  // \b doesn't create word boundaries around them. Splitting gives actual tokens.
  const wordOrdinals: Record<string, number> = {
    перв: 1, втор: 2, трет: 3, четвёрт: 4, четверт: 4,
    пят: 5, шест: 6, седьм: 7, восьм: 8, девят: 9, десят: 10,
    одиннадцат: 11, двенадцат: 12,
  };
  const tokens = q.split(/[\s,.!?]+/);
  for (const [prefix, num] of Object.entries(wordOrdinals)) {
    if (tokens.some((w) => w.startsWith(prefix))) return num;
  }

  return null;
}

function extractDayNumberFromQuery(query: string): number | null {
  const q = query.toLowerCase();
  // Numeric: "в 3 дне", "3-й день", "день 3"
  const numericMatch = q.match(/\bв\s+(\d+)\s*[- ]?м?\s*дн[еи]|\b(\d+)[- ]?й\s+день|\bдень\s+(\d+)/i);
  if (numericMatch) {
    const n = parseInt(numericMatch[1] ?? numericMatch[2] ?? numericMatch[3], 10);
    if (n >= 1 && n <= 30) return n;
  }
  // Ordinal words: "во втором дне", "в первый день", "третьем дне"
  for (const [prefix, num] of Object.entries(ORDINAL_DAY_MAP)) {
    if (new RegExp(`\\b${prefix}\\w*\\s+(день|дн[еи])`, 'i').test(q) ||
        new RegExp(`(день|дн[еи])\\s+${prefix}\\w*`, 'i').test(q)) {
      return num;
    }
  }
  return null;
}
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
  positional_count?: unknown;
  positional_direction?: unknown;
  target_day_number?: unknown;
}

export interface IntentRouterContext {
  has_existing_route: boolean;
  current_poi_count: number;
  current_city: string | null;
  current_pois?: Array<{ poi_id: string; title?: string | null }>;
}

const INTENT_ROUTER_MODEL = 'openai/gpt-4o-mini';
const ALLOWED_ACTION_TYPES: IntentRouterActionType[] = [
  'REMOVE_POI',
  'REMOVE_POSITIONAL',
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
{ "action_type": "REMOVE_POI"|"REMOVE_POSITIONAL"|"REPLACE_POI"|"ADD_POI"|"ADD_DAYS"|"APPLY_GLOBAL_FILTER"|"REDUCE_BUDGET"|"ADD_CATEGORY"|"REMOVE_BORING"|"NEW_ROUTE"|"TRAVEL_CHAT"|"OFF_TOPIC"|"SMALL_TALK", "confidence": number, "target_poi_id": string|null, "positional_count": number|null, "positional_direction": "start"|"end"|"keep_start"|"keep_end"|"exact"|null, "target_day_number": number|null }

All fields are always required. For non-REMOVE_POSITIONAL actions set positional_count=null, positional_direction=null, target_day_number=null.

Action type rules:
- NEW_ROUTE: use when (a) currentRoutePois is empty and user asks about a city/destination/trip with enough specifics to build a route, OR (b) user explicitly wants to start over / build a completely new route ("заново", "с нуля", "новый маршрут"). NEVER use NEW_ROUTE for deletion requests ("удали", "убери", "очисти", "сотри") even if currentRoutePois is empty.
- REMOVE_POSITIONAL: user wants to delete points BY POSITION (not by name). This includes ALL of the following — use REMOVE_POSITIONAL, never TRAVEL_CHAT, for these:
  DIRECTION RULES (positional_direction + positional_count):
  - "удали последние N" / "убери N последних" → direction="end", count=N
  - "удали первые N" / "убери N первых"        → direction="start", count=N
  - "удали N точек/мест" (no start/end qualifier) → direction="end", count=N
  - "оставь только первые N" / "оставь первые N" → direction="keep_start", count=N. CRITICAL: count = the EXACT number N from the user's message, copy it verbatim. DO NOT compute (total - N). Example: "оставь только первые 5 точек" with 9 total → count=5 (not 4).
  - "оставь только последние N" / "оставь последние N" → direction="keep_end", count=N. CRITICAL: count = N from message verbatim. Example: "оставь последние 2 места" → count=2 (not 7).
  - "оставь N точек" / "оставь только N" / "оставь N мест" (no first/last qualifier) → direction="keep_start", count=N. Example: "оставь 3 точки" → {direction:"keep_start",count:3}.
  - "сделай N точек" / "хочу N точек" / "нужно N точек" / "сделай маршрут на N точек" → direction="keep_start", count=N. Example: "сделай 3 точки" → {direction:"keep_start",count:3}. This means REDUCE to N points, NOT delete N points.
  - "удали 3-ю точку" / "убери вторую" / "удали пятую" (ORDINAL = specific position) → direction="exact", count=POSITION_NUMBER
    CRITICAL for exact: count = the ORDINAL POSITION, NOT the quantity. "вторую" → count=2, "3-ю" → count=3, "пятую" → count=5, "первую" → count=1. Do NOT set count=1 for ordinals.
  HOW TO DISTINGUISH ordinal vs cardinal: "удали 3 точки" (delete 3 = cardinal → direction="end", count=3) vs "удали 3-ю точку" (delete THE 3rd = ordinal → direction="exact", count=3).
  DAY TARGETING (target_day_number): if user specifies a day, ALWAYS set target_day_number to the integer day number:
  - "первый день" / "в первый день" / "в 1 дне" / "1-й день" → target_day_number=1
  - "второй день" / "во втором дне" / "во 2 дне" / "2-й день" → target_day_number=2
  - "третий день" / "в 3 дне" / "3-й день" → target_day_number=3
  - "четвёртый день" → target_day_number=4, "пятый" → 5, etc.
  - No day mentioned → target_day_number=null
  Examples: "удали первые 2 точки во втором дне" → {direction:"start",count:2,target_day_number:2}. "в 1 день удали последнюю" → {direction:"end",count:1,target_day_number:1}. "в 3 дне оставь только первые 2" → {direction:"keep_start",count:2,target_day_number:3}.
  WARNING: "в 3 дне" / "в третьем дне" means "within day 3" (it's a scope, not a count of days) → target_day_number=3. NEVER use ADD_DAYS for these — ADD_DAYS is only for "добавь ещё 1 день", "хочу 3 дня", "extend the trip".
  ALWAYS use REMOVE_POSITIONAL for ANY positional deletion/keep request.
- REMOVE_POI: user wants to delete a SINGLE specific named place from the CURRENT route ("удали X", "убери X", "исключи X") — set target_poi_id to the matching ID. OR all places at once ("удали весь маршрут", "очисти маршрут", "убери все точки", "сотри всё", "удали все места") — set target_poi_id to "ALL". IMPORTANT: "удали все кафе/рестораны/музеи/памятники" is NOT "ALL" — this is category-based removal → use TRAVEL_CHAT. target_poi_id="ALL" means DELETE THE ENTIRE ROUTE, not a category. For positional requests ("удали первые 3 точки", "оставь только последние 2") use REMOVE_POSITIONAL, not TRAVEL_CHAT.
- ADD_POI: user wants to add a new place to the CURRENT route (e.g. "добавь кафе", "включи музей", "добавь X", "добавь 1 точку", "добавь ещё одно место", "добавь 2 места", "добавь точку"). ALWAYS use ADD_POI when user says "добавь [число] точку/точки/место/места" — even if category is unspecified. The new point is appended without changing existing points order.
- REPLACE_POI: user wants to swap/change a specific point in the CURRENT route (e.g. "замени X", "поменяй X на что-то другое", "вместо X поставь Y").
- ADD_DAYS: user wants to extend the trip with more days.
- REDUCE_BUDGET: user wants a cheaper route (e.g. "сделай дешевле", "снизь бюджет").
- ADD_CATEGORY: user wants more items of a category added to the CURRENT route (e.g. "добавь больше музеев", "найди кино").
- REMOVE_BORING: user wants to remove dull or low-rated POIs from the CURRENT route (e.g. "удали скучное", "убери неинтересное").
- TRAVEL_CHAT: use for (a) conversational travel talk without a clear actionable request — vague preferences, general travel advice, comparing destinations; (b) when currentRoutePois is NOT empty and user asks general questions about the route; (c) complex reordering edits like "поменяй местами 1 и 3 точки" — NOT for simple positional deletions (those are REMOVE_POSITIONAL).
- OFF_TOPIC: request is NOT related to travel, routes, places, food, or cities at all (e.g. math, coding, recipes unrelated to travel).
- SMALL_TALK: user is just greeting or chatting without any travel intent ("привет", "как дела", "спасибо").

Critical rules:
- If currentRoutePois is NOT empty and the user asks to add/remove/change a specific point — use ADD_POI/REMOVE_POI/REPLACE_POI, NOT NEW_ROUTE. Mutations preserve existing route order.
- If currentRoutePois is empty and the request mentions a specific city clearly — use NEW_ROUTE.
- If currentRoutePois is empty and the destination is vague/unclear — use TRAVEL_CHAT to gather more info.
- For REMOVE_POI/REPLACE_POI, target_poi_id is the ID from currentRoutePois that best matches the user's request.
- confidence must be a number between 0 and 1.
- target_poi_id must be a string ID or null.

CRITICAL STATE RULES:
The system state is passed to you as JSON: { "has_existing_route": boolean }.

IF has_existing_route IS TRUE:
  - The user ALREADY HAS a planned route.
  - Any request to "add" / "добавь" / "включи", "remove" / "удали" / "убери" / "исключи", "change" / "замени" / "поменяй" MUST be classified as a mutation (ADD_POI / REMOVE_POI / REPLACE_POI).
  - NEVER return NEW_ROUTE unless the user EXPLICITLY says "заново", "с нуля", "новый маршрут", "начни заново", "сбрось всё", or names a completely different city.

IF has_existing_route IS FALSE:
  - The user DOES NOT have a route yet.
  - You CANNOT return any mutation type — there is nothing to mutate.
  - Requests to find places, visit a city, or create a plan MUST be classified as NEW_ROUTE.
  - Vague requests without a clear destination MUST be classified as TRAVEL_CHAT.

PRIORITY RULE — mutations ALWAYS win over TRAVEL_CHAT:
- If the message contains "добавь/добавить/включи" + any noun (кафе, музей, точку, место, парк, ресторан, or any count) → ALWAYS use ADD_POI or ADD_CATEGORY. NEVER TRAVEL_CHAT. TRAVEL_CHAT cannot add new points — only our pipeline can.
- If the message contains "удали/убери/исключи" + a SPECIFIC place NAME from currentRoutePois → ALWAYS use REMOVE_POI. TRAVEL_CHAT is only for positional removal ("удали первые 3", "удали последнюю").
- COMPOUND AND STRUCTURAL EXCEPTION: If the message requests MULTIPLE actions (like "удали X и добавь Y") or STRUCTURAL changes like removing a whole day ("удали второй день"), ALWAYS use TRAVEL_CHAT. TRAVEL_CHAT can process multiple intents and days simultaneously. Ignore the priority rules for ADD/REMOVE in these cases.
- If the message contains "замени/поменяй/вместо" + a SPECIFIC place NAME → ALWAYS use REPLACE_POI.
- If the message contains "дешевле/снизь бюджет" → ALWAYS use REDUCE_BUDGET.
- If the message contains "больше музеев/ресторанов/кафе" → ALWAYS use ADD_CATEGORY.

Use TRAVEL_CHAT ONLY for these cases (when no clear add/remove/replace/budget action):
- Subjective edits without specific action: "сделай маршрут покороче", "сделай поспортивнее"
- Reordering: "переставь местами", "поменяй местами 1 и 3 точки"
- Category filtering across route: "оставь только музеи", "можно без ресторанов?"
- Vague dissatisfaction: "мне не нравятся первые точки"
- General travel questions about the existing route
IMPORTANT: "удали первые N точек", "оставь только последние N", "оставь N точек", "сделай N точек" — these are ALL REMOVE_POSITIONAL, NOT TRAVEL_CHAT. Never route positional count-based requests to TRAVEL_CHAT.`;

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
      'оставь',
      'точк',  // covers "точки", "точек", "точку"
      'сделай',
      'убери',
      'исключи',
      'место',
      'места',
    ];
    return travelKeywords.some((kw) => text.toLowerCase().includes(kw));
  }

  async route(
    message: string,
    history: SessionMessage[],
    context: IntentRouterContext,
  ): Promise<IntentRouterDecision> {
    const query = message.trim();
    const currentRoutePois = context.current_pois ?? [];
    const hasCurrentRoute = context.has_existing_route;

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
      has_existing_route: context.has_existing_route,
      current_poi_count: context.current_poi_count,
      current_city: context.current_city,
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

      const parsed = this.parseAndValidateLlmResponse(content || '{}', query);

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

      // ── Deterministic override: fix LLM misclassification ──────────────────
      // ADD requests MUST use ADD_POI/ADD_CATEGORY — TRAVEL_CHAT cannot add new POIs.
      if (parsed.action_type === 'TRAVEL_CHAT' && hasCurrentRoute) {
        parsed.action_type = this.overrideTravelChatIfActionable(
          query,
          parsed.action_type,
        );
      }

      const targetPoiId = this.resolveTargetPoiId(
        query,
        parsed.action_type,
        parsed.target_poi_id,
        currentRoutePois,
      );
      const normalizedActionType = this.normalizeActionTypeForSessionState(
        parsed.action_type,
        hasCurrentRoute,
        query,
      );

      const baseDecision: IntentRouterDecision = {
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
          normalizedActionType === 'REMOVE_POSITIONAL' ||
          normalizedActionType === 'REPLACE_POI' ||
          normalizedActionType === 'ADD_POI' ||
          normalizedActionType === 'ADD_DAYS'
            ? 'targeted_mutation'
            : 'full_rebuild',
      };

      // Deterministic ordinal-position override: handles "удали 3-ю точку",
      // "убери вторую", "убери 5-е место" regardless of what the LLM classified.
      // LLMs often return REMOVE_POI (thinking "delete 1 specific item") or
      // REMOVE_POSITIONAL with count=1 for these queries.
      // We detect the ordinal pattern and force REMOVE_POSITIONAL direction=exact.
      const ordinalPos = extractOrdinalPosition(query);
      if (
        ordinalPos !== null &&
        ordinalPos > 1 &&
        (normalizedActionType === 'REMOVE_POI' ||
          normalizedActionType === 'REMOVE_POSITIONAL')
      ) {
        baseDecision.action_type = 'REMOVE_POSITIONAL';
        baseDecision.positional_direction = 'exact';
        baseDecision.positional_count = ordinalPos;
        baseDecision.target_poi_id = null;
        baseDecision.route_mode = 'targeted_mutation';
      } else if (normalizedActionType === 'REMOVE_POSITIONAL') {
        // Pass through positional fields for non-ordinal REMOVE_POSITIONAL
        baseDecision.positional_count = parsed.positional_count;
        baseDecision.positional_direction = parsed.positional_direction;
        baseDecision.target_day_number = parsed.target_day_number;
      }

      return this.applyDeterministicPostProcessing(baseDecision);
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

  private parseAndValidateLlmResponse(payload: string, query = ''): {
    action_type: IntentRouterActionType;
    confidence: number;
    target_poi_id: string | null;
    positional_count?: number;
    positional_direction?: 'start' | 'end' | 'keep_start' | 'keep_end' | 'exact';
    target_day_number?: number;
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
      parsed.target_poi_id !== undefined &&
      typeof parsed.target_poi_id !== 'string'
    ) {
      throw new Error('Intent router returned invalid target_poi_id');
    }

    const result: {
      action_type: IntentRouterActionType;
      confidence: number;
      target_poi_id: string | null;
      positional_count?: number;
      positional_direction?: 'start' | 'end' | 'keep_start' | 'keep_end' | 'exact';
      target_day_number?: number;
    } = {
      action_type: parsed.action_type as IntentRouterActionType,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      target_poi_id: parsed.target_poi_id ?? null,
    };

    if (result.action_type === 'REMOVE_POSITIONAL') {
      const count =
        typeof parsed.positional_count === 'number'
          ? Math.floor(parsed.positional_count)
          : parseInt(String(parsed.positional_count ?? '0'), 10);
      const direction = parsed.positional_direction as string;
      const validDirections = ['start', 'end', 'keep_start', 'keep_end', 'exact'];
      result.positional_count = count > 0 ? count : 1;
      result.positional_direction = validDirections.includes(direction)
        ? (direction as 'start' | 'end' | 'keep_start' | 'keep_end' | 'exact')
        : 'end';

      const rawDay = parsed.target_day_number;
      const dayNum =
        typeof rawDay === 'number'
          ? rawDay
          : typeof rawDay === 'string'
            ? parseInt(rawDay, 10)
            : NaN;
      if (Number.isFinite(dayNum) && dayNum >= 1) {
        result.target_day_number = Math.floor(dayNum);
      } else {
        // Fallback: extract day number from query deterministically
        // Handles cases where LLM omits target_day_number (e.g. ordinal words)
        const extracted = extractDayNumberFromQuery(query);
        if (extracted !== null) {
          result.target_day_number = extracted;
        }
      }
    }

    return result;
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
      'REMOVE_POSITIONAL', // Positional ops are always deterministic — confidence is irrelevant
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
    query: string,
  ): IntentRouterActionType {
    // ── GUARDRAIL: duration phrases like "казань 2 дня" / "на 3 дня" should never
    // trigger removal. LLM confuses "keep 2 days" with "keep_end/keep_start".
    if (
      (actionType === 'REMOVE_POSITIONAL' || actionType === 'REMOVE_POI') &&
      /\d+\s*(дн[ейя]|day)/i.test(query) &&
      !/удал[иь]|убер[иь]|исключ|оставь|первы[еха]|последн[иеяхм]/i.test(query)
    ) {
      this.logger.warn(
        `Guardrail: ${actionType} → ADD_DAYS (duration query without explicit removal: "${query}")`,
      );
      return 'ADD_DAYS';
    }

    if (!hasCurrentRoute) {
      // No route exists — mutation-type actions degrade to NEW_ROUTE
      if (
        actionType === 'REMOVE_POI' ||
        actionType === 'REMOVE_POSITIONAL' ||
        actionType === 'REPLACE_POI' ||
        actionType === 'ADD_DAYS' ||
        actionType === 'APPLY_GLOBAL_FILTER'
      ) {
        return 'NEW_ROUTE';
      }
      return actionType;
    }

    // ── GUARDRAIL: route exists but LLM returned NEW_ROUTE ──────────────────
    // LLM does not know the system state — backend enforces the contract.
    if (actionType === 'NEW_ROUTE') {
      const q = query.toLowerCase();
      // User explicitly wants to restart
      if (/заново|с нуля|новый маршрут|начни заново|перестрой/.test(q)) {
        return 'NEW_ROUTE';
      }
      // Clear mutation signals — override
      if (/добав[ьи]|включи|добавить/.test(q)) {
        this.logger.warn(
          `Guardrail: NEW_ROUTE → ADD_POI (hasRoute=true, query="${query}")`,
        );
        return 'ADD_POI';
      }
      if (/удали|убери|исключи/.test(q)) {
        this.logger.warn(
          `Guardrail: NEW_ROUTE → REMOVE_POI (hasRoute=true, query="${query}")`,
        );
        return 'REMOVE_POI';
      }
      if (/замени|поменяй|вместо/.test(q)) {
        this.logger.warn(
          `Guardrail: NEW_ROUTE → REPLACE_POI (hasRoute=true, query="${query}")`,
        );
        return 'REPLACE_POI';
      }
      // Ambiguous — let TravelChat handle rather than destroying the route
      this.logger.warn(
        `Guardrail: NEW_ROUTE → TRAVEL_CHAT (hasRoute=true, ambiguous, query="${query}")`,
      );
      return 'TRAVEL_CHAT';
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

  /**
   * Deterministic override: if LLM classified as TRAVEL_CHAT but
   * the message is a clear actionable request (add/remove/replace/budget),
   * reclassify to the correct mutation type.
   *
   * TRAVEL_CHAT cannot add new POIs — only the pipeline can.
   * TRAVEL_CHAT is only correct for positional edits, reordering,
   * category filtering, and subjective edits.
   */
  private overrideTravelChatIfActionable(
    query: string,
    currentAction: IntentRouterActionType,
  ): IntentRouterActionType {
    const q = query.toLowerCase();

    // ── ADD detection ─────────────────────────────────────────────────────
    // Any "добавь/включи" request needs the pipeline to search for new POIs.
    // modifyRoute() cannot add — it only works with existing poi_ids.
    const isAdd = /добав[ьи]|включи|добавить/.test(q);
    if (isAdd) {
      // "добавь больше музеев/ресторанов/кафе" → ADD_CATEGORY
      if (/больше\s+(музе|рестора|кафе|парк|бар|театр|галере)/.test(q)) {
        this.logger.log(
          `Override TRAVEL_CHAT → ADD_CATEGORY (deterministic, query="${query}")`,
        );
        return 'ADD_CATEGORY';
      }
      // "добавь кафе", "добавь 1 точку", "добавь ещё место" → ADD_POI
      this.logger.log(
        `Override TRAVEL_CHAT → ADD_POI (deterministic, query="${query}")`,
      );
      return 'ADD_POI';
    }

    // ── REDUCE_BUDGET detection ───────────────────────────────────────────
    if (/дешевле|снизь.*бюджет|бюджет.*сниз|cheaper/.test(q)) {
      this.logger.log(
        `Override TRAVEL_CHAT → REDUCE_BUDGET (deterministic, query="${query}")`,
      );
      return 'REDUCE_BUDGET';
    }

    // ── REMOVE_BORING detection ───────────────────────────────────────────
    if (/(удали|убери)\s*(скучн|неинтересн|boring)/.test(q)) {
      this.logger.log(
        `Override TRAVEL_CHAT → REMOVE_BORING (deterministic, query="${query}")`,
      );
      return 'REMOVE_BORING';
    }

    // Positional removals ("удали первые 3", "убери последнюю") stay TRAVEL_CHAT —
    // modifyRoute handles these correctly with poi_id lists.
    // Named removals ("удали Красную площадь") should already be REMOVE_POI from LLM.

    return currentAction;
  }
}

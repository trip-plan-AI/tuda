/**
 * Integration tests: IntentRouterService with real LLM (GPT-4o-mini via OpenRouter).
 *
 * These tests call the actual AI model to verify it correctly classifies
 * REMOVE_POSITIONAL intents from user queries.
 *
 * Run: pnpm --filter api test -- --testPathPatterns="intent-router-positional.integration" --no-coverage --runInBand
 *
 * Requires env: OPENROUTER_API_KEY (or OPENAI_API_KEY) in ../../.env
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../../../.env') });

import { IntentRouterService, IntentRouterContext } from './intent-router.service';
import { LlmClientService } from './llm-client.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Mock route: 3 days, ~3 points each */
const ROUTE_POIS: IntentRouterContext['current_pois'] = [
  { poi_id: 'p1', title: 'Кремль' },
  { poi_id: 'p2', title: 'ГУМ' },
  { poi_id: 'p3', title: 'Третьяковская галерея' },
  { poi_id: 'p4', title: 'Парк Горького' },
  { poi_id: 'p5', title: 'ВДНХ' },
  { poi_id: 'p6', title: 'Коломенское' },
  { poi_id: 'p7', title: 'Воробьёвы горы' },
  { poi_id: 'p8', title: 'Музей космонавтики' },
  { poi_id: 'p9', title: 'Арбат' },
];

const CTX: IntentRouterContext = {
  has_existing_route: true,
  current_poi_count: ROUTE_POIS.length,
  current_city: 'Москва',
  current_pois: ROUTE_POIS,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

let service: IntentRouterService;

beforeAll(() => {
  const llmClient = new LlmClientService();
  service = new IntentRouterService(llmClient);
});

async function route(query: string) {
  return service.route(query, [], CTX);
}

// Increase timeout — real LLM calls can take 3-8 seconds
jest.setTimeout(30_000);

// ════════════════════════════════════════════════════════════════════════════
// 1. Basic direction classification
// ════════════════════════════════════════════════════════════════════════════

describe('Basic direction classification', () => {
  it('AI-01: "удали последние 3 точки" → end, count=3', async () => {
    const r = await route('удали последние 3 точки');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('end');
    expect(r.positional_count).toBe(3);
  });

  it('AI-02: "удали первые 2 места" → start, count=2', async () => {
    const r = await route('удали первые 2 места');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('start');
    expect(r.positional_count).toBe(2);
  });

  it('AI-03: "убери первую точку" → start или exact, count=1', async () => {
    const r = await route('убери первую точку');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_count).toBe(1);
    expect(['start', 'exact']).toContain(r.positional_direction);
  });

  it('AI-04: "удали последнее место" → end, count=1', async () => {
    const r = await route('удали последнее место');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('end');
    expect(r.positional_count).toBe(1);
  });

  it('AI-05: "оставь только первые 5 точек" → keep_start, count=5', async () => {
    const r = await route('оставь только первые 5 точек');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('keep_start');
    expect(r.positional_count).toBe(5);
  });

  it('AI-06: "оставь только последние 2 места" → keep_end, count=2', async () => {
    const r = await route('оставь только последние 2 места');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('keep_end');
    expect(r.positional_count).toBe(2);
  });

  it('AI-07: "удали 3-ю точку" → exact, count=3', async () => {
    const r = await route('удали 3-ю точку');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('exact');
    expect(r.positional_count).toBe(3);
  });

  it('AI-08: "убери 5-е место" → exact, count=5', async () => {
    const r = await route('убери 5-е место');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('exact');
    expect(r.positional_count).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Day targeting (target_day_number)
// ════════════════════════════════════════════════════════════════════════════

describe('Day targeting', () => {
  it('AI-09: "удали первые 2 точки во втором дне" → start, count=2, day=2', async () => {
    const r = await route('удали первые 2 точки во втором дне');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('start');
    expect(r.positional_count).toBe(2);
    expect(r.target_day_number).toBe(2);
  });

  it('AI-10: "в первый день удали последнюю точку" → end, count=1, day=1', async () => {
    const r = await route('в первый день удали последнюю точку');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('end');
    expect(r.positional_count).toBe(1);
    expect(r.target_day_number).toBe(1);
  });

  it('AI-11: "в 3 дне оставь только первые 2" → keep_start, count=2, day=3', async () => {
    const r = await route('в 3 дне оставь только первые 2');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('keep_start');
    expect(r.positional_count).toBe(2);
    expect(r.target_day_number).toBe(3);
  });

  it('AI-12: "удали последние 3 точки" без указания дня → day=null (глобально)', async () => {
    const r = await route('удали последние 3 точки');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.target_day_number == null).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Трудные случаи — ordinal vs cardinal
// ════════════════════════════════════════════════════════════════════════════

describe('Ordinal vs cardinal disambiguation', () => {
  it('AI-13: "удали 3 точки" (количественное) → end или start, count=3, НЕ exact', async () => {
    const r = await route('удали 3 точки');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_count).toBe(3);
    expect(r.positional_direction).not.toBe('exact');
  });

  it('AI-14: "удали вторую точку" (порядковое) → exact, count=2', async () => {
    const r = await route('удали вторую точку');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('exact');
    expect(r.positional_count).toBe(2);
  });

  it('AI-15: "убери 4 последних места" → end, count=4', async () => {
    const r = await route('убери 4 последних места');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.positional_direction).toBe('end');
    expect(r.positional_count).toBe(4);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Граничные запросы — что НЕ должно быть REMOVE_POSITIONAL
// ════════════════════════════════════════════════════════════════════════════

describe('Non-positional queries (should NOT be REMOVE_POSITIONAL)', () => {
  it('AI-16: "удали Кремль" → REMOVE_POI, не REMOVE_POSITIONAL', async () => {
    const r = await route('удали Кремль');
    expect(r.action_type).toBe('REMOVE_POI');
  });

  it('AI-17: "сделай маршрут дешевле" → REDUCE_BUDGET', async () => {
    const r = await route('сделай маршрут дешевле');
    expect(r.action_type).toBe('REDUCE_BUDGET');
  });

  it('AI-18: "добавь больше музеев" → ADD_CATEGORY', async () => {
    const r = await route('добавь больше музеев');
    expect(r.action_type).toBe('ADD_CATEGORY');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. route_mode — REMOVE_POSITIONAL всегда targeted_mutation
// ════════════════════════════════════════════════════════════════════════════

describe('route_mode for REMOVE_POSITIONAL', () => {
  it('AI-19: route_mode всегда targeted_mutation для positional запросов', async () => {
    const r = await route('удали первые 2 точки');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.route_mode).toBe('targeted_mutation');
  });

  it('AI-20: даже с указанием дня route_mode = targeted_mutation', async () => {
    const r = await route('во втором дне удали последнюю точку');
    expect(r.action_type).toBe('REMOVE_POSITIONAL');
    expect(r.route_mode).toBe('targeted_mutation');
  });
});

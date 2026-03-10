import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiQueryStore } from './ai-query.store';
import { api } from '@/shared/api';
import { useTripStore } from '@/entities/trip';

vi.mock('@/shared/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    del: vi.fn(),
  },
}));

describe('useAiQueryStore', () => {
  const baseSessionId = 'session-local-1';

  beforeEach(() => {
    useAiQueryStore.setState({
      sessions: {
        [baseSessionId]: {
          id: baseSessionId,
          title: 'Новый чат',
          tripId: 'trip-1',
          sessionId: null,
          messages: [],
          lastAppliedPlanMessageId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      activeSessionId: baseSessionId,
      messages: [],
      isLoading: false,
      isSessionsLoading: false,
      sessionId: null,
      lastAppliedPlanMessageId: null,
    });

    useTripStore.setState({
      currentTrip: {
        id: 'trip-1',
        title: 'T',
        description: null,
        budget: null,
        ownerId: 'u',
        isActive: true,
        isPredefined: false,
        startDate: null,
        endDate: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        points: [],
      },
      trips: [],
    });

    vi.clearAllMocks();
  });

  it('sends sanitized query and stores assistant response', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      session_id: 's-1',
      route_plan: {
        city: 'Казань',
        total_budget_estimated: 2000,
        days: [
          {
            day_number: 1,
            date: '2026-03-05',
            day_budget_estimated: 2000,
            day_start_time: '10:00',
            day_end_time: '21:00',
            points: [
              {
                order: 0,
                arrival_time: '10:00',
                departure_time: '11:00',
                visit_duration_min: 60,
                estimated_cost: 1000,
                poi: {
                  id: 'p1',
                  name: 'Кремль',
                  address: 'Казань',
                  coordinates: { lat: 55.79, lon: 49.12 },
                  category: 'attraction',
                },
              },
            ],
          },
        ],
      },
      meta: {
        steps_duration_ms: {
          orchestrator: 1,
          yandex_fetch: 1,
          semantic_filter: 1,
          scheduler: 1,
          total: 4,
        },
        poi_counts: { yandex_raw: 10, after_prefilter: 8, after_semantic: 5 },
        fallbacks_triggered: [],
      },
    });

    await useAiQueryStore.getState().sendQuery('  2   дня\nв Казани  ', 'trip-1');

    expect(api.post).toHaveBeenCalledWith('/ai/plan', {
      user_query: '2 дня в Казани',
      session_id: null,
    });

    const state = useAiQueryStore.getState();
    expect(state.sessionId).toBe('s-1');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]?.routePlan?.city).toBe('Казань');
    expect(state.sessions['s-1']?.sessionId).toBe('s-1');
  });

  it('maps error by status', async () => {
    vi.mocked(api.post).mockRejectedValueOnce({ status: 429, message: 'too many' });

    await useAiQueryStore.getState().sendQuery('test', 'trip-1');

    const lastMessage = useAiQueryStore.getState().messages.at(-1);
    expect(lastMessage?.isError).toBe(true);
    expect(lastMessage?.content).toContain('Слишком много запросов');
  });

  it('applies plan to trip store', async () => {
    const assistantMessage = {
      id: 'm1',
      role: 'assistant' as const,
      content: 'ok',
      timestamp: new Date().toISOString(),
      routePlan: {
        city: 'Казань',
        total_budget_estimated: 1000,
        days: [
          {
            day_number: 1,
            date: '2026-03-05',
            day_budget_estimated: 1000,
            day_start_time: '10:00',
            day_end_time: '21:00',
            points: [
              {
                order: 0,
                arrival_time: '10:00',
                departure_time: '11:00',
                visit_duration_min: 60,
                estimated_cost: 500,
                poi: {
                  id: 'poi-1',
                  name: 'Кремль',
                  address: 'Адрес',
                  coordinates: { lat: 55, lon: 49 },
                  category: 'attraction' as const,
                },
              },
            ],
          },
        ],
      },
    };

    useAiQueryStore.setState({
      sessions: {
        [baseSessionId]: {
          id: baseSessionId,
          title: 'Тестовый чат',
          tripId: 'trip-1',
          sessionId: 's-1',
          messages: [assistantMessage],
          lastAppliedPlanMessageId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      activeSessionId: baseSessionId,
      messages: [assistantMessage],
    });

    useAiQueryStore.getState().applyPlanToCurrentTrip('m1');

    const points = useTripStore.getState().currentTrip?.points ?? [];
    expect(points).toHaveLength(1);
    expect(points[0]?.title).toBe('Кремль');
    expect(useAiQueryStore.getState().lastAppliedPlanMessageId).toBe('m1');
    expect(useAiQueryStore.getState().sessions[baseSessionId]?.lastAppliedPlanMessageId).toBe('m1');
  });

  it('creates and switches chat sessions', () => {
    const state = useAiQueryStore.getState();
    const newId = state.createNewSession('trip-2');

    const afterCreate = useAiQueryStore.getState();
    expect(afterCreate.activeSessionId).toBe(newId);
    expect(afterCreate.sessions[newId]?.tripId).toBe('trip-2');

    void afterCreate.switchSession(baseSessionId);
    expect(useAiQueryStore.getState().activeSessionId).toBe(baseSessionId);
  });
});

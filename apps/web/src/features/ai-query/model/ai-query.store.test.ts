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
    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: изоляция тестов от sessionStorage-побочных эффектов между кейсами handoff.
    // 3) Если убрать: тесты, использующие ai:pending-handoff, станут flaky и зависимыми от порядка выполнения.
    // 4) В этом блоке ранее не было веточного комментария; прямого конфликта со старым комментарием нет.
    window.sessionStorage.clear();

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
      trip_id: null,
      created_at: new Date().toISOString(),
    });

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

    expect(api.post).toHaveBeenNthCalledWith(1, '/ai/sessions', {
      trip_id: undefined,
    });

    expect(api.post).toHaveBeenNthCalledWith(2, '/ai/plan', {
      user_query: '2 дня в Казани',
      session_id: 's-1',
    });

    const state = useAiQueryStore.getState();
    expect(state.sessionId).toBe('s-1');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]?.routePlan?.city).toBe('Казань');
    expect(state.sessions['s-1']?.sessionId).toBe('s-1');
  });

  it('maps error by status', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      session_id: 's-err',
      trip_id: null,
      created_at: new Date().toISOString(),
    });
    vi.mocked(api.post).mockRejectedValueOnce({ status: 429, message: 'too many' });

    await useAiQueryStore.getState().sendQuery('test', 'trip-1');

    const lastMessage = useAiQueryStore.getState().messages.at(-1);
    expect(lastMessage?.isError).toBe(true);
    expect(lastMessage?.content).toContain('Слишком много запросов');
  });

  it('maps NEED_CITY error to clarification question', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      session_id: 's-need-city',
      trip_id: null,
      created_at: new Date().toISOString(),
    });
    vi.mocked(api.post).mockRejectedValueOnce({
      status: 422,
      code: 'NEED_CITY',
      message: 'Недостаточно данных для построения маршрута. Укажите, пожалуйста, город.',
    });

    await useAiQueryStore.getState().sendQuery('небанальный');

    const lastMessage = useAiQueryStore.getState().messages.at(-1);
    expect(lastMessage?.isError).toBe(true);
    expect(lastMessage?.content).toContain('Уточните, пожалуйста, город');
  });

  it('binds local chat to server session id on NEED_CITY error', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      session_id: '3d95f381-6ce5-4d11-8fcc-d55f4ce4de66',
      trip_id: null,
      created_at: new Date().toISOString(),
    });

    vi.mocked(api.post).mockRejectedValueOnce({
      status: 422,
      code: 'NEED_CITY',
      session_id: '3d95f381-6ce5-4d11-8fcc-d55f4ce4de66',
      message: 'Недостаточно данных для построения маршрута. Укажите, пожалуйста, город.',
    });

    await useAiQueryStore.getState().sendQuery('небанальный');

    const state = useAiQueryStore.getState();
    expect(state.activeSessionId).toBe('3d95f381-6ce5-4d11-8fcc-d55f4ce4de66');
    expect(state.sessionId).toBe('3d95f381-6ce5-4d11-8fcc-d55f4ce4de66');
    expect(state.sessions['3d95f381-6ce5-4d11-8fcc-d55f4ce4de66']?.sessionId).toBe(
      '3d95f381-6ce5-4d11-8fcc-d55f4ce4de66',
    );
    expect(state.sessions[baseSessionId]).toBeUndefined();
  });

  it('keeps non-null session_id for existing server session', async () => {
    useAiQueryStore.setState((state) => ({
      ...state,
      sessions: {
        serverSession: {
          id: 'serverSession',
          title: 'Существующий чат',
          tripId: null,
          sessionId: '8e94f2da-7047-488d-85e7-6ddf8f2dbf0f',
          messages: [],
          lastAppliedPlanMessageId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      activeSessionId: 'serverSession',
    }));

    vi.mocked(api.post).mockResolvedValueOnce({
      session_id: '8e94f2da-7047-488d-85e7-6ddf8f2dbf0f',
      route_plan: {
        city: 'Москва',
        total_budget_estimated: 1000,
        days: [
          {
            day_number: 1,
            date: '2026-03-05',
            day_budget_estimated: 1000,
            day_start_time: '10:00',
            day_end_time: '21:00',
            points: [],
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
        poi_counts: { yandex_raw: 1, after_prefilter: 1, after_semantic: 1 },
        fallbacks_triggered: [],
      },
    });

    await useAiQueryStore.getState().sendQuery('2 дня в Москве');

    expect(api.post).toHaveBeenCalledWith('/ai/plan', {
      user_query: '2 дня в Москве',
      session_id: '8e94f2da-7047-488d-85e7-6ddf8f2dbf0f',
    });
  });

  it('marks selected plan in AI session without mutating trip store directly', async () => {
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

    await useAiQueryStore.getState().applyPlanToCurrentTrip('m1');

    const points = useTripStore.getState().currentTrip?.points ?? [];
    expect(points).toHaveLength(0);
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

  it('clearChat creates a fresh local draft and does not nullify persisted sessionId', () => {
    useAiQueryStore.setState((state) => ({
      ...state,
      sessions: {
        persisted: {
          id: 'persisted',
          title: 'Серверный чат',
          tripId: null,
          sessionId: '8e94f2da-7047-488d-85e7-6ddf8f2dbf0f',
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'Казань',
              timestamp: new Date().toISOString(),
            },
          ],
          lastAppliedPlanMessageId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      activeSessionId: 'persisted',
      sessionId: '8e94f2da-7047-488d-85e7-6ddf8f2dbf0f',
    }));

    useAiQueryStore.getState().clearChat();

    const state = useAiQueryStore.getState();
    expect(state.sessions['persisted']?.sessionId).toBe('8e94f2da-7047-488d-85e7-6ddf8f2dbf0f');

    const nextActiveId = state.activeSessionId;
    expect(nextActiveId).not.toBeNull();
    expect(nextActiveId).not.toBe('persisted');

    const nextActiveSession = nextActiveId ? state.sessions[nextActiveId] : null;
    expect(nextActiveSession?.sessionId).toBeNull();
    expect(nextActiveSession?.messages).toHaveLength(0);
  });

  it('does not create backend chat before first user message', async () => {
    const before = useAiQueryStore.getState();
    const localId = before.createNewSession(null);

    const stateAfterCreate = useAiQueryStore.getState();
    expect(stateAfterCreate.sessions[localId]?.sessionId).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('loadSessions keeps optimistic server session not yet returned by backend list', async () => {
    const optimisticId = 'a141e5d6-4d06-4e53-b04f-ff7314f00387';
    useAiQueryStore.setState((state) => ({
      ...state,
      sessions: {
        [optimisticId]: {
          id: optimisticId,
          title: 'казань',
          tripId: null,
          sessionId: optimisticId,
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'казань',
              timestamp: new Date().toISOString(),
            },
          ],
          lastAppliedPlanMessageId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      activeSessionId: optimisticId,
    }));

    vi.mocked(api.get).mockResolvedValueOnce([]);
    await useAiQueryStore.getState().loadSessions();

    const state = useAiQueryStore.getState();
    expect(state.sessions[optimisticId]).toBeDefined();
    expect(state.sessions[optimisticId]?.messages[0]?.content).toBe('казань');
  });

  it('creates backend chat before /ai/plan for first message', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      session_id: 'server-first',
      trip_id: null,
      created_at: new Date().toISOString(),
    });
    vi.mocked(api.post).mockRejectedValueOnce({
      status: 422,
      code: 'NEED_CITY',
      session_id: 'server-first',
      message: 'Недостаточно данных для построения маршрута. Укажите, пожалуйста, город.',
    });

    await useAiQueryStore.getState().sendQuery('небанальный');

    expect(api.post).toHaveBeenNthCalledWith(1, '/ai/sessions', {
      trip_id: undefined,
    });
    expect(api.post).toHaveBeenNthCalledWith(2, '/ai/plan', {
      user_query: 'небанальный',
      session_id: 'server-first',
    });
  });

  it('loadSessions keeps handoff target session as active during landing->assistant transition', async () => {
    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: закрепить инвариант — во время handoff приоритет у targetSessionId, а не у списка с backend.
    // 3) Если убрать: легко вернуть regression, где первое сообщение/loader отображаются не в том чате.
    // 4) Возможен конфликт с ветками, где стратегия выбора activeSessionId меняется (например, приоритет trip-based).
    const handoffTargetId = 'handoff-local';
    const anotherServerSessionId = 'server-other';

    useAiQueryStore.setState((state) => ({
      ...state,
      sessions: {
        [handoffTargetId]: {
          id: handoffTargetId,
          title: 'handoff',
          tripId: null,
          sessionId: null,
          messages: [
            {
              id: 'u-handoff',
              role: 'user',
              content: 'небанальный',
              timestamp: new Date().toISOString(),
            },
          ],
          lastAppliedPlanMessageId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      activeSessionId: handoffTargetId,
      messages: [
        {
          id: 'u-handoff',
          role: 'user',
          content: 'небанальный',
          timestamp: new Date().toISOString(),
        },
      ],
    }));

    window.sessionStorage.setItem(
      'ai:pending-handoff',
      JSON.stringify({ query: 'небанальный', targetSessionId: handoffTargetId }),
    );

    vi.mocked(api.get).mockResolvedValueOnce([
      {
        id: anotherServerSessionId,
        trip_id: null,
        created_at: new Date().toISOString(),
        title: 'Другой чат',
        messages_count: 0,
      },
    ]);

    await useAiQueryStore.getState().loadSessions();

    const state = useAiQueryStore.getState();
    expect(state.activeSessionId).toBe(handoffTargetId);
    expect(state.messages[0]?.content).toBe('небанальный');
  });

  it('loadSessions ignores invalid handoff payload and keeps current active session', async () => {
    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: защитить store от падения/переключения activeSession при битом JSON в handoff key.
    // 3) Если убрать: поврежденный pending payload может внезапно перехватывать фокус чата.
    // 4) Возможен конфликт с ветками, где ожидается fallback на первый серверный чат при любой ошибке handoff.
    window.sessionStorage.setItem('ai:pending-handoff', '{bad-json');

    vi.mocked(api.get).mockResolvedValueOnce([
      {
        id: 'server-default',
        trip_id: null,
        created_at: new Date().toISOString(),
        title: 'Default',
        messages_count: 0,
      },
    ]);

    await useAiQueryStore.getState().loadSessions();

    const state = useAiQueryStore.getState();
    expect(state.activeSessionId).toBe(baseSessionId);
  });
});

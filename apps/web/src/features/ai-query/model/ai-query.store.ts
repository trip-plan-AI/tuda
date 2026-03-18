import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api } from '@/shared/api';
import { useTripStore } from '@/entities/trip';
import type { RoutePoint } from '@/entities/route-point/model/route-point.types';
import type { ChatMessage, ChatMeta, ChatRoutePlan } from '@/shared/types/ai-chat';

interface AiPlanResponse {
  session_id: string;
  route_plan: ChatRoutePlan;
  meta: ChatMeta;
}

interface AiSessionListItemResponse {
  id: string;
  trip_id: string | null;
  created_at: string;
  updated_at?: string;
  title: string;
  messages_count: number;
}

interface AiSessionDetailsResponse {
  id: string;
  trip_id: string | null;
  created_at: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

interface ApplySessionPlanResponse {
  trip_id: string;
  mode: 'created' | 'updated';
}

interface SessionFromTripResponse {
  session_id: string;
  trip_id: string;
}

interface CreateSessionResponse {
  session_id: string;
  trip_id: string | null;
  created_at: string;
}

interface HttpError {
  status?: number;
  message?: string;
  code?: string;
  session_id?: string;
}

function getPendingHandoffTargetSessionId(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: защитить handoff Landing -> AI от потери targetSessionId во время загрузки списка сессий.
    // 3) Если убрать: loadSessions может активировать другой чат, и первый запрос/скелетон будут не в том окне.
    // 4) Возможен конфликт с ветками, где handoff хранится не в sessionStorage, а в router state/query params.
    const raw = window.sessionStorage.getItem('ai:pending-handoff');
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { targetSessionId?: unknown };
    if (typeof parsed.targetSessionId !== 'string' || parsed.targetSessionId.length === 0)
      return null;

    return parsed.targetSessionId;
  } catch {
    return null;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

interface AiQueryStore {
  sessions: Record<string, ChatSession>;
  activeSessionId: string | null;
  messages: ChatMessage[];
  isLoading: boolean;
  isSessionsLoading: boolean;
  sessionId: string | null;
  lastAppliedPlanMessageId: string | null;
  loadSessions: () => Promise<void>;
  // preAddedMessageId — если передан, сообщение пользователя уже добавлено в стор с этим ID,
  // sendQuery не создаёт его повторно (используется для синхронного показа перед AI-запросом).
  sendQuery: (query: string, tripId?: string, preAddedMessageId?: string) => Promise<void>;
  // TRI-104: применяет AI-план в Planner-trip и возвращает tripId для навигации/подсветки UI.
  // MERGE-NOTE: контракт используется в AIAssistantPage и MessageBubble, не менять тип без синхронных правок UI.
  applyPlanToCurrentTrip: (messageId: string) => Promise<string | null>;
  sendMutationQuery: (
    query: string,
    tripId: string,
    currentPointsContext?: string,
  ) => Promise<void>;
  // TRI-104: ищет или создаёт AI-сессию для tripId при входе из Planner по кнопке "Редактировать с AI".
  // MERGE-NOTE: при изменении backend response обновите эту сигнатуру и маппинг ниже.
  openOrCreateSessionFromTrip: (tripId: string) => Promise<string | null>;
  createNewSession: (tripId?: string | null) => string;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  clearChat: (keepLastPlan?: boolean) => void;
  // TRI-120: добавляет одно сообщение в активную сессию без вызова AI (сокет-транспорт).
  addLocalMessage: (message: ChatMessage) => void;
  // TRI-120: добавляет массив сообщений истории чата (chat:history) без дубликатов.
  addChatHistory: (messages: ChatMessage[]) => void;
}

interface ChatSession {
  id: string;
  title: string;
  tripId: string | null;
  sessionId: string | null;
  messages: ChatMessage[];
  lastAppliedPlanMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  justCleared?: boolean; // Флаг: была ли сессия только что очищена (не загружать из бэка)
}

const MAX_QUERY_LENGTH = 1000;

function sanitizeQuery(query: string) {
  const withoutControlChars = Array.from(query)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 || char === '\n' || char === '\r' || char === '\t';
    })
    .join('');

  return withoutControlChars.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}

function mapErrorToUserMessage(error: HttpError) {
  if (error.status === 401) return 'Сессия истекла. Выполните вход повторно.';
  if (error.code === 'NEED_CITY')
    return 'Понял идею. Уточните, пожалуйста, город, для которого построить маршрут.';
  if (error.status === 422)
    return 'Не удалось построить маршрут по запросу. Уточните город и предпочтения.';
  if (error.status === 429) return 'Слишком много запросов. Подождите немного и повторите.';
  if (error.status === 504) return 'AI сервис отвечает слишком долго. Попробуйте повторить запрос.';
  return error.message ?? 'Неизвестная ошибка. Попробуйте еще раз.';
}

function toRoutePoints(routePlan: ChatRoutePlan, tripId: string): RoutePoint[] {
  return routePlan.days.flatMap((day) =>
    day.points.flatMap((point) => {
      const poi = point?.poi;
      const lat = poi?.coordinates?.lat;
      const lon = poi?.coordinates?.lon;

      if (!poi || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        return [];
      }

      return [
        {
          id: poi.id,
          tripId,
          title: poi.name,
          lat,
          lon,
          budget: point.estimated_cost ?? null,
          visitDate: day.date,
          imageUrl: poi.image_url ?? null,
          address: poi.address,
          order: point.order,
          duration: point.visit_duration_min ?? 0,
          createdAt: new Date().toISOString(),
        },
      ];
    }),
  );
}

function fallbackHint(meta: ChatMeta) {
  if (!meta.fallbacks_triggered.length) return '';

  return `\n⚠️ Режим деградации: ${meta.fallbacks_triggered.join(', ')}`;
}

function createSession(tripId: string | null = null): ChatSession {
  const timestamp = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    tripId,
    // Инвариант TRI-106:
    // sessionId === null допустим только для локального пустого чата
    // до первой отправки user_query на backend.
    sessionId: null,
    messages: [],
    lastAppliedPlanMessageId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function tryParseRoutePlan(content: string): ChatRoutePlan | null {
  try {
    const parsed = JSON.parse(content) as Partial<ChatRoutePlan>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.city !== 'string' || !Array.isArray(parsed.days)) return null;
    if (typeof parsed.total_budget_estimated !== 'number') return null;
    return parsed as ChatRoutePlan;
  } catch {
    return null;
  }
}

function mapStoredMessagesToChatMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: string; route_plan?: unknown }>,
): ChatMessage[] {
  return messages.map((message, index) => {
    if (message.role === 'assistant') {
      // Сначала проверяем структурное поле route_plan (новый формат),
      // потом fallback на JSON в content (legacy формат)
      const routePlan =
        (message.route_plan && typeof message.route_plan === 'object'
          ? (message.route_plan as ChatRoutePlan)
          : null) ?? tryParseRoutePlan(message.content);
      if (routePlan) {
        return {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Маршрут по городу ${routePlan.city} на ${routePlan.days.length} дн.`,
          routePlan,
          timestamp: new Date().toISOString(),
        } satisfies ChatMessage;
      }
    }

    return {
      id: crypto.randomUUID(),
      role: message.role,
      content: message.content,
      timestamp: new Date(Date.now() + index).toISOString(),
    } satisfies ChatMessage;
  });
}

function syncLegacyFields(sessions: Record<string, ChatSession>, activeSessionId: string | null) {
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;

  return {
    messages: activeSession?.messages ?? [],
    sessionId: activeSession?.sessionId ?? null,
    lastAppliedPlanMessageId: activeSession?.lastAppliedPlanMessageId ?? null,
  };
}

function ensureActiveSession(state: AiQueryStore): {
  sessions: Record<string, ChatSession>;
  activeSessionId: string;
} {
  if (state.activeSessionId && state.sessions[state.activeSessionId]) {
    return { sessions: state.sessions, activeSessionId: state.activeSessionId };
  }

  const fallbackSession = createSession();
  return {
    sessions: { ...state.sessions, [fallbackSession.id]: fallbackSession },
    activeSessionId: fallbackSession.id,
  };
}

export const useAiQueryStore = create<AiQueryStore>()(
  persist(
    (set, get) => ({
  sessions: {},
  activeSessionId: null,
  messages: [],
  isLoading: false,
  isSessionsLoading: false,
  sessionId: null,
  lastAppliedPlanMessageId: null,

  loadSessions: async () => {
    set({ isSessionsLoading: true });

    try {
      const list = await api.get<AiSessionListItemResponse[]>('/ai/sessions');

      if (list.length === 0) {
        set((state) => {
          const ensured = ensureActiveSession(state);
          return {
            sessions: ensured.sessions,
            activeSessionId: ensured.activeSessionId,
            isSessionsLoading: false,
            ...syncLegacyFields(ensured.sessions, ensured.activeSessionId),
          };
        });
        return;
      }

      const remoteSessions = list.reduce<Record<string, ChatSession>>((acc, item) => {
        const id = item.id;
        const existing = get().sessions[id];
        const serverUpdatedAt = item.updated_at ?? item.created_at;

        acc[id] = {
          id,
          title: item.title || 'Новый чат',
          tripId: item.trip_id,
          sessionId: item.id,
          messages: existing?.messages ?? [],
          lastAppliedPlanMessageId: existing?.lastAppliedPlanMessageId ?? null,
          createdAt: item.created_at,
          // TRI-106: Сохраняем более свежий updatedAt из локального стейта,
          // чтобы чат не "прыгал" вниз при фоновом обновлении списка.
          updatedAt:
            existing && new Date(existing.updatedAt) > new Date(serverUpdatedAt)
              ? existing.updatedAt
              : serverUpdatedAt,
        };
        return acc;
      }, {});

      let nextActiveSessionId: string | null = null;

      set((state) => {
        const localTransientSessions = Object.values(state.sessions).reduce<
          Record<string, ChatSession>
        >((acc, session) => {
          // Сохраняем локальные черновики (sessionId=null)
          // и оптимистично-промоутнутые серверные сессии,
          // которые еще не успели попасть в ответ /ai/sessions.
          const shouldKeepLocal =
            session.sessionId === null ||
            (session.sessionId !== null && !remoteSessions[session.sessionId]);

          if (shouldKeepLocal) {
            acc[session.id] = session;
          }
          return acc;
        }, {});

        // Merge remote sessions with local transient sessions, but filter out empty drafts
        // if we have real sessions from the server (prevents chat duplication/cloning)
        const mergedSessions = { ...remoteSessions };

        Object.values(localTransientSessions).forEach((localSession) => {
          // TRI-106: Сохраняем локальные черновики, если они не пустые
          // ИЛИ если это текущая активная сессия (чтобы не прыгало при создании нового чата)
          const isCompletelyEmptyDraft =
            localSession.sessionId === null && localSession.messages.length === 0;
          const isActive = localSession.id === state.activeSessionId;

          if (!isCompletelyEmptyDraft || isActive || Object.keys(remoteSessions).length === 0) {
            mergedSessions[localSession.id] = localSession;
          }
        });

        // TRI-106 / MERGE-GUARD
        // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
        // 2) Потребность: при наличии pending-handoff удержать activeSessionId на целевом локальном чате,
        //    чтобы UI (первое user-message + loader) рендерился в правильной сессии.
        // 3) Если убрать: воспроизводится race-condition — список сессий перехватывает фокус на другой чат.
        // 4) Возможен конфликт с веткой feature/TRI-104-ai-planner-interaction,
        //    где activeSessionId может приоритетно вычисляться от currentTrip/trip-session.
        const pendingHandoffTargetSessionId = getPendingHandoffTargetSessionId();

        nextActiveSessionId =
          (pendingHandoffTargetSessionId && mergedSessions[pendingHandoffTargetSessionId]
            ? pendingHandoffTargetSessionId
            : null) ??
          (state.activeSessionId && mergedSessions[state.activeSessionId]
            ? state.activeSessionId
            : (list[0]?.id ?? null));

        return {
          sessions: mergedSessions,
          activeSessionId: nextActiveSessionId,
          isSessionsLoading: false,
          ...syncLegacyFields(mergedSessions, nextActiveSessionId),
        };
      });

      if (nextActiveSessionId && remoteSessions[nextActiveSessionId]) {
        await get().switchSession(nextActiveSessionId);
      }
    } catch {
      set({ isSessionsLoading: false });
    }
  },

  sendQuery: async (query, tripId, preAddedMessageId) => {
    const normalized = sanitizeQuery(query);
    if (!normalized || get().isLoading) return;

    const ensured = ensureActiveSession(get());
    const activeId = ensured.activeSessionId;
    const currentSession = ensured.sessions[activeId] ?? createSession(tripId ?? null);
    // Если передан preAddedMessageId — сообщение уже в сторе, используем его ID.
    // Иначе создаём новое сообщение пользователя.
    const requestId = preAddedMessageId ?? crypto.randomUUID();
    let ensuredSessionId = currentSession.sessionId;

    const userMessage: ChatMessage = {
      id: requestId,
      role: 'user',
      content: normalized,
      timestamp: new Date().toISOString(),
    };

    // Если сообщение уже добавлено (preAddedMessageId), не дублируем его в список
    const existingMessages = currentSession.messages;
    const alreadyAdded = preAddedMessageId
      ? existingMessages.some((m) => m.id === preAddedMessageId)
      : false;

    const preRequestSession: ChatSession = {
      ...currentSession,
      tripId: tripId ?? currentSession.tripId,
      title: currentSession.messages.length === 0 ? normalized.slice(0, 60) : currentSession.title,
      messages: alreadyAdded ? existingMessages : [...existingMessages, userMessage],
      updatedAt: new Date().toISOString(),
    };

    const preRequestSessions = {
      ...ensured.sessions,
      [activeId]: preRequestSession,
    };

    set(() => ({
      sessions: preRequestSessions,
      activeSessionId: activeId,
      isLoading: true,
      ...syncLegacyFields(preRequestSessions, activeId),
    }));

    try {
      ensuredSessionId = preRequestSession.sessionId;

      if (!ensuredSessionId) {
        // TRI-106 / MERGE-GUARD
        // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
        // 2) Потребность: серверная сессия должна быть создана до /ai/plan, чтобы даже первый запрос
        //    (включая NEED_CITY) был связан с постоянным session_id.
        // 3) Если убрать: first-turn запросы снова пойдут с session_id=null и могут склеиваться между чатами.
        // 4) Возможен конфликт с веткой feature/TRI-104-ai-planner-interaction,
        //    если в ней ожидается старый flow с ленивым созданием сессии внутри /ai/plan.
        const created = await api.post<CreateSessionResponse>('/ai/sessions', {
          trip_id: tripId && isUuid(tripId) ? tripId : undefined,
          title: preRequestSession.title,
        });

        ensuredSessionId = created.session_id;

        set((state) => {
          const latestActive = state.sessions[activeId];
          if (!latestActive) return state;

          const promotedSession: ChatSession = {
            ...latestActive,
            id: ensuredSessionId as string,
            sessionId: ensuredSessionId as string,
            tripId: created.trip_id,
            updatedAt: new Date().toISOString(),
          };

          const nextSessions = { ...state.sessions };
          if (activeId !== promotedSession.id) {
            const { [activeId]: _, ...restSessions } = nextSessions;
            restSessions[promotedSession.id] = promotedSession;
            return {
              sessions: restSessions,
              activeSessionId: promotedSession.id,
              ...syncLegacyFields(restSessions, promotedSession.id),
            };
          }
          nextSessions[promotedSession.id] = promotedSession;

          return {
            sessions: nextSessions,
            activeSessionId: promotedSession.id,
            ...syncLegacyFields(nextSessions, promotedSession.id),
          };
        });
      }

      const payload: {
        user_query: string;
        trip_id?: string;
        session_id: string | null;
      } = {
        user_query: normalized,
        session_id: ensuredSessionId,
      };

      if (tripId && isUuid(tripId)) {
        payload.trip_id = tripId;
      }

      const response = await api.post<AiPlanResponse>('/ai/plan', {
        ...payload,
      });

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          `Маршрут по городу ${response.route_plan.city} ` +
          `на ${response.route_plan.days.length} дн.`,
        routePlan: response.route_plan,
        meta: response.meta,
        timestamp: new Date().toISOString(),
      };

      set((state) => {
        const sessionKey = ensuredSessionId ?? activeId;
        const activeSession = state.sessions[sessionKey] ?? null;
        if (!activeSession) {
          return { isLoading: false };
        }

        const persistedSessionId = response.session_id;
        const nextSession: ChatSession = {
          ...activeSession,
          id: persistedSessionId,
          sessionId: persistedSessionId,
          messages: [...activeSession.messages, assistantMessage],
          updatedAt: new Date().toISOString(),
        };

        let nextSessions = { ...state.sessions };
        if (activeSession.id !== persistedSessionId) {
          const { [activeSession.id]: _, ...restSessions } = nextSessions;
          nextSessions = restSessions;
        }
        nextSessions[persistedSessionId] = nextSession;

        return {
          sessions: nextSessions,
          activeSessionId: persistedSessionId,
          isLoading: false,
          ...syncLegacyFields(nextSessions, persistedSessionId),
        };
      });
    } catch (rawError) {
      const error = rawError as HttpError;

      set((state) => {
        const sessionKey = ensuredSessionId ?? activeId;
        const activeSession = state.sessions[sessionKey] ?? null;
        if (!activeSession) {
          return { isLoading: false };
        }

        const serverSessionId =
          error.code === 'NEED_CITY' && typeof error.session_id === 'string'
            ? error.session_id
            : null;

        const errorMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: mapErrorToUserMessage(error),
          timestamp: new Date().toISOString(),
          isError: true,
        };

        const nextSession: ChatSession = {
          ...activeSession,
          id: serverSessionId ?? activeSession.id,
          sessionId: serverSessionId ?? activeSession.sessionId,
          messages: [...activeSession.messages, errorMessage],
          updatedAt: new Date().toISOString(),
        };

        let nextSessions = { ...state.sessions };
        if (activeSession.id !== nextSession.id) {
          const { [activeSession.id]: _, ...restSessions } = nextSessions;
          nextSessions = restSessions;
        }
        nextSessions[nextSession.id] = nextSession;

        return {
          sessions: nextSessions,
          activeSessionId: nextSession.id,
          isLoading: false,
          ...syncLegacyFields(nextSessions, nextSession.id),
        };
      });
    }
  },

  sendMutationQuery: async (query, tripId, currentPointsContext) => {
    if (!tripId) return;
    const normalized = sanitizeQuery(query);
    if (!normalized || get().isLoading) return;

    const requestId = crypto.randomUUID();
    const userMessage: ChatMessage = {
      id: requestId,
      role: 'user',
      content: normalized,
      timestamp: new Date().toISOString(),
    };

    set((state) => {
      const activeId = state.activeSessionId;
      if (!activeId || !state.sessions[activeId]) return state;
      const session = state.sessions[activeId];
      const nextSessions = {
        ...state.sessions,
        [activeId]: {
          ...session,
          messages: [...session.messages, userMessage],
          updatedAt: new Date().toISOString(),
        },
      };
      return {
        isLoading: true,
        sessions: nextSessions,
        ...syncLegacyFields(nextSessions, activeId),
      };
    });

    const activeId = get().activeSessionId;
    try {
      // Fetch trip first to get actual DB points (for context) and version
      const tripData = await api.get<any>(`/trips/${tripId}`);
      const version = tripData?.version || 0;
      const actualContext =
        Array.isArray(tripData?.points) && tripData.points.length > 0
          ? tripData.points.map((p: any) => p.title).join(', ')
          : currentPointsContext;

      const mutations = await api.post<any[]>('/ai/mutations/parse', {
        query: normalized,
        tripContext: actualContext,
      });

      const response = await api.post<any>(`/ai/mutations/${tripId}/apply`, {
        mutations,
        ifMatch: version,
        sessionId: activeId,
      });

      const pointCount = response.points?.length ?? 0;
      const aiMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          pointCount === 0 ? `Маршрут очищен.` : `Я обновил маршрут согласно вашему запросу.`,
        routePlan: pointCount > 0 ? response.route_plan : undefined,
        timestamp: new Date().toISOString(),
      };

      // Sync map: update currentTrip.points so the map reflects the mutation
      // (WebSocket only fires if Planner page is mounted; this covers AI chat page too)
      if (Array.isArray(response.points)) {
        const tripState = useTripStore.getState();
        if (tripState.currentTrip?.id === tripId) {
          useTripStore.setState((s) => ({
            currentTrip: s.currentTrip
              ? {
                  ...s.currentTrip,
                  points: response.points,
                }
              : null,
          }));
        }
      }

      set((state) => {
        const activeId = state.activeSessionId;
        if (!activeId || !state.sessions[activeId]) return state;
        const session = state.sessions[activeId];
        const nextSessions = {
          ...state.sessions,
          [activeId]: {
            ...session,
            messages: [...session.messages, aiMessage],
            updatedAt: new Date().toISOString(),
          },
        };
        return {
          isLoading: false,
          sessions: nextSessions,
          ...syncLegacyFields(nextSessions, activeId),
        };
      });
    } catch (error) {
      console.error(error);

      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Ошибка: не удалось применить изменения. Попробуйте обновить страницу.`,
        timestamp: new Date().toISOString(),
      };

      set((state) => {
        const activeId = state.activeSessionId;
        if (!activeId || !state.sessions[activeId]) return { isLoading: false };
        const session = state.sessions[activeId];
        const nextSessions = {
          ...state.sessions,
          [activeId]: {
            ...session,
            messages: [...session.messages, errorMessage],
            updatedAt: new Date().toISOString(),
          },
        };
        return {
          isLoading: false,
          sessions: nextSessions,
          ...syncLegacyFields(nextSessions, activeId),
        };
      });
    }
  },

  applyPlanToCurrentTrip: (messageId) => {
    // TRI-104 / UX-SAFE-APPLY:
    // Задача: применить AI-план в маршрут на каждый клик "Применить", включая повторные применения.
    // Функция: всегда отправляем apply API даже для связанного чата, чтобы обновить точки.
    const { activeSessionId, sessions } = get();
    const activeSession = activeSessionId ? sessions[activeSessionId] : null;
    const message = activeSession?.messages.find((item) => item.id === messageId);

    if (!activeSession?.sessionId || !message?.routePlan) return Promise.resolve(null);

    // Всегда вызываем API для применения плана (создание новой trip или обновление существующей)
    return api
      .post<ApplySessionPlanResponse>(`/ai/sessions/${activeSession.sessionId}/apply`, {
        message_id: messageId,
        route_plan: message.routePlan,
      })
      .then(async (result) => {
        // TRI-104 / NO-CROSS-STORE-MUTATION:
        // Задача: развязать состояние страницы AI и локальное состояние Planner.
        // Функция: после apply обновляем только AI session store, не трогаем useTripStore.
        // Если вернуть прямую мутацию Planner-store отсюда, исчезнет корректный dirty-контекст
        // при возврате в Planner и снова появятся race-condition между страницами.

        set((state) => {
          if (!state.activeSessionId) return {};

          const targetSession = state.sessions[state.activeSessionId];
          if (!targetSession) return {};

          const nextSession: ChatSession = {
            ...targetSession,
            lastAppliedPlanMessageId: messageId,
            tripId: result.trip_id,
            updatedAt: new Date().toISOString(),
          };

          const nextSessions = {
            ...state.sessions,
            [nextSession.id]: nextSession,
          };

          return {
            sessions: nextSessions,
            ...syncLegacyFields(nextSessions, state.activeSessionId),
          };
        });

        return result.trip_id;
      })
      .catch(() => null);
  },

  openOrCreateSessionFromTrip: async (tripId) => {
    // TRI-104: единая точка sync Planner -> AI.
    // Назначение: загрузить готовый контекст маршрута в чат перед переходом на /ai-assistant.
    // MERGE-NOTE: парсинг сообщений должен оставаться совместимым с backend createSessionFromTrip.
    if (!tripId || !isUuid(tripId)) return null;

    try {
      const response = await api.post<SessionFromTripResponse>(
        `/ai/sessions/from-trip/${tripId}`,
        {},
      );
      const sessionDetails = await api.get<AiSessionDetailsResponse>(
        `/ai/sessions/${response.session_id}`,
      );
      const mappedMessages = mapStoredMessagesToChatMessages(sessionDetails.messages);

      set((state) => {
        // Удаляем все пустые сессии, чтобы они не дублировались и не "висели" рядом
        const nextSessions = Object.fromEntries(
          Object.entries({ ...state.sessions }).filter(
            ([key, session]) => !(session.messages.length === 0 && key !== response.session_id),
          ),
        );

        const baseSession = nextSessions[response.session_id] ?? {
          id: response.session_id,
          title: state.sessions[state.activeSessionId ?? '']?.title ?? 'Маршрут',
          tripId: response.trip_id,
          sessionId: response.session_id,
          messages: [],
          lastAppliedPlanMessageId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        nextSessions[response.session_id] = {
          ...baseSession,
          tripId: response.trip_id,
          sessionId: response.session_id,
          messages: mappedMessages,
          // updatedAt обновляем только если сообщения действительно изменились
          updatedAt:
            JSON.stringify(baseSession.messages) !== JSON.stringify(mappedMessages)
              ? new Date().toISOString()
              : baseSession.updatedAt,
        };

        return {
          sessions: nextSessions,
          activeSessionId: response.session_id,
          ...syncLegacyFields(nextSessions, response.session_id),
        };
      });

      return response.session_id;
    } catch {
      return null;
    }
  },

  createNewSession: (tripId = null) => {
    const session = createSession(tripId);

    set((state) => {
      const nextSessions = {
        ...state.sessions,
        [session.id]: session,
      };

      return {
        sessions: nextSessions,
        activeSessionId: session.id,
        isLoading: false,
        ...syncLegacyFields(nextSessions, session.id),
      };
    });

    return session.id;
  },

  switchSession: async (nextSessionId) => {
    const state = get();
    const target = state.sessions[nextSessionId];
    if (!target) return;

    // updatedAt не трогаем при переключении — чат всплывает только при отправке сообщений
    set({
      sessions: state.sessions,
      activeSessionId: nextSessionId,
      isLoading: false,
      ...syncLegacyFields(state.sessions, nextSessionId),
    });

    // Не загружаем историю если сессия только что была очищена (justCleared флаг)
    if (target.sessionId && target.messages.length === 0 && !target.justCleared) {
      try {
        const details = await api.get<AiSessionDetailsResponse>(`/ai/sessions/${target.sessionId}`);
        const mappedMessages = mapStoredMessagesToChatMessages(details.messages);

        set((currentState) => {
          const freshTarget = currentState.sessions[nextSessionId];
          if (!freshTarget) return {};

          const nextSession: ChatSession = {
            ...freshTarget,
            messages: mappedMessages,
          };

          const nextSessions = {
            ...currentState.sessions,
            [nextSession.id]: nextSession,
          };

          return {
            sessions: nextSessions,
            ...syncLegacyFields(nextSessions, currentState.activeSessionId),
          };
        });
      } catch {
        // no-op
      }
    } else if (target.justCleared) {
      // Если была очистка, убираем флаг после активации сессии
      set((state) => {
        const session = state.sessions[nextSessionId];
        if (!session) return {};
        return {
          sessions: {
            ...state.sessions,
            [nextSessionId]: { ...session, justCleared: undefined },
          },
        };
      });
    }
  },

  deleteSession: async (targetSessionId) => {
    const target = get().sessions[targetSessionId];
    if (!target) return;

    if (target.sessionId) {
      try {
        await api.del<{ ok: boolean }>(`/ai/sessions/${target.sessionId}`);
      } catch {
        return;
      }
    }

    set((state) => {
      if (!state.sessions[targetSessionId]) return {};

      const { [targetSessionId]: _, ...nextSessions } = { ...state.sessions };

      const fallbackSession = createSession();
      const sessionIds = Object.keys(nextSessions);
      const nextActiveSessionId =
        state.activeSessionId === targetSessionId
          ? (sessionIds[0] ?? fallbackSession.id)
          : state.activeSessionId;

      const normalizedSessions =
        sessionIds.length > 0 ? nextSessions : { [fallbackSession.id]: fallbackSession };

      return {
        sessions: normalizedSessions,
        activeSessionId: nextActiveSessionId,
        isLoading: false,
        ...syncLegacyFields(normalizedSessions, nextActiveSessionId),
      };
    });
  },

  clearChat: async (keepLastPlan = undefined) => {
    const activeId = get().activeSessionId;
    const activeSession = activeId ? get().sessions[activeId] : null;
    if (!activeId || !activeSession?.sessionId) return;

    // TRI-104: Если в маршруте есть точки, просим бэкенд оставить последнее сообщение с планом.
    // Если точек нет — чистим всё.
    const tripState = useTripStore.getState();
    // Если keepLastPlan не определен, используем старую логику
    const hasPoints = keepLastPlan ?? ((tripState.currentTrip?.points?.length ?? 0) > 0);

    try {
      // Вызываем бэкенд для очистки сообщений
      const res = await api.post<{ success: boolean; kept?: boolean }>(
        `/ai/sessions/${activeSession.sessionId}/clear`,
        { keep_last_plan: hasPoints },
      );

      // Очищаем локальное состояние
      set((state) => {
        const session = state.sessions[activeId];
        if (!session) return {};

        let newMessages: ChatMessage[] = [];
        if (res.kept) {
          // Ищем последнее сообщение ассистента с планом для сохранения в локальном стейте
          const lastPlan = [...session.messages]
            .reverse()
            .find((m) => m.role === 'assistant' && !!m.routePlan);
          if (lastPlan) newMessages = [lastPlan];
        }

        const nextSessions = {
          ...state.sessions,
          [activeId]: {
            ...session,
            messages: newMessages,
          },
        };

        return {
          sessions: nextSessions,
          ...syncLegacyFields(nextSessions, activeId),
        };
      });

      // Пометим что сессия была очищена, чтобы switchSession не загружал из бэка
      set((state) => {
        const session = state.sessions[activeId];
        if (!session) return {};
        return {
          sessions: {
            ...state.sessions,
            [activeId]: { ...session, justCleared: true },
          },
        };
      });
    } catch (error) {
      console.error('❌ Ошибка при очистке чата:', error);
    }
  },

  renameSession: async (targetSessionId, title) => {
    const target = get().sessions[targetSessionId];
    if (!target) return;

    if (target.sessionId) {
      await api.patch<{ success: boolean }>(`/ai/sessions/${target.sessionId}`, { title });
    }

    set((state) => {
      const session = state.sessions[targetSessionId];
      if (!session) return {};
      return {
        sessions: {
          ...state.sessions,
          [targetSessionId]: { ...session, title, updatedAt: new Date().toISOString() },
        },
      };
    });
  },

  // TRI-120: добавляет одно сообщение в активную сессию без вызова AI.
  // Используется для отображения сообщений других участников через сокет
  // и собственных сообщений, не требующих ответа AI.
  addLocalMessage: (message) => {
    set((state) => {
      const activeId = state.activeSessionId;
      if (!activeId) return state;
      const session = state.sessions[activeId];
      if (!session) return state;

      if (session.messages.some((m) => m.id === message.id)) return state;

      const nextSessions = {
        ...state.sessions,
        [activeId]: {
          ...session,
          messages: [...session.messages, message],
          updatedAt: new Date().toISOString(),
        },
      };

      return {
        sessions: nextSessions,
        ...syncLegacyFields(nextSessions, activeId),
      };
    });
  },

  // TRI-120: добавляет массив сообщений истории чата (chat:history) без дубликатов.
  addChatHistory: (messages) => {
    set((state) => {
      const activeId = state.activeSessionId;
      if (!activeId) return state;
      const session = state.sessions[activeId];
      if (!session) return state;

      const existingMap = new Map(session.messages.map((m) => [m.id, m]));
      const newMessages = [...session.messages];

      for (const msg of messages) {
        if (!existingMap.has(msg.id)) {
          newMessages.push(msg);
          existingMap.set(msg.id, msg);
        } else {
          // Merge metadata like routePlan if missing locally
          const existing = existingMap.get(msg.id)!;
          if (msg.routePlan && !existing.routePlan) {
            existing.routePlan = msg.routePlan;
          }
        }
      }

      newMessages.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      const nextSessions = {
        ...state.sessions,
        [activeId]: {
          ...session,
          messages: newMessages,
          updatedAt: new Date().toISOString(),
        },
      };

      return {
        sessions: nextSessions,
        ...syncLegacyFields(nextSessions, activeId),
      };
    });
  },
    }),
    {
      name: 'ai-query-sessions',
      storage: createJSONStorage(() => localStorage),
      // Сохраняем только сессии и активную сессию — не сохраняем isLoading и т.п.
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
      }),
    },
  ),
);

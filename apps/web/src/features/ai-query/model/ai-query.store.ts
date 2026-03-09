import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '@/shared/api';
import { useTripStore } from '@/entities/trip';
import type { RoutePoint } from '@/entities/route-point/model/route-point.types';
import type { ChatMessage, ChatMeta, ChatRoutePlan } from '@/shared/types/ai-chat';

interface AiPlanResponse {
  session_id: string;
  route_plan: ChatRoutePlan;
  meta: ChatMeta;
}

interface HttpError {
  status?: number;
  message?: string;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

interface AiQueryStore {
  sessions: Record<string, ChatSession>;
  activeSessionId: string | null;
  messages: ChatMessage[];
  isLoading: boolean;
  sessionId: string | null;
  lastAppliedPlanMessageId: string | null;
  sendQuery: (query: string, tripId?: string) => Promise<void>;
  applyPlanToCurrentTrip: (messageId: string) => void;
  createNewSession: (tripId?: string | null) => string;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  clearChat: () => void;
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
    sessionId: null,
    messages: [],
    lastAppliedPlanMessageId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function syncLegacyFields(sessions: Record<string, ChatSession>, activeSessionId: string | null) {
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;

  return {
    messages: activeSession?.messages ?? [],
    sessionId: activeSession?.sessionId ?? null,
    lastAppliedPlanMessageId: activeSession?.lastAppliedPlanMessageId ?? null,
  };
}

function ensureActiveSession(state: AiQueryStore): { sessions: Record<string, ChatSession>; activeSessionId: string } {
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
      sessionId: null,
      lastAppliedPlanMessageId: null,

      sendQuery: async (query, tripId) => {
        const normalized = sanitizeQuery(query);
        if (!normalized || get().isLoading) return;

        const ensured = ensureActiveSession(get());
        const activeId = ensured.activeSessionId;
        const currentSession = ensured.sessions[activeId];
        const requestId = crypto.randomUUID();

        const userMessage: ChatMessage = {
          id: requestId,
          role: 'user',
          content: normalized,
          timestamp: new Date().toISOString(),
        };

        const preRequestSession: ChatSession = {
          ...currentSession,
          tripId: tripId ?? currentSession.tripId,
          title: currentSession.messages.length === 0 ? normalized.slice(0, 60) : currentSession.title,
          messages: [...currentSession.messages, userMessage],
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
          const payload: {
            user_query: string;
            trip_id?: string;
            session_id: string | null;
          } = {
            user_query: normalized,
            session_id: get().sessionId,
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
              `Составил маршрут по городу ${response.route_plan.city} ` +
              `на ${response.route_plan.days.length} дн.${fallbackHint(response.meta)}`,
            routePlan: response.route_plan,
            meta: response.meta,
            timestamp: new Date().toISOString(),
          };

          set((state) => {
            const activeSession = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
            if (!activeSession) {
              return { isLoading: false };
            }

            const nextSession: ChatSession = {
              ...activeSession,
              sessionId: response.session_id,
              messages: [...activeSession.messages, assistantMessage],
              updatedAt: new Date().toISOString(),
            };

            const nextSessions = {
              ...state.sessions,
              [nextSession.id]: nextSession,
            };

            return {
              sessions: nextSessions,
              isLoading: false,
              ...syncLegacyFields(nextSessions, state.activeSessionId),
            };
          });
        } catch (rawError) {
          const error = rawError as HttpError;

          set((state) => {
            const activeSession = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
            if (!activeSession) {
              return { isLoading: false };
            }

            const errorMessage: ChatMessage = {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: mapErrorToUserMessage(error),
              timestamp: new Date().toISOString(),
              isError: true,
            };

            const nextSession: ChatSession = {
              ...activeSession,
              messages: [...activeSession.messages, errorMessage],
              updatedAt: new Date().toISOString(),
            };

            const nextSessions = {
              ...state.sessions,
              [nextSession.id]: nextSession,
            };

            return {
              sessions: nextSessions,
              isLoading: false,
              ...syncLegacyFields(nextSessions, state.activeSessionId),
            };
          });
        }
      },

      applyPlanToCurrentTrip: (messageId) => {
        const { activeSessionId, sessions } = get();
        const activeSession = activeSessionId ? sessions[activeSessionId] : null;
        const message = activeSession?.messages.find((item) => item.id === messageId);
        const currentTrip = useTripStore.getState().currentTrip;

        if (!message?.routePlan || !currentTrip) return;

        const points = toRoutePoints(message.routePlan, currentTrip.id);
        useTripStore.getState().setPoints(points);

        set((state) => {
          if (!state.activeSessionId) return {};

          const targetSession = state.sessions[state.activeSessionId];
          if (!targetSession) return {};

          const nextSession: ChatSession = {
            ...targetSession,
            lastAppliedPlanMessageId: messageId,
            tripId: currentTrip.id,
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

      switchSession: (nextSessionId) => {
        set((state) => {
          if (!state.sessions[nextSessionId]) return {};

          return {
            activeSessionId: nextSessionId,
            isLoading: false,
            ...syncLegacyFields(state.sessions, nextSessionId),
          };
        });
      },

      deleteSession: (targetSessionId) => {
        set((state) => {
          if (!state.sessions[targetSessionId]) return {};

          const nextSessions = { ...state.sessions };
          delete nextSessions[targetSessionId];

          const fallbackSession = createSession();
          const sessionIds = Object.keys(nextSessions);
          const nextActiveSessionId =
            state.activeSessionId === targetSessionId ? (sessionIds[0] ?? fallbackSession.id) : state.activeSessionId;

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

      clearChat: () => {
        set((state) => {
          const activeSession = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
          if (!activeSession) {
            return {
              sessions: {},
              activeSessionId: null,
              messages: [],
              sessionId: null,
              lastAppliedPlanMessageId: null,
              isLoading: false,
            };
          }

          const clearedSession: ChatSession = {
            ...activeSession,
            sessionId: null,
            messages: [],
            lastAppliedPlanMessageId: null,
            updatedAt: new Date().toISOString(),
          };

          const nextSessions = {
            ...state.sessions,
            [clearedSession.id]: clearedSession,
          };

          return {
            sessions: nextSessions,
            isLoading: false,
            ...syncLegacyFields(nextSessions, state.activeSessionId),
          };
        });
      },
    }),
    {
      name: 'ai-query-store',
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
      }),
    },
  ),
);

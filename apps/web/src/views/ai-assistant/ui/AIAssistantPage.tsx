'use client';

import { useEffect, useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useAiQueryStore } from '@/features/ai-query';
import { useTripStore } from '@/entities/trip';
import { AiChat } from '@/widgets/ai-chat';
import { Button } from '@/shared/ui/button';

export function AIAssistantPage() {
  const {
    sessions,
    activeSessionId,
    messages,
    isLoading,
    sendQuery,
    applyPlanToCurrentTrip,
    lastAppliedPlanMessageId,
    createNewSession,
    switchSession,
    deleteSession,
    loadSessions,
    isSessionsLoading,
  } = useAiQueryStore();
  const currentTrip = useTripStore((state) => state.currentTrip);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const sessionsList = useMemo(
    () =>
      Object.values(sessions).sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      ),
    [sessions],
  );

  const messagesWithGreeting = useMemo(() => {
    if (messages.length > 0) return messages;

    return [
      {
        id: 'welcome-message',
        role: 'assistant' as const,
        content:
          'Привет! Я AI-помощник по путешествиям. Напиши город, даты и бюджет — соберу маршрут.',
        timestamp: new Date().toISOString(),
      },
    ];
  }, [messages]);

  const handleSend = async (query: string) => {
    await sendQuery(query, currentTrip?.id);
  };

  const handleCreateSession = () => {
    createNewSession(currentTrip?.id ?? null);
  };

  return (
    <div className="min-h-full w-full">
      <div className="mx-auto flex w-full max-w-6xl gap-4 px-4 py-6 md:px-6 md:py-10">
        <aside className="hidden w-72 flex-col rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:flex">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-bold text-brand-indigo">Чаты маршрутов</h3>
            <Button type="button" size="sm" variant="outline" onClick={handleCreateSession}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Новый чат
            </Button>
          </div>

          <div className="flex max-h-[600px] flex-col gap-2 overflow-y-auto pr-1">
            {sessionsList.map((session) => {
              const isActive = session.id === activeSessionId;

              return (
                <div
                  key={session.id}
                  className={[
                    'group rounded-2xl border p-3 transition',
                    isActive
                      ? 'border-brand-indigo bg-indigo-50/60'
                      : 'border-slate-200 bg-slate-50 hover:border-slate-300',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => switchSession(session.id)}
                  >
                    <p className="line-clamp-1 text-sm font-semibold text-slate-800">{session.title}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {new Date(session.updatedAt).toLocaleString('ru-RU', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </button>

                  <button
                    type="button"
                    aria-label="Удалить чат"
                    onClick={() => deleteSession(session.id)}
                    className="mt-2 inline-flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-rose-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Удалить
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        <div className="flex-1">
          <div className="mb-3 flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-3 py-2 md:hidden">
            <p className="text-xs text-slate-600">Активный чат: {sessionsList.find((s) => s.id === activeSessionId)?.title ?? 'Новый чат'}</p>
            <Button type="button" size="sm" variant="outline" onClick={handleCreateSession}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Новый
            </Button>
          </div>

          <AiChat
            messages={messagesWithGreeting}
            isLoading={isLoading || isSessionsLoading}
            onSend={handleSend}
            onApplyPlan={applyPlanToCurrentTrip}
            lastAppliedPlanMessageId={lastAppliedPlanMessageId}
            chatKey={activeSessionId ?? 'chat-empty'}
          />
        </div>
      </div>
    </div>
  );
}

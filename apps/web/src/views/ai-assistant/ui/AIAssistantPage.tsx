'use client';

// feature/TRI-104-ai-planner-interaction
// В этом файле добавлена логика перехвата конфликтов маршрутов до перехода в Planner.
// Потребность: унифицировать UX модалок предупреждений о перезаписи маршрутов (сохранение старого/открытие нового).
// Если убрать этот код: пользователь будет "молча" терять старый маршрут в Planner при открытии нового из чата.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { useAiQueryStore } from '@/features/ai-query';
import { useTripStore } from '@/entities/trip';
import { AiChat } from '@/widgets/ai-chat';
import { Button } from '@/shared/ui/button';
import { PlannerConflictModal } from '@/widgets/planner-conflict-modal';
import type { PlannerConflictType } from '@/widgets/planner-conflict-modal';
import { toast } from 'sonner';
import { tripsApi } from '@/entities/trip';

const AI_QUICK_ACTIONS = ['Сделать дешевле', 'Добавить больше музеев', 'Убрать пешие прогулки'];

export function AIAssistantPage() {
  const router = useRouter();
  const [showPlannerConflictModal, setShowPlannerConflictModal] = useState(false);
  const [pendingPlannerTripId, setPendingPlannerTripId] = useState<string | null>(null);
  const [pendingDraftMessageId, setPendingDraftMessageId] = useState<string | null>(null);
  const [conflictType, setConflictType] = useState<PlannerConflictType>('different_route');
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
    openOrCreateSessionFromTrip,
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

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;

  const handleSend = async (query: string) => {
    // Важно: запрос должен идти в контексте активного чата, а не текущего trip из Planner.
    // Иначе новый чат "прилипает" к открытому в Planner маршруту, скрывает кнопку применения
    // и ломает one-to-one модель chat -> trip.
    await sendQuery(query, activeSession?.tripId ?? undefined);
  };

  const handleApplyPlan = async (messageId: string) => {
    const appliedTripId = await applyPlanToCurrentTrip(messageId);
    if (!appliedTripId) {
      toast.error('Не удалось применить маршрут из чата');
      return;
    }

    toast.success('Маршрут синхронизирован с Planner');
  };

  useEffect(() => {
    // feature/TRI-104-ai-planner-interaction: автоинициализация чата.
    // Потребность: при открытом trip в Planner заранее поднимаем связанный чат (или создаем новый),
    // чтобы пользователь попадал в нужный контекст AI-чата без ручного выбора.
    // Если убрать этот код: при переходе в чат из Planner будет открыт последний активный чат,
    // не связанный с текущим маршрутом, что нарушит контекст UX.
    // Возможен конфликт: при изменении логики active trip/session (сохранить приоритет tripId -> session.tripId).
    const tripId = currentTrip?.id;
    if (!tripId || tripId.startsWith('guest-')) return;

    const hasTripSession = Object.values(sessions).some((session) => session.tripId === tripId);
    if (hasTripSession) return;

    void openOrCreateSessionFromTrip(tripId);
  }, [currentTrip?.id, sessions, openOrCreateSessionFromTrip]);

  const handleCreateSession = () => {
    createNewSession(currentTrip?.id ?? null);
  };

  const handleOpenPlanner = (tripIdOverride?: string | null, messageId?: string) => {
    // feature/TRI-104-ai-planner-interaction: переход в Planner через applyTripId.
    // Потребность: передать целевой маршрут в PlannerPage для корректной синхронизации состояния.
    // Если убрать: Planner не поймёт, какой маршрут нужно открыть из AI-чата.
    // Возможен конфликт: query-параметр applyTripId связан с обработкой в PlannerPage useEffect.
    const targetTripId = tripIdOverride ?? activeSession?.tripId ?? currentTrip?.id ?? null;

    // feature/TRI-104-ai-planner-interaction: UX guard от потери текущего маршрута Planner.
    // Потребность: до навигации в Planner предупредить пользователя и дать выбор (сохранить/заменить/отменить).
    // Если убрать: пользователь может потерять несохранённый маршрут в Planner при переходе из AI-чата.
    const openedPlannerTripId = currentTrip?.id ?? null;
    if (targetTripId && openedPlannerTripId) {
      if (openedPlannerTripId !== targetTripId) {
        setConflictType('different_route');
        setPendingPlannerTripId(targetTripId);
        setPendingDraftMessageId(messageId ?? null);
        setShowPlannerConflictModal(true);
        return;
      } else if (messageId && messageId !== lastAppliedPlanMessageId) {
        // Тот же маршрут, но применяется новая версия из чата
        setConflictType('same_route');
        setPendingPlannerTripId(targetTripId);
        setPendingDraftMessageId(messageId);
        setShowPlannerConflictModal(true);
        return;
      }
    }

    if (!targetTripId || targetTripId.startsWith('guest-')) {
      router.push('/planner');
      return;
    }

    const query = new URLSearchParams();
    query.set('applyTripId', targetTripId);
    if (messageId) query.set('draftMessageId', messageId);
    router.push(`/planner?${query.toString()}`);
  };

  const handleConfirmPlannerReplace = () => {
    const targetTripId = pendingPlannerTripId;
    const draftMessageId = pendingDraftMessageId;
    setShowPlannerConflictModal(false);
    setPendingPlannerTripId(null);
    setPendingDraftMessageId(null);

    if (!targetTripId || targetTripId.startsWith('guest-')) {
      router.push('/planner');
      return;
    }

    const query = new URLSearchParams();
    query.set('applyTripId', targetTripId);
    if (draftMessageId) query.set('draftMessageId', draftMessageId);
    router.push(`/planner?${query.toString()}`);
  };

  const plannerRouteTitle = currentTrip?.title?.trim() || 'без названия';

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
                    <p className="line-clamp-1 text-sm font-semibold text-slate-800">
                      {session.title}
                    </p>
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
            <p className="text-xs text-slate-600">
              Активный чат:{' '}
              {sessionsList.find((s) => s.id === activeSessionId)?.title ?? 'Новый чат'}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={handleCreateSession}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Новый
            </Button>
          </div>

          <AiChat
            messages={messagesWithGreeting}
            isLoading={isLoading || isSessionsLoading}
            onSend={handleSend}
            onApplyPlan={handleApplyPlan}
            onOpenPlanner={handleOpenPlanner}
            lastAppliedPlanMessageId={lastAppliedPlanMessageId}
            chatKey={activeSessionId ?? 'chat-empty'}
            quickActions={AI_QUICK_ACTIONS}
            hasLinkedTrip={Boolean(activeSession?.tripId)}
            appliedTripId={activeSession?.tripId ?? null}
          />

          {activeSession?.tripId && (
            <div className="mt-3 flex justify-end">
              <Button type="button" variant="outline" onClick={() => handleOpenPlanner()}>
                Открыть Planner 🗺️
              </Button>
            </div>
          )}

          {/* feature/TRI-104-ai-planner-interaction: единый компонент модалки конфликтов (добавлен вместо разрозненных Dialog)
              Закрывает потребность в унифицированном дизайне и 4-х вариантах действий.
              Возможен конфликт с ветками, где правили модалки напрямую в PlannerPage. */}
          <PlannerConflictModal
            open={showPlannerConflictModal}
            onOpenChange={setShowPlannerConflictModal}
            conflictType={conflictType}
            currentRouteTitle={plannerRouteTitle}
            onCancel={() => {
              setShowPlannerConflictModal(false);
              setPendingPlannerTripId(null);
              setPendingDraftMessageId(null);
            }}
            onReplaceWithoutSave={handleConfirmPlannerReplace}
            onSaveAndReplace={async () => {
              if (currentTrip && !currentTrip.id.startsWith('guest-')) {
                await tripsApi.update(currentTrip.id, {
                  title: currentTrip.title,
                  description: currentTrip.description ?? undefined,
                  budget: currentTrip.budget ?? undefined,
                });
              }
              handleConfirmPlannerReplace();
            }}
            onGoToPlannerOnly={() => {
              setShowPlannerConflictModal(false);
              setPendingPlannerTripId(null);
              setPendingDraftMessageId(null);
              router.push('/planner');
            }}
          />
        </div>
      </div>
    </div>
  );
}

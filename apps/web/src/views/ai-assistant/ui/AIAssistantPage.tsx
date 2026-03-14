'use client';

// feature/TRI-104-ai-planner-interaction
// В этом файле добавлена логика перехвата конфликтов маршрутов до перехода в Planner.
// Потребность: унифицировать UX модалок предупреждений о перезаписи маршрутов (сохранение старого/открытие нового).
// Если убрать этот код: пользователь будет "молча" терять старый маршрут в Planner при открытии нового из чата.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useAiQueryStore } from '@/features/ai-query';
import { useTripStore } from '@/entities/trip';
import { useCollaborationSocket, CollaboratorsAvatarGroup } from '@/features/route-collaborate';
import { AiChat } from '@/widgets/ai-chat';
import { Button } from '@/shared/ui/button';
import { PlannerConflictModal } from '@/widgets/planner-conflict-modal';
import type { PlannerConflictType } from '@/widgets/planner-conflict-modal';
import { toast } from 'sonner';
import { tripsApi } from '@/entities/trip';
import { clearConfig, setConfig } from '@/features/persistent-map';

const AI_QUICK_ACTIONS = ['Сделать дешевле', 'Добавить больше музеев', 'Убрать пешие прогулки'];

export function AIAssistantPage() {
  const router = useRouter();
  const [showPlannerConflictModal, setShowPlannerConflictModal] = useState(false);
  const [pendingPlannerTripId, setPendingPlannerTripId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [pendingDraftMessageId, setPendingDraftMessageId] = useState<string | null>(null);
  const [conflictType, setConflictType] = useState<PlannerConflictType>('different_route');
  const {
    sessions,
    activeSessionId,
    messages,
    isLoading,
    sendQuery,
    sendMutationQuery,
    applyPlanToCurrentTrip,
    lastAppliedPlanMessageId,
    createNewSession,
    switchSession,
    deleteSession,
    renameSession,
    loadSessions,
    isSessionsLoading,
    openOrCreateSessionFromTrip,
    clearChat,
  } = useAiQueryStore();
  const currentTrip = useTripStore((state) => state.currentTrip);

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const sessionsList = useMemo(
    () =>
      Object.values(sessions).sort((left, right) => {
        const diff = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
        // Если время обновления совпадает, сортируем по ID для стабильности
        return diff !== 0 ? diff : right.id.localeCompare(left.id);
      }),
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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isSessionsLoading) return;

    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: атомарно обработать handoff из Landing (query + targetSessionId),
    //    чтобы сначала активировать нужный чат, а потом отправить запрос именно в него.
    // 3) Если убрать: запрос может уйти в одну сессию, а UI (первое сообщение/скелетон) откроется в другой.
    // 4) Возможен конфликт с ветками, где вход в AI-чат использует только ai:pending-query
    //    или где sendQuery вызывается до switchSession.
    const rawHandoff = sessionStorage.getItem('ai:pending-handoff');
    if (!rawHandoff) {
      const pendingQuery = sessionStorage.getItem('ai:pending-query');
      if (!pendingQuery) return;

      sessionStorage.removeItem('ai:pending-query');
      void sendQuery(pendingQuery, activeSession?.tripId ?? undefined);
      return;
    }

    let handoff: { query?: unknown; targetSessionId?: unknown } | null = null;
    try {
      handoff = JSON.parse(rawHandoff) as { query?: unknown; targetSessionId?: unknown };
    } catch {
      sessionStorage.removeItem('ai:pending-handoff');
      return;
    }

    if (
      !handoff ||
      typeof handoff.query !== 'string' ||
      !handoff.query.trim() ||
      typeof handoff.targetSessionId !== 'string' ||
      !handoff.targetSessionId
    ) {
      sessionStorage.removeItem('ai:pending-handoff');
      return;
    }

    sessionStorage.removeItem('ai:pending-handoff');

    void (async () => {
      await switchSession(handoff.targetSessionId as string);
      const targetTripId =
        useAiQueryStore.getState().sessions[handoff.targetSessionId as string]?.tripId;
      await sendQuery(handoff.query as string, targetTripId ?? undefined);
    })();
  }, [isSessionsLoading, sendQuery, switchSession, activeSession?.tripId]);

  const handleSend = async (query: string) => {
    // Всегда идём через Orchestrator (sendQuery), не напрямую в mutations (sendMutationQuery).
    // Orchestrator правильно парсит intent и маршрутизирует в Intent Router.
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
    //
    // ВАЖНО: sessions намеренно НЕ в deps — эффект должен срабатывать только при смене tripId,
    // но не при изменении списка сессий (например, после удаления), иначе удалённый чат сразу
    // пересоздаётся через openOrCreateSessionFromTrip.
    if (isSessionsLoading) return;
    const tripId = currentTrip?.id;
    if (!tripId || tripId.startsWith('guest-')) return;

    // Если активная сессия уже связана с этим tripId — не дёргаем from-trip повторно.
    // Иначе каждый trip:refresh → loadTripData → openOrCreateSessionFromTrip → trip:refresh...
    const currentActiveSession = activeSessionId ? sessions[activeSessionId] : null;
    if (currentActiveSession?.tripId === tripId && currentActiveSession.messages.length > 0) return;

    void openOrCreateSessionFromTrip(tripId);
  }, [currentTrip?.id, isSessionsLoading]);

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

  const handleDeleteAllPoints = async () => {
    if (!activeSession?.tripId) return;
    const currentPointsContext = currentTrip?.points?.map((p: any) => p.title).join(', ') || '';
    await sendMutationQuery('удали все точки', activeSession.tripId, currentPointsContext);
  };

  const handleDeletePoint = async (pointName: string) => {
    if (!activeSession?.tripId) return;
    const currentPointsContext = currentTrip?.points?.map((p: any) => p.title).join(', ') || '';
    await sendMutationQuery(`удали точку ${pointName}`, activeSession.tripId, currentPointsContext);
  };

  const plannerRouteTitle = currentTrip?.title?.trim() || 'без названия';

  const lastPlanMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.routePlan) return messages[i];
    }
    return null;
  }, [messages]);

  const aiPoints = useMemo(() => {
    if (!lastPlanMessage?.routePlan) return [];
    
    let globalIndex = 0;
    return lastPlanMessage.routePlan.days.flatMap((day: any) =>
      day.points.flatMap((point: any) => {
        const poi = point?.poi;
        const lat = poi?.coordinates?.lat;
        const lon = poi?.coordinates?.lon;

        if (!poi || typeof lat !== 'number' || typeof lon !== 'number') {
          return [];
        }

        return [{
          id: poi.id || `ai-point-${globalIndex++}`,
          tripId: currentTrip?.id || 'temp',
          title: poi.name || `Точка #${point.order}`,
          lat,
          lon,
          budget: point.estimated_cost ?? null,
          visitDate: day.date || null,
          imageUrl: poi.image_url ?? null,
          address: poi.address || '',
          order: point.order ?? globalIndex,
        }];
      })
    );
  }, [lastPlanMessage?.routePlan, currentTrip?.id]);

  const displayPoints = useMemo(() => {
    const lastMessage = messages[messages.length - 1];
    const hasPlan = !!lastMessage?.routePlan;
    // Предложение считается "новым" (черновиком), только если оно еще не было применено в этот трип
    const isNewAIProposal = hasPlan && lastMessage.id !== lastAppliedPlanMessageId;

    // Если чат связан с маршрутом, и мы не смотрим на свежее (непримененное) предложение ИИ,
    // то показываем актуальное состояние маршрута из базы (синхронизируется сокетами).
    if (activeSession?.tripId && !isNewAIProposal) {
      return currentTrip?.points || [];
    }
    
    // В противном случае показываем черновик ИИ из истории чата
    return aiPoints;
  }, [activeSession?.tripId, currentTrip?.points, aiPoints, messages, lastAppliedPlanMessageId]);

  const socketTripId = activeSession?.tripId || '';
  useCollaborationSocket(socketTripId);

  useEffect(() => {
    setConfig({
      source: 'ai-assistant-page',
      priority: 40,
      points: displayPoints,
      readonly: true,
      draggable: false,
      routeProfile: 'driving',
    });

    return () => {
      clearConfig('ai-assistant-page');
    };
  }, [displayPoints]);

  return (
    <div className="min-h-full w-full">
      <div className="mx-auto flex w-full max-w-6xl gap-4 px-4 py-6 md:px-6 md:py-10">
        <aside className="hidden w-72 flex-col rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:flex">
          {activeSession?.tripId && (
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-bold text-brand-indigo">Кто в маршруте</h3>
              <CollaboratorsAvatarGroup tripId={activeSession.tripId} />
            </div>
          )}

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
                  {renamingSessionId === session.id ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => {
                        if (renameValue.trim()) void renameSession(session.id, renameValue.trim());
                        setRenamingSessionId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          if (renameValue.trim()) void renameSession(session.id, renameValue.trim());
                          setRenamingSessionId(null);
                        }
                        if (e.key === 'Escape') setRenamingSessionId(null);
                      }}
                      className="w-full rounded border border-brand-indigo bg-white px-2 py-1 text-sm font-semibold text-slate-800 outline-none"
                      autoFocus
                    />
                  ) : (
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
                  )}

                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      aria-label="Переименовать чат"
                      onClick={() => {
                        setRenamingSessionId(session.id);
                        setRenameValue(session.title);
                      }}
                      className="inline-flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-brand-indigo"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Переименовать
                    </button>
                    <button
                      type="button"
                      aria-label="Удалить чат"
                      onClick={() => deleteSession(session.id)}
                      className="inline-flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-rose-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Удалить
                    </button>
                  </div>
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
            onDeletePoint={handleDeletePoint}
            lastAppliedPlanMessageId={lastAppliedPlanMessageId}
            lastPlanMessageId={lastPlanMessage?.id ?? null}
            chatKey={activeSessionId ?? 'chat-empty'}
            quickActions={AI_QUICK_ACTIONS}
            hasLinkedTrip={Boolean(activeSession?.tripId)}
            appliedTripId={activeSession?.tripId ?? null}
          />

          {activeSession?.tripId && (
            <div className="mt-3 flex flex-wrap justify-end gap-3">
              <Button type="button" variant="outline" size="lg" onClick={handleDeleteAllPoints}>
                Удалить все точки 🗑️
              </Button>
              <Button type="button" variant="outline" size="lg" onClick={() => clearChat()}>
                Очистить историю 📜
              </Button>
              <Button type="button" variant="outline" size="lg" onClick={() => handleOpenPlanner()}>
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

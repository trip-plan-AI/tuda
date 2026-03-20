'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Send, Bot } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage, ChatRoutePlanDay } from '@/shared/types/ai-chat';

interface AiChatProps {
  chatKey?: string;
  messages: ChatMessage[];
  isLoading?: boolean;
  onSend: (query: string) => void | Promise<void>;
  onApplyPlan?: (messageId: string) => void;
  lastAppliedPlanMessageId?: string | null;
  lastPlanMessageId?: string | null;
  // TRI-104: флаги, влияющие на CTA внутри MessageBubble:
  // "Применить" vs "Обновить" + deep-link в Planner по tripId.
  // MERGE-NOTE: изменение этих пропсов требует синхронной правки MessageBubble.
  hasLinkedTrip?: boolean;
  appliedTripId?: string | null;
  onOpenPlanner?: (tripId: string | null, messageId?: string) => void;
  onDeletePoint?: (pointName: string) => Promise<void>;
  hasCollaborators?: boolean;
  onSendToAi?: (query: string) => void | Promise<void>;
  /** Progressive streaming: thinking stage label ('collecting' | 'selecting' | 'scheduling') */
  thinkingStage?: string | null;
  /** Progressive streaming: days received so far via ai:day_ready */
  streamingDays?: ChatRoutePlanDay[];
}

// Кнопки для улучшения существующего маршрута (появляются только если уже есть routePlan)
const ROUTE_MUTATION_ACTIONS = [
  'Сделай дешевле',
  'Добавь больше музеев',
  'Удали самое скучное',
];

const THINKING_STAGE_TEXT: Record<string, string> = {
  collecting:   '🔍 Ищем лучшие места...',
  hidden_gems:  '💎 Ищем локации, о которых знают только местные...',
  selecting:    '🧠 Нейросеть выбирает лучшие варианты из найденных...',
  geocoding:    '📍 Проверяем координаты и строим карту...',
  enrichment:   '✨ Уточняем детали и проверяем рейтинги...',
  scheduling:   '📅 Составляем оптимальный график по дням...',
};

/** Simple typing indicator for TRAVEL_CHAT / conversational replies */
function ChatTypingSkeleton() {
  const [dots, setDots] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev.length < 3 ? prev + '.' : ''));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex justify-start">
      <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 shadow-sm">
        <span className="text-sm text-slate-500">Обрабатываю вашу просьбу{dots}</span>
      </div>
    </div>
  );
}

function AiResponseSkeleton({ stage }: { stage?: string | null }) {
  const [dots, setDots] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev.length < 3 ? prev + '.' : ''));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const labelText = (stage && THINKING_STAGE_TEXT[stage]) ?? 'Обрабатываю вашу просьбу';

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%] rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="mb-4 h-5 flex items-center gap-1.5">
          <span className="text-sm font-medium text-brand-indigo">
            {labelText}{dots}
          </span>
        </div>

        <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
        <div className="mt-2 h-3 w-full animate-pulse rounded bg-slate-100" />
        <div className="mt-1 h-3 w-4/5 animate-pulse rounded bg-slate-100" />

        <div className="mt-4 flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="h-3 w-3/5 animate-pulse rounded bg-slate-200" />
              <div className="mt-2 h-3 w-full animate-pulse rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StreamingDayPreview({ days: _days }: { days: ChatRoutePlanDay[] }) {
  return <AiResponseSkeleton stage="scheduling" />;
}

export function AiChat({
  chatKey,
  messages,
  isLoading = false,
  onSend,
  onApplyPlan,
  lastAppliedPlanMessageId = null,
  lastPlanMessageId = null,
  hasLinkedTrip = false,
  appliedTripId = null,
  onOpenPlanner,
  onDeletePoint,
  hasCollaborators = false,
  onSendToAi,
  thinkingStage = null,
  streamingDays = [],
}: AiChatProps) {
  const [query, setQuery] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isFirstAutoScrollRef = useRef(true);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    if (isFirstAutoScrollRef.current) {
      container.scrollTop = container.scrollHeight;
      isFirstAutoScrollRef.current = false;
      return;
    }

    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [messages.length, isLoading, streamingDays.length]);

  useEffect(() => {
    setQuery('');
    setValidationError(null);
    isFirstAutoScrollRef.current = true;
  }, [chatKey]);

  const handleSubmit = () => {
    const trimmed = query.trim();
    if (!trimmed || isLoading) return;
    if (trimmed.length > 1000) {
      setValidationError('Максимальная длина запроса — 1000 символов.');
      return;
    }

    setValidationError(null);
    // В режиме AI (только для коллабораций) добавляем префикс /ai
    const finalQuery = hasCollaborators && aiMode ? `/ai ${trimmed}` : trimmed;
    onSend(finalQuery);
    setQuery('');
  };

  return (
    <div className="flex h-full max-h-150 min-h-105 flex-col overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 xl:max-h-[calc(100vh-220px)]">
      <div className="shrink-0 border-b border-slate-200 bg-white px-5 py-4">
        <h2 className="text-base font-bold text-brand-indigo">AI Ассистент</h2>
        <p className="mt-1 text-xs text-slate-500">
          Спросите про маршрут, бюджет и идеи для путешествия
        </p>
      </div>

      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !isLoading ? (
          <div className="flex h-full items-center justify-center text-center">
            <p className="max-w-sm text-sm text-slate-500">
              Напишите первый запрос, чтобы сгенерировать план поездки.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onApplyPlan={onApplyPlan}
                wasApplied={lastAppliedPlanMessageId === message.id}
                hasLinkedTrip={hasLinkedTrip}
                appliedTripId={appliedTripId}
                onOpenPlanner={onOpenPlanner}
                onDeletePoint={onDeletePoint}
                isLatestRoutePlan={lastPlanMessageId === message.id}
              />
            ))}

            {isLoading && streamingDays.length > 0 && (
              <StreamingDayPreview days={streamingDays} />
            )}
            {isLoading && streamingDays.length === 0 && (
              thinkingStage === 'chat'
                ? <ChatTypingSkeleton />
                : <AiResponseSkeleton stage={thinkingStage} />
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-4">
        {/* Показываем кнопки только если есть маршрут */}
        {messages.some((m) => m.routePlan) && (
          <div className="mb-3 flex flex-wrap gap-2">
            {ROUTE_MUTATION_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => onSend(action)}
                disabled={isLoading}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="Улучшить текущий маршрут"
              >
                {action}
              </button>
            ))}
          </div>
        )}

        {hasCollaborators && (
          <p className="mb-2 text-[11px] text-slate-400">
            <Bot className="mr-1 inline h-3 w-3" />
            {aiMode
              ? 'Режим AI активен — следующее сообщение уйдёт в AI.'
              : 'Нажми на кнопку слева, чтобы включить режим AI.'}
          </p>
        )}

        <div className="flex gap-2">
          {hasCollaborators && (
            <button
              type="button"
              title={aiMode ? 'Режим AI активен (нажми чтобы выключить)' : 'Включить режим AI'}
              disabled={isLoading}
              onClick={() => setAiMode((v) => !v)}
              className={[
                'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-all duration-200',
                'active:scale-90',
                aiMode
                  ? 'border-brand-sky bg-brand-sky text-white shadow-[0_0_0_3px_rgba(14,165,233,0.25)]'
                  : 'border-brand-sky/40 text-brand-sky hover:border-brand-sky hover:bg-brand-sky/10',
              ].join(' ')}
            >
              <Bot className={`h-4 w-4 transition-transform duration-200 ${aiMode ? 'scale-110' : ''}`} />
              {/* Пульсирующее кольцо пока активно */}
              {aiMode && (
                <span className="absolute inset-0 rounded-lg animate-ping bg-brand-sky/30 pointer-events-none" />
              )}
            </button>
          )}
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value.slice(0, 1000));
              if (validationError) setValidationError(null);
            }}
            placeholder={
              hasCollaborators
                ? aiMode
                  ? 'Запрос к AI...'
                  : 'Сообщение участникам...'
                : 'Например: 2 дня в Казани с бюджетом 10000'
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
              }
            }}
            disabled={isLoading}
            className="focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-brand-blue/20"
          />
          <Button
            type="button"
            variant="brand-blue"
            size="icon"
            onClick={handleSubmit}
            disabled={isLoading}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
          <span>{query.length}/1000</span>
          {validationError && <span className="text-red-500">{validationError}</span>}
        </div>
      </div>
    </div>
  );
}

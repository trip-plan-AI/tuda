'use client';

import React from 'react';
import Link from 'next/link';
import type { ChatMessage } from '@/shared/types/ai-chat';

interface MessageBubbleProps {
  message: ChatMessage;
  onApplyPlan?: (messageId: string) => void;
  wasApplied?: boolean;
  hasLinkedTrip?: boolean;
  appliedTripId?: string | null;
}

export function MessageBubble({
  message,
  onApplyPlan,
  wasApplied = false,
  hasLinkedTrip = false,
  appliedTripId = null,
}: MessageBubbleProps) {
  // TRI-104: bubble знает контекст связки chat<->trip и меняет CTA:
  // "Применить план" только для первого создания trip из чата.
  // Для уже связанного trip — только переход в Planner.
  // MERGE-NOTE (CONFLICT-SAFE):
  // 1) Не возвращайте кнопку "Обновить маршрут" для hasLinkedTrip.
  // 2) Для linked-trip обязательно передавайте draftMessageId в query,
  //    иначе Planner не поймёт, что пришла новая версия из чата,
  //    и модалка замены может не сработать.
  // MERGE-NOTE: если переносите кнопки из bubble в другой компонент, сохраните эту развилку,
  // иначе сломается UX-логика one-to-one связи.
  const isAssistant = message.role === 'assistant';

  const getFallbackPoi = (point: {
    poi_id?: string;
    order: number;
    poi?: {
      id?: string;
      name?: string;
      address?: string;
      description?: string;
    };
  }) => {
    const poiId = point.poi?.id ?? point.poi_id ?? `point-${point.order}`;
    const name = point.poi?.name ?? `Точка #${point.order}`;
    const address = point.poi?.address ?? 'Адрес не указан';
    const description = point.poi?.description;

    return { poiId, name, address, description };
  };

  return (
    <div className={`flex ${isAssistant ? 'justify-start' : 'justify-end'}`}>
      <div
        className={[
          'max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm',
          isAssistant
            ? 'bg-white text-slate-800 border border-slate-100'
            : 'bg-brand-indigo text-white',
        ].join(' ')}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>

        {message.routePlan && isAssistant && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
              <p>
                <span className="font-semibold text-slate-700">Город:</span>{' '}
                {message.routePlan.city}
              </p>
              <p>
                <span className="font-semibold text-slate-700">Дней:</span>{' '}
                {message.routePlan.days.length}
              </p>
              <p>
                <span className="font-semibold text-slate-700">Бюджет:</span>{' '}
                {Math.round(message.routePlan.total_budget_estimated).toLocaleString('ru-RU')} ₽
              </p>
            </div>

            {message.routePlan.days.map((day) => (
              <div
                key={`${day.day_number}-${day.date}`}
                className="rounded-xl border border-slate-100 bg-slate-50 p-3"
              >
                <p className="text-xs font-semibold text-slate-700">
                  День {day.day_number} · {new Date(day.date).toLocaleDateString('ru-RU')}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Бюджет дня: {Math.round(day.day_budget_estimated).toLocaleString('ru-RU')} ₽
                </p>

                <div className="mt-2 flex flex-col gap-2">
                  {day.points.map((point) => {
                    const poi = getFallbackPoi(point);

                    return (
                      <div
                        key={`${day.day_number}-${poi.poiId}-${point.order}`}
                        className="rounded-lg border border-slate-100 bg-white p-2"
                      >
                        <p className="text-sm font-medium text-slate-800">{poi.name}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{poi.address}</p>
                        {poi.description && (
                          <p className="mt-1 text-xs text-slate-500">{poi.description}</p>
                        )}
                        <p className="mt-1 text-xs text-slate-600">
                          {point.arrival_time}–{point.departure_time}
                          {typeof point.estimated_cost === 'number'
                            ? ` · ${Math.round(point.estimated_cost).toLocaleString('ru-RU')} ₽`
                            : ''}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {message.routePlan.notes && (
              <p className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                {message.routePlan.notes}
              </p>
            )}

            {!!message.meta?.fallbacks_triggered?.length && (
              <p className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                Деградация AI: {message.meta.fallbacks_triggered.join(', ')}
              </p>
            )}

            {onApplyPlan && (
              <div className="flex flex-wrap items-center gap-2">
                {!hasLinkedTrip && (
                  <button
                    type="button"
                    onClick={() => onApplyPlan(message.id)}
                    className={[
                      'rounded-lg px-3 py-2 text-xs font-semibold transition',
                      wasApplied
                        ? 'cursor-default bg-emerald-100 text-emerald-700'
                        : 'bg-brand-sky text-white hover:bg-brand-sky/90',
                    ].join(' ')}
                  >
                    {wasApplied ? '✓ План применен' : 'Применить план в маршрут'}
                  </button>
                )}

                {(wasApplied || hasLinkedTrip) && (
                  <Link
                    href={
                      // TRI-104 / DRAFT-HANDOFF:
                      // Задача: передать в Planner факт, что переход идёт из конкретной AI-версии.
                      // Функция: draftMessageId триггерит сравнение/предупреждение в PlannerPage.
                      // Если убрать draftMessageId, переход на тот же tripId может выглядеть как
                      // "ничего нового", и пользователь не увидит предупреждение о замене.
                      appliedTripId
                        ? `/planner?applyTripId=${encodeURIComponent(appliedTripId)}&draftMessageId=${encodeURIComponent(message.id)}`
                        : '/planner'
                    }
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-brand-indigo hover:text-brand-indigo"
                  >
                    Открыть Planner 🗺️
                  </Link>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import React from 'react';
import type { ChatMessage } from '@/shared/types/ai-chat';

interface MessageBubbleProps {
  message: ChatMessage;
  onApplyPlan?: (messageId: string) => void;
  wasApplied?: boolean;
}

export function MessageBubble({ message, onApplyPlan, wasApplied = false }: MessageBubbleProps) {
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
              <button
                type="button"
                onClick={() => onApplyPlan(message.id)}
                className="rounded-lg bg-brand-sky px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand-sky/90"
              >
                {wasApplied ? 'План применен' : 'Применить план в маршрут'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

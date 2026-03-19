'use client';

import React from 'react';
import Link from 'next/link';
import { X, MapPin } from 'lucide-react';
import type { ChatMessage } from '@/shared/types/ai-chat';

interface MessageBubbleProps {
  message: ChatMessage;
  onApplyPlan?: (messageId: string) => void;
  wasApplied?: boolean;
  hasLinkedTrip?: boolean;
  appliedTripId?: string | null;
  onOpenPlanner?: (tripId: string | null, messageId?: string) => void;
  onDeletePoint?: (pointName: string) => Promise<void>;
  isLatestRoutePlan?: boolean;
}

export function MessageBubble({
  message,
  onApplyPlan,
  wasApplied = false,
  hasLinkedTrip = false,
  appliedTripId = null,
  onOpenPlanner,
  onDeletePoint,
  isLatestRoutePlan = false,
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
  // Чужое сообщение — если заполнен userName (пришло через сокет от другого участника)
  const isRemoteUser = !isAssistant && !!message.userName;

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${hour}:${minute}`;
  };

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
    <div className={`flex items-end gap-2 ${isAssistant || isRemoteUser ? 'justify-start' : 'justify-end'}`}>
      {/* Аватарка слева — только для чужих сообщений */}
      {isRemoteUser && (
        <img
          src={message.userAvatar}
          alt={message.userName}
          className="h-7 w-7 flex-shrink-0 rounded-full object-cover"
        />
      )}

      <div className="flex max-w-[85%] flex-col gap-0.5">
        {/* Имя отправителя — над пузырём, вне белого блока */}
        {isRemoteUser && (
          <p className="ml-1 text-[11px] font-semibold text-brand-indigo">{message.userName}</p>
        )}

        <div
          className={[
            'rounded-2xl px-4 py-3 text-sm shadow-sm',
            isAssistant
              ? 'bg-white text-slate-800 border border-slate-100'
              : isRemoteUser
                ? 'bg-white border border-slate-200 text-slate-800'
                : 'bg-brand-indigo text-white',
          ].join(' ')}
        >
        {/* Выделяем жирным заголовок маршрута если есть */}
        {message.content?.startsWith('Маршрут по городу') ? (
          <div className="whitespace-pre-wrap">
            <p className="font-bold text-slate-800 mb-2">
              {message.content.split('\n')[0]}
            </p>
            {message.content.split('\n').slice(1).join('\n').trim() && (
              <p className="text-slate-600">
                {message.content.split('\n').slice(1).join('\n').trim()}
              </p>
            )}
          </div>
        ) : (
          <p className="whitespace-pre-wrap">{message.content}</p>
        )}

        {/* Время в правом нижнем углу */}
        <p className="text-[10px] text-slate-400/80 float-right ml-3 mt-1">
          {formatTime(message.timestamp)}
        </p>

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
                <span className="bg-brand-yellow/20 text-brand-yellow font-semibold px-2 py-0.5 rounded">
                  {Math.round(message.routePlan.total_budget_estimated).toLocaleString('ru-RU')} ₽
                </span>
              </p>
            </div>

            {message.routePlan.days.map((day, dayIndex) => (
              <div
                key={`${day.day_number}-${day.date}`}
                className="rounded-xl border border-slate-100 bg-slate-50 p-3"
              >
                <p className="text-xs font-semibold text-slate-700">
                  День {day.day_number} · {new Date(day.date).toLocaleDateString('ru-RU')}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Бюджет дня: <span className="bg-brand-yellow/20 text-brand-yellow font-semibold px-1.5 py-0.5 rounded inline-block">
                    {Math.round(day.day_budget_estimated).toLocaleString('ru-RU')} ₽
                  </span>
                </p>

                <div className="mt-2 flex flex-col gap-2">
                  {day.points.map((point, pointIndex) => {
                    const poi = getFallbackPoi(point);
                    // Глобальный номер точки: сумма всех точек в предыдущих днях + текущий индекс + 1
                    const globalPointNumber =
                      (message.routePlan?.days ?? [])
                        .slice(0, dayIndex)
                        .reduce((sum, d) => sum + (d.points?.length ?? 0), 0) +
                      pointIndex +
                      1;

                    return (
                      <div
                        key={`${day.day_number}-${poi.poiId}-${point.order}`}
                        className="relative rounded-lg border border-slate-100 bg-white p-2"
                      >
                        {onDeletePoint && isLatestRoutePlan && (
                          <button
                            type="button"
                            onClick={() => onDeletePoint(poi.name)}
                            className="absolute top-1 right-1 w-7 h-7 rounded-full bg-slate-50 text-slate-400 flex items-center justify-center hover:bg-red-50 hover:text-red-500 transition-all active:scale-95 z-10"
                            title="Удалить точку"
                          >
                            <X size={14} strokeWidth={2.5} />
                          </button>
                        )}
                        <div className="flex items-start gap-2 pr-5">
                          <div className="mt-0.5 flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-brand-sky text-white text-xs font-semibold">
                            {globalPointNumber}
                          </div>
                          <p className="text-sm font-medium text-slate-800">{poi.name}</p>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500">{poi.address}</p>
                        {poi.description && (
                          <p className="mt-1 text-xs text-slate-500">{poi.description}</p>
                        )}
                        <div className="mt-1 flex flex-col gap-0.5">
                          <p className="text-xs text-slate-600">
                            Прибытие: {point.arrival_time}
                          </p>
                          {typeof point.estimated_cost === 'number' && (
                            <p className="text-xs text-slate-600 font-medium">
                              Стоимость: <span className="bg-brand-yellow/20 text-brand-yellow font-semibold px-1.5 py-0.5 rounded inline-block">
                                {Math.round(point.estimated_cost).toLocaleString('ru-RU')} ₽
                              </span>
                            </p>
                          )}
                        </div>
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

             <div className="flex flex-wrap items-center gap-2">
             </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

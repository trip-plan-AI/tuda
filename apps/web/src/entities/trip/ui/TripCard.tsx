import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  MapPin,
  Moon,
  ArrowRight,
  Plus,
  AlertTriangle,
  CheckCircle2,
  MoreVertical,
  Crown,
  CalendarIcon,
} from 'lucide-react';
import { format, startOfToday, startOfMonth } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Calendar } from '@/shared/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { calcNights } from '@/shared/lib/formatters';
import { cn } from '@/shared/lib/utils';
import type { Trip } from '@/entities/trip/model/trip.types';
import { useTripStore } from '@/entities/trip/model/trip.store';
import { collaborateApi, type Collaborator } from '@/features/route-collaborate/api/collaborate.api';
import { getSocket } from '@/shared/socket/socket-client';

function getInitials(name?: string, email?: string): string {
  const text = name || email || '';
  return text.slice(0, 2).toUpperCase();
}

function formatRub(value: number) {
  return value.toLocaleString('ru-RU').replace(/\u00A0/g, ' ');
}

function BudgetSummary({
  plannedBudget,
  totalBudget,
}: {
  plannedBudget: number | null | undefined;
  totalBudget: number;
}) {
  const plan = Math.max(0, plannedBudget ?? 0);
  const total = Math.max(0, totalBudget);
  const isOverBudget = plan > 0 && total > plan;
  const progressPercent = plan > 0 ? Math.min(100, Math.round((total / plan) * 100)) : 0;

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col min-w-0">
          <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest">
            Планируемый
          </span>
          <span className="text-sm font-black text-brand-indigo leading-tight">
            {formatRub(plan)} ₽
          </span>
        </div>
        <div className="flex flex-col min-w-0 text-right">
          <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest">
            Итого по точкам
          </span>
          <span
            className={cn(
              'text-sm font-black leading-tight',
              isOverBudget ? 'text-red-500' : 'text-brand-indigo',
            )}
          >
            {formatRub(total)} ₽
          </span>
        </div>
      </div>

      <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            isOverBudget ? 'bg-red-500' : 'bg-emerald-500',
          )}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[9px] font-bold text-slate-400">
        <span>{plan > 0 ? `Использовано ${progressPercent}%` : 'Лимит не задан'}</span>
        <span className="text-right">{plan > 0 ? `${formatRub(plan - total)} ₽` : '—'}</span>
      </div>

      <div
        className={cn(
          'flex items-start gap-1.5 rounded-lg border px-2 py-1 text-[9px] font-black leading-tight',
          isOverBudget
            ? 'border-red-100 bg-red-50/70 text-red-600'
            : 'border-emerald-100 bg-emerald-50/70 text-emerald-600',
        )}
      >
        {isOverBudget ? (
          <AlertTriangle size={10} className="shrink-0 mt-px" />
        ) : (
          <CheckCircle2 size={10} className="shrink-0 mt-px" />
        )}
        {plan > 0 ? (
          isOverBudget ? (
            <span>Перерасход: +{formatRub(total - plan)} ₽</span>
          ) : (
            <span>Остаток: {formatRub(plan - total)} ₽</span>
          )
        ) : (
          <span>Задайте планируемый бюджет для контроля расхода</span>
        )}
      </div>
    </div>
  );
}

interface TripCardProps {
  trip: Trip;
  isSelected?: boolean;
  onCardClick?: (tripId: string) => void;
  onInvite?: (tripId: string) => void;
  onCollaboratorsClick?: (tripId: string) => void;
  onDatesUpdate?: (tripId: string, dates: { startDate: string; endDate: string }) => void;
}

const COVER_FALLBACK = 'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=800&q=80';

const formatDate = (d?: string | null) =>
  d
    ? new Date(d).toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

export function TripCard({
  trip,
  isSelected,
  onCardClick,
  onInvite,
  onCollaboratorsClick,
  onDatesUpdate,
}: TripCardProps) {
  const router = useRouter();
  const nights = calcNights(trip.startDate, trip.endDate);
  const [dateStep, setDateStep] = useState<'from' | 'to' | null>(null);
  const [tempFrom, setTempFrom] = useState<Date | undefined>(undefined);
  const [hoverDate, setHoverDate] = useState<Date | undefined>(undefined);
  const calendarToRef = useRef<HTMLDivElement>(null);
  const pointsCount = trip.points?.length ?? 0;
  const pointsBudgetTotal = trip.points?.reduce((sum, p) => sum + (p.budget || 0), 0) ?? 0;
  const coverSrc = trip.img || COVER_FALLBACK;

  // ── Загружаем участников через API ──
  const [participants, setParticipants] = useState<Collaborator[]>([]);

  useEffect(() => {
    collaborateApi
      .getAll(trip.id)
      .then(setParticipants)
      .catch(() => {});
  }, [trip.id]);

  // Track hover dates in calendar for range preview
  useEffect(() => {
    if (dateStep !== 'to' || !calendarToRef.current || !tempFrom) return;

    const handleDayHover = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const dayButton = target.closest('button[role="button"]');
      if (!dayButton) return;

      const ariaLabel = dayButton.getAttribute('aria-label');
      if (!ariaLabel) return;

      try {
        // Parse date from aria-label like "14 марта 2026"
        const parts = ariaLabel.split(' ');
        const dayPart = parts[0];
        const monthPart = parts[1];
        const yearPart = parts[2];

        if (dayPart && monthPart) {
          const day = parseInt(dayPart, 10);
          const monthStr = monthPart;
          const year = yearPart ? parseInt(yearPart, 10) : new Date().getFullYear();

          const monthMap: Record<string, number> = {
            'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
            'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
          };

          const month = monthMap[monthStr];
          if (month !== undefined && !isNaN(day) && !isNaN(year)) {
            const hovered = new Date(year, month, day);
            if (hovered >= tempFrom) {
              setHoverDate(hovered);
            }
          }
        }
      } catch {
        // Ignore parsing errors
      }
    };

    const container = calendarToRef.current;
    container.addEventListener('mouseover', handleDayHover);

    return () => {
      container.removeEventListener('mouseover', handleDayHover);
    };
  }, [dateStep, tempFrom]);

  // ── Real-time sync: collaborator added / removed ──
  useEffect(() => {
    const socket = getSocket();

    const onAdded = (payload: Collaborator & { tripId: string }) => {
      if (payload.tripId !== trip.id) return;
      setParticipants((prev) =>
        prev.some((p) => p.userId === payload.userId) ? prev : [...prev, payload],
      );
    };

    const onRemoved = ({ tripId, userId }: { tripId: string; userId: string }) => {
      if (tripId !== trip.id) return;
      setParticipants((prev) => prev.filter((p) => p.userId !== userId));
    };

    socket.on('collaborator:added', onAdded);
    socket.on('collaborator:removed', onRemoved);

    return () => {
      socket.off('collaborator:added', onAdded);
      socket.off('collaborator:removed', onRemoved);
    };
  }, [trip.id]);

  // ── Разделяем владельца и остальных участников ──
  const owner = participants.find((p) => p.userId === trip.ownerId);
  const others = participants.filter((p) => p.userId !== trip.ownerId);

  // ── Вычисляем слоты для визуализации ──
  const MAX_SLOTS = 3;
  const visibleOthers = others.slice(0, MAX_SLOTS);
  const hasMore = others.length > MAX_SLOTS;
  const emptySlotsCount = Math.max(0, MAX_SLOTS - visibleOthers.length);

  return (
    <div
      onClick={() => onCardClick?.(trip.id)}
      className={`group cursor-pointer rounded-2xl overflow-hidden bg-white transition-all duration-200
        ${
          isSelected
            ? 'ring-2 ring-brand-sky shadow-lg shadow-brand-sky/20'
            : 'border border-slate-100 shadow-sm hover:shadow-md'
        }`}
    >
      {/* ── HEADER: Owner + Invite button ── */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100">
        {/* Owner info */}
        {owner ? (
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-10 h-10 rounded-full border-2 border-slate-200 overflow-hidden
                            bg-brand-indigo/10 flex items-center justify-center text-[12px] font-bold text-brand-indigo shrink-0"
            >
              {owner.photo ? (
                <img
                  src={owner.photo}
                  alt={owner.name ?? owner.email}
                  className="w-full h-full object-cover"
                />
              ) : (
                getInitials(owner.name, owner.email)
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-slate-400 font-medium">Владелец</p>
              <p className="text-[13px] font-semibold text-slate-900 truncate">
                {owner.email.split('@')[0]}
              </p>
            </div>
          </div>
        ) : (
          <span />
        )}

        {/* Invite button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onInvite?.(trip.id);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg ml-2 shrink-0
                     bg-brand-sky text-white text-[12px] font-semibold
                     hover:bg-brand-sky/90 transition-colors"
        >
          <Plus size={14} />
          Пригласить
        </button>
      </div>

      {/* ── COLLABORATORS: Owner + Others with slots ── */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100">
        <div className="flex items-center gap-4">
          {/* Owner */}
          {owner && (
            <div className="flex items-center gap-2">
              <div
                className="w-8 h-8 rounded-full border-2 border-white overflow-hidden
                              bg-brand-indigo/10 flex items-center justify-center text-[10px] font-bold
                              text-brand-indigo shrink-0"
              >
                {owner.photo ? (
                  <img
                    src={owner.photo}
                    alt={owner.name ?? owner.email}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  getInitials(owner.name, owner.email)
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Crown size={14} className="text-amber-500 shrink-0" />
                <span className="text-sm font-medium text-slate-700 truncate max-w-[100px]">
                  {owner.name ?? owner.email}
                </span>
              </div>
            </div>
          )}

          {/* Separator */}
          {owner && <div className="w-px h-5 bg-slate-200" />}

          {/* Others with overlay effect — clickable to open collaborators modal */}
          <div
            className="flex items-center cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onCollaboratorsClick?.(trip.id);
            }}
          >
            {/* Real participants */}
            {visibleOthers.map((p, index) => (
              <div
                key={p.userId}
                className={cn(
                  'relative rounded-full border-2 border-white shadow-sm bg-white overflow-hidden',
                  index > 0 && '-ml-4',
                )}
              >
                <div className="w-8 h-8 rounded-full bg-brand-indigo/10 flex items-center justify-center text-[10px] font-bold text-brand-indigo">
                  {p.photo ? (
                    <img
                      src={p.photo}
                      alt={p.name ?? p.email}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    getInitials(p.name, p.email)
                  )}
                </div>
              </div>
            ))}

            {/* More indicator */}
            {hasMore && (
              <div className="-ml-4 relative flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 border-2 border-white text-[10px] font-bold text-slate-500 shadow-sm z-10">
                ...
              </div>
            )}

            {/* Empty slots with add button */}
            {!hasMore &&
              Array.from({ length: emptySlotsCount }).map((_, i) => (
                <button
                  key={`empty-${i}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onInvite?.(trip.id);
                  }}
                  title="Добавить участника"
                  className={cn(
                    'relative flex items-center justify-center w-8 h-8 rounded-full bg-slate-50 border-2 border-white text-slate-400 hover:text-brand-sky hover:bg-brand-sky/10 transition-colors shadow-sm',
                    (visibleOthers.length > 0 || i > 0) && '-ml-4',
                  )}
                >
                  <Plus size={14} />
                </button>
              ))}
          </div>
        </div>

        {/* More details button */}
        {participants.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCollaboratorsClick?.(trip.id);
            }}
            className="ml-auto flex items-center justify-center w-8 h-8 rounded-lg
                       bg-slate-100 text-slate-500 hover:bg-slate-200
                       transition-colors shrink-0"
            title="Все участники"
          >
            <MoreVertical size={16} />
          </button>
        )}
      </div>

      {/* ── Cover image ── */}
      <div className="relative w-full h-32 overflow-hidden bg-slate-100">
        <img
          src={coverSrc}
          alt={trip.title}
          className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
        />

        {/* gradient scrim */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/40" />

        {/* active badge */}
        {trip.isActive && (
          <span
            className="absolute top-3 right-3 px-2.5 py-1 rounded-full
                           bg-emerald-500 text-white text-[11px] font-bold tracking-wide"
          >
            ACTIVE
          </span>
        )}

        {/* ── BOTTOM OVERLAY: night / point tags ── */}
        <div className="absolute bottom-3 left-3 flex gap-1.5 flex-wrap">
          {nights != null && nights > 0 && (
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full
                             bg-black/50 backdrop-blur-sm text-white text-[11px] font-semibold"
            >
              <Moon size={10} />
              {nights} {nights === 1 ? 'ночь' : nights < 5 ? 'ночи' : 'ночей'}
            </span>
          )}
          {pointsCount > 0 && (
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full
                             bg-black/50 backdrop-blur-sm text-white text-[11px] font-semibold"
            >
              <MapPin size={10} />
              {pointsCount} {pointsCount === 1 ? 'точка' : pointsCount < 5 ? 'точки' : 'точек'}
            </span>
          )}
          {(trip.tags ?? []).slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="px-2.5 py-1 rounded-full bg-brand-sky/80 backdrop-blur-sm text-white text-[11px] font-semibold"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* ── Card body ── */}
      <div className="px-3 pt-2 pb-2 flex flex-col gap-1">
        {/* Title */}
        <p className="font-bold text-[14px] leading-snug text-brand-indigo line-clamp-2">
          {trip.title}
        </p>

        {/* Dates */}
        <div onClick={(e) => e.stopPropagation()}>
          <Popover
            open={dateStep !== null}
            onOpenChange={(open) => { if (!open) { setDateStep(null); setTempFrom(undefined); } }}
          >
            <PopoverTrigger asChild>
              <button
                onClick={(e) => { e.stopPropagation(); setDateStep('from'); }}
                className="flex items-center gap-1.5 px-2 py-1 text-[12px] font-semibold rounded-md transition-colors
                           text-slate-500 hover:text-brand-sky hover:bg-slate-100"
              >
                <CalendarIcon size={11} className="shrink-0" />
                {trip.startDate && trip.endDate ? (
                  <>
                    {format(new Date(trip.startDate), 'd MMM', { locale: ru })}
                    {' – '}
                    {format(new Date(trip.endDate), 'd MMM yyyy', { locale: ru })}
                  </>
                ) : (
                  <span className="text-brand-sky">Указать даты</span>
                )}
              </button>
            </PopoverTrigger>

            <PopoverContent
              className="w-auto p-0 rounded-2xl border-slate-100 shadow-2xl"
              align="start"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Step header */}
              <div className="px-4 pt-3 pb-1 flex items-center gap-2">
                {dateStep === 'to' && (
                  <button
                    onClick={() => { setDateStep('from'); setTempFrom(undefined); }}
                    className="text-[11px] text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    ← Назад
                  </button>
                )}
                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  {dateStep === 'from' ? 'Дата начала' : 'Дата окончания'}
                </p>
                {tempFrom && dateStep === 'to' && (
                  <span className="ml-auto text-[11px] text-brand-sky font-semibold">
                    {format(tempFrom, 'd MMM', { locale: ru })} →
                  </span>
                )}
              </div>

              {dateStep === 'from' && (
                <Calendar
                  mode="single"
                  selected={tempFrom ?? (trip.startDate ? new Date(trip.startDate) : undefined)}
                  disabled={(date) => date < startOfToday()}
                  onSelect={(date) => {
                    if (!date) return;
                    setTempFrom(date);
                    setDateStep('to');
                  }}
                  locale={ru}
                  captionLayout="dropdown"
                  startMonth={startOfMonth(startOfToday())}
                  endMonth={new Date(2035, 11)}
                  classNames={{ caption_label: 'hidden' }}
                />
              )}

              {dateStep === 'to' && (
                <div ref={calendarToRef} className="calendar-to-wrapper">
                  <Calendar
                    mode="single"
                    selected={trip.endDate ? new Date(trip.endDate) : undefined}
                    disabled={(date) => date < startOfToday() || (!!tempFrom && date < tempFrom)}
                    onSelect={(date) => {
                      if (!date || !tempFrom) return;
                      onDatesUpdate?.(trip.id, {
                        startDate: tempFrom.toISOString(),
                        endDate: date.toISOString(),
                      });
                      setDateStep(null);
                      setTempFrom(undefined);
                      setHoverDate(undefined);
                    }}
                    locale={ru}
                    captionLayout="dropdown"
                    startMonth={startOfMonth(startOfToday())}
                    endMonth={new Date(2035, 11)}
                    classNames={{ caption_label: 'hidden' }}
                  />
                  {hoverDate && tempFrom && (
                    <div className="px-4 pb-3 text-center text-[11px] font-semibold text-brand-sky border-t border-slate-100 pt-2">
                      📅 {Math.ceil((hoverDate.getTime() - tempFrom.getTime()) / (1000 * 60 * 60 * 24)) + 1} дней
                    </div>
                  )}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Budget summary */}
        <div className="pt-1.5 border-t border-slate-100">
          <BudgetSummary plannedBudget={trip.budget} totalBudget={pointsBudgetTotal} />
        </div>

        {/* Bottom row: arrow button */}
        <div className="flex items-center justify-end mt-0.5">
          {/* Arrow → go to planner */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              useTripStore.getState().setCurrentTrip(trip);
              router.push('/planner');
            }}
            className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center
                       text-slate-400 hover:bg-brand-sky hover:text-white
                       transition-colors duration-150"
            title="Открыть в планнере"
          >
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

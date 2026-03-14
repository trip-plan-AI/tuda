import { useRouter } from 'next/navigation';
import { MapPin, Moon, ArrowRight, Plus, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { calcNights } from '@/shared/lib/formatters';
import { cn } from '@/shared/lib/utils';
import type { Trip } from '@/entities/trip/model/trip.types';
import { useTripStore } from '@/entities/trip/model/trip.store';

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
          <span className={cn('text-sm font-black leading-tight', isOverBudget ? 'text-red-500' : 'text-brand-indigo')}>
            {formatRub(total)} ₽
          </span>
        </div>
      </div>

      <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-300', isOverBudget ? 'bg-red-500' : 'bg-emerald-500')}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[9px] font-bold text-slate-400">
        <span>{plan > 0 ? `Использовано ${progressPercent}%` : 'Лимит не задан'}</span>
        <span className="text-right">{plan > 0 ? `${formatRub(plan - total)} ₽` : '—'}</span>
      </div>

      <div className={cn(
        'flex items-start gap-1.5 rounded-lg border px-2 py-1 text-[9px] font-black leading-tight',
        isOverBudget ? 'border-red-100 bg-red-50/70 text-red-600' : 'border-emerald-100 bg-emerald-50/70 text-emerald-600',
      )}>
        {isOverBudget ? <AlertTriangle size={10} className="shrink-0 mt-px" /> : <CheckCircle2 size={10} className="shrink-0 mt-px" />}
        {plan > 0 ? (
          isOverBudget
            ? <span>Перерасход: +{formatRub(total - plan)} ₽</span>
            : <span>Остаток: {formatRub(plan - total)} ₽</span>
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
}

const COVER_FALLBACK =
  'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=800&q=80';

const formatDate = (d?: string | null) =>
  d
    ? new Date(d).toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

export function TripCard({ trip, isSelected, onCardClick, onInvite, onCollaboratorsClick }: TripCardProps) {
  const router = useRouter();
  const nights = calcNights(trip.startDate, trip.endDate);
  const pointsCount = trip.points?.length ?? 0;
  const pointsBudgetTotal = trip.points?.reduce((sum, p) => sum + (p.budget || 0), 0) ?? 0;
  const collaborators = trip.collaborators ?? [];
  const owner = collaborators.find(c => c.role === 'owner') ?? collaborators[0];
  const MAX_AVATARS = 3;
  const visibleCollabs = collaborators.slice(0, MAX_AVATARS);
  const extraCount = Math.max(0, collaborators.length - MAX_AVATARS);
  const coverSrc = trip.img || COVER_FALLBACK;

  return (
    <div
      onClick={() => onCardClick?.(trip.id)}
      className={`group cursor-pointer rounded-2xl overflow-hidden bg-white transition-all duration-200
        ${isSelected
          ? 'ring-2 ring-brand-sky shadow-lg shadow-brand-sky/20'
          : 'border border-slate-100 shadow-sm hover:shadow-md'
        }`}
    >
      {/* ── Cover image ── */}
      <div className="relative w-full aspect-[4/3] overflow-hidden bg-slate-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={coverSrc}
          alt={trip.title}
          className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
        />

        {/* gradient scrim — stronger at top and bottom */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/55" />

        {/* ── TOP OVERLAY: owner avatar + invite button ── */}
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-3 pt-3">
          {/* Owner avatar + name */}
          {owner ? (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full border-2 border-white/80 overflow-hidden
                              bg-brand-indigo/30 flex items-center justify-center text-white text-[11px] font-bold shrink-0">
                {owner.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={owner.avatarUrl} alt={owner.name ?? owner.email} className="w-full h-full object-cover" />
                ) : (
                  (owner.name ?? owner.email)[0].toUpperCase()
                )}
              </div>
              <span className="text-white text-[12px] font-semibold drop-shadow-sm truncate max-w-[120px]">
                {owner.name ?? owner.email.split('@')[0]}
              </span>
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
            className="flex items-center gap-1 px-2.5 py-1 rounded-full
                       bg-white/20 backdrop-blur-sm border border-white/40
                       text-white text-[11px] font-semibold
                       hover:bg-white/30 transition-colors"
          >
            <Plus size={11} />
            Пригласить
          </button>
        </div>

        {/* active badge */}
        {trip.isActive && (
          <span className="absolute top-3 right-3 px-2.5 py-1 rounded-full
                           bg-emerald-500 text-white text-[11px] font-bold tracking-wide">
            ACTIVE
          </span>
        )}

        {/* ── BOTTOM OVERLAY: night / point tags ── */}
        <div className="absolute bottom-3 left-3 flex gap-1.5 flex-wrap">
          {nights != null && nights > 0 && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full
                             bg-black/50 backdrop-blur-sm text-white text-[11px] font-semibold">
              <Moon size={10} />
              {nights} {nights === 1 ? 'ночь' : nights < 5 ? 'ночи' : 'ночей'}
            </span>
          )}
          {pointsCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full
                             bg-black/50 backdrop-blur-sm text-white text-[11px] font-semibold">
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
      <div className="px-4 pt-3 pb-3 flex flex-col gap-1.5">
        {/* Title */}
        <p className="font-bold text-[17px] leading-snug text-brand-indigo line-clamp-2">
          {trip.title}
        </p>

        {/* Dates */}
        <p className="text-[12px] text-slate-400 font-medium">
          {trip.startDate
            ? `${formatDate(trip.startDate)} – ${formatDate(trip.endDate)}`
            : 'Даты не заданы'}
        </p>

        {/* Budget summary */}
        <div className="mt-1 pt-2 border-t border-slate-100">
          <BudgetSummary plannedBudget={trip.budget} totalBudget={pointsBudgetTotal} />
        </div>

        {/* Bottom row: collaborator avatars + open-in-planner arrow */}
        <div className="flex items-center justify-between mt-1">
          {/* Collaborator avatars (excluding owner) */}
          {collaborators.length > 0 ? (
            <div
              className="flex -space-x-2 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onCollaboratorsClick?.(trip.id);
              }}
              title="Участники маршрута"
            >
              {visibleCollabs.map((c) => (
                <div
                  key={c.id}
                  className="w-7 h-7 rounded-full border-2 border-white bg-brand-indigo/10
                             flex items-center justify-center text-[10px] font-bold
                             text-brand-indigo overflow-hidden"
                  title={c.name ?? c.email}
                >
                  {c.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.avatarUrl} alt={c.name ?? c.email} className="w-full h-full object-cover" />
                  ) : (
                    (c.name ?? c.email)[0].toUpperCase()
                  )}
                </div>
              ))}
              {extraCount > 0 && (
                <div className="w-7 h-7 rounded-full border-2 border-white bg-brand-indigo/20
                               flex items-center justify-center text-[10px] font-bold text-brand-indigo">
                  +{extraCount}
                </div>
              )}
            </div>
          ) : (
            <span />
          )}

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

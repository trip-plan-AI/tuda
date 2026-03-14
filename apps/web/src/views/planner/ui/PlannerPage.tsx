'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Search,
  MapPin,
  Route as RouteIcon,
  Plus,
  Minus,
  MessageSquare,
  ArrowRight,
  Pencil,
  X,
  GripVertical,
  Calendar as CalendarIcon,
  AlertTriangle,
  Clock,
  Cloud,
  CloudSun,
  Sun,
  Wind,
  ChevronDown,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { format } from 'date-fns';
import { startOfMonth } from 'date-fns';
import { startOfToday } from 'date-fns';
import { ru } from 'date-fns/locale';
import { useTripStore, tripsApi, type CreateTripPayload, type Trip } from '@/entities/trip';
import { useUserStore } from '@/entities/user';
import { usePointCrud } from '@/features/route-create';
import { pointsApi } from '@/entities/route-point';
import { useAiQueryStore } from '@/features/ai-query';
import { useAuthStore, LoginModal, RegisterModal } from '@/features/auth';
import { env } from '@/shared/config/env';
import type { RoutePoint } from '@/entities/route-point';
import { toast } from 'sonner';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Chip } from '@/shared/ui/chip';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Calendar,
} from '@/shared/ui';
import { clearConfig, setConfig } from '@/features/persistent-map';
import { PlannerConflictModal } from '@/widgets/planner-conflict-modal';
import type { PlannerConflictType } from '@/widgets/planner-conflict-modal';

interface GeoSuggestion {
  displayName: string;
  uri?: string; // ymapsbm1://geo?ll=LON,LAT&z=...
}

function filterUniqueSuggestions(results: any[]): GeoSuggestion[] {
  const seenCoords = new Set<string>();
  const seenNames = new Set<string>();
  const unique: GeoSuggestion[] = [];

  for (const item of results) {
    const displayName = (item.displayName ?? '').trim();
    if (!displayName) continue;

    const uri = item.uri as string | undefined;
    // Check various possible coordinate fields for robustness (backend tiers may vary)
    const lat = item.lat ?? item.geometry?.point?.lat ?? item.data?.geo_lat;
    const lon = item.lon ?? item.geometry?.point?.lon ?? item.data?.geo_lon;

    if (seenNames.has(displayName.toLowerCase())) continue;

    let coordsKey = '';
    if (lat !== undefined && lon !== undefined && !isNaN(Number(lat)) && !isNaN(Number(lon))) {
      coordsKey = `${Number(lon).toFixed(5)},${Number(lat).toFixed(5)}`;
    } else if (uri) {
      const match = uri.match(/[?&]ll=([^&]+)/);
      if (match && match[1]) {
        const rawCoords = decodeURIComponent(match[1]);
        const [p0, p1] = rawCoords.split(',').map(Number);
        if (p0 !== undefined && p1 !== undefined && !isNaN(p0) && !isNaN(p1)) {
          coordsKey = `${p0.toFixed(5)},${p1.toFixed(5)}`;
        } else {
          coordsKey = rawCoords;
        }
      }
    }

    if (coordsKey) {
      if (seenCoords.has(coordsKey)) continue;
      seenCoords.add(coordsKey);
    }

    seenNames.add(displayName.toLowerCase());
    unique.push({ displayName, uri });
  }

  return unique;
}

const FILTERS = ['Все', 'Активный', 'Зима', 'Экстрим'] as const;
type Filter = (typeof FILTERS)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatDuration(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (d > 0) parts.push(`${d} дн.`);
  if (h > 0) parts.push(`${h} ч`);
  if (m > 0) parts.push(`${m} мин`);

  return parts.length > 0 ? parts.join(' ') : '0 мин';
}

function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} м`;
  return `${(meters / 1000).toFixed(1)} км`;
}

/**
 * Вычисляет даты для точек маршрута по цепочке.
 * Если у точки дата пустая или раньше (дата предыдущей + время пути), ставит автоматически.
 * Возвращает массив {id, visitDate} для точек, которые нужно обновить.
 */
function computeDateCascade(
  points: RoutePoint[],
  legs: { duration: number; distance: number }[],
  fromIndex: number,
): Array<{ id: string; visitDate: string }> {
  const updates: Array<{ id: string; visitDate: string }> = [];
  const dates = points.map((p) => p.visitDate);

  for (let j = fromIndex + 1; j < points.length; j++) {
    const prevDate = dates[j - 1];
    if (!prevDate) break;

    const leg = legs[j - 1];
    if (!leg) break;

    const minMs = new Date(prevDate).getTime() + leg.duration * 1000;
    const currentMs = dates[j] ? new Date(dates[j]!).getTime() : null;

    if (currentMs === null || currentMs < minMs) {
      const newDate = new Date(minMs).toISOString();
      dates[j] = newDate;
      updates.push({ id: points[j]!.id, visitDate: newDate });
    }
    // Если дата уже корректна — оставляем её, но продолжаем проверку дальше по цепочке
  }

  return updates;
}

interface PointRowProps {
  point: RoutePoint;
  index: number;
  editingPointId: string | null;
  editingTitle: string;
  setEditingPointId: (id: string | null) => void;
  setEditingTitle: (t: string) => void;
  onUpdate: (
    id: string,
    patch: {
      title?: string;
      budget?: number;
      visitDate?: string | undefined;
      address?: string | null;
      lat?: number;
      lon?: number;
      transportMode?: 'driving' | 'foot' | 'bike' | 'direct';
    },
  ) => void;
  onRemove: (id: string) => void;
  onFocusPoint: (coords: { lon: number; lat: number }) => void;
  leg?: { duration: number; distance: number };
  isRouteLoading?: boolean;
  userLocation?: { lat: number; lon: number };
}

function SortablePointRow({
  point,
  index,
  editingPointId,
  editingTitle,
  setEditingPointId,
  setEditingTitle,
  onUpdate,
  onRemove,
  onFocusPoint,
  leg,
  isRouteLoading,
  userLocation,
}: PointRowProps) {
  const [addressVal, setAddressVal] = useState(point.address ?? '');
  const [suggestions, setSuggestions] = useState<GeoSuggestion[]>([]);
  const [showDropdownState, setShowDropdownState] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAddressVal(point.address ?? '');
  }, [point.address]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdownState(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: point.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const getSuggestions = async (query: string) => {
    if (query.length < 3) {
      setSuggestions([]);
      setShowDropdownState(false);
      return;
    }
    setIsSearching(true);
    try {
      const locSuffix = userLocation ? `&lat=${userLocation.lat}&lon=${userLocation.lon}` : '';
      const url = `${env.apiUrl}/geosearch/suggest?q=${encodeURIComponent(query)}${locSuffix}`;
      const res = await fetch(url);
      const data = await res.json();

      const found = filterUniqueSuggestions(data.results ?? []);
      setSuggestions(found);
      setShowDropdownState(true);
    } catch {
      setSuggestions([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleAddressChange = (val: string) => {
    setAddressVal(val);
    if (val.length > 2) {
      setIsSearching(true);
    } else {
      setIsSearching(false);
      setSuggestions([]);
      setShowDropdownState(false);
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => getSuggestions(val), 700);
  };

  const handleSelectSuggestion = async (s: GeoSuggestion) => {
    setShowDropdownState(false);
    setAddressVal(s.displayName);
    setIsSearching(true);
    try {
      let coords: { lat: number; lon: number } | null = null;
      if (s.uri) {
        const match = s.uri.match(/[?&]ll=([^&]+)/);
        if (match) {
          const [lon, lat] = decodeURIComponent(match[1]!).split(',').map(Number) as [
            number,
            number,
          ];
          if (Number.isFinite(lon) && Number.isFinite(lat)) coords = { lat, lon };
        }
      }

      if (coords) {
        const cityName = s.displayName.split(/[,.]/).shift()?.trim() || s.displayName;
        onUpdate(point.id, {
          address: s.displayName,
          lat: coords.lat,
          lon: coords.lon,
          title: cityName,
        });
        onFocusPoint(coords);
      }
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="planner-point-row"
      data-point-id={point.id}
      className={cn('flex flex-col gap-3 group', showDropdownState && 'z-50')}
    >
      {index > 0 && (leg || isRouteLoading) && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-1.5 md:gap-3 self-center px-2.5 md:px-4 py-2 bg-white border border-slate-100 rounded-2xl md:rounded-full shadow-sm animate-in fade-in slide-in-from-top-1 my-2 relative z-10 w-full max-w-[300px] sm:max-w-[340px] md:max-w-[420px] justify-center transition-all',
            isDragging && 'invisible',
          )}
        >
          <div className="flex items-center gap-1 md:gap-1.5 shrink-0">
            <button
              onClick={() => onUpdate(point.id, { transportMode: 'driving' })}
              className={cn(
                'p-1.5 rounded-xl transition-all hover:scale-110',
                (point.transportMode || 'driving') === 'driving'
                  ? 'bg-[#eaf5fd] shadow-sm'
                  : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100',
              )}
              title="На авто"
            >
              <span className="text-sm md:text-base leading-none">🚗</span>
            </button>
            <button
              onClick={() => onUpdate(point.id, { transportMode: 'foot' })}
              className={cn(
                'p-1.5 rounded-xl transition-all hover:scale-110',
                point.transportMode === 'foot'
                  ? 'bg-brand-amber/10 shadow-sm'
                  : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100',
              )}
              title="Пешком"
            >
              <span className="text-sm md:text-base leading-none">🚶</span>
            </button>
            <button
              onClick={() => onUpdate(point.id, { transportMode: 'bike' })}
              className={cn(
                'p-1.5 rounded-xl transition-all hover:scale-110',
                point.transportMode === 'bike'
                  ? 'bg-emerald-50 shadow-sm'
                  : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100',
              )}
              title="На велосипеде"
            >
              <span className="text-sm md:text-base leading-none">🚲</span>
            </button>
            <button
              onClick={() => onUpdate(point.id, { transportMode: 'direct' })}
              className={cn(
                'p-1.5 rounded-xl transition-all hover:scale-110',
                point.transportMode === 'direct'
                  ? 'bg-brand-purple/10 shadow-sm'
                  : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100',
              )}
              title="Прямая линия"
            >
              <span className="text-sm md:text-base leading-none">📏</span>
            </button>
          </div>
          <div className="w-px h-4 bg-slate-100 md:w-1 md:h-1 md:rounded-full md:bg-slate-200" />
          <div className="relative flex flex-wrap items-center gap-1.5 md:pl-2">
            {isRouteLoading && (
              <div className="absolute inset-0 bg-white/40 flex items-center justify-center z-10 animate-in fade-in duration-200">
                <div className="w-4 h-4 border border-brand-indigo border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {leg && (
              <div
                className={cn(
                  'flex flex-wrap items-center gap-x-3 gap-y-1',
                  isRouteLoading && 'opacity-40',
                )}
              >
                {(point.transportMode || 'driving') !== 'direct' && (
                  <>
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <Clock size={12} className="text-brand-blue shrink-0" />
                      <span className="text-[10px] md:text-xs font-black text-slate-700 uppercase tracking-tight">
                        {formatDuration(leg.duration)}
                      </span>
                    </div>
                    <div className="w-px h-3 bg-slate-200" />
                  </>
                )}
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  <RouteIcon size={12} className="text-emerald-500 shrink-0" />
                  <span className="text-[10px] md:text-xs font-black text-slate-500 uppercase tracking-tight">
                    {formatDistance(leg.distance)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div
        className={cn(
          'flex flex-row items-center lg:items-start justify-start gap-3 md:gap-4 group/row bg-slate-50 p-4 rounded-2xl border border-transparent hover:border-slate-200 transition-all shadow-sm hover:shadow-md relative z-0',
          isDragging && 'invisible',
        )}
      >
        <button
          onClick={() => onRemove(point.id)}
          className="absolute top-3 right-3 w-7 h-7 rounded-full bg-slate-50 text-slate-400 flex items-center justify-center hover:bg-red-50 hover:text-red-500 transition-all active:scale-95 z-10"
        >
          <X size={14} strokeWidth={2.5} />
        </button>

        <div className="flex items-center lg:items-start gap-2 lg:pt-1">
          <button
            {...attributes}
            {...listeners}
            className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing transition-colors shrink-0 touch-none"
          >
            <GripVertical size={16} />
          </button>
          <button
            onClick={() => onFocusPoint({ lon: point.lon, lat: point.lat })}
            className="w-5 h-5 md:w-6 md:h-6 shrink-0 rounded-full bg-brand-blue text-white font-bold hidden lg:flex items-center justify-center text-[10px] shadow-sm cursor-pointer hover:bg-brand-blue-hover transition-colors"
          >
            {index + 1}
          </button>
        </div>

        <div className="flex-1 flex flex-col items-start gap-2 min-w-0 pr-10 w-full">
          <div className="flex flex-col lg:flex-row lg:items-center gap-2 min-w-0 w-full items-start">
            <div className="flex-1 min-w-0 flex items-center justify-start gap-2 w-full">
              <button
                onClick={() => onFocusPoint({ lon: point.lon, lat: point.lat })}
                className="w-5 h-5 shrink-0 rounded-full bg-brand-blue text-white font-bold flex lg:hidden items-center justify-center text-[10px] shadow-sm cursor-pointer hover:bg-brand-blue-hover transition-colors"
              >
                {index + 1}
              </button>

              {editingPointId === point.id ? (
                <input
                  autoFocus
                  type="text"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={() => {
                    if (editingTitle.trim()) onUpdate(point.id, { title: editingTitle.trim() });
                    setEditingPointId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (editingTitle.trim()) onUpdate(point.id, { title: editingTitle.trim() });
                      setEditingPointId(null);
                    }
                    if (e.key === 'Escape') setEditingPointId(null);
                  }}
                  className="flex-1 min-w-0 bg-white border border-brand-blue rounded-lg px-2 py-1 font-bold text-slate-700 text-sm outline-none text-left"
                />
              ) : (
                <>
                  <span
                    title={point.title}
                    className="min-w-0 font-bold text-slate-700 text-sm md:text-base truncate text-left"
                  >
                    {point.title}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => {
                      setEditingPointId(point.id);
                      setEditingTitle(point.title);
                    }}
                    className="text-slate-300 hover:text-brand-blue hover:bg-transparent transition-all shrink-0"
                  >
                    <Pencil size={14} />
                  </Button>
                </>
              )}
            </div>

            <div className="flex flex-col gap-2 w-full lg:flex-row lg:items-center lg:shrink-0 lg:ml-auto lg:w-auto">
              <Popover open={dateOpen} onOpenChange={setDateOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      'w-full lg:w-44 px-3 py-2 bg-white border border-slate-200 rounded-xl font-bold text-slate-500 justify-start text-left text-sm hover:bg-slate-50 transition-all',
                      !point.visitDate && 'text-slate-300',
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
                    {point.visitDate
                      ? format(new Date(point.visitDate), 'd MMM yyyy', { locale: ru })
                      : 'Дата'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-auto p-0 rounded-2xl border-slate-100 shadow-2xl"
                  align="end"
                >
                  <Calendar
                    mode="single"
                    selected={point.visitDate ? new Date(point.visitDate) : undefined}
                    onSelect={(date) => {
                      onUpdate(point.id, { visitDate: date?.toISOString() });
                      setDateOpen(false);
                    }}
                    disabled={(date) => date < startOfToday()}
                    locale={ru}
                    captionLayout="dropdown"
                    startMonth={startOfMonth(startOfToday())}
                    endMonth={new Date(2035, 11)}
                    classNames={{ caption_label: 'hidden' }}
                  />
                </PopoverContent>
              </Popover>
              <div className="flex items-center justify-between border border-slate-200 rounded-xl px-3 py-2 bg-white hover:border-slate-300 transition-colors w-full lg:w-40">
                <button
                  onClick={() =>
                    onUpdate(point.id, { budget: Math.max(0, (point.budget ?? 0) - 1000) })
                  }
                  className="text-slate-400 hover:text-brand-indigo transition-colors p-0.5 flex items-center justify-center"
                  type="button"
                >
                  <Minus size={16} />
                </button>
                <div className="flex items-center justify-center flex-1 min-w-0">
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={point.budget ?? 0}
                    onChange={(e) =>
                      onUpdate(point.id, { budget: Math.max(0, Number(e.target.value) || 0) })
                    }
                    onKeyDown={(e) => {
                      if (e.key === '-' || e.key === 'e') e.preventDefault();
                    }}
                    className="w-16 bg-transparent text-center font-bold text-brand-indigo outline-none text-sm [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    style={{ MozAppearance: 'textfield' }}
                  />
                  <span className="text-slate-400 font-bold text-sm">₽</span>
                </div>
                <button
                  onClick={() => onUpdate(point.id, { budget: (point.budget ?? 0) + 1000 })}
                  className="text-slate-400 hover:text-brand-indigo transition-colors p-0.5 flex items-center justify-center"
                  type="button"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>
          </div>

          <div ref={dropdownRef} className="relative w-full">
            <div
              title={addressVal}
              className="flex items-center justify-start gap-2 px-3 py-2 bg-white border border-slate-200 hover:border-slate-300 focus-within:border-brand-blue/30 focus-within:shadow-sm transition-all rounded-xl"
            >
              <div className="flex items-center gap-2 min-w-0 w-full">
                {isSearching ? (
                  <div className="w-3 h-3 border border-brand-blue border-t-transparent rounded-full animate-spin shrink-0" />
                ) : (
                  <MapPin size={14} className="text-slate-400 shrink-0" />
                )}
                <input
                  type="text"
                  value={addressVal}
                  title={addressVal}
                  onChange={(e) => handleAddressChange(e.target.value)}
                  onFocus={() => {
                    if (addressVal.length > 2) {
                      setShowDropdownState(true);
                      if (suggestions.length === 0) getSuggestions(addressVal);
                    }
                  }}
                  onBlur={() => {
                    setTimeout(() => {
                      if (!showDropdownState) onUpdate(point.id, { address: addressVal || null });
                    }, 200);
                  }}
                  placeholder="Введите адрес..."
                  className="text-sm text-slate-500 bg-transparent border-none outline-none w-full placeholder:text-slate-300 font-bold focus:text-slate-700 cursor-text text-left"
                />
              </div>
            </div>
            {showDropdownState && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl border border-slate-100 shadow-2xl overflow-hidden z-40 animate-in fade-in zoom-in-95 duration-200">
                <div className="flex flex-col max-h-60 overflow-y-auto no-scrollbar">
                  {suggestions.length > 0 ? (
                    suggestions.map((s, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSelectSuggestion(s)}
                        className="flex items-center gap-3 w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 group"
                      >
                        <div className="w-8 h-8 rounded-full bg-slate-50 group-hover:bg-brand-blue/10 flex items-center justify-center text-slate-300 group-hover:text-brand-blue transition-colors shrink-0">
                          <MapPin size={14} />
                        </div>
                        <span className="text-sm md:text-base font-bold text-slate-700 group-hover:text-brand-indigo truncate flex-1">
                          {s.displayName}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="px-5 py-4 text-slate-500 text-sm font-medium text-center italic">
                      Ничего не найдено
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const weatherIcons = [Cloud, Sun, CloudSun, Wind];

export function PlannerPage() {
  const { geoDenied, setGeoDenied } = useUserStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { openOrCreateSessionFromTrip } = useAiQueryStore();
  const initialTab = searchParams.get('tab') === 'popular' ? 'popular' : 'my';
  const [activeTab, setActiveTab] = useState<'my' | 'popular'>(initialTab);
  const [searchInput, setSearchInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [suggestions, setSuggestions] = useState<GeoSuggestion[]>([]);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justMigratedRef = useRef(false);
  // feature/TRI-104-ai-planner-interaction: idempotency-guard для обработки applyTripId.
  // Потребность: чтобы не срабатывали повторные toasts/загрузки при re-render и router.replace.
  const handledApplyTripIdRef = useRef<string | null>(null);
  const userLocationRef = useRef<{ lat: number; lon: number } | null>(null);
  const prevLegsCountRef = useRef(0);
  const prevLegsDurationsRef = useRef<string>('');

  const [isActiveRoute, setIsActiveRoute] = useState(false);
  const [focusCoords, setFocusCoords] = useState<{ lon: number; lat: number } | null>(null);
  const [showBudgetWarning, setShowBudgetWarning] = useState(true);

  const [editingPointId, setEditingPointId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<Filter>('Все');
  const [popularSearch, setPopularSearch] = useState('');
  const [predefinedTrips, setPredefinedTrips] = useState<Trip[]>([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [modal, setModal] = useState<'login' | 'register' | null>(null);
  const [isAddPointMode, setIsAddPointMode] = useState(false);
  const [isOptimizationExpanded, setIsOptimizationExpanded] = useState(true);
  const [showPlannerConflictModal, setShowPlannerConflictModal] = useState(false);
  const [pendingApplyTripId, setPendingApplyTripId] = useState<string | null>(null);
  const [pendingDraftMessageId, setPendingDraftMessageId] = useState<string | null>(null);
  const [conflictType, setConflictType] = useState<PlannerConflictType>('different_route');
  const addPointStartCountRef = useRef(0);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.geolocation && !geoDenied) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userLocationRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) {
            setGeoDenied(true);
          }
          console.warn('Geolocation error:', err.message);
        },
        { timeout: 5000 },
      );
    }
  }, [geoDenied, setGeoDenied]);

  const handleAddPointModeChange = useCallback((active: boolean) => {
    if (active) {
      addPointStartCountRef.current = useTripStore.getState().currentTrip?.points?.length ?? 0;
    }
    setIsAddPointMode(active);
  }, []);

  const profileParam = searchParams.get('profile');
  const [routeProfile, setRouteProfile] = useState<'driving' | 'foot' | 'bike' | 'direct'>(
    (profileParam as any) || 'driving',
  );

  const {
    currentTrip,
    setCurrentTrip,
    updateCurrentTrip,
    clearPlanner,
    setPoints,
    _hasHydrated,
    isDirty,
    setSaved,
    optimizationResults,
    setOptimizationResults,
    previousPoints,
    setPreviousPoints,
    lastOptimizedPoints,
    setLastOptimizedPoints,
    lastOptimizedProfile,
    setLastOptimizedProfile,
  } = useTripStore();
  const points = currentTrip?.points || [];
  const { isAuthenticated } = useAuthStore();
  const crud = usePointCrud(currentTrip?.id);

  const [routeInfo, setRouteInfo] = useState<{
    duration: number;
    distance: number;
    legs: { duration: number; distance: number }[];
  } | null>(() => useTripStore.getState().cachedRouteInfo ?? null);
  const [isRouteLoading, setIsRouteLoading] = useState(false);
  const [affectedSegments, setAffectedSegments] = useState<Set<number>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);

  const isAlreadyOptimal = useMemo(() => {
    if (!lastOptimizedPoints || points.length !== lastOptimizedPoints.length) return false;
    return points.every((p, i) => {
      const lo = lastOptimizedPoints[i];
      // Compare ID and coordinates
      return lo && p.id === lo.id && p.lat === lo.lat && p.lon === lo.lon;
    });
  }, [points, lastOptimizedPoints]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'popular' || tab === 'my') {
      setActiveTab(tab as 'my' | 'popular');
    }
  }, [searchParams]);

  useEffect(() => {
    if (optimizationResults.status !== 'idle' && !isAlreadyOptimal) {
      setOptimizationResults({ status: 'idle', metrics: null });
      setPreviousPoints(null);
    }
  }, [isAlreadyOptimal, optimizationResults.status]);

  const resolveCoords = useCallback(async (query: string) => {
    try {
      const loc = userLocationRef.current;
      const locSuffix = loc ? `&lat=${loc.lat}&lon=${loc.lon}` : '';
      const url = `${env.apiUrl}/geosearch/suggest?q=${encodeURIComponent(query)}${locSuffix}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const results = data.results ?? [];

      if (results.length > 0) {
        const first = results[0];
        const match = first.uri?.match(/[?&]ll=([^&]+)/);
        if (match) {
          const [lonStr, latStr] = decodeURIComponent(match[1]).split(',');
          const lon = Number(lonStr);
          const lat = Number(latStr);
          if (Number.isFinite(lon) && Number.isFinite(lat)) {
            return { lon, lat, address: first.displayName || query };
          }
        }
      }
    } catch (e) {
      console.error('[Geosearch] Geocoding failed:', e);
    }
    return null;
  }, []);

  const resolveMapCoords = useCallback(async (coords: { lon: number; lat: number }) => {
    try {
      const url = `${env.apiUrl}/geosearch/reverse?lat=${coords.lat}&lon=${coords.lon}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      if (!data) return null;
      const address = data.displayName || `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`;
      const title = data.title || address;
      return { address, title };
    } catch {
      return null;
    }
  }, []);

  const { isMixedRoute, mixedModes } = useMemo(() => {
    if (points.length < 2) return { isMixedRoute: false, mixedModes: [] };
    // Only check points[1..n] because point[i].transportMode defines segment (i-1)→i
    const modes = points.slice(1).map((p) => p.transportMode || 'driving');
    const first = modes[0];
    const isMixedRoute = modes.some((m) => m !== first);
    return { isMixedRoute, mixedModes: Array.from(new Set(modes)) };
  }, [points]);

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 0, tolerance: 0 },
    }),
  );

  // Обёртка над crud.update: при смене visitDate каскадно пересчитывает даты вперёд
  const handlePointUpdate = useCallback(
    async (id: string, patch: Parameters<typeof crud.update>[1]) => {
      const fullPatch = { ...patch };
      if ('title' in patch && patch.title) {
        (fullPatch as any).isTitleCustom = true;
      }
      await crud.update(id, fullPatch);
      if ('visitDate' in patch && patch.visitDate && routeInfo?.legs) {
        const pts = useTripStore.getState().currentTrip?.points ?? [];
        const fromIndex = pts.findIndex((p) => p.id === id);
        if (fromIndex >= 0) {
          const cascadeUpdates = computeDateCascade(pts, routeInfo.legs, fromIndex);
          for (const u of cascadeUpdates) {
            await crud.update(u.id, { visitDate: u.visitDate });
          }
        }
      }
    },
    [crud, routeInfo],
  );

  // Когда появляется новый сегмент или меняется duration сегмента (смена режима передвижения),
  // каскадно проставляем даты от первой датированной точки
  useEffect(() => {
    const legs = routeInfo?.legs;
    const legsCount = legs?.length ?? 0;
    const legsDurationsKey = legs ? legs.map((l) => l.duration).join(',') : '';

    const legsCountChanged = legsCount > prevLegsCountRef.current;
    const legsDurationsChanged = legsDurationsKey !== prevLegsDurationsRef.current;

    if ((legsCountChanged || legsDurationsChanged) && legs && points.length > 1) {
      prevLegsCountRef.current = legsCount;
      prevLegsDurationsRef.current = legsDurationsKey;
      const firstDatedIdx = points.findIndex((p) => p.visitDate);
      if (firstDatedIdx >= 0) {
        const cascadeUpdates = computeDateCascade(points, legs, firstDatedIdx);
        cascadeUpdates.forEach((u) => crud.update(u.id, { visitDate: u.visitDate }));
      }
    } else {
      prevLegsCountRef.current = legsCount;
      prevLegsDurationsRef.current = legsDurationsKey;
    }
  }, [routeInfo]);

  useEffect(() => {
    useTripStore.getState().setCachedRouteInfo(null);
  }, []);

  useEffect(() => {
    if (!currentTrip?.id || currentTrip.id.startsWith('guest-')) return;
    if (justMigratedRef.current) {
      justMigratedRef.current = false;
      return;
    }

    // Если точки уже есть в store (например, применены из AI-чата),
    // не перетираем их пустым ответом с бэкенда при первом открытии Planner.
    if ((currentTrip.points?.length ?? 0) > 0) return;

    pointsApi
      .getAll(currentTrip.id)
      .then((pts) => setPoints(pts, false))
      .catch((e) => {
        console.error('Failed to load points:', e);

        const message = e instanceof Error ? e.message : '';
        // Если в localStorage остался чужой/устаревший tripId, сбрасываем его,
        // чтобы ниже сработала загрузка доступных поездок текущего пользователя.
        if (message.includes('Access denied') || message.includes('403')) {
          setCurrentTrip(null as unknown as Trip);
          return;
        }

        setPoints([], false);
      });
  }, [currentTrip?.id, setPoints]);

  useEffect(() => {
    if (!_hasHydrated) return; // Wait for store to hydrate
    if (currentTrip) return;

    // Если есть входящий applyTripId, не подставляем маршрут автоматически,
    // чтобы конфликтный guard отработал корректно и не было «тихой» замены.
    const incomingTripId = searchParams.get('applyTripId');
    if (incomingTripId) return;

    if (!isAuthenticated) {
      const guestTrip: Trip = {
        id: `guest-${Date.now()}`,
        ownerId: 'guest',
        title: 'Мой маршрут',
        description: null,
        budget: 0,
        startDate: null,
        endDate: null,
        isActive: false,
        isPredefined: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        points: [],
      };
      setCurrentTrip(guestTrip);
      return;
    }
    tripsApi
      .getAll()
      .then((all) => {
        if (all.length > 0) {
          const target = all[0];
          if (target) {
            setCurrentTrip(target);
            setIsActiveRoute(target.isActive);
          }
        } else {
          const emptyTrip: Trip = {
            id: `guest-${Date.now()}`,
            ownerId: 'guest',
            title: 'Мой маршрут',
            description: null,
            budget: 0,
            startDate: null,
            endDate: null,
            isActive: false,
            isPredefined: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            points: [],
          };
          setCurrentTrip(emptyTrip);
        }
      })
      .catch(console.error);
  }, [currentTrip, setCurrentTrip, isAuthenticated, _hasHydrated, searchParams]);

  // Загружаем предзаданные туры для вкладки «Популярные»
  useEffect(() => {
    tripsApi.getPredefined().then(setPredefinedTrips).catch(console.error);
  }, []);

  // Синхронизация routeProfile с transportMode точек
  useEffect(() => {
    if (points.length === 0) return;
    if (isMixedRoute) return; // если смешанный — не меняем routeProfile

    // Все одинаковые — выбираем общий транспорт
    const common = points.find((p) => p.transportMode)?.transportMode ?? 'driving';
    setRouteProfile(common);
  }, [isMixedRoute, points.map((p) => p.transportMode).join(',')]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };
  const handleDragCancel = () => {
    setActiveId(null);
  };
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = points.findIndex((p) => p.id === active.id);
      const newIndex = points.findIndex((p) => p.id === over.id);
      const newOrder = arrayMove(points, oldIndex, newIndex);

      // Сохраняем transport modes при переупорядочивании
      // Создаём карту сегментов со старого порядка: ключ = "fromId→toId"
      const oldSegmentModes = new Map<string, string>();
      points.slice(1).forEach((point, i) => {
        const fromId = points[i]!.id;
        const toId = point.id;
        const mode = point.transportMode || 'driving';
        oldSegmentModes.set(`${fromId}→${toId}`, mode);
      });

      // Обновляем transport modes в новом порядке
      const updatedOrder = newOrder.map((point, i) => {
        if (i === 0) {
          // Первая точка не имеет входящего сегмента, но сохраняем существующий режим
          return point;
        }
        const fromId = newOrder[i - 1]!.id;
        const toId = point.id;
        const segmentKeyForward = `${fromId}→${toId}`;
        const segmentKeyReverse = `${toId}→${fromId}`;

        // Проверяем сегмент в обе стороны (могла быть транспортировка между точками в обратном порядке)
        let mode = oldSegmentModes.get(segmentKeyForward);
        if (!mode) {
          mode = oldSegmentModes.get(segmentKeyReverse);
        }
        if (!mode) {
          mode = 'driving'; // По умолчанию если сегмент новый
        }

        return { ...point, transportMode: mode as 'driving' | 'foot' | 'bike' | 'direct' };
      });

      // Определяем затронутые сегменты
      const affectedIndices = new Set<number>();

      // Добавляем индексы старой позиции (сегменты до и после)
      if (oldIndex > 0) affectedIndices.add(oldIndex - 1); // сегмент перед старой позицией
      if (oldIndex < newOrder.length - 1) affectedIndices.add(oldIndex); // сегмент после старой позиции

      // Добавляем индексы новой позиции (сегменты до и после)
      if (newIndex > 0) affectedIndices.add(newIndex - 1); // сегмент перед новой позицией
      if (newIndex < newOrder.length - 1) affectedIndices.add(newIndex); // сегмент после новой позиции

      // Собираем обновления для затронутых точек
      const pointsToUpdate: Array<{
        id: string;
        transportMode: 'driving' | 'foot' | 'bike' | 'direct';
      }> = [];
      updatedOrder.forEach((p, i) => {
        if (i > 0 && affectedIndices.has(i - 1)) {
          // Точка i определяет сегмент (i-1)→i, и этот сегмент был затронут
          const tm = (p.transportMode as 'driving' | 'foot' | 'bike' | 'direct') || 'driving';
          pointsToUpdate.push({ id: p.id, transportMode: tm });
        }
      });

      // Обновляем в порядке: сначала reorder, потом обновляем только затронутые точки
      crud.reorder(updatedOrder.map((p) => p.id));

      // Задержка для того чтобы reorder завершился, затем обновляем только затронутые
      setTimeout(() => {
        pointsToUpdate.forEach((update) => {
          crud.update(update.id, { transportMode: update.transportMode });
        });
      }, 0);
    },
    [points, crud],
  );

  const handlePointDragEnd = useCallback(
    async (
      pointId: string,
      newCoords: { lon: number; lat: number },
      _mapAddress: string,
      _mapTitle: string,
    ) => {
      const geoData = await resolveMapCoords(newCoords);
      const point = points.find((p) => p.id === pointId);
      const patch: any = {
        lat: newCoords.lat,
        lon: newCoords.lon,
        address: geoData?.address || `${newCoords.lat.toFixed(4)}, ${newCoords.lon.toFixed(4)}`,
      };

      if (!point?.isTitleCustom) {
        patch.title = geoData?.title || `${newCoords.lat.toFixed(4)}, ${newCoords.lon.toFixed(4)}`;
      }

      crud.update(pointId, patch);
    },
    [crud, resolveMapCoords, points],
  );

  const ensureTripId = useCallback(async (): Promise<string> => {
    if (
      currentTrip &&
      !(isAuthenticated && (currentTrip.id.startsWith('guest-') || !UUID_RE.test(currentTrip.id)))
    ) {
      return currentTrip.id;
    }

    if (
      currentTrip &&
      isAuthenticated &&
      (currentTrip.id.startsWith('guest-') || !UUID_RE.test(currentTrip.id))
    ) {
      const trip = await tripsApi.create({
        title: currentTrip.title || 'Мой маршрут',
        isActive: isActiveRoute,
        budget: currentTrip.budget ?? 0,
      } as CreateTripPayload);

      const createdPoints = await Promise.all(
        points.map((p) =>
          pointsApi.create(trip.id, {
            title: p.title,
            lat: p.lat,
            lon: p.lon,
            budget: p.budget ?? 0,
            visitDate: p.visitDate ?? undefined,
            imageUrl: p.imageUrl ?? undefined,
            order: p.order,
            address: p.address ?? undefined,
          }),
        ),
      );

      justMigratedRef.current = true;
      setCurrentTrip(trip);
      setPoints(createdPoints, false);
      return trip.id;
    }
    if (!isAuthenticated) {
      const guestTrip: Trip = {
        id: `guest-${Date.now()}`,
        ownerId: 'guest',
        title: 'Мой маршрут',
        description: null,
        budget: currentTrip?.budget ?? 0,
        startDate: null,
        endDate: null,
        isActive: isActiveRoute,
        isPredefined: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        points: [],
      };
      setCurrentTrip(guestTrip);
      return guestTrip.id;
    }

    const trip = await tripsApi.create({
      title: 'Мой маршрут',
      isActive: isActiveRoute,
      budget: currentTrip?.budget ?? 0,
    } as CreateTripPayload);
    setCurrentTrip(trip);
    return trip.id;
  }, [currentTrip, setCurrentTrip, isActiveRoute, isAuthenticated, points, setPoints]);

  const totalBudget = useMemo(
    () => points.reduce((sum: number, p: RoutePoint) => sum + (p.budget ?? 0), 0),
    [points],
  );

  const plannedBudget = currentTrip?.budget ?? 0;
  const budgetOverrun = Math.max(0, totalBudget - plannedBudget);
  const isBudgetExceeded = plannedBudget > 0 && budgetOverrun > 0;

  useEffect(() => {
    if (isBudgetExceeded) {
      setShowBudgetWarning(true);
    }
  }, [isBudgetExceeded]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const geocode = useCallback(async (query: string) => {
    if (query.length < 3) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }
    setIsSearching(true);
    try {
      const loc = userLocationRef.current;
      const locSuffix = loc ? `&lat=${loc.lat}&lon=${loc.lon}` : '';
      const url = `${env.apiUrl}/geosearch/suggest?q=${encodeURIComponent(query)}${locSuffix}`;
      const res = await fetch(url);
      const data = await res.json();
      const found = filterUniqueSuggestions(data.results ?? []);
      setSuggestions(found);
      setShowDropdown(true);
    } catch {
      setSuggestions([]);
      setShowDropdown(true);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (value.length > 2) {
      setIsSearching(true);
      setShowDropdown(false);
    } else {
      setIsSearching(false);
      setSuggestions([]);
      setShowDropdown(false);
    }
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => geocode(value), 1000);
  };

  const addPoint_ = useCallback(
    async (payload: { title: string; lat: number; lon: number; address?: string }) => {
      await crud.add({ ...payload, budget: 0 });
    },
    [crud],
  );

  const handleAddByQuery = async () => {
    if (!searchInput.trim()) return;
    setIsSearching(true);
    try {
      const coords = await resolveCoords(searchInput);
      if (!coords) return;
      await addPoint_({
        title: coords.address.split(/[.,;]/)[0]?.trim() || coords.address,
        lat: coords.lat,
        lon: coords.lon,
        address: coords.address,
      });
      setSearchInput('');
      setShowDropdown(false);
      setSuggestions([]);
      setFocusCoords({ lon: coords.lon, lat: coords.lat });
    } finally {
      setIsSearching(false);
    }
  };

  const handleConfirmClear = async (save: boolean) => {
    setShowClearConfirm(false);
    if (save && points.length > 0) {
      if (!isAuthenticated) {
        setModal('register');
        return;
      }
      try {
        const isExistingRealTrip = !!currentTrip?.id && UUID_RE.test(currentTrip.id);
        const tripId = await ensureTripId();

        if (isExistingRealTrip) {
          const backendPoints = await pointsApi.getAll(tripId);
          await Promise.all(backendPoints.map((p) => pointsApi.remove(tripId, p.id)));
          await Promise.all(
            points.map((p, i) =>
              pointsApi.create(tripId, {
                title: p.title,
                lat: p.lat,
                lon: p.lon,
                budget: p.budget ?? 0,
                visitDate: p.visitDate ?? undefined,
                imageUrl: p.imageUrl ?? undefined,
                order: i,
                address: p.address ?? undefined,
                transportMode: p.transportMode,
              }),
            ),
          );
        }

        const autoTitle =
          points.length > 1
            ? `${points[0]!.title} — ${points[points.length - 1]!.title}`
            : points.length === 1
              ? points[0]!.title
              : 'Мой маршрут';

        await tripsApi.update(tripId, {
          title: autoTitle,
          budget: currentTrip?.budget || null,
          isActive: isActiveRoute,
        });
        updateCurrentTrip({
          title: autoTitle,
          budget: currentTrip?.budget || null,
          isActive: isActiveRoute,
        });
        import('@/shared/socket/socket-client').then(({ getSocket }) => {
          getSocket().emit('trip:update', {
            trip_id: tripId,
            title: autoTitle,
            budget: currentTrip?.budget || null,
            isActive: isActiveRoute,
          });
        });
        setSaved();
        toast.success('Предыдущий маршрут сохранен', { id: 'planner-status' });
      } catch {
        toast.error('Не удалось сохранить маршрут', { id: 'planner-status' });
      }
    }
    setIsActiveRoute(false);
    setIsAddPointMode(false);
    clearPlanner();
    const guestTrip: Trip = {
      id: `guest-${Date.now()}`,
      ownerId: 'guest',
      title: 'Мой маршрут',
      description: null,
      budget: 0,
      startDate: null,
      endDate: null,
      isActive: false,
      isPredefined: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      points: [],
    };
    setCurrentTrip(guestTrip);
    toast.info('Конструктор очищен', { id: 'planner-status' });
  };

  const handleEditWithAi = () => {
    router.push('/ai-assistant');
  };

  const handleSelectSuggestion = async (s: GeoSuggestion) => {
    setShowDropdown(false);
    setSearchInput('');
    setSuggestions([]);
    setIsSearching(true);
    try {
      let coords: { lat: number; lon: number } | null = null;
      if (s.uri) {
        const match = s.uri.match(/[?&]ll=([^&]+)/);
        if (match) {
          const [lon, lat] = decodeURIComponent(match[1]!).split(',').map(Number) as [
            number,
            number,
          ];
          if (Number.isFinite(lon) && Number.isFinite(lat)) coords = { lat, lon };
        }
      }
      if (!coords) coords = await resolveCoords(s.displayName);
      if (!coords) return;
      await addPoint_({
        title: s.displayName.split(/[.,;]/)[0]?.trim() || s.displayName,
        lat: coords.lat,
        lon: coords.lon,
        address: s.displayName,
      });
      setFocusCoords({ lon: coords.lon, lat: coords.lat });
    } catch (e) {
      console.error('Не удалось добавить точку:', e);
    } finally {
      setIsSearching(false);
    }
  };

  const handleMapClick = useCallback(
    async (coords: { lon: number; lat: number }) => {
      setIsSearching(true);
      try {
        const geoData = await resolveMapCoords(coords);
        const payload = {
          title: geoData?.title || `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`,
          lat: coords.lat,
          lon: coords.lon,
          address: geoData?.address || `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`,
        };
        await addPoint_(payload);

        // Автоотключение режима добавления точки:
        // - если точек не было → ждём 2 → отключаем
        // - если хотя бы 1 была → ждём 1 → отключаем
        const startCount = addPointStartCountRef.current;
        const needed = startCount === 0 ? 2 : 1;
        const newCount = useTripStore.getState().currentTrip?.points?.length ?? 0;
        if (newCount >= startCount + needed) {
          setIsAddPointMode(false);
        }
      } catch (e) {
        // Фолбэк: даже при ошибке reverse geocode сохраняем точку по координатам,
        // чтобы интерактив карты не ломался в оффлайн/нестабильной среде.
        console.error('Не удалось добавить точку с карты:', e);
        await addPoint_({
          title: `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`,
          lat: coords.lat,
          lon: coords.lon,
          address: `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`,
        });
      } finally {
        setIsSearching(false);
      }
    },
    [addPoint_, resolveMapCoords],
  );

  useEffect(() => {
    setConfig({
      source: 'planner-page',
      priority: 100,
      points,
      focusCoords,
      draggable: true,
      readonly: false,
      routeProfile,
      isDropdownOpen: showDropdown,
      isAddPointMode,
      onPointDragEnd: handlePointDragEnd,
      onMapClick: handleMapClick,
      onAddPointModeChange: handleAddPointModeChange,
      onRouteInfoUpdate: setRouteInfo,
      onRouteInfoLoading: setIsRouteLoading,
      onAffectedSegmentsChange: setAffectedSegments,
    });

    return () => {
      clearConfig('planner-page');
    };
  }, [
    points,
    focusCoords,
    routeProfile,
    showDropdown,
    isAddPointMode,
    handlePointDragEnd,
    handleMapClick,
    handleAddPointModeChange,
  ]);

  const handleUpdatePlannedBudget = async (val: number) => {
    const newBudget = Math.max(0, val);
    updateCurrentTrip({ budget: newBudget });
    if (currentTrip && !currentTrip.id.startsWith('guest-')) {
      await tripsApi.update(currentTrip.id, { budget: newBudget });
      import('@/shared/socket/socket-client').then(({ getSocket }) => {
        getSocket().emit('trip:update', {
          trip_id: currentTrip.id,
          budget: newBudget,
        });
      });
    }
  };

  const clearApplyTripParams = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('applyTripId');
    params.delete('draftMessageId');
    const nextQuery = params.toString();
    router.replace(nextQuery ? `/planner?${nextQuery}` : '/planner');
  }, [router, searchParams]);

  const finalizeApplyFlow = useCallback(
    (clearQuery = true) => {
      setShowPlannerConflictModal(false);
      setPendingApplyTripId(null);
      setPendingDraftMessageId(null);
      if (clearQuery) {
        clearApplyTripParams();
      }
    },
    [clearApplyTripParams],
  );

  // feature/TRI-104-ai-planner-interaction: централизованное применение tripId из query-параметра applyTripId.
  // Потребность: загрузить маршрут из AI чата в UI без перезагрузки страницы.
  // Если убрать: маршруты из AI чата не будут переноситься в Planner.
  const applyIncomingTrip = useCallback(
    async (tripId: string) => {
      const all = await tripsApi.getAll();
      const target = all.find((trip) => trip.id === tripId);
      if (!target) return;

      const targetPoints = await pointsApi.getAll(tripId);
      setCurrentTrip({ ...target, points: targetPoints });
      setSaved();

      const params = new URLSearchParams(searchParams.toString());
      params.delete('applyTripId');
      params.delete('draftMessageId');
      const nextQuery = params.toString();
      router.replace(nextQuery ? `/planner?${nextQuery}` : '/planner');

      toast.success('Маршрут из AI чата открыт в Planner');
      // Открываем связанный AI-чат для контекста
      void openOrCreateSessionFromTrip(tripId);
    },
    [router, searchParams, setCurrentTrip, setSaved, openOrCreateSessionFromTrip],
  );

  const handleConfirmPlannerReplace = useCallback(() => {
    const targetTripId = pendingApplyTripId;
    finalizeApplyFlow(false);

    if (!targetTripId) {
      clearApplyTripParams();
      return;
    }

    if (targetTripId.startsWith('guest-')) {
      clearApplyTripParams();
      return;
    }

    void applyIncomingTrip(targetTripId);
  }, [
    pendingApplyTripId,
    applyIncomingTrip,
    clearApplyTripParams,
    finalizeApplyFlow,
  ]);

  useEffect(() => {
    if (!_hasHydrated) return;

    // feature/TRI-104-ai-planner-interaction: IDEMPOTENCY GUARD
    // Потребность: исключить зацикливание подгрузки маршрута при ре-рендерах.
    const incomingTripId = searchParams.get('applyTripId');
    const draftMessageId = searchParams.get('draftMessageId');

    if (!incomingTripId || incomingTripId.startsWith('guest-')) {
      handledApplyTripIdRef.current = null;
      return;
    }

    const currentKey = `${incomingTripId}-${draftMessageId || 'nodraft'}`;
    if (handledApplyTripIdRef.current === currentKey) return;

    const hasPlannerContent = (currentTrip?.points?.length ?? 0) > 0 || isDirty;
    const isDifferentRoute = currentTrip?.id !== incomingTripId;
    const hasIncomingDraftVersion = Boolean(draftMessageId);

    if (!hasPlannerContent || !currentTrip) {
      handledApplyTripIdRef.current = currentKey;
      void applyIncomingTrip(incomingTripId);
      return;
    }

    if (!isDifferentRoute && !hasIncomingDraftVersion) {
      handledApplyTripIdRef.current = currentKey;
      clearApplyTripParams();
      return;
    }

    handledApplyTripIdRef.current = currentKey;
    setPendingApplyTripId(incomingTripId);
    setPendingDraftMessageId(draftMessageId);
    setConflictType(hasIncomingDraftVersion ? 'same_route' : 'different_route');
    setShowPlannerConflictModal(true);
  }, [
    _hasHydrated,
    applyIncomingTrip,
    searchParams,
    points.length,
    currentTrip?.id,
    currentTrip?.points,
    isDirty,
    clearApplyTripParams,
  ]);

  useEffect(() => {
    if (activeTab !== 'my') return;
    if (points.length === 0) return;
    const first = points[0];
    if (!first) return;
    setFocusCoords({ lon: first.lon, lat: first.lat });
  }, [activeTab, points]);

  return (
    <div className="bg-white min-h-screen md:min-h-0 md:h-[calc(100vh-64px)] md:overflow-hidden w-full max-w-full flex flex-col">
      <div className="w-full mx-auto px-4 md:px-8 py-6 md:py-8 flex-1 flex flex-col relative min-h-0">
        <div className="mb-8 bg-white md:p-0 rounded-none w-full max-w-7xl mx-auto shrink-0">
          <h2 className="text-2xl md:text-4xl font-black text-brand-indigo tracking-tight mb-6 text-left">
            Маршруты
          </h2>
          <SegmentedControl
            options={[
              { label: 'Конструктор', value: 'my' },
              { label: 'Популярные', value: 'popular' },
            ]}
            value={activeTab}
            onChange={(val) => {
              setActiveTab(val as 'my' | 'popular');
              router.push(`/planner?tab=${val}`);
            }}
          />
        </div>

        <div className="flex-1 min-h-0 md:overflow-y-auto no-scrollbar md:pr-1">
          {activeTab === 'my' ? (
            <div className="animate-in fade-in duration-500 w-full relative">
              <div className="mb-10 w-full max-w-7xl mx-auto">
              {isBudgetExceeded && showBudgetWarning && (
                <div className="fixed right-4 bottom-20 md:bottom-6 z-40 animate-in slide-in-from-right-4 duration-300">
                  <div className="relative group flex items-start gap-2 rounded-2xl border border-red-200 bg-white/95 backdrop-blur px-3 py-2 shadow-lg max-w-[300px]">
                    <button
                      onClick={() => setShowBudgetWarning(false)}
                      className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-100 text-red-600 flex items-center justify-center hover:bg-red-200 transition-colors shadow-sm"
                    >
                      <X size={14} strokeWidth={3} />
                    </button>
                    <div className="mt-0.5 rounded-full bg-red-100 text-red-600 p-1.5 shrink-0">
                      <AlertTriangle size={14} />
                    </div>
                    <div className="min-w-0 pr-2">
                      <p className="text-xs md:text-sm font-black text-red-700 leading-tight">
                        Лимит превышен на {budgetOverrun.toLocaleString('ru-RU')} ₽
                      </p>
                      <p className="text-[11px] md:text-xs font-semibold text-slate-500 leading-tight mt-0.5">
                        Итого по точкам выше планируемого бюджета
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <div ref={searchContainerRef} className="w-full relative z-30">
                <div className="w-full relative group">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-brand-blue transition-colors">
                    {isSearching ? (
                      <div className="w-5 h-5 border-2 border-brand-blue border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Search size={20} />
                    )}
                  </div>
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    onFocus={() => {
                      if (searchInput.length > 2) {
                        setShowDropdown(true);
                        if (suggestions.length === 0) geocode(searchInput);
                      }
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddByQuery()}
                    placeholder="Поиск места..."
                    className="w-full pl-12 pr-4 py-4 md:py-5 bg-slate-50 rounded-xl md:rounded-2xl border-none focus:ring-2 focus:ring-brand-blue/20 outline-none text-slate-800 font-bold text-base md:text-lg transition-all placeholder:text-slate-400 shadow-sm"
                  />
                </div>
                {showDropdown && searchInput.length > 2 && (
                  <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl border border-slate-100 shadow-2xl overflow-hidden z-40 animate-in fade-in slide-in-from-top-2">
                    <div className="flex flex-col">
                      {suggestions.length > 0 ? (
                        suggestions.map((s, idx) => (
                          <button
                            key={idx}
                            onClick={() => handleSelectSuggestion(s)}
                            className="flex items-center gap-3 w-full text-left px-5 py-4 hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 group"
                          >
                            <div className="w-8 h-8 rounded-full bg-slate-100 group-hover:bg-brand-blue/10 flex items-center justify-center text-slate-400 group-hover:text-brand-blue transition-colors shrink-0">
                              <MapPin size={14} />
                            </div>
                            <span className="font-bold text-slate-700 group-hover:text-brand-indigo truncate flex-1">
                              {s.displayName}
                            </span>
                            <Plus
                              size={14}
                              className="ml-auto text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                            />
                          </button>
                        ))
                      ) : (
                        <div className="px-5 py-4 text-slate-500 text-sm font-medium text-center">
                          Ничего не найдено
                        </div>
                      )}
                      <button
                        onClick={() => {}}
                        className="flex items-center gap-3 w-full text-left px-5 py-5 bg-slate-50 hover:bg-slate-100 transition-colors group mt-2 border-t border-slate-100"
                      >
                        <div className="w-12 h-12 rounded-2xl bg-brand-purple text-white flex items-center justify-center shadow-lg shadow-brand-purple/20 group-hover:scale-105 transition-transform duration-300">
                          <MessageSquare size={22} />
                        </div>
                        <div className="flex flex-col">
                          <span className="font-black text-brand-purple uppercase tracking-wider text-xs">
                            Найти с AI
                          </span>
                          <span className="text-slate-500 text-sm font-medium">
                            AI найдет место: «{searchInput}»
                          </span>
                        </div>
                        <ArrowRight
                          size={18}
                          className="ml-auto text-brand-purple transition-transform group-hover:translate-x-1"
                        />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 mb-6 w-full max-w-7xl mx-auto">
              <div className="grid grid-cols-2 sm:flex sm:flex-row items-stretch bg-slate-100 p-1.5 rounded-[1.25rem] shadow-inner shrink-0 h-auto lg:h-16 gap-1 sm:gap-0">
                {isMixedRoute ? (
                  <div className="col-span-2 sm:col-span-1 flex items-center justify-between px-4 sm:px-6 py-3.5 bg-white shadow-sm rounded-[1rem] flex-1 text-sm font-bold text-slate-700">
                    <div className="flex items-center gap-2">
                      <span className="hidden sm:inline">Смешанный маршрут</span>
                      <span className="sm:hidden text-xs text-slate-400">Смешанный</span>
                      <div className="flex gap-1.5 ml-1 md:ml-2">
                        {mixedModes.includes('driving') && (
                          <div
                            className="w-7 h-7 rounded-lg bg-[#eaf5fd] flex items-center justify-center shadow-xs"
                            title="Авто"
                          >
                            <span className="text-sm">🚗</span>
                          </div>
                        )}
                        {mixedModes.includes('foot') && (
                          <div
                            className="w-7 h-7 rounded-lg bg-brand-amber/10 flex items-center justify-center shadow-xs"
                            title="Пешком"
                          >
                            <span className="text-sm">🚶</span>
                          </div>
                        )}
                        {mixedModes.includes('bike') && (
                          <div
                            className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center shadow-xs"
                            title="Вело"
                          >
                            <span className="text-sm">🚲</span>
                          </div>
                        )}
                        {mixedModes.includes('direct') && (
                          <div
                            className="w-7 h-7 rounded-lg bg-brand-purple/10 flex items-center justify-center shadow-xs"
                            title="Прямой"
                          >
                            <span className="text-sm">📏</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        points.forEach((p) => crud.update(p.id, { transportMode: routeProfile }));
                      }}
                      className="ml-4 w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center hover:bg-red-100 hover:text-red-500 transition-colors"
                      title="Сбросить на единый профиль"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setRouteProfile('driving');
                        points.forEach((p) => {
                          if (p.transportMode !== 'driving')
                            crud.update(p.id, { transportMode: 'driving' });
                        });
                      }}
                      disabled={points.length < 2}
                      className={cn(
                        'px-4 sm:px-6 py-3.5 rounded-[1rem] text-sm font-black transition-all flex items-center justify-center h-full disabled:opacity-40 disabled:cursor-default border border-transparent',
                        routeProfile === 'driving'
                          ? 'bg-white text-brand-blue shadow-sm border-slate-100'
                          : 'text-slate-500 hover:text-brand-blue hover:bg-white/50',
                      )}
                    >
                      <span className="leading-none align-middle -translate-y-px mr-2">🚗</span>{' '}
                      Авто
                    </button>
                    <button
                      onClick={() => {
                        setRouteProfile('foot');
                        points.forEach((p) => {
                          if (p.transportMode !== 'foot')
                            crud.update(p.id, { transportMode: 'foot' });
                        });
                      }}
                      disabled={points.length < 2}
                      className={cn(
                        'px-4 sm:px-6 py-3.5 rounded-[1rem] text-sm font-black transition-all flex items-center justify-center h-full disabled:opacity-40 disabled:cursor-default border border-transparent',
                        routeProfile === 'foot'
                          ? 'bg-white text-brand-amber shadow-sm border-slate-100'
                          : 'text-slate-500 hover:text-brand-amber hover:bg-white/50',
                      )}
                    >
                      <span className="leading-none align-middle -translate-y-px mr-2">🚶</span>{' '}
                      Пешком
                    </button>
                    <button
                      onClick={() => {
                        setRouteProfile('bike');
                        points.forEach((p) => {
                          if (p.transportMode !== 'bike')
                            crud.update(p.id, { transportMode: 'bike' });
                        });
                      }}
                      disabled={points.length < 2}
                      className={cn(
                        'px-4 sm:px-6 py-3.5 rounded-[1rem] text-sm font-black transition-all flex items-center justify-center h-full disabled:opacity-40 disabled:cursor-default border border-transparent',
                        routeProfile === 'bike'
                          ? 'bg-white text-emerald-500 shadow-sm border-slate-100'
                          : 'text-slate-500 hover:text-emerald-500 hover:bg-white/50',
                      )}
                    >
                      <span className="leading-none align-middle -translate-y-px mr-2">🚲</span>{' '}
                      Вело
                    </button>
                    <button
                      onClick={() => {
                        setRouteProfile('direct');
                        points.forEach((p) => {
                          if (p.transportMode !== 'direct')
                            crud.update(p.id, { transportMode: 'direct' });
                        });
                      }}
                      disabled={points.length < 2}
                      className={cn(
                        'px-4 sm:px-6 py-3.5 rounded-[1rem] text-sm font-black transition-all flex items-center justify-center h-full disabled:opacity-40 disabled:cursor-default border border-transparent',
                        routeProfile === 'direct'
                          ? 'bg-white text-brand-purple shadow-sm border-slate-100'
                          : 'text-slate-500 hover:text-brand-purple hover:bg-white/50',
                      )}
                    >
                      <span className="leading-none align-middle -translate-y-px mr-2">📏</span>{' '}
                      Прямой
                    </button>
                  </>
                )}
              </div>

              {(routeInfo || isRouteLoading) && (
                <div
                  data-testid="planner-route-info"
                  className="flex items-center justify-center gap-6 px-6 py-3 bg-brand-indigo/5 rounded-[1.25rem] border border-brand-indigo/10 animate-in fade-in zoom-in-95 relative overflow-hidden transition-all duration-300 w-full lg:w-96 lg:h-16"
                >
                  {isRouteLoading && (
                    <div className="absolute inset-0 bg-white/40 flex items-center justify-center z-10 animate-in fade-in duration-200">
                      <div className="w-5 h-5 border-2 border-brand-indigo border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  <div className={cn('flex items-center gap-6', isRouteLoading && 'opacity-40')}>
                    {routeInfo && routeProfile !== 'direct' && (
                      <>
                        <div className="flex items-center gap-2">
                          <Clock size={18} className="text-brand-blue" />
                          <span className="text-sm font-black text-slate-700 leading-none">
                            {formatDuration(routeInfo.duration)}
                          </span>
                        </div>
                        <div className="w-px h-8 bg-brand-indigo/10" />
                      </>
                    )}
                    {routeInfo && (
                      <div className="flex items-center gap-2">
                        <RouteIcon size={18} className="text-emerald-500" />
                        <span className="text-sm font-black text-slate-700 leading-none">
                          {formatDistance(routeInfo.distance)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="max-w-7xl mx-auto w-full mt-8">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Button
                  onClick={() => {
                    if (!isAuthenticated) {
                      setModal('register');
                      return;
                    }
                    if (points.length > 0 && isDirty) {
                      setShowClearConfirm(true);
                    } else {
                      handleConfirmClear(false);
                    }
                  }}
                  disabled={points.length < 2}
                  variant="brand-blue"
                  className="w-full font-black text-[10px] md:text-xs tracking-widest uppercase py-6 rounded-2xl h-auto shadow-lg shadow-brand-blue/10"
                >
                  НОВЫЙ
                </Button>

                <Button
                  onClick={handleEditWithAi}
                  disabled={points.length === 0}
                  variant="brand-purple"
                  className="w-full font-black text-[10px] md:text-xs tracking-widest uppercase py-6 rounded-2xl h-auto shadow-lg shadow-brand-purple/10"
                >
                  РЕДАКТИРОВАТЬ С AI
                </Button>

                <Button
                  onClick={async () => {
                    if (!isAuthenticated) {
                      setModal('register');
                      return;
                    }
                    try {
                      setIsOptimizing(true);
                      const tripId = await ensureTripId();
                      const latestPoints = useTripStore.getState().currentTrip?.points || points;
                      const result = await tripsApi.optimize(tripId, routeProfile, latestPoints);
                      if (result?.optimizedPoints) {
                        const pointsChanged = !points.every(
                          (p, i) =>
                            result.optimizedPoints?.[i] && p.id === result.optimizedPoints[i].id,
                        );
                        const hasRealImprovement =
                          result.metrics && result.metrics.newKm < result.metrics.originalKm - 0.05;
                        if (pointsChanged && hasRealImprovement) {
                          setPreviousPoints([...points]);
                          useTripStore.getState().setPoints(result.optimizedPoints);
                          setLastOptimizedPoints(result.optimizedPoints);
                          setLastOptimizedProfile(routeProfile);

                          // Broadcast reordered points to other collaborators
                          import('@/shared/socket/socket-client').then(({ getSocket }) => {
                            getSocket().emit('point:reorder', {
                              trip_id: tripId,
                              pointIds: result.optimizedPoints.map((p: RoutePoint) => p.id),
                            });
                          });

                          setOptimizationResults({
                            status: 'success',
                            metrics: result.metrics || null,
                          });
                          setIsOptimizationExpanded(true);
                        } else {
                          setLastOptimizedPoints([...points]);
                          setLastOptimizedProfile(routeProfile);
                          setOptimizationResults({ status: 'optimal', metrics: null });
                          setIsOptimizationExpanded(true);
                        }
                      }
                    } catch (error) {
                      console.error('Optimization error:', error);
                      toast.error('Ошибка оптимизации');
                    } finally {
                      setIsOptimizing(false);
                    }
                  }}
                  disabled={points.length < 3 || isOptimizing || isAlreadyOptimal}
                  variant="brand-yellow"
                  className="w-full font-black text-[10px] md:text-xs tracking-widest uppercase py-6 rounded-2xl h-auto shadow-lg shadow-brand-yellow/10"
                >
                  {isOptimizing
                    ? 'ОПТИМИЗАЦИЯ...'
                    : isAlreadyOptimal
                      ? 'ОПТИМАЛЬНО'
                      : 'ОПТИМИЗИРОВАТЬ'}
                </Button>

                <Button
                  onClick={async () => {
                    if (!isAuthenticated) {
                      setModal('register');
                      return;
                    }
                    try {
                      const tripId = await ensureTripId();
                      const isExistingRealTrip = !!currentTrip?.id && UUID_RE.test(currentTrip.id);
                      if (isExistingRealTrip) {
                        const backendPoints = await pointsApi.getAll(tripId);
                        await Promise.all(backendPoints.map((p) => pointsApi.remove(tripId, p.id)));
                        await Promise.all(
                          points.map((p, i) =>
                            pointsApi.create(tripId, {
                              title: p.title,
                              lat: p.lat,
                              lon: p.lon,
                              order: i,
                              budget: p.budget ?? undefined,
                              visitDate: p.visitDate ?? undefined,
                              imageUrl: p.imageUrl ?? undefined,
                              address: p.address ?? undefined,
                              transportMode: p.transportMode,
                            }),
                          ),
                        );
                      }
                      const autoTitle =
                        points.length > 1
                          ? `${points[0]!.title} — ${points[points.length - 1]!.title}`
                          : 'Мой маршрут';
                      const updated = await tripsApi.update(tripId, {
                        title: autoTitle,
                        budget: currentTrip?.budget ?? 0,
                        isActive: isActiveRoute,
                      });
                      updateCurrentTrip(updated);
                      import('@/shared/socket/socket-client').then(({ getSocket }) => {
                        getSocket().emit('trip:update', {
                          trip_id: tripId,
                          ...updated,
                        });
                      });
                      setSaved();
                      toast.success('Маршрут сохранён');
                    } catch {
                      toast.error('Не удалось сохранить');
                    }
                  }}
                  disabled={points.length === 0}
                  variant="brand-indigo"
                  className="w-full font-black text-[10px] md:text-xs tracking-widest uppercase py-6 rounded-2xl h-auto shadow-lg shadow-brand-indigo/10"
                >
                  СОХРАНИТЬ
                </Button>
              </div>

              {/* Optimization Results Block moved here, right under buttons */}
              {optimizationResults.status !== 'idle' && (
                <div className="mt-8 p-0 bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/20 overflow-hidden animate-in fade-in slide-in-from-top-4 duration-500 relative group/opt">
                  {optimizationResults.status === 'optimal' ||
                  (optimizationResults.status === 'success' &&
                    routeProfile !== lastOptimizedProfile) ? (
                    <div className="flex flex-col">
                      <div
                        className={cn(
                          "p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 bg-slate-50/50 cursor-pointer transition-colors hover:bg-slate-100/50",
                          isOptimizationExpanded ? "border-b border-slate-100" : ""
                        )}
                        onClick={() => setIsOptimizationExpanded(!isOptimizationExpanded)}
                      >
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-white rounded-2xl shadow-sm border border-slate-100 flex items-center justify-center shrink-0">
                            <MapPin size={22} className="text-emerald-500" />
                          </div>
                          <div>
                            <h4 className="text-brand-indigo font-black uppercase tracking-widest text-sm md:text-base mb-1">
                              Маршрут оптимален
                            </h4>
                            <p className="text-slate-400 text-xs md:text-sm font-bold uppercase tracking-wider">
                              {routeProfile !== lastOptimizedProfile
                                ? `Порядок точек идеален для режима «${routeProfile === 'driving' ? 'Авто' : routeProfile === 'foot' ? 'Пешком' : routeProfile === 'bike' ? 'Вело' : 'Прямой'}»`
                                : 'Текущий порядок точек — самый эффективный'}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 mt-4 md:mt-0 ml-auto">
                          <button
                            className="w-8 h-8 rounded-full bg-slate-50 text-slate-400 flex items-center justify-center transition-transform hover:bg-slate-200"
                            style={{ transform: isOptimizationExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                          >
                            <ChevronDown size={20} />
                          </button>
                        </div>
                      </div>
                      
                      {isOptimizationExpanded && (
                        <div className="p-6 md:p-8 bg-white flex justify-start md:justify-end animate-in slide-in-from-top-2 fade-in">
                          <div className="px-6 py-3 bg-emerald-50 rounded-xl border border-emerald-100/50">
                            <span className="text-emerald-600 font-black text-xs uppercase tracking-widest flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                              Улучшение не требуется
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col">
                      <div
                        className={cn(
                          "p-6 md:p-8 bg-gradient-to-r from-brand-indigo/[0.02] to-transparent flex flex-col md:flex-row items-start md:items-center justify-between gap-6 cursor-pointer hover:from-brand-indigo/[0.05] transition-colors",
                          isOptimizationExpanded ? "border-b border-slate-50" : ""
                        )}
                        onClick={() => setIsOptimizationExpanded(!isOptimizationExpanded)}
                      >
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-brand-indigo rounded-2xl shadow-lg shadow-brand-indigo/20 flex items-center justify-center shrink-0">
                            <MapPin size={22} className="text-white" />
                          </div>
                          <div>
                            <h4 className="text-brand-indigo font-black uppercase tracking-widest text-sm md:text-base mb-1">
                              Маршрут оптимизирован
                            </h4>
                            <p className="text-slate-400 text-xs md:text-sm font-bold uppercase tracking-wider">
                              Мы нашли путь короче и быстрее
                            </p>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-4 w-full md:w-auto justify-end mt-4 md:mt-0">
                          {previousPoints && !isOptimizationExpanded && (
                            <Button
                              onClick={(e) => {
                                e.stopPropagation();
                                useTripStore.getState().setPoints(previousPoints);
                                if (currentTrip && !currentTrip.id.startsWith('guest-')) {
                                  const orderedIds = previousPoints.map((p) => p.id);
                                  crud.reorder(orderedIds).catch(console.error);
                                }
                                setPreviousPoints(null);
                                setOptimizationResults({ status: 'idle', metrics: null });
                                setLastOptimizedPoints(null);
                                setLastOptimizedProfile(null);
                                toast.info('Маршрут возвращён к исходному состоянию');
                              }}
                              variant="ghost"
                              shape="xl"
                              className="text-slate-400 hover:text-brand-indigo hover:bg-brand-indigo/5 font-black uppercase tracking-widest text-[10px] md:text-xs h-10 px-6 border border-slate-200 transition-all active:scale-95"
                            >
                              Вернуть
                            </Button>
                          )}
                          <button
                            className="w-8 h-8 rounded-full bg-slate-50 text-slate-400 flex items-center justify-center transition-transform hover:bg-slate-200"
                            style={{ transform: isOptimizationExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                          >
                            <ChevronDown size={20} />
                          </button>
                        </div>
                      </div>

                      {isOptimizationExpanded && (
                        <div className="flex flex-col bg-white animate-in slide-in-from-top-2 fade-in">
                          {previousPoints && (
                            <div className="px-6 md:px-8 pt-6 flex justify-end">
                              <Button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  useTripStore.getState().setPoints(previousPoints);
                                  if (currentTrip && !currentTrip.id.startsWith('guest-')) {
                                    const orderedIds = previousPoints.map((p) => p.id);
                                    crud.reorder(orderedIds).catch(console.error);
                                  }
                                  setPreviousPoints(null);
                                  setOptimizationResults({ status: 'idle', metrics: null });
                                  setLastOptimizedPoints(null);
                                  setLastOptimizedProfile(null);
                                  toast.info('Маршрут возвращён к исходному состоянию');
                                }}
                                variant="ghost"
                                shape="xl"
                                className="text-slate-400 hover:text-brand-indigo hover:bg-brand-indigo/5 font-black uppercase tracking-widest text-[10px] md:text-xs h-10 px-6 border border-slate-200 transition-all active:scale-95"
                              >
                                Вернуть как было
                              </Button>
                            </div>
                          )}

                          <div className="p-6 md:p-8">
                            {optimizationResults.metrics && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
                                <div className="group bg-slate-50/50 p-6 rounded-3xl border border-slate-100 hover:border-emerald-500/30 transition-all duration-300">
                                  <div className="flex items-center gap-3 mb-6">
                                    <div className="w-8 h-8 rounded-xl bg-white shadow-sm border border-slate-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                                      <Clock size={16} className="text-brand-blue" />
                                    </div>
                                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                                      Время в пути
                                    </span>
                                  </div>
                                  <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                      <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
                                        Было:
                                      </span>
                                      <span className="text-sm font-bold text-slate-400 line-through decoration-slate-300">
                                        {formatDuration(
                                          Math.round(optimizationResults.metrics.originalHours * 3600),
                                        )}
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-[10px] font-black text-brand-blue uppercase tracking-widest">
                                        Стало:
                                      </span>
                                      <span className="text-xl font-black text-slate-700 tabular-nums">
                                        {formatDuration(
                                          Math.round(optimizationResults.metrics.newHours * 3600),
                                        )}
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                <div className="group bg-slate-50/50 p-6 rounded-3xl border border-slate-100 hover:border-emerald-500/30 transition-all duration-300">
                                  <div className="flex items-center gap-3 mb-6">
                                    <div className="w-8 h-8 rounded-xl bg-white shadow-sm border border-slate-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                                      <RouteIcon size={16} className="text-emerald-500" />
                                    </div>
                                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                                      Расстояние
                                    </span>
                                  </div>
                                  <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                      <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
                                        Было:
                                      </span>
                                      <span className="text-sm font-bold text-slate-400 line-through decoration-slate-300">
                                        {optimizationResults.metrics.originalKm.toFixed(1)} км
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">
                                        Стало:
                                      </span>
                                      <span className="text-xl font-black text-slate-700 tabular-nums">
                                        {optimizationResults.metrics.newKm.toFixed(1)}{' '}
                                        <span className="text-sm text-slate-400">км</span>
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="relative max-w-7xl mx-auto w-full">
              {/* Main Content: Points List */}
              <div className="w-full">
                <div className="mb-10 mt-10 w-full bg-white rounded-[2rem] p-6 md:p-8 border border-slate-100 shadow-xl shadow-slate-200/20">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12 pb-8 border-b border-slate-50">
                    <h3 className="text-xl md:text-2xl font-black text-brand-indigo uppercase tracking-widest">
                      Бюджет маршрута
                    </h3>
                    <div className="flex items-center gap-3">
                      <span className="font-black text-brand-indigo uppercase tracking-widest text-xs md:text-sm flex items-center gap-1.5">
                        <span className="text-base">💳</span> Планируемый:
                      </span>
                      <div className="flex items-center justify-between border border-slate-200 rounded-xl px-2 py-2 bg-white hover:border-slate-300 transition-colors w-full sm:w-48">
                        <button
                          onClick={() => handleUpdatePlannedBudget(plannedBudget - 1000)}
                          className="text-slate-400 hover:text-brand-indigo transition-colors p-1 flex items-center justify-center"
                          type="button"
                        >
                          <Minus size={16} />
                        </button>
                        <div className="flex items-center justify-center flex-1 min-w-0">
                          <input
                            type="number"
                            min="0"
                            step="1000"
                            value={plannedBudget}
                            onChange={(e) => handleUpdatePlannedBudget(Number(e.target.value) || 0)}
                            className="w-16 md:w-20 bg-transparent text-center font-bold text-brand-indigo outline-none text-sm md:text-base [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            style={{ MozAppearance: 'textfield' }}
                          />
                          <span className="text-slate-400 font-bold text-sm">₽</span>
                        </div>
                        <button
                          onClick={() => handleUpdatePlannedBudget(plannedBudget + 1000)}
                          className="text-slate-400 hover:text-brand-indigo transition-colors p-1 flex items-center justify-center"
                          type="button"
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3">
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      onDragCancel={handleDragCancel}
                    >
                      <SortableContext
                        items={points.map((p) => p.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {points.map((point, i) => (
                          <SortablePointRow
                            key={point.id}
                            point={point}
                            index={i}
                            editingPointId={editingPointId}
                            editingTitle={editingTitle}
                            setEditingPointId={setEditingPointId}
                            setEditingTitle={setEditingTitle}
                            onUpdate={handlePointUpdate}
                            onRemove={crud.remove}
                            onFocusPoint={setFocusCoords}
                            leg={i > 0 && routeInfo?.legs ? routeInfo.legs[i - 1] : undefined}
                            isRouteLoading={isRouteLoading && affectedSegments.has(i - 1)}
                            userLocation={userLocationRef.current ?? undefined}
                          />
                        ))}
                      </SortableContext>
                      <DragOverlay adjustScale={false}>
                        {activeId ? (
                          <div className="w-full pointer-events-none opacity-90 scale-102 shadow-2xl rounded-2xl">
                            {(() => {
                              const activePoint = points.find((p) => p.id === activeId);
                              const idx = points.findIndex((p) => p.id === activeId);
                              if (!activePoint) return null;
                              return (
                                <div className="flex flex-row items-center lg:items-start justify-start gap-3 md:gap-4 bg-white p-4 rounded-2xl border-2 border-brand-blue shadow-xl">
                                  <div className="flex items-center lg:items-start gap-2 lg:pt-1">
                                    <GripVertical size={16} className="text-brand-blue" />
                                    <div className="w-5 h-5 md:w-6 md:h-6 shrink-0 rounded-full bg-brand-blue text-white font-bold hidden lg:flex items-center justify-center text-[10px]">
                                      {idx + 1}
                                    </div>
                                  </div>
                                  <div className="flex-1 flex flex-col items-start gap-2 min-w-0 pr-10 w-full">
                                    <div className="flex items-center gap-2 w-full">
                                      <span className="font-bold text-slate-700 text-sm md:text-base truncate">
                                        {activePoint.title}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl w-full">
                                      <MapPin size={14} className="text-slate-400 shrink-0" />
                                      <span className="text-xs text-slate-500 font-bold truncate">
                                        {activePoint.address || 'Адрес не указан'}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        ) : null}
                      </DragOverlay>
                    </DndContext>
                    {points.length === 0 && (
                      <p className="text-center text-slate-400 text-sm py-4">
                        Пока нет добавленных мест
                      </p>
                    )}
                  </div>
                </div>

                <div className="mb-10 px-8 py-6 bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/20 flex items-center justify-between">
                  <h4 className="text-xs md:text-sm font-black text-slate-400 uppercase tracking-widest">
                    ИТОГО ПО ТОЧКАМ
                  </h4>
                  <div className="flex flex-col items-end">
                    <div
                      className={cn(
                        'text-2xl md:text-3xl font-black tabular-nums transition-colors',
                        plannedBudget > 0 && totalBudget > plannedBudget
                          ? 'text-red-500'
                          : 'text-brand-indigo',
                      )}
                    >
                      {totalBudget.toLocaleString('ru-RU')} ₽
                    </div>
                    {isBudgetExceeded && (
                      <p className="text-[10px] font-bold text-red-400 uppercase mt-1">
                        Превышение на {(totalBudget - plannedBudget).toLocaleString()} ₽
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

              {/* Mobile Actions (Fallback for smaller screens) is removed */}
            </div>
          ) : (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-7xl mx-auto w-full">
              <div className="w-full mb-10">
              <div className="relative group mb-8">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-brand-blue transition-colors">
                  <Search size={20} />
                </div>
                <input
                  type="text"
                  value={popularSearch}
                  onChange={(e) => setPopularSearch(e.target.value)}
                  placeholder="Куда"
                  className="w-full pl-12 pr-4 py-4 md:py-5 bg-slate-50 rounded-xl md:rounded-2xl border-none focus:ring-2 focus:ring-brand-blue/20 outline-none text-slate-800 font-bold text-base md:text-lg transition-all placeholder:text-slate-400 shadow-sm"
                />
              </div>
              <div className="relative -mx-4 px-4 md:mx-0 md:px-0">
                <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2">
                  {FILTERS.map((f) => (
                    <Chip
                      key={f}
                      onClick={() => setSelectedFilter(f)}
                      variant={selectedFilter === f ? 'active' : 'default'}
                    >
                      {f === 'Активный' && <span className="text-sm">⚡</span>}
                      {f === 'Зима' && <span className="text-sm">❄️</span>}
                      {f === 'Экстрим' && <span className="text-sm">⛰️</span>}
                      {f}
                    </Chip>
                  ))}
                  <div className="w-12 shrink-0 md:hidden" />
                </div>
                <div className="absolute top-0 right-0 bottom-0 w-16 bg-linear-to-l from-white via-white/80 to-transparent pointer-events-none md:hidden z-10" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 md:gap-12 pb-10">
              {predefinedTrips
                .filter(
                  (trip) =>
                    selectedFilter === 'Все' ||
                    (trip.tags ?? []).some((t) => t.includes(selectedFilter)),
                )
                .filter(
                  (trip) =>
                    !popularSearch.trim() ||
                    trip.title.toLowerCase().includes(popularSearch.toLowerCase()),
                )
                .map((trip, idx) => {
                  const WeatherIcon = weatherIcons[idx % weatherIcons.length] ?? Cloud;
                  return (
                    <Link
                      key={trip.id}
                      className="group block w-full cursor-pointer"
                      href={`/tours/${trip.id}`}
                    >
                      <div className="relative aspect-4/3 md:aspect-16/10 rounded-[3rem] overflow-hidden mb-6 shadow-2xl">
                        <img
                          src={trip.img ?? ''}
                          className="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-110 will-change-transform"
                          alt={trip.title}
                        />
                        <div className="absolute inset-0 bg-linear-to-t from-black/90 via-black/20 to-transparent" />
                        <div className="absolute top-6 left-6">
                          <div className="bg-slate-900/40 backdrop-blur-md border border-white/10 rounded-xl px-3 py-1.5 text-white font-bold text-xs shadow-lg flex items-center gap-1.5">
                            <WeatherIcon size={14} /> {trip.temp}
                          </div>
                        </div>
                        <div className="absolute bottom-6 left-6 right-6 text-left">
                          <h3 className="text-2xl lg:text-4xl font-black text-white mb-4 tracking-tight leading-none drop-shadow-[0_25px_25px_rgba(0,0,0,0.15)]">
                            {trip.title}
                          </h3>
                          <div className="bg-brand-yellow text-white px-6 py-2.5 rounded-full text-sm font-black uppercase tracking-widest inline-block shadow-xl">
                            {trip.budget
                              ? `${trip.budget.toLocaleString('ru-RU')} ₽`
                              : 'По запросу'}
                          </div>
                        </div>
                      </div>
                      <p className="text-slate-500 text-lg font-medium leading-relaxed px-4 text-left">
                        {trip.description ?? ''}
                      </p>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <Dialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md border-none shadow-2xl rounded-[2.5rem] p-10 overflow-hidden"
        >
          <button
            onClick={() => setShowClearConfirm(false)}
            className="absolute top-6 right-6 w-10 h-10 rounded-full bg-slate-50 flex items-center justify-center text-slate-400 hover:text-brand-indigo hover:bg-slate-100 transition-all active:scale-95 group z-10"
          >
            <X size={20} strokeWidth={2.5} />
          </button>
          <DialogHeader className="gap-8">
            <DialogTitle className="text-xl font-black text-brand-indigo uppercase tracking-widest leading-tight">
              Новый маршрут
            </DialogTitle>
            <DialogDescription className="text-slate-500 font-bold text-lg leading-snug">
              Сохранить текущий маршрут?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-3 mt-8">
            <Button
              variant="ghost"
              className="flex-1 font-bold text-slate-400 hover:text-slate-600 hover:bg-slate-50 h-12 rounded-xl"
              onClick={() => handleConfirmClear(false)}
            >
              ОЧИСТИТЬ
            </Button>
            <Button
              variant="brand-indigo"
              className="flex-1 font-black uppercase tracking-widest h-12 rounded-xl shadow-lg shadow-brand-indigo/20"
              onClick={() => handleConfirmClear(true)}
            >
              СОХРАНИТЬ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <LoginModal
        open={modal === 'login'}
        onClose={() => setModal(null)}
        onSwitchToRegister={() => setModal('register')}
      />
      <RegisterModal
        open={modal === 'register'}
        onClose={() => setModal(null)}
        onSwitchToLogin={() => setModal('login')}
      />
      <PlannerConflictModal
        open={showPlannerConflictModal}
        onOpenChange={setShowPlannerConflictModal}
        conflictType={conflictType}
        currentRouteTitle={currentTrip?.title?.trim() || 'без названия'}
        onCancel={() => {
          finalizeApplyFlow(true);
        }}
        onReplaceWithoutSave={handleConfirmPlannerReplace}
        onSaveAndReplace={async () => {
          try {
            if (currentTrip && !currentTrip.id.startsWith('guest-')) {
              await tripsApi.update(currentTrip.id, {
                title: currentTrip.title,
                description: currentTrip.description ?? undefined,
                budget: currentTrip.budget ?? undefined,
              });
            }
          } catch (e) {
            console.error('Failed to save current trip before replace:', e);
            toast.error('Не удалось сохранить текущий маршрут');
          }
          handleConfirmPlannerReplace();
        }}
        onGoToPlannerOnly={() => {
          finalizeApplyFlow(true);
        }}
      />
    </div>
  );
}

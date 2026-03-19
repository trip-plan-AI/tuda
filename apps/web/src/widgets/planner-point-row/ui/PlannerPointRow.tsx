'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  MapPin,
  Route as RouteIcon,
  Plus,
  Minus,
  Pencil,
  X,
  GripVertical,
  Calendar as CalendarIcon,
  Clock,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { format } from 'date-fns';
import { startOfMonth, startOfToday } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { RoutePoint } from '@/entities/route-point';
import { env } from '@/shared/config/env';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger, Calendar } from '@/shared/ui';
import {
  ROUTE_PROFILE_COLORS,
  type GeoSuggestion,
  filterUniqueSuggestions,
  hasTime,
  formatDuration,
  formatDistance,
  resolveTransportMode,
} from '@/shared/lib/route-utils';

export interface PointRowProps {
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
      duration?: number;
      transportMode?: 'driving' | 'foot' | 'bike' | 'direct';
    },
  ) => void;
  onRemove: (id: string) => void;
  onFocusPoint: (coords: { lon: number; lat: number }) => void;
  leg?: { duration: number; distance: number };
  isRouteLoading?: boolean;
  userLocation?: { lat: number; lon: number };
  isLast: boolean;
  nextPointId?: string;
  nextTransportMode?: 'driving' | 'foot' | 'bike' | 'direct';
  prevPointDate?: string | null;
  prevPointDuration?: number;
}

export const PlannerPointRow = React.memo(function PlannerPointRow({
  point,
  index,
  isLast,
  nextPointId,
  nextTransportMode,
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
  prevPointDate,
  prevPointDuration = 0,
}: PointRowProps) {
  const minVisitDate = useMemo(() => {
    if (!prevPointDate) return startOfToday();
    const travelMs = (leg?.duration || 0) * 1000;
    const stayMs = prevPointDuration * 60 * 1000;
    return new Date(new Date(prevPointDate).getTime() + stayMs + travelMs);
  }, [prevPointDate, prevPointDuration, leg]);

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
    if (!query.trim() || query.length < 2) {
      setSuggestions([]);
      setShowDropdownState(false);
      return;
    }
    setIsSearching(true);
    try {
      const url = `${env.apiUrl}/geosearch/suggest?q=${encodeURIComponent(query)}`;
      const res = await fetch(url);

      if (!res.ok) {
        console.error(`[Geosearch] HTTP ${res.status}: ${res.statusText}`);
        throw new Error(`Suggest request failed: ${res.status}`);
      }

      const data = await res.json();
      const found = filterUniqueSuggestions(data.results ?? []);
      setSuggestions(found);
      setShowDropdownState(true);
    } catch (e) {
      console.error('[Geosearch] Failed to fetch suggestions:', e);
      setSuggestions([]);
      setShowDropdownState(false);
    } finally {
      setIsSearching(false);
    }
  };

  const handleAddressChange = (val: string) => {
    setAddressVal(val);
    if (val.length > 1) {
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
      }
    } finally {
      setIsSearching(false);
    }
  };

  const handlePointUpdateExtended = useCallback(
    (id: string, patch: Parameters<typeof onUpdate>[1]) => {
      if (patch.visitDate) {
        const patchMs = new Date(patch.visitDate).getTime();
        const minMs = minVisitDate.getTime();
        if (patchMs < minMs - 1000) {
          const snapDate = hasTime(patch.visitDate)
            ? minVisitDate.toISOString()
            : minVisitDate.toISOString().split('T')[0];
          onUpdate(id, { ...patch, visitDate: snapDate });
          return;
        }
      }
      onUpdate(id, patch);
    },
    [onUpdate, minVisitDate],
  );

  const getModeColor = (mode?: string | null) => ROUTE_PROFILE_COLORS[resolveTransportMode(mode)];

  const leftColor = index > 0 ? getModeColor(point.transportMode) : null;
  const rightColor = !isLast ? getModeColor(nextTransportMode) : null;
  const isSplit = leftColor && rightColor && leftColor !== rightColor;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="planner-point-row"
      data-point-id={point.id}
      className={cn('flex flex-col gap-3 group', showDropdownState && 'z-50')}
    >
      <div
        className={cn(
          'flex flex-row items-center lg:items-start justify-start gap-3 md:gap-4 group/row bg-slate-50 p-4 rounded-2xl border border-transparent hover:border-slate-200 transition-all shadow-sm hover:shadow-md relative',
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
            onClick={() => onFocusPoint({ lat: point.lat, lon: point.lon })}
            className="w-7 h-7 shrink-0 rounded-full text-white font-bold hidden lg:flex items-center justify-center text-[12px] leading-none p-0 shadow-[0_2px_8px_rgba(0,0,0,0.3)] hover:scale-110 active:scale-95 transition-all relative overflow-hidden border-2 border-white"
            style={{
              background: !isSplit ? leftColor || rightColor || ROUTE_PROFILE_COLORS.driving : 'transparent',
              textShadow: '0 1px 2px rgba(0,0,0,0.5)',
            }}
          >
            {isSplit && (
              <>
                <div
                  className="absolute inset-0 left-0 w-1/2 h-full"
                  style={{ background: leftColor! }}
                />
                <div
                  className="absolute inset-0 left-1/2 w-1/2 h-full"
                  style={{ background: rightColor! }}
                />
              </>
            )}
            <span className="relative z-10 leading-none">{index + 1}</span>
          </button>

          <div
            className={cn(
              'hidden lg:flex flex-col items-center justify-center min-w-[60px] border-r border-slate-100 pr-3 mr-1',
              !hasTime(point.visitDate) && 'invisible',
            )}
          >
            <span className="text-[10px] font-black text-brand-indigo uppercase tracking-tight">
              Прибытие
            </span>
            <span className="text-sm font-bold text-slate-700">
              {hasTime(point.visitDate) ? format(new Date(point.visitDate!), 'HH:mm') : '--:--'}
            </span>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-start gap-3 min-w-0 pr-10 w-full">
          {editingPointId === point.id ? (
            <input
              autoFocus
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={() => {
                if (editingTitle.trim())
                  handlePointUpdateExtended(point.id, { title: editingTitle.trim() });
                setEditingPointId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (editingTitle.trim())
                    handlePointUpdateExtended(point.id, { title: editingTitle.trim() });
                  setEditingPointId(null);
                }
                if (e.key === 'Escape') setEditingPointId(null);
              }}
              className="w-full bg-white border border-brand-blue rounded-lg px-2 py-1 font-bold text-slate-700 text-sm md:text-base outline-none text-left"
            />
          ) : (
            <div className="flex items-center gap-2 w-full">
              <span
                title={point.title}
                className="min-w-0 font-bold text-slate-700 text-base md:text-lg truncate text-left"
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
            </div>
          )}

          <div className="flex flex-col lg:flex-row lg:items-center gap-2 min-w-0 w-full items-start">
            <div className="flex-1 min-w-0 flex items-center justify-start gap-2 w-full lg:hidden">
              <button
                onClick={() => onFocusPoint({ lat: point.lat, lon: point.lon })}
                className="w-7 h-7 shrink-0 rounded-full text-white font-bold flex items-center justify-center text-[12px] leading-none p-0 shadow-[0_2px_8px_rgba(0,0,0,0.3)] active:scale-90 transition-all relative overflow-hidden border-2 border-white"
                style={{
                  background: !isSplit ? leftColor || rightColor || ROUTE_PROFILE_COLORS.driving : 'transparent',
                  textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                }}
              >
                {isSplit && (
                  <>
                    <div
                      className="absolute inset-0 left-0 w-1/2 h-full"
                      style={{ background: leftColor! }}
                    />
                    <div
                      className="absolute inset-0 left-1/2 w-1/2 h-full"
                      style={{ background: rightColor! }}
                    />
                  </>
                )}
                <span className="relative z-10 leading-none">{index + 1}</span>
              </button>

              <div
                className={cn(
                  'flex flex-col items-center justify-center min-w-[50px] border-r border-slate-100 pr-2 mr-1',
                  !hasTime(point.visitDate) && 'invisible',
                )}
              >
                <span className="text-[9px] font-bold text-slate-400 uppercase leading-none">
                  Прибытие
                </span>
                <span className="text-xs font-bold text-slate-700">
                  {hasTime(point.visitDate) ? format(new Date(point.visitDate!), 'HH:mm') : '--:--'}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2 w-full lg:flex-row lg:items-center lg:shrink-0 lg:w-auto">
              <Popover open={dateOpen} onOpenChange={setDateOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      'w-full lg:w-48 px-3 py-2 pr-4 bg-white border border-slate-200 rounded-xl font-bold text-slate-500 justify-start text-left text-sm hover:bg-slate-50 transition-all',
                      !point.visitDate && 'text-slate-300',
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
                    {point.visitDate
                      ? format(
                          new Date(point.visitDate),
                          hasTime(point.visitDate) ? 'd MMM yyyy, HH:mm' : 'd MMM yyyy',
                          { locale: ru },
                        )
                      : 'Дата'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-auto p-0 rounded-2xl border-slate-100 shadow-2xl overflow-hidden flex flex-col"
                  align="end"
                >
                  <Calendar
                    mode="single"
                    selected={point.visitDate ? new Date(point.visitDate) : undefined}
                    onSelect={(date) => {
                      if (!date) return;
                      const newDate = new Date(date);
                      const oldDate = point.visitDate ? new Date(point.visitDate) : null;
                      if (oldDate && hasTime(point.visitDate)) {
                        newDate.setHours(oldDate.getHours(), oldDate.getMinutes(), 0, 0);
                        handlePointUpdateExtended(point.id, { visitDate: newDate.toISOString() });
                      } else {
                        handlePointUpdateExtended(point.id, {
                          visitDate: format(newDate, 'yyyy-MM-dd'),
                        });
                      }
                      setDateOpen(false);
                    }}
                    disabled={(date) =>
                      date < startOfToday() ||
                      (prevPointDate
                        ? date < new Date(new Date(prevPointDate).setHours(0, 0, 0, 0))
                        : false)
                    }
                    locale={ru}
                    captionLayout="dropdown"
                    startMonth={startOfMonth(startOfToday())}
                    endMonth={new Date(2035, 11)}
                    classNames={{ caption_label: 'hidden' }}
                  />
                  <div className="p-4 bg-slate-50 border-t border-slate-100 flex flex-col gap-3">
                    {point.visitDate && (
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <Clock size={16} className="text-slate-400" />
                          <span className="text-[10px] font-black text-slate-400 uppercase">
                            Время:
                          </span>
                        </div>
                        {hasTime(point.visitDate) ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="time"
                              value={format(new Date(point.visitDate), 'HH:mm')}
                              onChange={(e) => {
                                const parts = e.target.value.split(':');
                                if (parts.length !== 2) return;
                                const h = parseInt(parts[0] || '0', 10);
                                const m = parseInt(parts[1] || '0', 10);
                                if (isNaN(h) || isNaN(m)) return;
                                const newDate = new Date(point.visitDate!);
                                newDate.setHours(h, m, 0, 0);
                                handlePointUpdateExtended(point.id, {
                                  visitDate: newDate.toISOString(),
                                });
                              }}
                              className="bg-white border border-slate-200 rounded-lg px-2 py-1 font-bold text-slate-700 outline-none text-sm focus:border-brand-indigo transition-colors"
                            />
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() =>
                                handlePointUpdateExtended(point.id, {
                                  visitDate: point.visitDate!.split('T')[0],
                                })
                              }
                              className="text-slate-400 hover:text-red-500"
                              title="Убрать время"
                            >
                              <X size={14} />
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-[10px] font-bold uppercase h-8"
                            onClick={() => {
                              const d = new Date(point.visitDate!);
                              d.setHours(Math.max(10, minVisitDate.getHours() + 1), 0, 0, 0);
                              handlePointUpdateExtended(point.id, { visitDate: d.toISOString() });
                            }}
                          >
                            Установить время
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              <div className="flex items-center justify-between border border-slate-200 rounded-xl px-3 py-2 bg-white hover:border-slate-300 transition-colors w-full lg:w-40">
                <button
                  onClick={() =>
                    handlePointUpdateExtended(point.id, {
                      budget: Math.max(0, (point.budget ?? 0) - 1000),
                    })
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
              <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl border border-slate-100 shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-200">
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

      {!isLast && nextPointId && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-1.5 md:gap-3 self-center px-2.5 md:px-4 py-2 bg-white border border-slate-100 rounded-2xl md:rounded-full shadow-sm animate-in fade-in slide-in-from-top-1 my-2 relative z-10 w-full max-w-[300px] sm:max-w-[340px] md:max-w-[420px] justify-center transition-all',
            isDragging && 'invisible',
          )}
        >
          <div className="flex items-center gap-1 md:gap-1.5 shrink-0">
            <button
              onClick={() => nextPointId && onUpdate(nextPointId, { transportMode: 'driving' })}
              className={cn(
                'p-1.5 rounded-xl transition-all hover:scale-110',
                (nextTransportMode || 'driving') === 'driving'
                  ? 'bg-[#eaf5fd] shadow-sm'
                  : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100',
              )}
              title="На авто"
            >
              <span className="text-sm md:text-base leading-none">🚗</span>
            </button>
            <button
              onClick={() => nextPointId && onUpdate(nextPointId, { transportMode: 'foot' })}
              className={cn(
                'p-1.5 rounded-xl transition-all hover:scale-110',
                nextTransportMode === 'foot'
                  ? 'bg-brand-amber/10 shadow-sm'
                  : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100',
              )}
              title="Пешком"
            >
              <span className="text-sm md:text-base leading-none">🚶</span>
            </button>
            <button
              onClick={() => nextPointId && onUpdate(nextPointId, { transportMode: 'bike' })}
              className={cn(
                'p-1.5 rounded-xl transition-all hover:scale-110',
                nextTransportMode === 'bike'
                  ? 'bg-emerald-50 shadow-sm'
                  : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100',
              )}
              title="На велосипеде"
            >
              <span className="text-sm md:text-base leading-none">🚲</span>
            </button>
            <button
              onClick={() => nextPointId && onUpdate(nextPointId, { transportMode: 'direct' })}
              className={cn(
                'p-1.5 rounded-xl transition-all hover:scale-110',
                nextTransportMode === 'direct'
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
            {leg ? (
              <div
                className={cn(
                  'flex flex-wrap items-center gap-x-3 gap-y-1',
                  isRouteLoading && 'opacity-40',
                )}
              >
                {(nextTransportMode || 'driving') !== 'direct' && (
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
            ) : (
              <div className={cn('flex items-center gap-2 md:pl-2', isRouteLoading && 'opacity-40')}>
                <span className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-tight">
                  {isRouteLoading ? 'Считаем маршрут...' : 'Маршрут готовится...'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

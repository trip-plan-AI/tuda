'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import {
  Search,
  MapPin,
  Plus,
  Minus,
  MessageSquare,
  ArrowRight,
  Pencil,
  X,
  GripVertical,
  Calendar as CalendarIcon,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { useTripStore, tripsApi, type CreateTripPayload, type Trip } from '@/entities/trip';
import { usePointCrud } from '@/features/route-create';
import { pointsApi } from '@/entities/route-point';
import { useAuthStore, LoginModal, RegisterModal } from '@/features/auth';
import { loadYandexMaps } from '@/shared/lib/yandex-maps';
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

const RouteMap = dynamic(() => import('@/widgets/route-map').then((m) => m.RouteMap), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

function MapSkeleton() {
  return (
    <div className="w-full h-full rounded-[2.5rem] bg-gray-100 animate-pulse flex items-center justify-center">
      <p className="text-sm text-gray-400">Загрузка карты...</p>
    </div>
  );
}

interface GeoSuggestion {
  displayName: string;
  uri?: string; // ymapsbm1://geo?ll=LON,LAT&z=...
}

interface PredefinedRoute {
  id: number;
  title: string;
  desc: string;
  total: string;
  img: string;
  tags: string[];
  temp: string;
}

const PREDEFINED_ROUTES: PredefinedRoute[] = [
  {
    id: 1,
    title: 'Ледяная сказка Байкала',
    desc: 'Погрузитесь в мир чистого льда и зимних приключений на озере Байкал.',
    total: '65 000 ₽',
    img: 'https://images.pexels.com/photos/9344421/pexels-photo-9344421.jpeg?auto=compress&cs=tinysrgb&w=800',
    tags: ['❄️ Зима', 'РФ'],
    temp: '-15°',
  },
  {
    id: 2,
    title: 'Летний Байкал: Природа и Отдых',
    desc: 'Идеальный маршрут для знакомства с летней красотой Байкала, его природой и культурой.',
    total: '70 000 ₽',
    img: 'https://images.pexels.com/photos/10103738/pexels-photo-10103738.jpeg?auto=compress&cs=tinysrgb&w=800',
    tags: ['☀️ Лето', 'РФ'],
    temp: '+20°',
  },
  {
    id: 3,
    title: 'Алтай: Золотые Горы',
    desc: 'Дикая природа, бирюзовая Катунь и бескрайние степи.',
    total: '55 000 ₽',
    img: 'https://images.pexels.com/photos/10103738/pexels-photo-10103738.jpeg?auto=compress&cs=tinysrgb&w=800',
    tags: ['⚡ Активный', 'РФ'],
    temp: '+8°',
  },
  {
    id: 4,
    title: 'Камчатка: Вулканы и Океан',
    desc: 'Путешествие на край света к огнедышащим горам и Тихому океану.',
    total: '115 000 ₽',
    img: 'https://images.pexels.com/photos/20120288/pexels-photo-20120288.jpeg?auto=compress&cs=tinysrgb&w=800',
    tags: ['⛰️ Экстрим', 'РФ'],
    temp: '+5°',
  },
  {
    id: 5,
    title: 'Сочи: Горы и Море',
    desc: 'Идеальный баланс: 2 дня в горах, 3 дня на побережье.',
    total: '45 000 ₽',
    img: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&q=80&w=800',
    tags: ['⚡ Активный', 'РФ'],
    temp: '+12°',
  },
];

const FILTERS = ['Все', 'Активный', 'Зима', 'Экстрим'] as const;
type Filter = (typeof FILTERS)[number];

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
    },
  ) => void;
  onRemove: (id: string) => void;
  onFocusPoint: (coords: { lon: number; lat: number }) => void;
  onDropdownToggle: (isOpen: boolean) => void;
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
  onDropdownToggle,
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
    opacity: isDragging ? 0.5 : 1,
  };

  const getSuggestions = async (query: string) => {
    if (query.length < 3) {
      setSuggestions([]);
      setShowDropdownState(false);
      return;
    }    setIsSearching(true);
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found: GeoSuggestion[] = (data.results ?? []).map((item: any) => {
        const title = item.title?.text ?? '';
        const subtitle = item.subtitle?.text ?? '';
        return {
          displayName: subtitle ? `${title}, ${subtitle}` : title,
          uri: item.uri as string | undefined,
        };
      });
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
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => getSuggestions(val), 400);
  };

  const resolveCoords = async (query: string) => {
    await loadYandexMaps(env.yandexMapsKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ymap = (window as any).ymaps3;
    if (!ymap?.search) return null;
    const results = await ymap.search({ text: query, results: 1 });
    if (!results?.length) return null;
    const coords = results[0]?.geometry?.coordinates as [number, number] | undefined;
    if (!coords) return null;
    return { lon: coords[0], lat: coords[1] };
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
      if (!coords) coords = await resolveCoords(s.displayName);
      if (coords) {
        onUpdate(point.id, {
          address: s.displayName,
          lat: coords.lat,
          lon: coords.lon,
          title: s.displayName.split(/[.,;]/)[0]?.trim() || s.displayName,
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
      className="flex flex-row items-center lg:items-start justify-start gap-3 md:gap-4 group bg-slate-50 p-4 rounded-2xl border border-transparent hover:border-slate-200 transition-all shadow-sm hover:shadow-md relative z-10"
    >
      {/* Кнопка удаления */}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onRemove(point.id)}
        className="absolute top-4 right-4 text-slate-300 hover:text-red-500 transition-colors z-10 hover:bg-transparent"
      >
        <X size={18} />
      </Button>

      {/* Левая часть: drag + номер */}
      <div className="flex items-center lg:items-start gap-2 lg:pt-1">
        <button
          {...attributes}
          {...listeners}
          className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing transition-colors shrink-0"
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

      {/* Правая часть: Название, адрес, дата, бюджет */}
      <div className="flex-1 flex flex-col items-start gap-2 min-w-0 pr-10 w-full">
        {/* Название + дата + бюджет */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-2 min-w-0 w-full items-start">
          <div className="flex-1 min-w-0 flex items-center justify-start gap-2 w-full">
            {/* Номер (только мобайл) */}
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

          {/* Дата + бюджет справа */}
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
              <PopoverContent className="w-auto p-0 rounded-2xl border-slate-100 shadow-2xl" align="end">
                <Calendar
                  mode="single"
                  selected={point.visitDate ? new Date(point.visitDate) : undefined}
                  onSelect={(date) => {
                    onUpdate(point.id, { visitDate: date?.toISOString() });
                    setDateOpen(false);
                  }}
                  locale={ru}
                  captionLayout="dropdown"
                  startMonth={new Date(2020, 0)}
                  endMonth={new Date(2035, 11)}
                  classNames={{ caption_label: "hidden" }}
                />
              </PopoverContent>
            </Popover>
            <div className="flex items-center justify-between border border-slate-200 rounded-xl px-3 py-2 bg-white hover:border-slate-300 transition-colors w-full lg:w-40">
              <button
                onClick={() => onUpdate(point.id, { budget: Math.max(0, (point.budget ?? 0) - 1000) })}
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

        {/* Адрес */}
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
  );
}

export function PlannerPage() {
  const [activeTab, setActiveTab] = useState<'my' | 'popular'>('my');
  const [searchInput, setSearchInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [suggestions, setSuggestions] = useState<GeoSuggestion[]>([]);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [plannedBudget, setPlannedBudget] = useState(0);
  const [isActiveRoute, setIsActiveRoute] = useState(false);
  const [focusCoords, setFocusCoords] = useState<{ lon: number; lat: number } | null>(null);

  const [editingPointId, setEditingPointId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<Filter>('Все');
  const [popularSearch, setPopularSearch] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [modal, setModal] = useState<'login' | 'register' | null>(null);

  const { points, setPoints, currentTrip, setCurrentTrip, addPoint, updateCurrentTrip } = useTripStore();
  const { isAuthenticated } = useAuthStore();
  const crud = usePointCrud(currentTrip?.id);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Сохраняем ID текущего трипа для восстановления при F5
  useEffect(() => {
    if (currentTrip?.id) {
      localStorage.setItem('planner_currentTripId', currentTrip.id);
    }
  }, [currentTrip?.id]);

  // Загружаем существующий маршрут при входе
  useEffect(() => {
    if (currentTrip) return;
    const savedId = localStorage.getItem('planner_currentTripId');

    if (!isAuthenticated) {
      // If we have a guest trip ID in localStorage, don't auto-create new one
      if (savedId && savedId.startsWith('guest-')) {
        // Here we could try to load points from local storage for guest,
        // but currently we don't persist guest points in localStorage.
        // For simplicity, just create a new guest trip if none exists.
      }
      
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
      };
      setCurrentTrip(guestTrip);
      return;
    }

    tripsApi
      .getAll()
      .then((all) => {
        if (all.length > 0) {
          // Пытаемся найти тот же самый трип, который был открыт, иначе берем последний
          const target = (savedId ? all.find((t) => t.id === savedId) : null) ?? all[0];
          if (target) {
            setCurrentTrip(target);
            setPlannedBudget(target.budget ?? 0);
            setIsActiveRoute(target.isActive);
          }
        } else {
            // Create a first trip for the user if they have none
            void ensureTripId();
        }
      })
      .catch(console.error);
  }, [currentTrip, setCurrentTrip, isAuthenticated]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = points.findIndex((p) => p.id === active.id);
      const newIndex = points.findIndex((p) => p.id === over.id);
      const newOrder = arrayMove(points, oldIndex, newIndex);
      crud.reorder(newOrder.map((p) => p.id));
    },
    [points, crud],
  );

  const handlePointDragEnd = useCallback(
    (pointId: string, newCoords: { lon: number; lat: number }, newAddress: string, newTitle: string) => {
      crud.update(pointId, { lat: newCoords.lat, lon: newCoords.lon, address: newAddress, title: newTitle });
    },
    [crud],
  );

  // Если трипа нет — создаём «Мой маршрут» и сразу возвращаем его id
  const ensureTripId = useCallback(async (): Promise<string> => {
    if (currentTrip) return currentTrip.id;
    
    if (!isAuthenticated) {
        const guestTrip: Trip = {
            id: `guest-${Date.now()}`,
            ownerId: 'guest',
            title: 'Мой маршрут',
            description: null,
            budget: plannedBudget,
            startDate: null,
            endDate: null,
            isActive: isActiveRoute,
            isPredefined: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        setCurrentTrip(guestTrip);
        return guestTrip.id;
    }

    const trip = await tripsApi.create({
      title: 'Мой маршрут',
      isActive: isActiveRoute,
      budget: plannedBudget,
    } as CreateTripPayload);
    setCurrentTrip(trip);
    return trip.id;
  }, [currentTrip, setCurrentTrip, isActiveRoute, plannedBudget, isAuthenticated]);

  const totalBudget = useMemo(
    () => points.reduce((sum: number, p: RoutePoint) => sum + (p.budget ?? 0), 0),
    [points],
  );

  // Закрыть дропдаун при клике снаружи
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Suggest через серверный прокси (нет CORS, ключ на сервере)
  const geocode = useCallback(async (query: string) => {
    if (query.length < 3) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found: GeoSuggestion[] = (data.results ?? []).map((item: any) => {
        const title = item.title?.text ?? '';
        const subtitle = item.subtitle?.text ?? '';
        return {
          displayName: subtitle ? `${title}, ${subtitle}` : title,
          uri: item.uri as string | undefined,
        };
      });
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
      setShowDropdown(false); // покажем только когда придут результаты
    } else {
      setIsSearching(false);
      setSuggestions([]);
      setShowDropdown(false);
    }
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => geocode(value), 400);
  };

  // Геокодирование через ymaps3.search() — работает с Maps JS ключом без отдельного geocoder ключа
  const resolveCoords = useCallback(async (query: string) => {
    await loadYandexMaps(env.yandexMapsKey); // гарантируем что ymaps3 загружен
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ymap = (window as any).ymaps3;
    if (!ymap?.search) return null;
    const results = await ymap.search({ text: query, results: 1 });
    if (!results?.length) return null;
    const coords = results[0]?.geometry?.coordinates as [number, number] | undefined;
    if (!coords) return null;
    return { lon: coords[0], lat: coords[1], address: query };
  }, []);

  const addPoint_ = useCallback(
    async (payload: { title: string; lat: number; lon: number; address?: string }) => {
      await ensureTripId();
      await crud.add(payload);
    },
    [ensureTripId, crud],
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
    } finally {
      setIsSearching(false);
    }
  };

  const handleConfirmClear = async (save: boolean) => {
    setShowClearConfirm(false);
    if (save && points.length > 0) {
      if (!isAuthenticated) {
        setModal('login');
        return;
      }
      try {
        const tripId = await ensureTripId();
        await tripsApi.update(tripId, { budget: plannedBudget || null, isActive: isActiveRoute });
        updateCurrentTrip({ budget: plannedBudget || null, isActive: isActiveRoute });
        toast.success('Предыдущий маршрут сохранен', { id: 'planner-status' });
      } catch (e) {
        toast.error('Не удалось сохранить маршрут', { id: 'planner-status' });
      }
    }
    setCurrentTrip(null as any);
    setPoints([]);
    setPlannedBudget(0);
    setIsActiveRoute(false);
    localStorage.removeItem('planner_currentTripId');
    toast.info('Конструктор очищен', { id: 'planner-status' });
  };

  const handleSelectSuggestion = async (s: GeoSuggestion) => {
    setShowDropdown(false);
    setSearchInput('');
    setSuggestions([]);
    setIsSearching(true);
    try {
      // Парсим ll=LON,LAT из URI через regex (new URL() не работает с ymapsbm1://)
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
      // Фоллбэк на ymaps3.search если URI нет
      if (!coords) coords = await resolveCoords(s.displayName);
      if (!coords) return;
      await addPoint_({
        title: s.displayName.split(/[.,;]/)[0]?.trim() || s.displayName,
        lat: coords.lat,
        lon: coords.lon,
        address: s.displayName,
      });
    } catch (e) {
      console.error('Не удалось добавить точку:', e);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="bg-white min-h-screen w-full max-w-full flex flex-col">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 md:py-10 w-full flex-1 flex flex-col">
        {/* Заголовок + табы */}
        <div className="mb-8 bg-white md:p-0 rounded-none w-full">
          <h2 className="text-2xl md:text-4xl font-black text-brand-indigo tracking-tight mb-6 text-left">
            Маршруты
          </h2>

          <SegmentedControl
            options={[
              { label: 'Конструктор', value: 'my' },
              { label: 'Популярные', value: 'popular' },
            ]}
            value={activeTab}
            onChange={(val) => setActiveTab(val as 'my' | 'popular')}
          />
        </div>

        {activeTab === 'my' ? (
          <div className="animate-in fade-in duration-500">
            {/* Поисковая строка */}
            <div className="mb-10 w-full">
              <div
                ref={searchContainerRef}
                className="flex flex-col md:flex-row gap-4 w-full relative items-center z-30"
              >
                <div className="w-full relative group flex-1">
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

                <Button
                  onClick={handleAddByQuery}
                  disabled={isSearching}
                  variant="brand-yellow"
                  size="xl"
                  shape="responsive"
                  className="w-full md:w-auto font-black uppercase tracking-widest whitespace-nowrap disabled:opacity-70"
                >
                  ДОБАВИТЬ
                </Button>

                {/* Дропдаун с результатами */}
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

                      {/* Опция AI */}
                      <button
                        onClick={() => {
                          /* TODO: TRI-32 AI чат */
                        }}
                        className="flex items-center gap-3 w-full text-left px-5 py-5 bg-slate-50 hover:bg-slate-100 transition-colors group mt-2 border-t border-slate-100"
                      >
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-600 via-violet-500 to-indigo-400 text-white flex items-center justify-center shadow-lg shadow-purple-500/20 group-hover:scale-105 transition-transform duration-300">
                          <MessageSquare size={22} />
                        </div>
                        <div className="flex flex-col">
                          <span className="font-black text-brand-indigo uppercase tracking-wider text-xs">
                            Найти с AI
                          </span>
                          <span className="text-slate-500 text-sm font-medium">
                            AI найдет место: «{searchInput}»
                          </span>
                        </div>
                        <ArrowRight
                          size={18}
                          className="ml-auto text-brand-indigo transition-transform group-hover:translate-x-1"
                        />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Карта */}
            <div className="w-full aspect-[4/5] md:aspect-[21/9] rounded-[2.5rem] overflow-hidden relative z-0 border border-slate-200 shadow-inner bg-slate-50 group">
              <RouteMap
                points={points}
                focusCoords={focusCoords}
                onPointDragEnd={handlePointDragEnd}
                isDropdownOpen={showDropdown}
              />
            </div>

            {/* Секция бюджета и список точек */}
            <div className="mb-10 mt-10 w-full bg-white rounded-[2rem] p-6 md:p-8 border border-slate-100 shadow-xl shadow-slate-200/20">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12 pb-8 border-b border-slate-50">
                <h3 className="text-xl md:text-2xl font-black text-brand-indigo uppercase tracking-widest">
                  Бюджет маршрута
                </h3>
                <div className="flex items-center gap-3">
                  <span className="font-black text-slate-400 uppercase tracking-widest text-xs md:text-sm">
                    Планируемый:
                  </span>
                  <div className="flex items-center justify-between border border-slate-200 rounded-xl px-2 py-2 bg-white hover:border-slate-300 transition-colors w-full sm:w-48">
                    <button
                      onClick={() => setPlannedBudget(Math.max(0, plannedBudget - 1000))}
                      onBlur={async () => {
                        if (currentTrip) {
                          updateCurrentTrip({ budget: plannedBudget });
                          if (!currentTrip.id.startsWith('guest-')) {
                            await tripsApi.update(currentTrip.id, { budget: plannedBudget });
                          }
                        }
                      }}
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
                        onChange={async (e) => {
                          const val = Number(e.target.value) || 0;
                          setPlannedBudget(val);
                          if (currentTrip) {
                            updateCurrentTrip({ budget: val });
                            if (!currentTrip.id.startsWith('guest-')) {
                              await tripsApi.update(currentTrip.id, { budget: val });
                            }
                          }
                        }}
                        className="w-16 md:w-20 bg-transparent text-center font-bold text-brand-indigo outline-none text-sm md:text-base [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        style={{ MozAppearance: 'textfield' }}
                      />
                      <span className="text-slate-400 font-bold text-sm">₽</span>
                    </div>
                    <button
                      onClick={() => setPlannedBudget(plannedBudget + 1000)}
                      onBlur={async () => {
                        if (currentTrip) {
                          updateCurrentTrip({ budget: plannedBudget });
                          if (!currentTrip.id.startsWith('guest-')) {
                            await tripsApi.update(currentTrip.id, { budget: plannedBudget });
                          }
                        }
                      }}
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
                  onDragEnd={handleDragEnd}
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
                        onUpdate={crud.update}
                        onRemove={crud.remove}
                        onFocusPoint={setFocusCoords}
                        onDropdownToggle={setShowDropdown}
                      />
                    ))}
                  </SortableContext>
                </DndContext>

                {points.length === 0 && (
                  <p className="text-center text-slate-400 text-sm py-4">
                    Пока нет добавленных мест
                  </p>
                )}

                {/* Итого */}
                <div className="mt-4 pt-6 border-t border-slate-200/60 flex flex-col gap-6">
                  <div className="flex items-center justify-between px-2">
                    <span className="font-black text-slate-400 uppercase tracking-widest text-xs md:text-sm">
                      Итого по точкам
                    </span>
                    <span
                      className={`font-black text-xl md:text-3xl drop-shadow-[0_1px_1px_rgba(0,0,0,0.05)] ${
                        plannedBudget > 0 && totalBudget > plannedBudget
                          ? 'text-red-500'
                          : plannedBudget > 0 && totalBudget <= plannedBudget
                            ? 'text-emerald-500'
                            : 'text-brand-yellow'
                      }`}
                    >
                      {totalBudget.toLocaleString('ru-RU')} ₽
                    </span>
                  </div>

                  <div className="flex flex-col lg:flex-row gap-4 items-center justify-between bg-slate-50/50 p-4 rounded-2xl border border-slate-100">
                    <Button
                      onClick={() => {
                        if (points.length > 0) {
                          setShowClearConfirm(true);
                        } else {
                          handleConfirmClear(false);
                        }
                      }}
                      disabled={points.length === 0}
                      variant="ghost"
                      shape="xl"
                      className="w-full lg:w-auto px-8 py-4 font-black uppercase tracking-widest text-xs h-auto bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-100 transition-all shadow-sm active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      НОВЫЙ МАРШРУТ
                    </Button>
                    <div className="flex flex-col lg:flex-row gap-4 w-full lg:w-auto">
                      <Button
                        onClick={() => {
                          /* TODO: TRI-32 AI редактирование */
                        }}
                        disabled={points.length === 0}
                        variant="brand-purple"
                        shape="xl"
                        className="w-full lg:w-auto px-8 py-4 font-black uppercase tracking-widest text-sm h-auto disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        РЕДАКТИРОВАТЬ С AI
                      </Button>
                      <Button
                        onClick={async () => {
                          if (!isAuthenticated) {
                            setModal('login');
                            return;
                          }
                          const tripId = await ensureTripId();
                          const updated = await tripsApi.update(tripId, {
                            budget: plannedBudget,
                            isActive: isActiveRoute,
                          });
                          updateCurrentTrip(updated);
                          toast.success('Маршрут сохранён', { id: 'save-route' });
                        }}
                        disabled={points.length === 0}
                        variant="brand-indigo"
                        shape="xl"
                        className="w-full lg:w-auto px-8 py-4 font-black uppercase tracking-widest text-sm h-auto disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        СОХРАНИТЬ МАРШРУТ
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Таб "Популярные" */
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="w-full mb-10">
              {/* Поиск по направлению */}
              <div className="relative group mb-8">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-brand-blue transition-colors">
                  <MapPin size={20} />
                </div>
                <input
                  type="text"
                  value={popularSearch}
                  onChange={(e) => setPopularSearch(e.target.value)}
                  placeholder="Куда"
                  className="w-full pl-12 pr-4 py-4 bg-slate-50 rounded-xl md:rounded-2xl border-none focus:ring-2 focus:ring-brand-blue/20 outline-none text-slate-800 font-bold text-base md:text-lg transition-all placeholder:text-slate-400"
                />
              </div>

              {/* Фильтр-чипсы */}
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

            {/* Грид карточек */}
            <div className="grid grid-cols-2 gap-8 md:gap-12 pb-10">
              {PREDEFINED_ROUTES.filter(
                (route) =>
                  selectedFilter === 'Все' || route.tags.some((t) => t.includes(selectedFilter)),
              )
                .filter(
                  (route) =>
                    !popularSearch.trim() ||
                    route.title.toLowerCase().includes(popularSearch.toLowerCase()),
                )
                .map((route) => (
                  <div key={route.id} className="group cursor-pointer">
                    <div className="relative aspect-4/5 md:aspect-16/10 rounded-[3rem] overflow-hidden mb-6 shadow-2xl">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={route.img}
                        className="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-110 will-change-transform"
                        alt={route.title}
                      />
                      <div className="absolute inset-0 bg-linear-to-t from-black/90 via-black/20 to-transparent" />
                      <div className="absolute top-6 left-6">
                        <div className="bg-slate-900/40 backdrop-blur-md border border-white/10 rounded-xl px-3 py-1.5 text-white font-bold text-xs shadow-lg">
                          {route.temp}
                        </div>
                      </div>
                      <div className="absolute bottom-6 left-6 right-6 text-left">
                        <h3 className="text-2xl md:text-4xl font-black text-white mb-4 tracking-tight leading-none drop-shadow-[0_25px_25px_rgba(0,0,0,0.15)]">
                          {route.title}
                        </h3>
                        <div className="bg-brand-yellow text-white px-6 py-2.5 rounded-full text-sm font-black uppercase tracking-widest inline-block shadow-xl">
                          {route.total}
                        </div>
                      </div>
                    </div>
                    <p className="text-slate-500 text-lg font-medium leading-relaxed px-4 text-left">
                      {route.desc}
                    </p>
                  </div>
                ))}
            </div>
          </div>
        )}
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
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Calendar as CalendarIcon,
  Cloud,
  CloudSun,
  MapPin,
  Mic,
  Search,
  Sun,
  Wind,
} from 'lucide-react';
import { format } from 'date-fns';
import { startOfMonth } from 'date-fns';
import { startOfToday } from 'date-fns';
import { ru } from 'date-fns/locale';
import { api } from '@/shared/api';
import { useTripStore, tripsApi } from '@/entities/trip';
import { pointsApi } from '@/entities/route-point';
import type { Trip } from '@/entities/trip';
import type { RoutePoint } from '@/entities/route-point';
import { useAuthStore, LoginModal, RegisterModal } from '@/features/auth';
import { useAiQueryStore } from '@/features/ai-query';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Calendar,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/shared/ui';
import { PlannerConflictModal } from '@/widgets/planner-conflict-modal';
import { env } from '@/shared/config/env';

type Modal = 'login' | 'register' | null;
type SearchMode = 'ai' | 'manual';

interface ManualForm {
  from: string;
  to: string;
  dateFrom: string;
  dateTo: string;
  budget: string;
}

interface GeoSuggestion {
  displayName: string;
  uri?: string;
}

const QUICK_FILTERS = [
  { icon: '👍', label: 'Очень хвалят' },
  { icon: '🌊', label: 'Хочу на море' },
  { icon: '🔥', label: 'Хит сезона' },
  { icon: '⚡', label: 'Лучшее из недорогих' },
];

const FAQ_CARDS = [
  {
    id: 1,
    title: 'Как работает сервис?',
    desc: 'Наш алгоритм анализирует ваши предпочтения и подбирает оптимальные локации в РФ. Мы убрали всё лишнее, чтобы вы не тратили часы на изучение форумов и отзывов.',
    image: '/assets/images/photo-1524850011238-e3d235c7d4c9.avif',
  },
  {
    id: 2,
    title: 'Используются реальные данные?',
    desc: 'Используются реальные агрегированные данные и AI-моделирование бюджета.',
    image: '/assets/images/photo-1460925895917-afdab827c52f.avif',
  },
  {
    id: 3,
    title: 'Можно ли редактировать маршрут?',
    desc: 'Можно добавлять и удалять точки, изменять бюджет и настраивать маршрут под себя.',
    image: '/assets/images/photo-1503220317375-aaad61436b1b.avif',
  },
];

const weatherIcons = [Cloud, Sun, CloudSun, Wind];

const fallbackImages = [
  '/assets/images/photo-1524850011238-e3d235c7d4c9.avif',
  '/assets/images/photo-1460925895917-afdab827c52f.avif',
  '/assets/images/photo-1503220317375-aaad61436b1b.avif',
];

export function LandingPage() {
  const router = useRouter();
  const [modal, setModal] = useState<Modal>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('ai');
  const [selectedFilter, setSelectedFilter] = useState('Все');
  const [inputRows, setInputRows] = useState(1);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [isDesktop, setIsDesktop] = useState(false);
  const [manualForm, setManualForm] = useState<ManualForm>({
    from: '',
    to: '',
    dateFrom: '',
    dateTo: '',
    budget: '',
  });
  const [dateFromOpen, setDateFromOpen] = useState(false);
  const [dateToOpen, setDateToOpen] = useState(false);
  const [fromSuggestions, setFromSuggestions] = useState<GeoSuggestion[]>([]);
  const [toSuggestions, setToSuggestions] = useState<GeoSuggestion[]>([]);
  const [fromDropdownOpen, setFromDropdownOpen] = useState(false);
  const [toDropdownOpen, setToDropdownOpen] = useState(false);
  const [isSearchingFrom, setIsSearchingFrom] = useState(false);
  const [isSearchingTo, setIsSearchingTo] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const debounceFromRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceToRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendAiQuery = useAiQueryStore((state) => state.sendQuery);
  const createNewSession = useAiQueryStore((state) => state.createNewSession);
  const { currentTrip, setCurrentTrip, addPoint, clearPlanner } = useTripStore();
  const points = currentTrip?.points || [];
  const { isAuthenticated } = useAuthStore();
  const [showConfirmOverwrite, setShowConfirmOverwrite] = useState(false);

  // Адаптивный размер textarea, как в исходном прототипе
  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      setIsDesktop(width >= 1024);
      if (width >= 768) setInputRows(1);
      else if (width >= 375) setInputRows(2);
      else setInputRows(3);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Устойчивый автоплей видео-фона (mobile friendly)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const tryPlay = () => {
      video.muted = true;
      video.defaultMuted = true;
      void video.play().catch(() => undefined);
    };

    tryPlay();
    window.addEventListener('touchstart', tryPlay, { passive: true });
    window.addEventListener('click', tryPlay, { passive: true });

    return () => {
      window.removeEventListener('touchstart', tryPlay);
      window.removeEventListener('click', tryPlay);
    };
  }, []);

  // Загружаем предзаданные маршруты для блока «Популярное сейчас»
  useEffect(() => {
    api
      .get<Trip[]>('/trips/predefined')
      .then(setTrips)
      .catch(() => setTrips([]));
  }, []);

  const filteredTrips = useMemo(() => {
    const base = trips.filter((t) => t.isPredefined);
    if (selectedFilter === 'Все') return base;
    return base.filter((t) =>
      (t.description ?? '').toLowerCase().includes(selectedFilter.toLowerCase()),
    );
  }, [trips, selectedFilter]);

  const popularCards = useMemo(() => {
    return filteredTrips.map((trip, idx) => ({
      id: trip.id,
      title: trip.title,
      desc: trip.description ?? 'Маршрут с живописными локациями и насыщенной программой.',
      total: trip.budget ? `${trip.budget.toLocaleString('ru-RU')} ₽` : 'По запросу',
      img: trip.img || fallbackImages[idx % fallbackImages.length],
      temp: trip.temp ?? '+12°',
    }));
  }, [filteredTrips]);

  // Получение подсказок при вводе
  const getSuggestions = async (
    query: string,
    setter: (suggestions: GeoSuggestion[]) => void,
    setLoading?: (loading: boolean) => void,
  ) => {
    if (!query.trim() || query.length < 2) {
      setter([]);
      setLoading?.(false);
      return;
    }
    setLoading?.(true);
    try {
      const url = `${env.apiUrl}/geosearch/suggest?q=${encodeURIComponent(query)}`;
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error(`Suggest request failed: ${res.status}`);
      }

      const data = await res.json();
      const results = data.results ?? [];
      setter(results);
    } catch (e) {
      console.error('Failed to fetch suggestions:', e);
      setter([]);
    } finally {
      setLoading?.(false);
    }
  };

  // Геокодирование через Nominatim (OpenStreetMap)
  const geocodePlace = async (place: string): Promise<{ lat: number; lon: number } | null> => {
    if (!place.trim()) return null;
    try {
      const url = `${env.apiUrl}/geosearch/suggest?q=${encodeURIComponent(place)}`;
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error(`Geocode request failed: ${res.status}`);
      }

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
            return { lat, lon };
          }
        }
      }
    } catch (e) {
      console.error('Geocoding failed:', e);
    }
    return null;
  };

  const doManualSearch = async () => {
    // Manual mode
    const title = manualForm.to || 'Мой маршрут';
    const budget = parseInt(manualForm.budget.replace(/\D/g, ''), 10) || 0;

    clearPlanner();

    if (!isAuthenticated) {
      // Create a guest trip without saving to backend
      const guestTrip: Trip = {
        id: `guest-${Date.now()}`,
        ownerId: 'guest',
        title,
        description: manualForm.from ? `Из ${manualForm.from}` : null,
        budget: budget > 0 ? budget : null,
        startDate: manualForm.dateFrom || null,
        endDate: manualForm.dateTo || null,
        isActive: false,
        isPredefined: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        points: [],
      };

      setCurrentTrip(guestTrip);

      // Add two points: from and to (with geocoding in parallel)
      if (manualForm.from && manualForm.to) {
        const [fromCoords, toCoords] = await Promise.all([
          geocodePlace(manualForm.from),
          geocodePlace(manualForm.to),
        ]);

        if (fromCoords) {
          const fromCityName = manualForm.from.split(/[,.]/).shift()?.trim() || manualForm.from;
          const fromPoint: RoutePoint = {
            id: `point-${Date.now()}-0`,
            tripId: guestTrip.id,
            title: fromCityName,
            address: manualForm.from,
            lat: fromCoords.lat,
            lon: fromCoords.lon,
            budget: 0,
            visitDate: manualForm.dateFrom || null,
            imageUrl: null,
            order: 0,
            createdAt: new Date().toISOString(),
          };
          addPoint(fromPoint);
        }

        if (toCoords) {
          const toCityName = manualForm.to.split(/[,.]/).shift()?.trim() || manualForm.to;
          const toPoint: RoutePoint = {
            id: `point-${Date.now()}-1`,
            tripId: guestTrip.id,
            title: toCityName,
            address: manualForm.to,
            lat: toCoords.lat,
            lon: toCoords.lon,
            budget: 0,
            visitDate: manualForm.dateTo || null,
            imageUrl: null,
            order: 1,
            createdAt: new Date().toISOString(),
          };
          addPoint(toPoint);
        }
      }

      router.push('/planner');
      return;
    }

    try {
      const trip = await tripsApi.create({
        title,
        description: manualForm.from ? `Из ${manualForm.from}` : undefined,
      });

      let tripToStore = trip;
      if (budget > 0 || manualForm.dateFrom || manualForm.dateTo) {
        const updated = await tripsApi.update(trip.id, {
          budget: budget > 0 ? budget : undefined,
          startDate: manualForm.dateFrom || undefined,
          endDate: manualForm.dateTo || undefined,
        });
        tripToStore = updated;
      }

      setCurrentTrip(tripToStore);
      console.log('✓ Trip created:', trip);

      // Add two points: from and to (with geocoding in parallel)
      if (manualForm.from && manualForm.to) {
        try {
          const [fromCoords, toCoords] = await Promise.all([
            geocodePlace(manualForm.from),
            geocodePlace(manualForm.to),
          ]);
          console.log('✓ Geocoding done:', { fromCoords, toCoords });

          if (fromCoords) {
            try {
              const fromCityName = manualForm.from.split(/[,.]/).shift()?.trim() || manualForm.from;
              const fromPoint = await pointsApi.create(trip.id, {
                title: fromCityName,
                address: manualForm.from,
                lat: fromCoords.lat,
                lon: fromCoords.lon,
                budget: 0,
                visitDate: manualForm.dateFrom || undefined,
                order: 0,
              });
              console.log('✓ Created from point:', fromPoint);
            } catch (e) {
              console.error('✗ Failed to create from point:', e);
            }
          }

          if (toCoords) {
            try {
              const toCityName = manualForm.to.split(/[,.]/).shift()?.trim() || manualForm.to;
              const toPoint = await pointsApi.create(trip.id, {
                title: toCityName,
                address: manualForm.to,
                lat: toCoords.lat,
                lon: toCoords.lon,
                budget: 0,
                visitDate: manualForm.dateTo || undefined,
                order: 1,
              });
              console.log('✓ Created to point:', toPoint);
            } catch (e) {
              console.error('✗ Failed to create to point:', e);
            }
          }
        } catch (e) {
          console.error('✗ Geocoding failed:', e);
        }
      }

      console.log('→ Navigating to /planner');
      router.push('/planner');
    } catch (e) {
      console.error('Failed to create trip:', e);
      router.push('/planner');
    }
  };

  const handleSearch = () => {
    if (searchMode === 'ai') {
      if (searchQuery.trim()) {
        createNewSession();
        void sendAiQuery(searchQuery);
      }
      router.push('/ai-assistant');
      return;
    }

    if (points && points.length > 0) {
      setShowConfirmOverwrite(true);
    } else {
      void doManualSearch();
    }
  };

  const confirmOverwrite = () => {
    setShowConfirmOverwrite(false);
    void doManualSearch();
  };

  return (
    <>
      <div className="relative flex flex-col min-h-full bg-white">
        {/* 1. CINEMATIC HERO SECTION (Layla Style) */}
        <div className="relative h-auto md:h-[112vh] flex flex-col items-center justify-start md:justify-center overflow-hidden py-8 md:py-0">
          {/* Background Layer */}
          <div className="absolute inset-0 z-0">
            <div
              className="absolute inset-0 bg-cover bg-center z-[-1]"
              style={{ backgroundImage: 'url(/assets/video/hero-poster.jpg)' }}
            ></div>
            <video
              ref={videoRef}
              key={isDesktop ? 'hd' : 'sd'}
              autoPlay
              loop
              muted
              playsInline
              preload="auto"
              className="w-full h-full object-cover"
              poster="/assets/video/hero-poster.jpg"
            >
              {isDesktop ? (
                <>
                  <source src="/assets/video/hero-bg-hd.webm" type="video/webm" />
                  <source src="/assets/video/hero-bg-hd.mp4" type="video/mp4" />
                </>
              ) : (
                <>
                  <source src="/assets/video/hero-bg-small.webm" type="video/webm" />
                  <source src="/assets/video/hero-bg-small.mp4" type="video/mp4" />
                </>
              )}
            </video>
            <div className="absolute inset-0 bg-black/10"></div>
            <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-transparent"></div>
          </div>

          {/* Content Layer */}
          <div className="relative z-10 w-full max-w-5xl mx-auto px-4 md:px-6 text-center">
            <div className="animate-in fade-in slide-in-from-bottom-10 duration-1000">
              <h1 className="text-[clamp(2rem,8vw,6.5rem)] font-black text-white mb-6 tracking-tight leading-[0.9] drop-shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
                Личный <br /> <span className="text-brand-blue">тревел-гид</span>
              </h1>
              <p className="text-white text-[clamp(0.875rem,2.5vw,1.5rem)] font-medium mb-12 max-w-3xl mx-auto drop-shadow-2xl leading-relaxed">
                Планирование ещё никогда не было таким простым.
              </p>
            </div>

            {/* MINIMALIST AI SEARCH BAR */}
            <div className="w-full max-w-3xl mx-auto">
              {/* Mode Switcher */}
              <div className="flex justify-center gap-2 mb-6">
                <button
                  onClick={() => setSearchMode('ai')}
                  className={`px-6 py-2 rounded-full text-sm font-bold transition-none backdrop-blur-md ${
                    searchMode === 'ai'
                      ? 'bg-white text-brand-indigo border border-white shadow-lg'
                      : 'bg-white/10 border border-white/10 text-white hover:bg-white/20'
                  }`}
                >
                  AI-поиск
                </button>
                <button
                  onClick={() => setSearchMode('manual')}
                  className={`px-6 py-2 rounded-full text-sm font-bold transition-none backdrop-blur-md ${
                    searchMode === 'manual'
                      ? 'bg-white text-brand-indigo border border-white shadow-lg'
                      : 'bg-white/10 border border-white/10 text-white hover:bg-white/20'
                  }`}
                >
                  Вручную
                </button>
              </div>

              <div className="bg-white/10 backdrop-blur-3xl p-1.5 md:p-2.5 rounded-[2.5rem] md:rounded-[4rem] border border-white/20 shadow-2xl shadow-black/20 transition-none">
                {searchMode === 'ai' ? (
                  <div className="bg-white rounded-[2.2rem] md:rounded-[3.5rem] flex items-center p-1 md:p-2 pr-2 md:pr-4 focus-within:ring-4 focus-within:ring-brand-blue/10 transition-none">
                    <div className="flex-1 relative group">
                      <textarea
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSearch();
                          }
                        }}
                        placeholder="Например: Сочи за 45 000 руб на 5 дней"
                        rows={inputRows}
                        className="w-full py-3 md:py-4 lg:py-6 !pl-10 md:!pl-12 lg:!pl-14 pr-12 md:pr-14 bg-transparent outline-none text-slate-800 font-bold text-[clamp(0.875rem,1.5vw,1.25rem)] placeholder:text-slate-400 placeholder:font-normal resize-none overflow-hidden leading-snug md:leading-normal transition-none"
                      />
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-brand-blue transition-none"
                      >
                        <Mic size={24} />
                      </button>
                    </div>
                    <Link
                      href="/ai-assistant"
                      onClick={() => {
                        if (searchQuery.trim()) {
                          createNewSession();
                          void sendAiQuery(searchQuery);
                        }
                      }}
                      className="w-14 h-14 md:w-16 md:h-16 lg:w-20 lg:h-20 bg-brand-yellow text-white rounded-full flex items-center justify-center shadow-xl hover:scale-105 active:scale-95 shrink-0 transition-none"
                    >
                      <ArrowRight size={28} className="rotate-0 transition-none text-white" />
                    </Link>
                  </div>
                ) : (
                  <div className="bg-white rounded-[2.2rem] md:rounded-[3.5rem] p-4 md:p-8 transition-none text-left">
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Откуда */}
                        <div className="space-y-2 relative">
                          <label className="text-sm md:text-base font-black text-slate-700 uppercase ml-3">
                            Откуда
                          </label>
                          <Popover
                            open={fromDropdownOpen && fromSuggestions.length > 0}
                            onOpenChange={(open) => setFromDropdownOpen(open)}
                          >
                            <PopoverTrigger asChild>
                              <div className="relative">
                                <div className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 transition-colors">
                                  {isSearchingFrom ? (
                                    <div className="w-4 h-4 border-2 border-brand-blue border-t-transparent rounded-full animate-spin" />
                                  ) : (
                                    <MapPin size={16} className="text-slate-400" />
                                  )}
                                </div>
                                <input
                                  type="text"
                                  placeholder="Москва"
                                  value={manualForm.from}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setManualForm((p) => ({ ...p, from: value }));
                                    if (value.length > 2) {
                                      setIsSearchingFrom(true);
                                      setFromDropdownOpen(true);
                                    } else {
                                      setIsSearchingFrom(false);
                                      setFromSuggestions([]);
                                      setFromDropdownOpen(false);
                                    }
                                    if (debounceFromRef.current) clearTimeout(debounceFromRef.current);
                                    debounceFromRef.current = setTimeout(() => {
                                      void getSuggestions(value, setFromSuggestions, setIsSearchingFrom);
                                    }, 700);
                                  }}
                                  onFocus={() => manualForm.from && setFromDropdownOpen(true)}
                                  className="w-full pl-12 px-5 py-4 bg-slate-50 rounded-2xl shadow-sm border-none outline-none font-bold text-slate-700 transition-none placeholder:text-slate-400 focus:ring-2 focus:ring-brand-blue/20"
                                />
                              </div>
                            </PopoverTrigger>

                            <PopoverContent
                              align="start"
                              sideOffset={4}
                              onOpenAutoFocus={(e) => e.preventDefault()}
                              onCloseAutoFocus={(e) => e.preventDefault()}
                              className="w-[var(--radix-popover-trigger-width)] p-0 bg-white rounded-2xl shadow-lg border border-slate-200 z-50 max-h-48 overflow-y-auto"
                            >
                              {fromSuggestions.map((suggestion, idx) => (
                                <button
                                  key={idx}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setManualForm((p) => ({ ...p, from: suggestion.displayName }));
                                    setFromDropdownOpen(false);
                                    setFromSuggestions([]);
                                  }}
                                  className="w-full text-left px-4 py-3 hover:bg-slate-100 border-b border-slate-100 last:border-0 text-sm font-medium text-slate-700 transition-none"
                                >
                                  {suggestion.displayName}
                                </button>
                              ))}
                            </PopoverContent>
                          </Popover>
                        </div>
                        {/* Куда */}
                        <div className="space-y-2 relative">
                          <label className="text-sm md:text-base font-black text-slate-700 uppercase ml-3">
                            Куда
                          </label>
                          <Popover
                            open={toDropdownOpen && toSuggestions.length > 0}
                            onOpenChange={(open) => setToDropdownOpen(open)}
                          >
                            <PopoverTrigger asChild>
                              <div className="relative">
                                <div className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 transition-colors">
                                  {isSearchingTo ? (
                                    <div className="w-4 h-4 border-2 border-brand-blue border-t-transparent rounded-full animate-spin" />
                                  ) : (
                                    <MapPin size={16} className="text-slate-400" />
                                  )}
                                </div>
                                <input
                                  type="text"
                                  placeholder="Алтай"
                                  value={manualForm.to}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setManualForm((p) => ({ ...p, to: value }));
                                    if (value.length > 2) {
                                      setIsSearchingTo(true);
                                      setToDropdownOpen(true);
                                    } else {
                                      setIsSearchingTo(false);
                                      setToSuggestions([]);
                                      setToDropdownOpen(false);
                                    }
                                    if (debounceToRef.current) clearTimeout(debounceToRef.current);
                                    debounceToRef.current = setTimeout(() => {
                                      void getSuggestions(value, setToSuggestions, setIsSearchingTo);
                                    }, 700);
                                  }}
                                  onFocus={() => manualForm.to && setToDropdownOpen(true)}
                                  className="w-full pl-12 px-5 py-4 bg-slate-50 rounded-2xl shadow-sm border-none outline-none font-bold text-slate-700 transition-none placeholder:text-slate-400 focus:ring-2 focus:ring-brand-blue/20"
                                />
                              </div>
                            </PopoverTrigger>

                            <PopoverContent
                              align="start"
                              sideOffset={4}
                              onOpenAutoFocus={(e) => e.preventDefault()}
                              onCloseAutoFocus={(e) => e.preventDefault()}
                              className="w-[var(--radix-popover-trigger-width)] p-0 bg-white rounded-2xl shadow-lg border border-slate-200 z-50 max-h-48 overflow-y-auto"
                            >
                              {toSuggestions.map((suggestion, idx) => (
                                <button
                                  key={idx}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setManualForm((p) => ({ ...p, to: suggestion.displayName }));
                                    setToDropdownOpen(false);
                                    setToSuggestions([]);
                                  }}
                                  className="w-full text-left px-4 py-3 hover:bg-slate-100 border-b border-slate-100 last:border-0 text-sm font-medium text-slate-700 transition-none"
                                >
                                  {suggestion.displayName}
                                </button>
                              ))}
                            </PopoverContent>
                          </Popover>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm md:text-base font-black text-slate-700 uppercase ml-3">
                          Даты
                        </label>
                        <div className="flex flex-col md:flex-row md:items-center gap-2">
                          <Popover open={dateFromOpen} onOpenChange={setDateFromOpen}>
                            <PopoverTrigger asChild>
                              <button className="w-full px-5 py-4 bg-slate-50 rounded-2xl shadow-sm border-none outline-none font-bold text-slate-700 transition-none text-left flex items-center gap-2 focus:ring-2 focus:ring-brand-blue/20">
                                <CalendarIcon size={18} className="text-slate-400" />
                                {manualForm.dateFrom ? (
                                  format(new Date(manualForm.dateFrom), 'd MMM yyyy', {
                                    locale: ru,
                                  })
                                ) : (
                                  <span className="text-slate-400 font-normal">От</span>
                                )}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent
                              className="w-auto p-0 rounded-2xl border-slate-100 shadow-2xl"
                              align="start"
                            >
                              <Calendar
                                mode="single"
                                selected={
                                  manualForm.dateFrom ? new Date(manualForm.dateFrom) : undefined
                                }
                                disabled={(date) => date < startOfToday()}
                                onSelect={(date) => {
                                  setManualForm((p) => ({
                                    ...p,
                                    dateFrom: date?.toISOString() || '',
                                  }));
                                  setDateFromOpen(false);
                                }}
                                locale={ru}
                                captionLayout="dropdown"
                                startMonth={startOfMonth(startOfToday())}
                                endMonth={new Date(2035, 11)}
                                classNames={{ caption_label: 'hidden' }}
                              />
                            </PopoverContent>
                          </Popover>

                          <span className="text-slate-400 font-bold shrink-0 text-lg hidden md:block">
                            —
                          </span>

                          <Popover open={dateToOpen} onOpenChange={setDateToOpen}>
                            <PopoverTrigger asChild>
                              <button className="w-full px-5 py-4 bg-slate-50 rounded-2xl shadow-sm border-none outline-none font-bold text-slate-700 transition-none text-left flex items-center gap-2 focus:ring-2 focus:ring-brand-blue/20">
                                <CalendarIcon size={18} className="text-slate-400" />
                                {manualForm.dateTo ? (
                                  format(new Date(manualForm.dateTo), 'd MMM yyyy', { locale: ru })
                                ) : (
                                  <span className="text-slate-400 font-normal">До</span>
                                )}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent
                              className="w-auto p-0 rounded-2xl border-slate-100 shadow-2xl"
                              align="start"
                            >
                              <Calendar
                                mode="single"
                                selected={
                                  manualForm.dateTo ? new Date(manualForm.dateTo) : undefined
                                }
                                disabled={(date) =>
                                  date < startOfToday() ||
                                  (!!manualForm.dateFrom && date < new Date(manualForm.dateFrom))
                                }
                                onSelect={(date) => {
                                  setManualForm((p) => ({
                                    ...p,
                                    dateTo: date?.toISOString() || '',
                                  }));
                                  setDateToOpen(false);
                                }}
                                locale={ru}
                                captionLayout="dropdown"
                                startMonth={startOfMonth(startOfToday())}
                                endMonth={new Date(2035, 11)}
                                classNames={{ caption_label: 'hidden' }}
                              />
                            </PopoverContent>
                          </Popover>
                        </div>
                      </div>

                      <div className="space-y-2 flex flex-col items-center">
                        <label className="text-sm md:text-base font-black text-slate-700 uppercase">
                          Бюджет
                        </label>
                        <input
                          type="text"
                          placeholder="100 000 ₽"
                          value={manualForm.budget}
                          onChange={(e) => setManualForm((p) => ({ ...p, budget: e.target.value }))}
                          className="w-full max-w-md px-5 py-4 bg-slate-50 rounded-2xl shadow-sm border-none outline-none font-bold text-slate-700 transition-none placeholder:text-slate-400 focus:ring-2 focus:ring-brand-blue/20 text-center"
                        />
                      </div>
                    </div>
                    <Button
                      onClick={handleSearch}
                      variant="brand-yellow"
                      size="xl"
                      shape="responsive"
                      className="w-full md:w-auto mt-8 mx-auto flex font-black uppercase tracking-widest whitespace-nowrap disabled:opacity-70"
                    >
                      Добавить
                    </Button>
                  </div>
                )}
              </div>

              {/* Context suggestions */}
              <div className="mt-6 flex flex-wrap gap-2 justify-center">
                {QUICK_FILTERS.map((filter, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      createNewSession();
                      void sendAiQuery(filter.label);
                      router.push('/ai-assistant');
                    }}
                    className="px-5 py-2 bg-white/10 backdrop-blur-md border border-white/10 rounded-full text-white text-xs md:text-sm font-bold hover:bg-white/20 transition-none"
                  >
                    {filter.icon} {filter.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 2. MAIN CONTENT (Smooth transition from hero) */}
        <div className="relative z-20 bg-white">
          <div className="max-w-5xl mx-auto px-4 md:px-6 py-24 w-full">
            <div className="flex flex-col md:flex-row justify-center items-center gap-8 md:gap-16 text-center mb-32">
              <div className="flex flex-col items-center">
                <h3 className="text-4xl md:text-5xl font-black text-brand-indigo tracking-tighter">
                  AI
                </h3>
                <p className="text-xs text-slate-400 uppercase font-bold tracking-widest mt-2">
                  Генерация за секунды
                </p>
              </div>
              <div className="w-px h-12 bg-slate-200 hidden md:block"></div>
              <div className="flex flex-col items-center">
                <h3 className="text-4xl md:text-5xl font-black text-emerald-500 tracking-tighter">
                  100%
                </h3>
                <p className="text-xs text-slate-400 uppercase font-bold tracking-widest mt-2">
                  Редактируемый маршрут
                </p>
              </div>
              <div className="w-px h-12 bg-slate-200 hidden md:block"></div>
              <div className="flex flex-col items-center">
                <h3 className="text-4xl md:text-5xl font-black text-brand-yellow tracking-tighter">
                  24/7
                </h3>
                <p className="text-xs text-slate-400 uppercase font-bold tracking-widest mt-2">
                  В любое время
                </p>
              </div>
            </div>

            <div className="mb-32">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-16">
                <div>
                  <h2 className="text-[clamp(1.75rem,6vw,4.5rem)] font-black text-brand-indigo tracking-tight leading-[0.9]">
                    Популярное <br /> <span className="text-brand-blue">сейчас</span>
                  </h2>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-20 md:gap-16">
                {popularCards.map((trip, idx) => {
                  const Icon = weatherIcons[idx % weatherIcons.length] ?? Cloud;
                  return (
                    <Link
                      key={trip.id}
                      href={`/tours/${trip.id}`}
                      className="group block w-full cursor-pointer"
                    >
                      <div className="relative aspect-[4/5] md:aspect-[16/10] rounded-[3rem] overflow-hidden mb-8 shadow-2xl isolation-auto">
                        <img
                          src={trip.img}
                          className="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-110 rounded-[3rem] will-change-transform"
                          alt={trip.title}
                        />
                        {/* Layla-style enhanced gradient underlay */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent rounded-[3rem]"></div>

                        <div className="absolute top-6 left-6">
                          <div className="bg-slate-900/40 backdrop-blur-md border border-white/10 rounded-xl px-3 py-1.5 text-white font-bold text-xs flex items-center gap-1.5 shadow-lg">
                            <Icon size={14} /> {trip.temp}
                          </div>
                        </div>

                        <div className="absolute bottom-6 left-6 right-6 text-left">
                          <h3 className="text-2xl lg:text-4xl font-black text-white mb-1 tracking-tight leading-tight drop-shadow-2xl">
                            {trip.title}
                          </h3>
                          <div className="flex items-center gap-2 text-white/90 font-bold text-xs uppercase tracking-widest mb-4 drop-shadow-lg"></div>
                          <div className="bg-brand-yellow text-white px-6 py-2.5 rounded-full text-sm font-black uppercase tracking-widest inline-block shadow-xl">
                            <span>{trip.total}</span>
                          </div>
                        </div>
                      </div>
                      <p className="text-slate-500 text-xl font-medium leading-relaxed px-4">
                        {trip.desc}
                      </p>
                    </Link>
                  );
                })}
              </div>
            </div>

            <div className="pt-0">
              <h2 className="text-[clamp(1.75rem,6vw,4.5rem)] font-black text-brand-indigo mb-[clamp(2.5rem,5vw,5rem)] tracking-tight leading-[0.9]">
                Ответы <br /> <span className="text-brand-blue">на вопросы</span>
              </h2>
              <div className="space-y-32">
                {FAQ_CARDS.map((card, idx) => (
                  <div
                    key={card.id}
                    className={`flex flex-col md:flex-row items-center gap-12 md:gap-24 ${idx % 2 !== 0 ? 'md:flex-row-reverse' : ''}`}
                  >
                    <div className="w-full md:w-1/2 aspect-square md:aspect-[4/3] rounded-[3rem] overflow-hidden shadow-2xl">
                      <img
                        src={card.image}
                        className="w-full h-full object-cover"
                        alt={card.title}
                      />
                    </div>
                    <div className="w-full md:w-1/2 text-left">
                      <h4 className="text-[clamp(1.25rem,4vw,2.5rem)] font-black text-brand-indigo mb-8 leading-tight tracking-tight">
                        {card.title}
                      </h4>
                      <p className="text-slate-500 text-[clamp(1rem,2vw,1.25rem)] font-medium leading-relaxed">
                        {' '}
                        {card.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <PlannerConflictModal
        open={showConfirmOverwrite}
        onOpenChange={setShowConfirmOverwrite}
        conflictType="landing_new"
        currentRouteTitle={currentTrip?.title || 'без названия'}
        onCancel={() => setShowConfirmOverwrite(false)}
        onReplaceWithoutSave={() => {
          setShowConfirmOverwrite(false);
          confirmOverwrite();
        }}
        onSaveAndReplace={async () => {
          setShowConfirmOverwrite(false);
          if (currentTrip && !currentTrip.id.startsWith('guest-')) {
            await tripsApi.update(currentTrip.id, {
              title: currentTrip.title,
              description: currentTrip.description ?? undefined,
              budget: currentTrip.budget ?? undefined,
            });
          }
          confirmOverwrite();
        }}
        onGoToPlannerOnly={() => {
          setShowConfirmOverwrite(false);
          router.push('/planner');
        }}
      />

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
    </>
  );
}

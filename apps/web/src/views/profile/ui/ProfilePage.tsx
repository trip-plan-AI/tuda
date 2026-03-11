'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  User as UserIcon,
  Pencil,
  Map as MapIcon,
  ArrowUp,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useUserStore, usersApi } from '@/entities/user';
import { useTripStore, type Trip } from '@/entities/trip';
import { useAuthStore } from '@/features/auth';
import { tripsApi } from '@/entities/trip';
import { toast } from 'sonner';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';

const RouteMap = dynamic(() => import('@/widgets/route-map').then((m) => m.RouteMap), {
  ssr: false,
  loading: () => <div className="w-full h-full bg-slate-50 animate-pulse rounded-2xl" />,
});

function getBudgetMetrics(plannedBudget: number | null | undefined, totalBudget: number) {
  const plan = Math.max(0, plannedBudget ?? 0);
  const total = Math.max(0, totalBudget);
  const isOverBudget = plan > 0 && total > plan;
  const progressPercent = plan > 0 ? Math.min(100, Math.round((total / plan) * 100)) : 0;
  return { plan, total, isOverBudget, progressPercent };
}

function formatRub(value: number) {
  return value.toLocaleString('ru-RU').replace(/\u00A0/g, ' ');
}

function BudgetSummary({
  plannedBudget,
  totalBudget,
  className,
}: {
  plannedBudget: number | null | undefined;
  totalBudget: number;
  className?: string;
}) {
  const { plan, total, isOverBudget, progressPercent } = getBudgetMetrics(plannedBudget, totalBudget);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className="flex flex-col min-w-0 text-left">
          <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest">Планируемый</span>
          <span className="text-sm sm:text-base md:text-lg font-black text-brand-indigo leading-tight break-all">
            {formatRub(plan)} ₽
          </span>
        </div>
        <div className="flex flex-col min-w-0 text-left md:text-right">
          <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest">Итого по точкам</span>
          <span className={cn('text-sm sm:text-base md:text-lg font-black leading-tight break-all', isOverBudget ? 'text-red-500' : 'text-brand-indigo')}>
            {formatRub(total)} ₽
          </span>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all duration-300', isOverBudget ? 'bg-red-500' : 'bg-emerald-500')}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 text-[9px] font-bold text-slate-400">
          <span className="min-w-0 break-words">{plan > 0 ? `Использовано ${progressPercent}%` : 'Лимит не задан'}</span>
          <span className="min-w-0 text-right break-all">{plan > 0 ? `${formatRub(plan - total)} ₽` : '—'}</span>
        </div>
        <div className={cn('flex items-start gap-2 rounded-lg border px-2 py-1 text-[9px] sm:text-[10px] font-black leading-tight break-words', isOverBudget ? 'border-red-100 bg-red-50/70 text-red-600' : 'border-emerald-100 bg-emerald-50/70 text-emerald-600')}>
          {isOverBudget ? <AlertTriangle size={10} /> : <CheckCircle2 size={10} />}
          {plan > 0 ? (
            isOverBudget ? <span>Перерасход: +{formatRub(total - plan)} ₽</span> : <span>Остаток: {formatRub(plan - total)} ₽</span>
          ) : (
            <span>Задайте планируемый бюджет для контроля расхода</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProfilePage() {
  const router = useRouter();
  const { user, setUser } = useUserStore();
  const { setCurrentTrip } = useTripStore();
  const { isAuthenticated } = useAuthStore();

  const [activeTab, setActiveTab] = useState<'routes' | 'saved'>('routes');
  const [sheetHeight, setSheetHeight] = useState(60);
  const [isDragging, setIsDragging] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [tempName, setTempName] = useState(user?.name || '');
  const [savedTrips, setSavedTrips] = useState<Trip[]>([]);
  const [isLoadingTrips, setIsLoadingTrips] = useState(true);
  const [isAuthResolved, setIsAuthResolved] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const progressColor = scrollProgress < 0.4 ? '#0ea5e9' : scrollProgress < 0.8 ? '#4f46e5' : '#9333ea';
  const progressTrackColor = '#e2e8f0';

  const fileInputRef = useRef<HTMLInputElement>(null);
  const savedListScrollRef = useRef<HTMLDivElement>(null);
  const routePointsScrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const evaluateScrollState = useCallback(() => {
    const container = activeTab === 'saved' ? savedListScrollRef.current : routePointsScrollRef.current;
    if (!container) return;
    const { scrollTop, clientHeight, scrollHeight } = container;
    const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
    const progress = Math.max(0, Math.min(1, scrollTop / maxScrollTop));
    setScrollProgress(progress);
    setShowScrollTop(scrollTop > 10);
  }, [activeTab]);

  const handleContentScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      evaluateScrollState();
    });
  }, [evaluateScrollState]);

  const handleScrollToTop = useCallback(() => {
    const container = activeTab === 'saved' ? savedListScrollRef.current : routePointsScrollRef.current;
    if (!container) return;
    const currentTop = container.scrollTop;
    if (currentTop > 4000) {
      container.scrollTo({ top: 1200, behavior: 'auto' });
      window.requestAnimationFrame(() => {
        const c = activeTab === 'saved' ? savedListScrollRef.current : routePointsScrollRef.current;
        c?.scrollTo({ top: 0, behavior: 'smooth' });
      });
      return;
    }
    container.scrollTo({ top: 0, behavior: 'smooth' });
  }, [activeTab]);

  const progressDegrees = Math.round(scrollProgress * 360);

  useEffect(() => { setIsAuthResolved(true); }, []);

  useEffect(() => {
    if (!isAuthResolved) return;
    const hasStoredToken = typeof window !== 'undefined' && Boolean(window.localStorage.getItem('accessToken'));
    if (!isAuthenticated && !hasStoredToken) { router.push('/'); return; }
    tripsApi.getAll()
      .then((trips) => { setSavedTrips(trips); setIsLoadingTrips(false); })
      .catch((err) => { console.error('Failed to load trips:', err); setIsLoadingTrips(false); });
  }, [isAuthenticated, isAuthResolved, router]);

  useEffect(() => { evaluateScrollState(); }, [activeTab, savedTrips, isLoadingTrips, evaluateScrollState]);

  useEffect(() => {
    return () => { if (scrollRafRef.current != null) window.cancelAnimationFrame(scrollRafRef.current); };
  }, []);

  const activeRoute = savedTrips.find((t) => t.isActive);
  const activeRouteTotalBudget = activeRoute?.points?.reduce((sum, point) => sum + (point.budget || 0), 0) || 0;

  const handleTouchStart = (e: React.TouchEvent) => {
    setIsDragging(true);
    startY.current = e.touches[0]!.clientY;
    startHeight.current = sheetHeight;
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return;
    const deltaY = startY.current - e.touches[0]!.clientY;
    const deltaPercent = (deltaY / window.innerHeight) * 100;
    let newHeight = startHeight.current + deltaPercent;
    newHeight = Math.max(20, Math.min(90, newHeight));
    setSheetHeight(newHeight);
  };
  const handleTouchEnd = () => setIsDragging(false);

  const handleAvatarClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          const updatedUser = await usersApi.updateMe({ photo: reader.result as string });
          setUser(updatedUser);
          toast.success('Фото профиля обновлено');
        } catch { toast.error('Не удалось обновить фото'); }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSaveName = async () => {
    if (!tempName.trim()) return;
    try {
      const updatedUser = await usersApi.updateMe({ name: tempName.trim() });
      setUser(updatedUser);
      setIsEditingName(false);
      toast.success('Имя обновлено');
    } catch { toast.error('Не удалось обновить имя'); }
  };

  const handleToggleActive = async (routeId: string) => {
    try {
      const trip = savedTrips.find((t) => t.id === routeId);
      if (!trip) return;
      const newIsActive = !trip.isActive;
      setSavedTrips(savedTrips.map((t) => ({ ...t, isActive: t.id === routeId ? newIsActive : false })));
      await tripsApi.update(routeId, { isActive: newIsActive });
      toast.success(newIsActive ? 'Маршрут активирован' : 'Маршрут деактивирован', { id: 'route-activation' });
    } catch {
      toast.error('Ошибка при обновлении статуса', { id: 'route-activation-error' });
    }
  };

  const handleEditRoute = (trip: Trip) => {
    setCurrentTrip(trip);
    router.push('/planner');
  };

  return (
    <div className="flex flex-col h-full max-h-[calc(100vh-100px)] bg-slate-50 relative overflow-hidden w-full rounded-[1.5rem] shadow-sm border border-slate-200 animate-in fade-in slide-in-from-bottom-8 duration-1000 ease-out">
      <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/*" className="hidden" />

      {/* ── ШАПКА ПРОФИЛЯ ── */}
      <div className="w-full shrink-0 bg-white border-b border-slate-200 z-20 px-4 py-3 md:px-5 md:py-4 shadow-sm">
        <div className="flex items-center gap-3 mb-3 md:mb-4 w-full">
          <h1 className="text-lg md:text-xl font-black text-brand-indigo">Мой профиль</h1>
        </div>
        <div className="flex items-center gap-4 md:gap-5">
          <div
            onClick={handleAvatarClick}
            className="w-16 h-16 md:w-20 md:h-20 bg-slate-50 rounded-full flex items-center justify-center border-2 border-white shadow-md overflow-hidden cursor-pointer group relative shrink-0"
          >
            {user?.photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.photo} className="w-full h-full object-cover" alt={user.name} />
            ) : (
              <UserIcon size={32} className="text-slate-200" />
            )}
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <Pencil size={20} className="text-white" />
            </div>
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              {isEditingName ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={tempName}
                    onChange={(e) => setTempName(e.target.value)}
                    onBlur={handleSaveName}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                    className="text-lg md:text-xl font-black text-brand-indigo border-b-2 border-brand-blue outline-none bg-transparent min-w-[150px]"
                  />
                  <button
                    onClick={handleSaveName}
                    className="p-2 hover:scale-110 active:scale-90 transition-all flex items-center justify-center"
                    aria-label="Сохранить имя"
                  >
                    <span className="text-xl leading-none">💾</span>
                  </button>
                </div>
              ) : (
                <>
                  <h2 className="text-lg md:text-xl font-black text-brand-indigo">{user?.name}</h2>
                  <button
                    onClick={() => {
                      setTempName(user?.name || '');
                      setIsEditingName(true);
                    }}
                    className="p-1 hover:scale-110 active:scale-90 transition-all flex items-center justify-center"
                    aria-label="Редактировать имя"
                  >
                    <span className="text-sm leading-none">✏️</span>
                  </button>
                </>
              )}
            </div>
            <p className="text-[10px] text-slate-400 font-bold mt-0.5">
              Путешественник с {user?.createdAt ? new Date(user.createdAt).getFullYear() : '2026'} года
            </p>
          </div>
        </div>
      </div>

      {/* ── ОСНОВНАЯ ОБЛАСТЬ ── */}
      <div className="flex-1 flex flex-col md:flex-row relative overflow-hidden w-full">

        {/* Мобильный бэкграунд */}
        <div className="md:hidden absolute inset-0 bg-slate-100 flex items-start justify-center pt-4">
          {isMobile && activeRoute && activeRoute.points && activeRoute.points.length > 0 ? (
            <div className="w-full h-1/2 opacity-60 pointer-events-none grayscale">
              <RouteMap key={`bg-${activeRoute.id}-${activeTab}`} points={activeRoute.points} onPointDragEnd={() => {}} />
            </div>
          ) : (
            <MapIcon size={48} className="text-slate-200 mt-10" />
          )}
        </div>

        {/* ── ЛЕВАЯ КОЛОНКА: Список ── */}
        <div
          className={cn(
            'absolute bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] md:bottom-auto md:top-0',
            'h-[var(--sheet-height)] md:h-full w-full md:static',
            'flex flex-col bg-white z-10',
            'shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.1)] md:shadow-none',
            'rounded-t-[1.5rem] md:rounded-none',
            'transition-[height] duration-75 ease-out overflow-hidden',
            'md:w-[40%] lg:w-[35%] xl:w-[400px] shrink-0 md:border-r md:border-slate-200',
          )}
          style={{ ['--sheet-height' as string]: `${sheetHeight}%` }}
        >
          <div
            className="w-full pt-2 pb-1 shrink-0 bg-white rounded-t-[1.5rem] md:hidden cursor-grab active:cursor-grabbing touch-none"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto" />
          </div>

          <div className="px-3 md:px-4 pt-3 md:pt-4 shrink-0 bg-white z-20">
            <div className="flex w-full p-1 bg-slate-100 rounded-xl">
              <button
                onClick={() => setActiveTab('routes')}
                className={cn('flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all', activeTab === 'routes' ? 'bg-white text-brand-indigo shadow-sm' : 'text-slate-400 hover:text-slate-600')}
              >
                Активно
              </button>
              <button
                onClick={() => setActiveTab('saved')}
                className={cn('flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all', activeTab === 'saved' ? 'bg-white text-brand-indigo shadow-sm' : 'text-slate-400 hover:text-slate-600')}
              >
                Сохранено
              </button>
            </div>
          </div>

          <div className="flex-1 relative min-h-0">
            <div
              className={cn(
                'absolute right-3 bottom-3 md:right-4 md:bottom-4 z-30',
                'transition-all duration-300',
                showScrollTop ? 'opacity-100 translate-y-0 visible' : 'opacity-0 translate-y-2 invisible pointer-events-none',
              )}
            >
              <button
                type="button"
                onClick={handleScrollToTop}
                className="relative h-10 w-10 rounded-full shadow-md transition-transform hover:scale-105 active:scale-95"
              >
                <span
                  className="absolute inset-0 rounded-full"
                  style={{ background: `conic-gradient(${progressColor} ${progressDegrees}deg, ${progressTrackColor} ${progressDegrees}deg)` }}
                />
                <span className="absolute inset-[2px] rounded-full bg-white" />
                <span className="relative z-10 flex h-full w-full items-center justify-center text-brand-indigo">
                  <ArrowUp size={14} />
                </span>
              </button>
            </div>

            <div className="h-full overflow-y-auto p-3 md:p-4 flex flex-col no-scrollbar">
              {activeTab === 'routes' ? (
                activeRoute ? (
                  <div className="space-y-3 w-full h-full flex flex-col">
                    <div className="flex justify-between items-center px-1">
                      <h3 className="text-[10px] font-black text-brand-indigo uppercase tracking-widest">Активный маршрут</h3>
                      <Button variant="outline" size="sm" onClick={() => handleEditRoute(activeRoute)} className="h-7 px-2 rounded-lg border-slate-200 text-slate-500 font-bold text-[9px]">
                        <Pencil size={12} className="mr-1" />
                        ИЗМЕНИТЬ
                      </Button>
                    </div>

                    <div className="bg-white p-3 md:p-4 rounded-2xl border border-slate-100 shadow-sm flex-1 min-h-0 flex flex-col">
                      <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 rounded-xl bg-brand-blue/10 text-brand-blue flex items-center justify-center shrink-0">
                          <MapIcon size={20} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[8px] font-black text-slate-300 uppercase tracking-widest truncate">Маршрут</p>
                          <p className="text-base font-black text-brand-indigo truncate leading-tight">{activeRoute.title}</p>
                        </div>
                      </div>

                      <div className="relative flex-1 min-h-[100px]">
                        <div ref={routePointsScrollRef} onScroll={handleContentScroll} className="h-full overflow-y-auto pr-1 no-scrollbar">
                          <div className="space-y-2.5 pb-2">
                            {activeRoute.points?.map((point, idx) => (
                              <div key={point.id} className="flex items-start gap-3">
                                <div className="w-5 h-5 rounded-full bg-brand-blue text-white font-black flex items-center justify-center text-[8px] shrink-0 mt-0.5">
                                  {idx + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-black text-slate-700 leading-tight">{point.title}</p>
                                  <p className="text-[10px] text-slate-400 font-bold">
                                    {point.budget ? `${point.budget.toLocaleString('ru-RU')} ₽` : 'Бесплатно'}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="mt-2 pt-2 border-t border-slate-50 shrink-0">
                        <BudgetSummary plannedBudget={activeRoute.budget} totalBudget={activeRouteTotalBudget} />
                      </div>
                    </div>

                    {/* Превью карты (только мобилка) */}
                    {isMobile && (
                      <div className="w-full aspect-[16/9] md:hidden rounded-2xl overflow-hidden relative border border-slate-200 shadow-inner bg-slate-100 mt-3">
                        <RouteMap key={`card-${activeRoute.id}-${activeTab}`} points={activeRoute.points || []} onPointDragEnd={() => {}} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-full w-full flex flex-col items-center justify-center text-slate-300 text-center p-6">
                    <MapIcon size={32} className="mb-2 opacity-20" />
                    <p className="text-[11px] font-bold italic">Нет активного маршрута</p>
                    <Button onClick={() => router.push('/planner')} variant="brand" className="mt-4 h-8 rounded-lg uppercase font-black tracking-widest text-[9px]">
                      Создать
                    </Button>
                  </div>
                )
              ) : isLoadingTrips ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-slate-100 animate-pulse rounded-2xl" />)}
                </div>
              ) : savedTrips.length > 0 ? (
                <div ref={savedListScrollRef} onScroll={handleContentScroll} className="h-full overflow-y-auto pr-1 no-scrollbar">
                  <div className="space-y-3 w-full pb-2">
                    {savedTrips.map((route) => {
                      const routeTotalBudget = route.points?.reduce((sum, p) => sum + (p.budget || 0), 0) || 0;
                      return (
                        <div key={route.id} className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
                          <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 flex items-center justify-center shrink-0">
                                <MapIcon size={18} />
                              </div>
                              <div className="min-w-0">
                                <p className="text-[8px] font-black text-slate-300 uppercase tracking-widest truncate">Маршрут</p>
                                <p className="text-base font-black text-brand-indigo truncate leading-tight">{route.title}</p>
                              </div>
                            </div>
                            <button onClick={() => handleEditRoute(route)} className="p-2 bg-slate-50 text-slate-400 hover:text-brand-blue rounded-lg transition-all active:scale-90 shrink-0">
                              <Pencil size={14} />
                            </button>
                          </div>
                          <div className="pt-3 border-t border-slate-50 space-y-3">
                            <BudgetSummary plannedBudget={route.budget} totalBudget={routeTotalBudget} />
                            <div className="flex justify-end">
                              <label className="flex items-center gap-2 cursor-pointer group">
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest group-hover:text-slate-600 transition-colors">
                                  {route.isActive ? 'Активен' : 'Активировать'}
                                </span>
                                <div className="relative">
                                  <input type="checkbox" className="sr-only peer" checked={route.isActive} onChange={() => handleToggleActive(route.id)} />
                                  <div className="w-10 h-6 bg-slate-100 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[3px] after:start-[3px] after:bg-white after:border-slate-200 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-brand-blue" />
                                </div>
                              </label>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="h-full w-full flex flex-col items-center justify-center text-slate-300 text-center p-6">
                  <MapIcon size={32} className="mb-2 opacity-20" />
                  <p className="text-[11px] font-bold italic">Список пуст</p>
                </div>
              )}
            </div>
          </div>
        </div>


        <div className="hidden md:flex flex-1 relative bg-slate-50 items-center justify-center overflow-hidden p-4">
          <div className="w-full h-full max-w-[96%] max-h-[96%] overflow-hidden relative rounded-2xl border border-slate-200 shadow-lg">
            {!isMobile && activeRoute && activeRoute.points && activeRoute.points.length > 0 ? (
              <RouteMap key={`desktop-${activeRoute.id}-${activeTab}`} points={activeRoute.points} onPointDragEnd={() => {}} />
            ) : (
              <MapIcon 
                size={44} 
                className="text-slate-200 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" 
              />
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
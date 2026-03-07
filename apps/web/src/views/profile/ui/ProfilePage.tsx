'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  User as UserIcon,
  Check,
  Pencil,
  Map as MapIcon,
  ChevronLeft,
  ArrowUp,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useUserStore, usersApi, type User } from '@/entities/user';
import { useTripStore, tripsApi, type Trip } from '@/entities/trip';
import { useAuthStore } from '@/features/auth';
import { toast } from 'sonner';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';

const RouteMap = dynamic(() => import('@/widgets/route-map').then((m) => m.RouteMap), {
  ssr: false,
  loading: () => <div className="w-full h-full bg-slate-50 animate-pulse rounded-3xl" />,
});

function getBudgetMetrics(plannedBudget: number | null | undefined, totalBudget: number) {
  const plan = Math.max(0, plannedBudget ?? 0);
  const total = Math.max(0, totalBudget);
  const isOverBudget = plan > 0 && total > plan;
  const progressPercent = plan > 0 ? Math.min(100, Math.round((total / plan) * 100)) : 0;

  return { plan, total, isOverBudget, progressPercent };
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
    <div className={cn('space-y-3', className)}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        <div className="flex flex-col min-w-0 text-left">
          <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">
            Планируемый
          </span>
          <span className="text-lg sm:text-xl md:text-2xl font-black text-brand-indigo leading-tight break-words">
            {plan.toLocaleString('ru-RU')} ₽
          </span>
        </div>

        <div className="flex flex-col min-w-0 text-left md:text-right">
          <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">
            Итого по точкам
          </span>
          <span
            className={cn(
              'text-lg sm:text-xl md:text-2xl font-black leading-tight break-words',
              isOverBudget ? 'text-red-500' : 'text-brand-indigo',
            )}
          >
            {total.toLocaleString('ru-RU')} ₽
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-300',
              isOverBudget ? 'bg-red-500' : 'bg-emerald-500',
            )}
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-[10px] font-bold text-slate-400">
          <span>{plan > 0 ? `Использовано ${progressPercent}%` : 'Лимит не задан'}</span>
          <span>{plan > 0 ? `${(plan - total).toLocaleString('ru-RU')} ₽` : '—'}</span>
        </div>

        <div
          className={cn(
            'flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] font-black',
            isOverBudget
              ? 'border-red-100 bg-red-50/70 text-red-600'
              : 'border-emerald-100 bg-emerald-50/70 text-emerald-600',
          )}
        >
          {isOverBudget ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
          {plan > 0 ? (
            isOverBudget ? (
              <span>Перерасход: +{(total - plan).toLocaleString('ru-RU')} ₽</span>
            ) : (
              <span>Остаток: {(plan - total).toLocaleString('ru-RU')} ₽</span>
            )
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
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [isScrollableSavedList, setIsScrollableSavedList] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);

  const progressColor =
    scrollProgress < 0.4 ? '#0ea5e9' : scrollProgress < 0.8 ? '#4f46e5' : '#9333ea';
  const progressTrackColor = '#e2e8f0';

  const fileInputRef = useRef<HTMLInputElement>(null);
  const savedListScrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const isFabVisibleRef = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const evaluateScrollState = useCallback(() => {
    const container = savedListScrollRef.current;
    if (!container) return;

    const { scrollTop, clientHeight, scrollHeight } = container;
    const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
    const progress = Math.max(0, Math.min(1, scrollTop / maxScrollTop));
    const isScrollable = scrollHeight > clientHeight + 1;
    setScrollProgress(progress);
    setIsScrollableSavedList(isScrollable);

    if (!isScrollable) {
      isFabVisibleRef.current = false;
      setShowScrollTop(false);
      setScrollProgress(0);
      return;
    }

    // Гистерезис по прогрессу скролла: одинаковое поведение на desktop/mobile и при любой высоте контейнера.
    const showThreshold = 0.15;
    const hideThreshold = 0.05;
    const shouldShow = isFabVisibleRef.current
      ? progress > hideThreshold
      : progress > showThreshold;

    isFabVisibleRef.current = shouldShow;
    setShowScrollTop(shouldShow);
  }, []);

  const handleContentScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      evaluateScrollState();
    });
  }, [evaluateScrollState]);

  const handleScrollToTop = useCallback(() => {
    const container = savedListScrollRef.current;
    if (!container) return;

    const currentTop = container.scrollTop;
    if (currentTop > 4000) {
      container.scrollTo({ top: 1200, behavior: 'auto' });
      window.requestAnimationFrame(() => {
        savedListScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      });
      return;
    }

    container.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const progressDegrees = Math.round(scrollProgress * 360);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
      return;
    }

    // Загружаем все маршруты пользователя
    tripsApi
      .getAll()
      .then((trips) => {
        setSavedTrips(trips);
        setIsLoadingTrips(false);
      })
      .catch((err) => {
        console.error('Failed to load trips:', err);
        setIsLoadingTrips(false);
      });
  }, [isAuthenticated, router]);

  useEffect(() => {
    evaluateScrollState();
  }, [activeTab, savedTrips, isLoadingTrips, evaluateScrollState]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const activeRoute = savedTrips.find((t) => t.isActive);
  const activeRouteTotalBudget =
    activeRoute?.points?.reduce((sum, point) => sum + (point.budget || 0), 0) || 0;

  const handleTouchStart = (e: React.TouchEvent) => {
    setIsDragging(true);
    startY.current = e.touches[0]!.clientY;
    startHeight.current = sheetHeight;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return;
    const currentY = e.touches[0]!.clientY;
    const deltaY = startY.current - currentY;
    const windowHeight = window.innerHeight;
    const deltaPercent = (deltaY / windowHeight) * 100;
    let newHeight = startHeight.current + deltaPercent;
    if (newHeight < 20) newHeight = 20;
    if (newHeight > 90) newHeight = 90;
    setSheetHeight(newHeight);
  };

  const handleTouchEnd = () => setIsDragging(false);

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = reader.result as string;
        try {
          const updatedUser = await usersApi.updateMe({ photo: base64 });
          setUser(updatedUser);
          toast.success('Фото профиля обновлено');
        } catch (err) {
          toast.error('Не удалось обновить фото');
        }
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
    } catch (err) {
      toast.error('Не удалось обновить имя');
    }
  };

  const handleToggleActive = async (routeId: string) => {
    try {
      const trip = savedTrips.find((t) => t.id === routeId);
      if (!trip) return;

      const newIsActive = !trip.isActive;

      // Если мы активируем маршрут, нужно деактивировать все остальные на клиенте
      const updatedTrips = savedTrips.map((t) => ({
        ...t,
        isActive: t.id === routeId ? newIsActive : false,
      }));
      setSavedTrips(updatedTrips);

      // Отправляем запрос на сервер
      await tripsApi.update(routeId, { isActive: newIsActive });

      toast.success(newIsActive ? 'Маршрут активирован' : 'Маршрут деактивирован');
    } catch (err) {
      toast.error('Ошибка при обновлении статуса');
    }
  };

  const handleEditRoute = (trip: Trip) => {
    setCurrentTrip(trip);
    router.push('/planner');
  };

  return (
    <div className="flex flex-col h-screen bg-white relative overflow-hidden">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        className="hidden"
      />

      <div className="flex-1 flex flex-col relative overflow-hidden">
        {/* Мобильная шапка/фон */}
        <div className="md:hidden h-1/3 w-full bg-slate-100 flex items-center justify-center">
          {activeRoute && activeRoute.points && activeRoute.points.length > 0 ? (
            <div className="w-full h-full opacity-50 grayscale pointer-events-none">
              <RouteMap points={activeRoute.points} onPointDragEnd={() => {}} />
            </div>
          ) : (
            <MapIcon size={64} className="text-slate-200" />
          )}
        </div>

        {/* ПРОФИЛЬ */}
          <div
            className={cn(
              'absolute bottom-0 h-[var(--sheet-height)] md:h-full w-full md:static flex flex-col bg-white z-10 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.2)] md:shadow-none rounded-t-[2.5rem] md:rounded-none transition-[height] duration-75 ease-out overflow-hidden',
              'md:max-w-4xl md:mx-auto md:px-10',
            )}
            style={{ ['--sheet-height' as string]: `${sheetHeight}%` }}
          >
          {/* Зона перетаскивания и Навигация */}
          <div
            className="w-full pt-3 shrink-0 bg-white rounded-t-[2.5rem] md:rounded-none border-b border-slate-50 md:cursor-default cursor-grab active:cursor-grabbing touch-none"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div className="w-12 h-1.5 bg-slate-200 rounded-full mx-auto mb-2 md:hidden"></div>

            <div className="px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => router.back()}
                  className="md:hidden p-2 -ml-2 text-slate-400"
                >
                  <ChevronLeft size={24} />
                </button>
                <h1 className="text-xl md:text-2xl font-black text-brand-indigo">Мой профиль</h1>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6 md:p-10 flex flex-col pb-28 md:pb-10 no-scrollbar">
            <div className="flex flex-col items-center md:items-start mb-10">
              <div
                onClick={handleAvatarClick}
                className="w-24 h-24 md:w-28 md:h-28 bg-slate-50 rounded-full flex items-center justify-center mb-4 border-4 border-white shadow-md overflow-hidden cursor-pointer group relative"
              >
                {user?.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={user.photo} className="w-full h-full object-cover" alt={user.name} />
                ) : (
                  <UserIcon size={48} className="text-slate-200" />
                )}
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <Pencil size={24} className="text-white" />
                </div>
              </div>

              <div className="flex items-center gap-3">
                {isEditingName ? (
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      type="text"
                      value={tempName}
                      onChange={(e) => setTempName(e.target.value)}
                      onBlur={handleSaveName}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                      className="text-xl md:text-2xl font-black text-brand-indigo border-b-2 border-brand-blue outline-none bg-transparent min-w-[200px]"
                    />
                    <button
                      onClick={handleSaveName}
                      className="p-2 bg-emerald-500 text-white rounded-xl shadow-lg active:scale-90 transition-transform"
                    >
                      <Check size={20} />
                    </button>
                  </div>
                ) : (
                  <>
                    <h2 className="text-xl md:text-2xl font-black text-brand-indigo">
                      {user?.name}
                    </h2>
                    <button
                      onClick={() => {
                        setTempName(user?.name || '');
                        setIsEditingName(true);
                      }}
                      className="p-2.5 bg-slate-50 text-slate-400 hover:text-brand-blue hover:bg-slate-100 rounded-xl transition-all active:scale-90"
                      aria-label="Редактировать имя"
                    >
                      <Pencil size={18} />
                    </button>
                  </>
                )}
              </div>

              <p className="text-sm text-slate-400 font-bold mt-1">
                Путешественник с {user?.createdAt ? new Date(user.createdAt).getFullYear() : '2026'}{' '}
                года
              </p>
            </div>

            <div className="flex p-1.5 bg-slate-50 rounded-2xl mb-8">
              <button
                onClick={() => setActiveTab('routes')}
                className={cn(
                  'flex-1 py-3 rounded-xl text-sm font-black uppercase tracking-widest transition-all',
                  activeTab === 'routes'
                    ? 'bg-white text-brand-indigo shadow-sm'
                    : 'text-slate-400',
                )}
              >
                Активно
              </button>
              <button
                onClick={() => setActiveTab('saved')}
                className={cn(
                  'flex-1 py-3 rounded-xl text-sm font-black uppercase tracking-widest transition-all',
                  activeTab === 'saved' ? 'bg-white text-brand-indigo shadow-sm' : 'text-slate-400',
                )}
              >
                Сохранено
              </button>
            </div>

            <div
              className={cn(
                'flex-1 min-h-[300px] bg-slate-50/50 rounded-[2.5rem] border border-slate-100 relative p-4 md:p-8',
                activeTab === 'saved' && 'overflow-hidden',
              )}
            >
              {activeTab === 'routes' ? (
                // "Активно" tab
                activeRoute ? (
                  <div className="space-y-6 w-full animate-in fade-in duration-500">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg font-black text-brand-indigo uppercase tracking-widest">
                        Активный маршрут
                      </h3>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditRoute(activeRoute)}
                        className="rounded-xl border-slate-200 text-slate-500 font-bold"
                      >
                        <Pencil size={14} className="mr-2" />
                        ИЗМЕНИТЬ
                      </Button>
                    </div>

                    <div className="w-full aspect-[4/5] md:aspect-video rounded-[2rem] overflow-hidden relative border border-slate-200 shadow-inner bg-slate-100">
                      <RouteMap points={activeRoute.points || []} onPointDragEnd={() => {}} />
                    </div>

                    <div className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm">
                      <div className="flex items-center gap-4 mb-6">
                        <div className="w-12 h-12 rounded-2xl bg-brand-blue/10 text-brand-blue flex items-center justify-center">
                          <MapIcon size={24} />
                        </div>
                        <div>
                          <p className="text-xs font-black text-slate-300 uppercase tracking-widest">
                            Маршрут
                          </p>
                          <p className="text-xl font-black text-brand-indigo">
                            {activeRoute.title}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-4">
                        {activeRoute.points?.map((point, idx) => (
                          <div key={point.id} className="flex items-start gap-4">
                            <div className="w-6 h-6 rounded-full bg-brand-blue text-white font-black flex items-center justify-center text-[10px] shrink-0 mt-0.5">
                              {idx + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-black text-slate-700">{point.title}</p>
                              <p className="text-xs text-slate-400 font-bold">
                                {point.budget
                                  ? `${point.budget.toLocaleString('ru-RU')} ₽`
                                  : 'Бесплатно'}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="mt-8 pt-6 border-t border-slate-50">
                        <BudgetSummary
                          plannedBudget={activeRoute.budget}
                          totalBudget={activeRouteTotalBudget}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="h-full w-full flex flex-col items-center justify-center text-slate-300 text-center p-10">
                    <MapIcon size={48} className="mb-4 opacity-20" />
                    <p className="text-sm font-bold italic">Нет активного маршрута</p>
                    <Button
                      onClick={() => router.push('/planner')}
                      variant="brand"
                      className="mt-6 rounded-xl uppercase font-black tracking-widest text-xs"
                    >
                      Создать
                    </Button>
                  </div>
                )
              ) : // "Сохранено" tab
              isLoadingTrips ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-32 bg-slate-100 animate-pulse rounded-3xl" />
                  ))}
                </div>
              ) : savedTrips.length > 0 ? (
                <div
                  ref={savedListScrollRef}
                  onScroll={handleContentScroll}
                  className="h-full overflow-y-auto pr-1 no-scrollbar"
                >
                  <div className="space-y-4 w-full animate-in fade-in duration-500 pb-2">
                    {savedTrips.map((route) => {
                      const routeTotalBudget =
                        route.points?.reduce((sum, point) => sum + (point.budget || 0), 0) || 0;

                      return (
                        <div
                          key={route.id}
                          className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md transition-all"
                        >
                          <div className="flex items-center justify-between mb-6">
                            <div className="flex items-center gap-4">
                              <div className="w-12 h-12 rounded-2xl bg-slate-50 text-slate-400 flex items-center justify-center">
                                <MapIcon size={20} />
                              </div>
                              <div>
                                <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">
                                  Маршрут
                                </p>
                                <p className="text-lg font-black text-brand-indigo truncate max-w-[150px] md:max-w-xs">
                                  {route.title}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleEditRoute(route)}
                                className="p-2.5 bg-slate-50 text-slate-400 hover:text-brand-blue hover:bg-slate-100 rounded-xl transition-all active:scale-90"
                                title="Редактировать"
                              >
                                <Pencil size={18} />
                              </button>
                            </div>
                          </div>

                          <div className="pt-4 border-t border-slate-50 space-y-4">
                            <BudgetSummary plannedBudget={route.budget} totalBudget={routeTotalBudget} />

                            <div className="flex justify-end">
                              <label className="flex items-center gap-3 cursor-pointer group">
                                <span className="text-xs font-black text-slate-400 uppercase tracking-widest group-hover:text-slate-600 transition-colors">
                                  {route.isActive ? 'Активен' : 'Активировать'}
                                </span>
                                <div className="relative">
                                  <input
                                    type="checkbox"
                                    className="sr-only peer"
                                    checked={route.isActive}
                                    onChange={() => handleToggleActive(route.id)}
                                  />
                                  <div className="w-12 h-7 bg-slate-100 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[4px] after:start-[4px] after:bg-white after:border-slate-200 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-blue"></div>
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
                <div className="h-full w-full flex flex-col items-center justify-center text-slate-300 text-center p-10">
                  <MapIcon size={48} className="mb-4 opacity-20" />
                  <p className="text-sm font-bold italic">Список пуст</p>
                </div>
              )}

              {activeTab === 'saved' && isScrollableSavedList && showScrollTop && (
                <div className="hidden md:block absolute right-4 bottom-16 z-30">
                  <button
                    type="button"
                    aria-label="Вернуться наверх"
                    onClick={handleScrollToTop}
                    className="relative h-14 w-14 rounded-full shadow-lg transition-transform duration-200 hover:scale-105 active:scale-95 focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
                  >
                    <span
                      className="absolute inset-0 rounded-full"
                      style={{
                        background: `conic-gradient(${progressColor} ${progressDegrees}deg, ${progressTrackColor} ${progressDegrees}deg)`,
                      }}
                    />
                    <span className="absolute inset-[3px] rounded-full bg-white" />
                    <span className="relative z-10 flex h-full w-full items-center justify-center text-brand-indigo">
                      <ArrowUp size={18} />
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {activeTab === 'saved' && isScrollableSavedList && showScrollTop && (
        <button
          type="button"
          aria-label="Вернуться наверх"
          onClick={handleScrollToTop}
          className="md:hidden fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+92px)] z-[70] h-14 w-14 rounded-full shadow-xl transition-transform duration-200 active:scale-95 focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
        >
          <span
            className="absolute inset-0 rounded-full"
            style={{
              background: `conic-gradient(${progressColor} ${progressDegrees}deg, ${progressTrackColor} ${progressDegrees}deg)`,
            }}
          />
          <span className="absolute inset-[3px] rounded-full bg-white" />
          <span className="relative z-10 flex h-full w-full items-center justify-center text-brand-indigo">
            <ArrowUp size={18} />
          </span>
        </button>
      )}
    </div>
  );
}

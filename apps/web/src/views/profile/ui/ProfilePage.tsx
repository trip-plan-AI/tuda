'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  User as UserIcon,
  Check,
  Pencil,
  Map as MapIcon,
  ChevronLeft,
  ArrowUp,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { useUserStore, usersApi, type User } from '@/entities/user'
import { useTripStore, tripsApi, type Trip } from '@/entities/trip'
import { useAuthStore } from '@/features/auth'
import { toast } from 'sonner'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

const RouteMap = dynamic(() => import('@/widgets/route-map').then((m) => m.RouteMap), {
  ssr: false,
  loading: () => <div className="w-full h-full bg-slate-50 animate-pulse rounded-3xl" />,
})

export function ProfilePage() {
  const router = useRouter()
  const { user, setUser } = useUserStore()
  const { setCurrentTrip } = useTripStore()
  const { isAuthenticated } = useAuthStore()

  const [activeTab, setActiveTab] = useState<'routes' | 'saved'>('routes')
  const [sheetHeight, setSheetHeight] = useState(60)
  const [isDragging, setIsDragging] = useState(false)
  const [isEditingName, setIsEditingName] = useState(false)
  const [tempName, setTempName] = useState(user?.name || '')
  const [savedTrips, setSavedTrips] = useState<Trip[]>([])
  const [isLoadingTrips, setIsLoadingTrips] = useState(true)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [isScrollableSavedList, setIsScrollableSavedList] = useState(false)
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)
  const isFabVisibleRef = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)

  const evaluateScrollState = useCallback(() => {
    const container = contentScrollRef.current
    if (!container) return

    const { scrollTop, clientHeight, scrollHeight } = container
    const isScrollable = scrollHeight > clientHeight + 1
    setIsScrollableSavedList(isScrollable)

    if (!isScrollable) {
      isFabVisibleRef.current = false
      setShowScrollTop(false)
      return
    }

    // Гистерезис: показываем позже, скрываем раньше, чтобы не мигало на границе.
    const showThreshold = clientHeight * 1.25
    const hideThreshold = clientHeight * 0.4
    const shouldShow = isFabVisibleRef.current ? scrollTop > hideThreshold : scrollTop > showThreshold

    isFabVisibleRef.current = shouldShow
    setShowScrollTop(shouldShow)
  }, [])

  const handleContentScroll = useCallback(() => {
    if (scrollRafRef.current != null) return
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null
      evaluateScrollState()
    })
  }, [evaluateScrollState])

  const handleScrollToTop = useCallback(() => {
    const container = contentScrollRef.current
    if (!container) return

    const currentTop = container.scrollTop
    if (currentTop > 4000) {
      container.scrollTo({ top: 1200, behavior: 'auto' })
      window.requestAnimationFrame(() => {
        contentScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      })
      return
    }

    container.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/')
      return
    }

    // Загружаем все маршруты пользователя
    tripsApi
      .getAll()
      .then((trips) => {
        setSavedTrips(trips)
        setIsLoadingTrips(false)
      })
      .catch((err) => {
        console.error('Failed to load trips:', err)
        setIsLoadingTrips(false)
      })
  }, [isAuthenticated, router])

  useEffect(() => {
    evaluateScrollState()
  }, [activeTab, savedTrips, isLoadingTrips, evaluateScrollState])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const handleViewportResize = () => {
      const keyboardLikelyOpen = viewport.height < window.innerHeight * 0.75
      setIsKeyboardOpen(keyboardLikelyOpen)
    }

    viewport.addEventListener('resize', handleViewportResize)
    handleViewportResize()

    return () => {
      viewport.removeEventListener('resize', handleViewportResize)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) {
        window.cancelAnimationFrame(scrollRafRef.current)
      }
    }
  }, [])

  const activeRoute = savedTrips.find((t) => t.isActive)

  const handleTouchStart = (e: React.TouchEvent) => {
    setIsDragging(true)
    startY.current = e.touches[0]!.clientY
    startHeight.current = sheetHeight
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return
    const currentY = e.touches[0]!.clientY
    const deltaY = startY.current - currentY
    const windowHeight = window.innerHeight
    const deltaPercent = (deltaY / windowHeight) * 100
    let newHeight = startHeight.current + deltaPercent
    if (newHeight < 20) newHeight = 20
    if (newHeight > 90) newHeight = 90
    setSheetHeight(newHeight)
  }

  const handleTouchEnd = () => setIsDragging(false)

  const handleAvatarClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = async () => {
        const base64 = reader.result as string
        try {
          const updatedUser = await usersApi.updateMe({ photo: base64 })
          setUser(updatedUser)
          toast.success('Фото профиля обновлено')
        } catch (err) {
          toast.error('Не удалось обновить фото')
        }
      }
      reader.readAsDataURL(file)
    }
  }

  const handleSaveName = async () => {
    if (!tempName.trim()) return
    try {
      const updatedUser = await usersApi.updateMe({ name: tempName.trim() })
      setUser(updatedUser)
      setIsEditingName(false)
      toast.success('Имя обновлено')
    } catch (err) {
      toast.error('Не удалось обновить имя')
    }
  }

  const handleToggleActive = async (routeId: string) => {
    try {
      const trip = savedTrips.find((t) => t.id === routeId)
      if (!trip) return

      const newIsActive = !trip.isActive

      // Если мы активируем маршрут, нужно деактивировать все остальные на клиенте
      const updatedTrips = savedTrips.map((t) => ({
        ...t,
        isActive: t.id === routeId ? newIsActive : false,
      }))
      setSavedTrips(updatedTrips)

      // Отправляем запрос на сервер
      await tripsApi.update(routeId, { isActive: newIsActive })
      
      toast.success(newIsActive ? 'Маршрут активирован' : 'Маршрут деактивирован')
    } catch (err) {
      toast.error('Ошибка при обновлении статуса')
    }
  }

  const handleEditRoute = (trip: Trip) => {
    setCurrentTrip(trip)
    router.push('/planner')
  }

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
            "absolute bottom-0 w-full md:static md:h-full flex flex-col bg-white z-10 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.2)] md:shadow-none rounded-t-[2.5rem] md:rounded-none transition-[height] duration-75 ease-out overflow-hidden",
            "md:max-w-4xl md:mx-auto md:px-10"
          )}
          style={{
            height: typeof window !== 'undefined' && window.innerWidth < 768 ? `${sheetHeight}%` : "100%",
          }}
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
                  <button onClick={() => router.back()} className="md:hidden p-2 -ml-2 text-slate-400">
                      <ChevronLeft size={24} />
                  </button>
                  <h1 className="text-xl md:text-2xl font-black text-brand-indigo">
                    Мой профиль
                  </h1>
              </div>
            </div>
          </div>

          <div
            ref={contentScrollRef}
            onScroll={handleContentScroll}
            className="flex-1 overflow-y-auto p-6 md:p-10 flex flex-col pb-28 md:pb-10 no-scrollbar"
          >
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
                      onKeyDown={(e) => e.key === "Enter" && handleSaveName()}
                      className="text-xl md:text-2xl font-black text-brand-indigo border-b-2 border-brand-blue outline-none bg-transparent min-w-[200px]"
                    />
                    <button onClick={handleSaveName} className="p-2 bg-emerald-500 text-white rounded-xl shadow-lg active:scale-90 transition-transform">
                      <Check size={20} />
                    </button>
                  </div>
                ) : (
                  <>
                    <h2 className="text-xl md:text-2xl font-black text-brand-indigo">{user?.name}</h2>
                    <button
                      onClick={() => {
                        setTempName(user?.name || "");
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
                Путешественник с {user?.createdAt ? new Date(user.createdAt).getFullYear() : '2026'} года
              </p>
            </div>

            <div className="flex p-1.5 bg-slate-50 rounded-2xl mb-8">
              <button
                onClick={() => setActiveTab("routes")}
                className={cn(
                  "flex-1 py-3 rounded-xl text-sm font-black uppercase tracking-widest transition-all",
                  activeTab === "routes" ? "bg-white text-brand-indigo shadow-sm" : "text-slate-400"
                )}
              >
                Активно
              </button>
              <button
                onClick={() => setActiveTab("saved")}
                className={cn(
                  "flex-1 py-3 rounded-xl text-sm font-black uppercase tracking-widest transition-all",
                  activeTab === "saved" ? "bg-white text-brand-indigo shadow-sm" : "text-slate-400"
                )}
              >
                Сохранено
              </button>
            </div>

            <div className="flex-1 min-h-[300px] bg-slate-50/50 rounded-[2.5rem] border border-slate-100 relative p-4 md:p-8">
              {activeTab === "routes" ? (
                // "Активно" tab
                activeRoute ? (
                    <div className="space-y-6 w-full animate-in fade-in duration-500">
                        <div className="flex justify-between items-center">
                            <h3 className="text-lg font-black text-brand-indigo uppercase tracking-widest">Активный маршрут</h3>
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
                                    <p className="text-xs font-black text-slate-300 uppercase tracking-widest">Маршрут</p>
                                    <p className="text-xl font-black text-brand-indigo">{activeRoute.title}</p>
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
                                                {point.budget ? `${point.budget.toLocaleString("ru-RU")} ₽` : 'Бесплатно'}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <div className="mt-8 pt-6 border-t border-slate-50 flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">Общий бюджет</span>
                                    <span className="text-2xl font-black text-brand-indigo">
                                        {(activeRoute.points?.reduce((sum, p) => sum + (p.budget || 0), 0) || 0).toLocaleString("ru-RU")} ₽
                                    </span>
                                </div>
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
              ) : (
                // "Сохранено" tab
                isLoadingTrips ? (
                   <div className="space-y-4">
                       {[1,2,3].map(i => <div key={i} className="h-32 bg-slate-100 animate-pulse rounded-3xl" />)}
                   </div>
                ) : savedTrips.length > 0 ? (
                  <div className="space-y-4 w-full animate-in fade-in duration-500">
                    {savedTrips.map((route) => (
                      <div key={route.id} className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md transition-all">
                        <div className="flex items-center justify-between mb-6">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-2xl bg-slate-50 text-slate-400 flex items-center justify-center">
                              <MapIcon size={20} />
                            </div>
                            <div>
                              <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">Маршрут</p>
                              <p className="text-lg font-black text-brand-indigo truncate max-w-[150px] md:max-w-xs">{route.title}</p>
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

                        <div className="flex items-center justify-between pt-4 border-t border-slate-50">
                          <div className="flex flex-col">
                            <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">Бюджет</span>
                            <span className="text-xl font-black text-brand-indigo">
                                {(route.points?.reduce((sum, p) => sum + (p.budget || 0), 0) || 0).toLocaleString("ru-RU")} ₽
                            </span>
                          </div>
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
                    ))}
                  </div>
                ) : (
                  <div className="h-full w-full flex flex-col items-center justify-center text-slate-300 text-center p-10">
                      <MapIcon size={48} className="mb-4 opacity-20" />
                      <p className="text-sm font-bold italic">Список пуст</p>
                  </div>
                )
              )}

            </div>
          </div>
        </div>
      </div>

      {activeTab === 'saved' && isScrollableSavedList && showScrollTop && !isKeyboardOpen && (
        <Button
          type="button"
          aria-label="Вернуться наверх"
          onClick={handleScrollToTop}
          variant="brand-indigo"
          className="fixed right-4 md:right-8 z-40 h-12 min-w-12 px-3 rounded-full shadow-xl transition-all duration-200 hover:scale-[1.03] active:scale-95 opacity-90 hover:opacity-100"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
        >
          <ArrowUp size={18} />
        </Button>
      )}
    </div>
  )
}

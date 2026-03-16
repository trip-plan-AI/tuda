'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  User as UserIcon,
  Pencil,
  Map as MapIcon,
  ArrowUp,
  Route,
  MapPin,
  Ruler,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { useUserStore, usersApi } from '@/entities/user';
import { useTripStore, type Trip } from '@/entities/trip';
import { useAuthStore } from '@/features/auth';
import { pointsApi } from '@/entities/route-point';
import { tripsApi } from '@/entities/trip';
import { toast } from 'sonner';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import {
  useCollaborateStore,
  collaborateApi,
  useCollaborationSocket,
  InviteModal,
  CollaboratorsModal,
} from '@/features/route-collaborate';
import { getSocket } from '@/shared/socket/socket-client';
import { setConfig, clearConfig } from '@/features/persistent-map';
import { TripCard } from '@/entities/trip/ui/TripCard';
import { PlannerConflictModal } from '@/widgets/planner-conflict-modal';

type TabKey = 'routes' | 'saved';

export function ProfilePage() {
  const router = useRouter();
  const { user, setUser } = useUserStore();
  const { setCurrentTrip, currentTrip, updateCurrentTrip, setPoints, addPoint, removePoint } =
    useTripStore();
  const trips = useTripStore((state) => state.trips);
  const setTrips = useTripStore((state) => state.setTrips);
  const isDirty = useTripStore((state) => state.isDirty);
  const clearPlanner = useTripStore((state) => state.clearPlanner);
  const { isAuthenticated } = useAuthStore();

  const [activeTab, setActiveTab] = useState<TabKey>('routes');
  const [isEditingName, setIsEditingName] = useState(false);
  const [tempName, setTempName] = useState(user?.name || '');
  const [allTrips, setAllTrips] = useState<Trip[]>([]);
  const [isLoadingTrips, setIsLoadingTrips] = useState(true);
  const [showPlannerConflictModal, setShowPlannerConflictModal] = useState(false);
  const [pendingPlannerTripId, setPendingPlannerTripId] = useState<string | null>(null);
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [isAuthResolved, setIsAuthResolved] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [collaboratorsModalOpen, setCollaboratorsModalOpen] = useState(false);
  const [inviteTripId, setInviteTripId] = useState<string | null>(null);
  const [collaboratorsTripId, setCollaboratorsTripId] = useState<string | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [highlightedTripId, setHighlightedTripId] = useState<string | null>(null);
  const { setCollaborators } = useCollaborateStore();

  // Sync local allTrips into the Zustand store so selectors/filtered arrays stay up-to-date
  useEffect(() => {
    setTrips(allTrips);
  }, [allTrips, setTrips]);

  const travelTrips = trips.filter((t) => t.startDate && t.endDate);
  const savedTrips = trips.filter((t) => !t.startDate || !t.endDate);

  const now = new Date();
  const currentTrips = travelTrips
    .filter((t) => new Date(t.startDate!) <= now && new Date(t.endDate!) >= now)
    .sort((a, b) => new Date(a.endDate!).getTime() - new Date(b.endDate!).getTime());
  const upcomingTrips = travelTrips
    .filter((t) => new Date(t.startDate!) > now)
    .sort((a, b) => new Date(a.startDate!).getTime() - new Date(b.startDate!).getTime());
  const pastTrips = travelTrips
    .filter((t) => new Date(t.endDate!) < now)
    .sort((a, b) => new Date(b.endDate!).getTime() - new Date(a.endDate!).getTime());

  const toRad = (value: number) => (value * Math.PI) / 180;
  const getDistanceKmBetweenPoints = (
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
  ) => {
    const earthRadiusKm = 6371;
    const dLat = toRad(to.lat - from.lat);
    const dLon = toRad(to.lon - from.lon);
    const lat1 = toRad(from.lat);
    const lat2 = toRad(to.lat);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadiusKm * c;
  };

  const getTripDistanceKm = (trip: Trip) => {
    if (trip.distanceKm != null) return trip.distanceKm;

    const tripPoints = trip.points ?? [];
    if (tripPoints.length < 2) return 0;

    let total = 0;
    for (let i = 1; i < tripPoints.length; i += 1) {
      const prev = tripPoints[i - 1]!;
      const curr = tripPoints[i]!;
      total += getDistanceKmBetweenPoints({ lat: prev.lat, lon: prev.lon }, { lat: curr.lat, lon: curr.lon });
    }
    return total;
  };

  const finishedOrActiveTrips = [...currentTrips, ...pastTrips];
  const statsTripsCount = finishedOrActiveTrips.length;
  const statsPointsCount = finishedOrActiveTrips.reduce((acc, t) => acc + (t.points?.length ?? 0), 0);
  const statsDistanceKm = Math.round(
    finishedOrActiveTrips.reduce((acc, t) => acc + getTripDistanceKm(t), 0),
  );
  const formatStatValue = (value: number) =>
    value
      .toLocaleString('ru-RU')
      .replace(/\u00A0/g, ' ');

  const progressColor =
    scrollProgress < 0.4 ? '#0ea5e9' : scrollProgress < 0.8 ? '#4f46e5' : '#9333ea';
  const progressTrackColor = '#e2e8f0';

  const fileInputRef = useRef<HTMLInputElement>(null);
  const savedListScrollRef = useRef<HTMLDivElement>(null);
  const routePointsScrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const highlightTimeoutRef = useRef<number | null>(null);
  const tripCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const getTripTab = useCallback((trip?: Pick<Trip, 'startDate' | 'endDate'> | null): TabKey => {
    return trip?.startDate && trip?.endDate ? 'routes' : 'saved';
  }, []);

  const getTripIdsByTab = useCallback((tripsList: Trip[], tab: TabKey): string[] => {
    if (tab === 'saved') {
      return tripsList
        .filter((t) => !t.startDate || !t.endDate)
        .map((t) => t.id);
    }

    const currentTime = new Date();
    const travelList = tripsList.filter((t) => t.startDate && t.endDate);
    const currentList = travelList
      .filter((t) => new Date(t.startDate!) <= currentTime && new Date(t.endDate!) >= currentTime)
      .sort((a, b) => new Date(a.endDate!).getTime() - new Date(b.endDate!).getTime());
    const upcomingList = travelList
      .filter((t) => new Date(t.startDate!) > currentTime)
      .sort((a, b) => new Date(a.startDate!).getTime() - new Date(b.startDate!).getTime());
    const pastList = travelList
      .filter((t) => new Date(t.endDate!) < currentTime)
      .sort((a, b) => new Date(b.endDate!).getTime() - new Date(a.endDate!).getTime());

    return [...currentList, ...upcomingList, ...pastList].map((t) => t.id);
  }, []);

  const registerTripCardRef = useCallback((tripId: string, node: HTMLDivElement | null) => {
    if (node) {
      tripCardRefs.current.set(tripId, node);
      return;
    }
    tripCardRefs.current.delete(tripId);
  }, []);

  const focusTripCard = useCallback((tripId: string, targetTab: TabKey) => {
    setActiveTab(targetTab);
    setSelectedTripId(tripId);

    const tryFocus = () => {
      const node = tripCardRefs.current.get(tripId);
      if (!node) {
        window.setTimeout(() => {
          const delayedNode = tripCardRefs.current.get(tripId);
          if (!delayedNode) return;
          delayedNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightedTripId(tripId);
        }, 120);
        return;
      }

      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedTripId(tripId);
    };

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(tryFocus);
    });

    if (highlightTimeoutRef.current != null) {
      window.clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedTripId((prev) => (prev === tripId ? null : prev));
    }, 1800);
  }, []);

  const showTripMovedToast = useCallback(
    (tripId: string, nextTab: TabKey) => {
      toast.custom(
        (toastId) => (
          <div className="relative overflow-hidden rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/95 via-white to-emerald-100/80 shadow-xl backdrop-blur-md">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.15),transparent_45%)]" />
            <div className="relative flex items-center gap-3 px-4 py-3.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 ring-1 ring-emerald-200">
                <CheckCircle2 size={16} />
              </div>

              <div className="min-w-0">
                <p className="text-[15px] font-black text-emerald-900 leading-tight">Даты обновлены</p>
                <p className="mt-0.5 text-[12px] font-medium text-emerald-700/90 leading-snug">
                  Маршрут изменил позицию в списке. Перейдите к нему в один клик.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  focusTripCard(tripId, nextTab);
                  toast.dismiss(toastId);
                }}
                className="ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-brand-indigo px-3 py-2 text-[12px] font-bold text-white shadow-sm transition-all hover:bg-brand-indigo-hover hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky/60"
              >
                Показать
                <ArrowRight size={13} />
              </button>
            </div>
          </div>
        ),
        {
          duration: 7000,
        },
      );
    },
    [focusTripCard],
  );

  const evaluateScrollState = useCallback(() => {
    const scrollTop = window.scrollY;
    const maxScrollTop = document.documentElement.scrollHeight - window.innerHeight;
    const progress = Math.max(0, Math.min(1, maxScrollTop > 0 ? scrollTop / maxScrollTop : 0));
    setScrollProgress(progress);
    setShowScrollTop(scrollTop > 50);
  }, []);

  const handleContentScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      evaluateScrollState();
    });
  }, [evaluateScrollState]);

  useEffect(() => {
    window.addEventListener('scroll', handleContentScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleContentScroll);
  }, [handleContentScroll]);

  const handleScrollToTop = useCallback(() => {
    const currentTop = window.scrollY;
    if (currentTop > 4000) {
      window.scrollTo({ top: 1200, behavior: 'auto' });
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const progressDegrees = Math.round(scrollProgress * 360);

  useEffect(() => {
    setIsAuthResolved(true);
  }, []);

  useEffect(() => {
    if (!isAuthResolved) return;
    const hasStoredToken =
      typeof window !== 'undefined' && Boolean(window.localStorage.getItem('accessToken'));
    if (!isAuthenticated && !hasStoredToken) {
      const isSessionExpiredFlow =
        typeof window !== 'undefined' &&
        window.sessionStorage.getItem('auth:session-expired') === '1';

      if (isSessionExpiredFlow) {
        setIsLoadingTrips(false);
        return;
      }

      router.push('/');
      return;
    }

    tripsApi
      .getAll()
      .then((loadedTrips) => {
        setAllTrips(loadedTrips);
        setIsLoadingTrips(false);
      })
      .catch((err) => {
        console.error('Failed to load trips:', err);
        setAllTrips([]);
        toast.error('Не удалось загрузить маршруты профиля. Попробуйте обновить страницу.');
        setIsLoadingTrips(false);
      });
  }, [isAuthenticated, isAuthResolved, router]);

  useEffect(() => {
    evaluateScrollState();
  }, [activeTab, allTrips, isLoadingTrips, evaluateScrollState]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) window.cancelAnimationFrame(scrollRafRef.current);
      if (highlightTimeoutRef.current != null) window.clearTimeout(highlightTimeoutRef.current);
    };
  }, []);

  const activeRoute = allTrips.find((t) => t.isActive);

  // Prefer currentTrip.points (kept live by WS) when viewing the active route
  const displayedActiveRoute = activeRoute
    ? currentTrip?.id === activeRoute.id
      ? { ...activeRoute, points: currentTrip.points }
      : activeRoute
    : undefined;

  useCollaborationSocket(activeRoute?.id ?? '');

  // Selected trip for map display.
  // When the selected card is the active route, use displayedActiveRoute so live
  // socket updates (currentTrip.points) are reflected on the map immediately.
  const selectedTrip = selectedTripId
    ? selectedTripId === activeRoute?.id
      ? (displayedActiveRoute ?? allTrips.find((t) => t.id === selectedTripId) ?? null)
      : (allTrips.find((t) => t.id === selectedTripId) ?? null)
    : (displayedActiveRoute ?? travelTrips[0] ?? null);

  // Feed points to PersistentMapShell (right aside in layout)
  useEffect(() => {
    setConfig({
      source: 'profile-page',
      priority: 80,
      points: selectedTrip?.points || [],
      readonly: true,
      draggable: false,
      routeProfile: 'driving',
      fitKey: selectedTrip?.id,
    });
    return () => {
      clearConfig('profile-page');
    };
  }, [selectedTrip?.id, selectedTrip?.points]);

  // Join all trip sockets for real-time card updates
  useEffect(() => {
    const socket = getSocket();
    const joinedIds = allTrips.map((t) => t.id).filter(Boolean);

    joinedIds.forEach((id) => {
      if (id !== activeRoute?.id) {
        socket.emit('join:trip', { trip_id: id });
      }
    });

    return () => {
      joinedIds.forEach((id) => {
        if (id !== activeRoute?.id) {
          socket.emit('leave:trip', { trip_id: id });
        }
      });
    };
  }, [allTrips, activeRoute?.id]);

  // When the current user is invited to / removed from a trip
  useEffect(() => {
    const socket = getSocket();
    socket.on('trip:shared', (trip: Trip) => {
      setAllTrips((prev) => {
        if (prev.some((t) => t.id === trip.id)) return prev;
        return [...prev, { ...trip, isActive: false }];
      });
    });
    socket.on('trip:removed', ({ tripId }: { tripId: string }) => {
      setAllTrips((prev) => prev.filter((t) => t.id !== tripId));
    });
    return () => {
      socket.off('trip:shared');
      socket.off('trip:removed');
    };
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!currentTrip?.id) return;

    const onPointReorder = ({ trip_id, pointIds }: { trip_id: string; pointIds: string[] }) => {
      if (trip_id === currentTrip.id) {
        const currentPoints = useTripStore.getState().currentTrip?.points || [];
        const pointMap = new Map(currentPoints.map((p) => [p.id, p]));
        const newPoints: any[] = [];
        for (const id of pointIds) {
          const p = pointMap.get(id);
          if (p) newPoints.push(p);
        }
        if (newPoints.length === currentPoints.length) {
          setPoints(newPoints);
        } else {
          pointsApi.getAll(trip_id).then(setPoints).catch(console.error);
        }
      }

      setAllTrips((prev) =>
        prev.map((t) => {
          if (t.id !== trip_id || !t.points) return t;
          const pointMap = new Map(t.points.map((p) => [p.id, p]));
          const newPoints: any[] = [];
          for (const id of pointIds) {
            const p = pointMap.get(id);
            if (p) newPoints.push(p);
          }
          if (newPoints.length === t.points.length) {
            return { ...t, points: newPoints };
          }
          return t;
        }),
      );
    };

    // point:updated payload: { trip_id, point_id, ...fields }
    const onPointUpdate = ({
      trip_id,
      point_id,
      ...patch
    }: { trip_id: string; point_id: string } & any) => {
      if (!trip_id) return;
      if (trip_id === currentTrip.id) {
        const currentPoints = useTripStore.getState().currentTrip?.points || [];
        setPoints(currentPoints.map((p) => (p.id === point_id ? { ...p, ...patch } : p)));
      }

      setAllTrips((prev) =>
        prev.map((t) => {
          if (t.id !== trip_id || !t.points) return t;
          return {
            ...t,
            points: t.points.map((p) => (p.id === point_id ? { ...p, ...patch } : p)),
          };
        }),
      );
    };

    // point:moved payload: { trip_id, point_id, coords: { lat, lon } }
    const onPointMoved = ({
      trip_id,
      point_id,
      coords,
    }: { trip_id: string; point_id: string; coords: { lat: number; lon: number } }) => {
      if (!trip_id) return;
      if (trip_id === currentTrip.id) {
        const currentPoints = useTripStore.getState().currentTrip?.points || [];
        setPoints(currentPoints.map((p) => (p.id === point_id ? { ...p, lat: coords.lat, lon: coords.lon } : p)));
      }

      setAllTrips((prev) =>
        prev.map((t) => {
          if (t.id !== trip_id || !t.points) return t;
          return {
            ...t,
            points: t.points.map((p) =>
              p.id === point_id ? { ...p, lat: coords.lat, lon: coords.lon } : p,
            ),
          };
        }),
      );
    };

    // point:added payload: { trip_id, point }
    const onPointAdd = ({ trip_id, point }: { trip_id: string; point: any }) => {
      if (!trip_id) return;
      if (trip_id === currentTrip.id) {
        addPoint(point);
      }

      setAllTrips((prev) =>
        prev.map((t) => {
          if (t.id !== trip_id) return t;
          return { ...t, points: [...(t.points || []), point] };
        }),
      );
    };

    // point:deleted payload: { trip_id, point_id }
    const onPointDelete = ({ trip_id, point_id }: { trip_id: string; point_id: string }) => {
      if (!trip_id) return;
      if (trip_id === currentTrip.id) {
        removePoint(point_id);
      }

      setAllTrips((prev) =>
        prev.map((t) => {
          if (t.id !== trip_id || !t.points) return t;
          return { ...t, points: t.points.filter((p) => p.id !== point_id) };
        }),
      );
    };

    const onTripUpdate = ({ trip_id, ...patch }: { trip_id: string } & any) => {
      if (trip_id === currentTrip.id) {
        updateCurrentTrip(patch);
      }
      setAllTrips((prev) => prev.map((t) => (t.id === trip_id ? { ...t, ...patch } : t)));
    };

    socket.on('point:reorder', onPointReorder);
    socket.on('point:updated', onPointUpdate);
    socket.on('point:moved', onPointMoved);
    socket.on('point:added', onPointAdd);
    socket.on('point:deleted', onPointDelete);
    socket.on('trip:update', onTripUpdate);

    return () => {
      socket.off('point:reorder', onPointReorder);
      socket.off('point:updated', onPointUpdate);
      socket.off('point:moved', onPointMoved);
      socket.off('point:added', onPointAdd);
      socket.off('point:deleted', onPointDelete);
      socket.off('trip:update', onTripUpdate);
    };
  }, [currentTrip?.id, setPoints, updateCurrentTrip, addPoint, removePoint]);

  useEffect(() => {
    if (activeRoute?.id) {
      collaborateApi
        .getAll(activeRoute.id)
        .then(setCollaborators)
        .catch(() => setCollaborators([]));
    }
  }, [activeRoute?.id, setCollaborators]);

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
        } catch {
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
    } catch {
      toast.error('Не удалось обновить имя');
    }
  };

  const handleToggleActive = async (routeId: string) => {
    try {
      const trip = allTrips.find((t) => t.id === routeId);
      if (!trip) return;
      const newIsActive = !trip.isActive;
      setAllTrips(
        allTrips.map((t) => ({ ...t, isActive: t.id === routeId ? newIsActive : false })),
      );
      await tripsApi.update(routeId, { isActive: newIsActive });
      const socket = getSocket();
      if (socket.connected) {
        socket.emit('trip:update', { trip_id: routeId, isActive: newIsActive });
      }

      if (newIsActive) {
        Promise.all([tripsApi.getOne(routeId), pointsApi.getAll(routeId)])
          .then(([updatedTrip, updatedPoints]) => {
            if (updatedTrip && updatedPoints) {
              setAllTrips((prev) =>
                prev.map((t) =>
                  t.id === routeId ? { ...updatedTrip, points: updatedPoints, isActive: true } : t,
                ),
              );
              const storeState = useTripStore.getState();
              if (storeState.currentTrip?.id === routeId) {
                storeState.updateCurrentTrip(updatedTrip);
                if (updatedPoints) {
                  storeState.setPoints(updatedPoints, false);
                }
              }
            }
          })
          .catch(console.error);
      }

      toast.success(newIsActive ? 'Маршрут активирован' : 'Маршрут деактивирован', {
        id: 'route-activation',
      });
    } catch {
      toast.error('Ошибка при обновлении статуса', { id: 'route-activation-error' });
    }
  };

  // Open edit conflict modal for switching to a different route in planner
  const handleEditRoute = (trip: Trip) => {
    setPendingPlannerTripId(trip.id);
    setShowPlannerConflictModal(true);
  };

  const handleConfirmPlannerReplace = () => {
    const targetTripId = pendingPlannerTripId;
    setShowPlannerConflictModal(false);
    setPendingPlannerTripId(null);
    if (!targetTripId) {
      router.push('/planner');
      return;
    }
    router.push(`/planner?applyTripId=${encodeURIComponent(targetTripId)}`);
  };

  const handleDatesUpdate = async (
    tripId: string,
    dates: { startDate: string; endDate: string },
  ) => {
    try {
      await tripsApi.update(tripId, dates);
      const prevTrip = allTrips.find((t) => t.id === tripId);
      const prevTab = getTripTab(prevTrip ?? null);
      const prevOrder = getTripIdsByTab(allTrips, prevTab);
      const prevIndex = prevOrder.indexOf(tripId);

      const nextTrips = allTrips.map((t) => (t.id === tripId ? { ...t, ...dates } : t));
      setAllTrips(nextTrips);

      const nextTrip = nextTrips.find((t) => t.id === tripId);
      const nextTab = getTripTab(nextTrip ?? null);
      const nextOrder = getTripIdsByTab(nextTrips, nextTab);
      const nextIndex = nextOrder.indexOf(tripId);

      const hasTabChanged = prevTab !== nextTab;
      const hasPositionChanged = prevIndex !== -1 && nextIndex !== -1 && prevIndex !== nextIndex;

      if (hasTabChanged || hasPositionChanged) {
        showTripMovedToast(tripId, nextTab);
        return;
      }

      toast.success('Даты сохранены');
    } catch {
      toast.error('Не удалось сохранить даты');
    }
  };

  // Open create conflict modal when creating a new trip with unsaved changes
  const handleCreateTrip = () => {
    if (currentTrip && isDirty) {
      setConflictModalOpen(true);
    } else {
      clearPlanner();
      router.push('/planner');
    }
  };

  const handleConflictSaveAndReplace = async () => {
    try {
      if (currentTrip) {
        await tripsApi.update(currentTrip.id, {
          title: currentTrip.title,
          description: currentTrip.description ?? undefined,
          budget: currentTrip.budget ?? undefined,
          startDate: currentTrip.startDate ?? undefined,
          endDate: currentTrip.endDate ?? undefined,
          isActive: currentTrip.isActive,
          distanceKm: currentTrip.distanceKm ?? 0,
        });
      }
      clearPlanner();
      setConflictModalOpen(false);
      router.push('/planner');
    } catch (err) {
      console.error('Failed to save trip:', err);
      toast.error('Не удалось сохранить маршрут');
    }
  };

  const handleConflictGoToPlannerOnly = () => {
    setConflictModalOpen(false);
    router.push('/planner');
  };

  const handleConflictReplaceWithoutSave = () => {
    clearPlanner();
    setConflictModalOpen(false);
    router.push('/planner');
  };

  return (
    <div className="w-full bg-[#f0f4f8] pb-16">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        className="hidden"
      />

      {/* ── ШАПКА ПРОФИЛЯ ── */}
      <div className="w-full shrink-0 bg-white border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            onClick={handleAvatarClick}
            className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center
                       border-4 border-white shadow-lg overflow-hidden cursor-pointer group relative shrink-0"
          >
            {user?.photo ? (
              <img src={user.photo} className="w-full h-full object-cover" alt={user.name} />
            ) : user?.name ? (
              <span className="text-lg font-bold text-slate-400 uppercase">
                {user.name.substring(0, 2)}
              </span>
            ) : (
              <UserIcon size={36} className="text-slate-300" />
            )}
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-full">
              <Pencil size={20} className="text-white" />
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              {isEditingName ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={tempName}
                    onChange={(e) => setTempName(e.target.value)}
                    onBlur={handleSaveName}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                    className="text-xl font-black text-brand-indigo border-b-2 border-brand-sky
                               outline-none bg-transparent w-full"
                  />
                  <button
                    onClick={handleSaveName}
                    className="p-1.5 hover:scale-110 active:scale-90 transition-all"
                    aria-label="Сохранить имя"
                  >
                    <span className="text-lg leading-none">💾</span>
                  </button>
                </div>
              ) : (
                <>
                  <h2 className="text-xl font-black text-brand-indigo leading-tight truncate">
                    {user?.name}
                  </h2>
                  <button
                    onClick={() => {
                      setTempName(user?.name || '');
                      setIsEditingName(true);
                    }}
                    className="p-1 hover:scale-110 active:scale-90 transition-all opacity-40 hover:opacity-100 shrink-0"
                    aria-label="Редактировать имя"
                  >
                    <Pencil size={14} className="text-slate-500" />
                  </button>
                </>
              )}
            </div>

            <p className="text-[13px] text-slate-400 font-medium truncate">
              {user?.email ?? '—'}
            </p>
            <p className="text-[13px] text-slate-400 font-medium">
              Путешественник с {user?.createdAt ? new Date(user.createdAt).getFullYear() : '2026'}{' '}
              года
            </p>
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-2.5 sm:p-3.5">
              <div className="flex items-center gap-1.5 text-slate-500">
                <MapPin size={12} className="sm:w-3.5 sm:h-3.5" />
                <p className="text-[10px] sm:text-xs font-semibold leading-none">Точки</p>
              </div>
              <p className="text-lg sm:text-2xl font-black text-brand-indigo leading-none mt-2">
                {formatStatValue(statsPointsCount)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-2.5 sm:p-3.5">
              <div className="flex items-center gap-1.5 text-slate-500">
                <Route size={12} className="sm:w-3.5 sm:h-3.5" />
                <p className="text-[10px] sm:text-xs font-semibold leading-none">Поездки</p>
              </div>
              <p className="text-lg sm:text-2xl font-black text-brand-indigo leading-none mt-2">
                {formatStatValue(statsTripsCount)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-2.5 sm:p-3.5">
              <div className="flex items-center gap-1.5 text-slate-500">
                <Ruler size={12} className="sm:w-3.5 sm:h-3.5" />
                <p className="text-[10px] sm:text-xs font-semibold leading-none">Километры</p>
              </div>
              <p className="text-lg sm:text-2xl font-black text-brand-indigo leading-none mt-2">
                {formatStatValue(statsDistanceKm)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── ТАБЫ ── */}
      <div className="px-4 pt-2.5 pb-0 shrink-0 bg-white border-b border-slate-100">
        <div className="flex gap-4">
          <button
            onClick={() => setActiveTab('routes')}
            className={cn(
              'pb-2 text-[12px] font-bold tracking-wide border-b-2 transition-all',
              activeTab === 'routes'
                ? 'border-brand-sky text-brand-sky'
                : 'border-transparent text-slate-400 hover:text-slate-600',
            )}
          >
            Путешествия
            <span className="ml-1.5 text-[10px] font-black opacity-60">{travelTrips.length}</span>
          </button>
          <button
            onClick={() => setActiveTab('saved')}
            className={cn(
              'pb-2 text-[12px] font-bold tracking-wide border-b-2 transition-all',
              activeTab === 'saved'
                ? 'border-brand-sky text-brand-sky'
                : 'border-transparent text-slate-400 hover:text-slate-600',
            )}
          >
            Сохранено
            <span className="ml-1.5 text-[10px] font-black opacity-60">{savedTrips.length}</span>
          </button>
        </div>
      </div>

      {/* ── КОНТЕНТ ТАБОВ ── */}
      <div className="w-full flex flex-col relative">
        {/* Sub-header: count + create button */}
        <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b border-slate-100 bg-white">
          <span className="text-[13px] font-bold text-slate-500">
            {activeTab === 'routes'
              ? `${travelTrips.length} путешествий`
              : `${savedTrips.length} сохранено`}
          </span>
          <Button
            onClick={handleCreateTrip}
            variant="brand"
            className="h-8 px-4 rounded-xl text-[12px] font-bold"
          >
            + Создать поездку
          </Button>
        </div>

        {/* Cards area */}
        <div className="w-full flex flex-col relative">
          {/* Scroll-to-top button */}
          <div
            className={cn(
              'sticky top-[calc(100vh-5rem)] z-30 h-0 px-4 flex justify-end pointer-events-none',
              'transition-all duration-300',
              showScrollTop
                ? 'opacity-100 translate-y-0 visible'
                : 'opacity-0 translate-y-2 invisible',
            )}
          >
            <button
              type="button"
              onClick={handleScrollToTop}
              className="pointer-events-auto relative h-10 w-10 rounded-full shadow-md transition-transform hover:scale-105 active:scale-95"
            >
              <span
                className="absolute inset-0 rounded-full"
                style={{
                  background: `conic-gradient(${progressColor} ${progressDegrees}deg, ${progressTrackColor} ${progressDegrees}deg)`,
                }}
              />
              <span className="absolute inset-[2px] rounded-full bg-white" />
              <span className="relative z-10 flex h-full w-full items-center justify-center text-brand-indigo">
                <ArrowUp size={14} />
              </span>
            </button>
          </div>

          {activeTab === 'routes' ? (
            isLoadingTrips ? (
              <div className="px-4 space-y-3 pb-4 pt-3 w-full">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="aspect-[4/3] bg-slate-100 animate-pulse rounded-2xl" />
                ))}
              </div>
            ) : travelTrips.length > 0 ? (
              <div
                ref={routePointsScrollRef}
                className="px-4 pb-4 pt-3 w-full"
              >
                {currentTrips.length > 0 && (
                  <>
                    <div className="flex items-center gap-4 my-4">
                      <hr className="flex-1 border-gray-200" />
                      <span className="text-xs font-semibold text-gray-400 tracking-wider uppercase">В процессе</span>
                      <hr className="flex-1 border-gray-200" />
                    </div>
                    <div className="space-y-3">
                      {currentTrips.map((trip) => (
                        <TripCard
                          key={trip.id}
                          trip={trip}
                          isSelected={selectedTripId === trip.id}
                          onCardClick={setSelectedTripId}
                          highlighted={highlightedTripId === trip.id}
                          cardRef={(node) => registerTripCardRef(trip.id, node)}
                          onDatesUpdate={handleDatesUpdate}
                          onInvite={() => { setInviteTripId(trip.id); setInviteModalOpen(true); }}
                          onCollaboratorsClick={() => { setCollaboratorsTripId(trip.id); setCollaboratorsModalOpen(true); }}
                        />
                      ))}
                    </div>
                  </>
                )}

                {upcomingTrips.length > 0 && (
                  <>
                    <div className="flex items-center gap-4 my-4">
                      <hr className="flex-1 border-gray-200" />
                      <span className="text-xs font-semibold text-gray-400 tracking-wider uppercase">Скоро</span>
                      <hr className="flex-1 border-gray-200" />
                    </div>
                    <div className="space-y-3">
                      {upcomingTrips.map((trip) => (
                        <TripCard
                          key={trip.id}
                          trip={trip}
                          isSelected={selectedTripId === trip.id}
                          onCardClick={setSelectedTripId}
                          highlighted={highlightedTripId === trip.id}
                          cardRef={(node) => registerTripCardRef(trip.id, node)}
                          onDatesUpdate={handleDatesUpdate}
                          onInvite={() => { setInviteTripId(trip.id); setInviteModalOpen(true); }}
                          onCollaboratorsClick={() => { setCollaboratorsTripId(trip.id); setCollaboratorsModalOpen(true); }}
                        />
                      ))}
                    </div>
                  </>
                )}

                {pastTrips.length > 0 && (
                  <>
                    <div className="flex items-center gap-4 my-4">
                      <hr className="flex-1 border-gray-200" />
                      <span className="text-xs font-semibold text-gray-400 tracking-wider uppercase">Завершенные</span>
                      <hr className="flex-1 border-gray-200" />
                    </div>
                    <div className="space-y-3">
                      {pastTrips.map((trip) => (
                        <TripCard
                          key={trip.id}
                          trip={trip}
                          isSelected={selectedTripId === trip.id}
                          onCardClick={setSelectedTripId}
                          highlighted={highlightedTripId === trip.id}
                          cardRef={(node) => registerTripCardRef(trip.id, node)}
                          onDatesUpdate={handleDatesUpdate}
                          onInvite={() => { setInviteTripId(trip.id); setInviteModalOpen(true); }}
                          onCollaboratorsClick={() => { setCollaboratorsTripId(trip.id); setCollaboratorsModalOpen(true); }}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-slate-300 text-center px-4 py-10 flex-1">
                <MapIcon size={40} className="mb-3 opacity-20" />
                <p className="text-sm font-semibold text-slate-400">Путешествий пока нет</p>
                <p className="text-xs text-slate-300 mt-1">Создайте первую поездку с датами</p>
              </div>
            )
          ) : isLoadingTrips ? (
            <div className="px-4 space-y-3 pb-4 pt-3 w-full">
              {[1, 2, 3].map((i) => (
                <div key={i} className="aspect-[4/3] bg-slate-100 animate-pulse rounded-2xl" />
              ))}
            </div>
          ) : savedTrips.length > 0 ? (
            <div
              ref={savedListScrollRef}
              className="px-4 space-y-3 pb-4 pt-3 w-full"
            >
              {savedTrips.map((trip) => (
                <TripCard
                  key={trip.id}
                  trip={trip}
                  isSelected={selectedTripId === trip.id}
                  onCardClick={setSelectedTripId}
                          highlighted={highlightedTripId === trip.id}
                          cardRef={(node) => registerTripCardRef(trip.id, node)}
                  onDatesUpdate={handleDatesUpdate}
                  onInvite={() => {
                    setInviteTripId(trip.id);
                    setInviteModalOpen(true);
                  }}
                  onCollaboratorsClick={() => {
                    setCollaboratorsTripId(trip.id);
                    setCollaboratorsModalOpen(true);
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-slate-300 text-center px-4 py-10 flex-1">
              <MapIcon size={40} className="mb-3 opacity-20" />
              <p className="text-sm font-semibold text-slate-400">Список пуст</p>
            </div>
          )}
        </div>
      </div>

      {inviteTripId && (
        <InviteModal
          tripId={inviteTripId}
          open={inviteModalOpen}
          onClose={() => {
            setInviteModalOpen(false);
            setInviteTripId(null);
          }}
        />
      )}
      {collaboratorsTripId && (
        <CollaboratorsModal
          tripId={collaboratorsTripId}
          ownerId={allTrips.find((t) => t.id === collaboratorsTripId)?.ownerId || ''}
          open={collaboratorsModalOpen}
          onClose={() => {
            setCollaboratorsModalOpen(false);
            setCollaboratorsTripId(null);
          }}
        />
      )}

      {/* Conflict modal: switching to a different trip in planner */}
      <PlannerConflictModal
        open={showPlannerConflictModal}
        onOpenChange={setShowPlannerConflictModal}
        conflictType="different_route"
        currentRouteTitle={currentTrip?.title?.trim() || 'без названия'}
        onCancel={() => {
          setShowPlannerConflictModal(false);
          setPendingPlannerTripId(null);
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
          setShowPlannerConflictModal(false);
          setPendingPlannerTripId(null);
          router.push('/planner');
        }}
      />

      {/* Conflict modal: creating a new trip with unsaved changes */}
      <PlannerConflictModal
        open={conflictModalOpen}
        onOpenChange={setConflictModalOpen}
        conflictType="landing_new"
        currentRouteTitle={currentTrip?.title || 'без названия'}
        onCancel={() => setConflictModalOpen(false)}
        onReplaceWithoutSave={handleConflictReplaceWithoutSave}
        onSaveAndReplace={handleConflictSaveAndReplace}
        onGoToPlannerOnly={handleConflictGoToPlannerOnly}
      />
    </div>
  );
}

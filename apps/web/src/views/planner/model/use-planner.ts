'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import React from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { useTripStore, tripsApi, type CreateTripPayload, type Trip } from '@/entities/trip';
import { useUserStore } from '@/entities/user';
import { usePointCrud } from '@/features/route-create';
import { pointsApi } from '@/entities/route-point';
import { useAiQueryStore } from '@/features/ai-query';
import { useAuthStore } from '@/features/auth';
import { env } from '@/shared/config/env';
import type { RoutePoint } from '@/entities/route-point';
import { toast } from 'sonner';
import { setConfig, clearConfig } from '@/features/persistent-map';
import type { PlannerConflictType } from '@/widgets/planner-conflict-modal';
import {
  type GeoSuggestion,
  filterUniqueSuggestions,
  hasTime,
} from '@/shared/lib/route-utils';
import { UUID_RE, computeDateCascade } from '@/views/planner/lib/utils';
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

export function usePlanner() {
  const { geoDenied, setGeoDenied } = useUserStore();
  const router = useRouter();
  const searchParams = useSearchParams();

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
  const profileParam = searchParams.get('profile');
  const { isAuthenticated } = useAuthStore();
  const crud = usePointCrud(currentTrip?.id);

  const { openOrCreateSessionFromTrip } = useAiQueryStore();
  const initialTab = searchParams.get('tab') === 'popular' ? 'popular' : 'my';
  const [activeTab, setActiveTab] = useState<'my' | 'popular'>(initialTab);
  const [searchInput, setSearchInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [suggestions, setSuggestions] = useState<GeoSuggestion[]>([]);
  const [isActiveRoute, setIsActiveRoute] = useState(false);
  const [focusCoords, setFocusCoords] = useState<{ lon: number; lat: number } | null>(null);
  const [showBudgetWarning, setShowBudgetWarning] = useState(true);
  const [editingPointId, setEditingPointId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [modal, setModal] = useState<'login' | 'register' | null>(null);
  const [isAddPointMode, setIsAddPointMode] = useState(false);
  const [isOptimizationExpanded, setIsOptimizationExpanded] = useState(true);
  const [isDailyBudgetsExpanded, setIsDailyBudgetsExpanded] = useState(false);
  const [showPlannerConflictModal, setShowPlannerConflictModal] = useState(false);
  const pointsContainerRef = useRef<HTMLDivElement>(null);
  const pointRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [pendingApplyTripId, setPendingApplyTripId] = useState<string | null>(null);
  const [pendingDraftMessageId, setPendingDraftMessageId] = useState<string | null>(null);
  const [conflictType, setConflictType] = useState<PlannerConflictType>('different_route');

  const [visibleCount, setVisibleCount] = useState(20);
  const [routeInfo, setRouteInfo] = useState<{
    duration: number;
    distance: number;
    legs: { duration: number; distance: number }[];
  } | null>(() => useTripStore.getState().cachedRouteInfo ?? null);
  const [isRouteLoading, setIsRouteLoading] = useState(false);
  const [affectedSegments, setAffectedSegments] = useState<Set<number>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isPending, startTransition] = React.useTransition();
  const [optimisticProfile, setOptimisticProfile] = useState<string | null>(null);
  const [selectedDays, setSelectedDays] = useState<string[]>([]);

  const toggleDayFilter = useCallback((dayKey: string) => {
    setSelectedDays((prev) =>
      prev.includes(dayKey) ? prev.filter((d) => d !== dayKey) : [...prev, dayKey],
    );
  }, []);

  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justMigratedRef = useRef(false);
  const handledApplyTripIdRef = useRef<string | null>(null);
  const userLocationRef = useRef<{ lat: number; lon: number } | null>(null);
  const prevLegsCountRef = useRef(0);
  const prevLegsDurationsRef = useRef<string>('');
  const addPointStartCountRef = useRef(0);
  const mapClickDebounceRef = useRef<number>(0);
  const loadedTripIdsRef = useRef<Set<string>>(new Set());

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
        },
        { timeout: 5000 },
      );
    }
  }, [geoDenied, setGeoDenied]);

  useEffect(() => {
    if (points.length > visibleCount) {
      const timer = setTimeout(() => setVisibleCount((prev) => prev + 20), 100);
      return () => clearTimeout(timer);
    }
  }, [points.length, visibleCount]);

  const handleAddPointModeChange = useCallback((active: boolean) => {
    if (active) {
      addPointStartCountRef.current = useTripStore.getState().currentTrip?.points?.length ?? 0;
    }
    setIsAddPointMode(active);
  }, []);

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

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 0, tolerance: 0 } }),
  );

  const handleProfileChange = useCallback(
    (newMode: 'driving' | 'foot' | 'bike' | 'direct') => {
      setOptimisticProfile(newMode);
      setTimeout(() => {
        const updates = points
          .filter((p) => p.transportMode !== newMode)
          .map((p) => ({ id: p.id, data: { transportMode: newMode } }));

        if (updates.length > 0) {
          startTransition(() => {
            crud.updateMany(updates);
          });
        } else {
          setOptimisticProfile(null);
        }
      }, 0);
    },
    [points, crud],
  );

  const isAlreadyOptimal = useMemo(() => {
    if (!lastOptimizedPoints || points.length !== lastOptimizedPoints.length) return false;
    return points.every((p, i) => {
      const lo = lastOptimizedPoints[i];
      return lo && p.id === lo.id && p.lat === lo.lat && p.lon === lo.lon;
    });
  }, [points, lastOptimizedPoints]);

  const { isMixedRoute, mixedModes } = useMemo(() => {
    if (points.length < 2) return { isMixedRoute: false, mixedModes: [] };
    const modes = points.slice(1).map((p) => p.transportMode || 'driving');
    const first = modes[0];
    const isMixedRoute = modes.some((m) => m !== first);
    return { isMixedRoute, mixedModes: Array.from(new Set(modes)) };
  }, [points]);

  const routeProfile = useMemo(() => {
    if (optimisticProfile) return optimisticProfile as any;
    if (points.length < 2) return (profileParam as any) || 'driving';
    if (isMixedRoute) return 'driving';
    return points[1]?.transportMode || 'driving';
  }, [points, isMixedRoute, profileParam, optimisticProfile]);

  useEffect(() => {
    if (!optimisticProfile) return;
    const allMatch =
      points.length < 2 ||
      points.slice(1).every((p) => (p.transportMode || 'driving') === optimisticProfile);
    if (allMatch) setOptimisticProfile(null);
  }, [points, optimisticProfile]);

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

  const handlePointClick = useCallback(
    (pointId: string) => {
      const idx = points.findIndex((p) => p.id === pointId);
      if (idx !== -1 && idx >= visibleCount) {
        setVisibleCount(idx + 1);
      }

      setTimeout(() => {
        const wrapper = pointRefs.current[pointId];
        if (wrapper) {
          wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const rowWrapper =
            wrapper.querySelector<HTMLElement>(`[data-point-id="${pointId}"]`) || wrapper;
          const el = (rowWrapper.firstElementChild as HTMLElement) || rowWrapper;
          el.classList.add(
            'ring-2',
            'ring-brand-sky',
            'ring-offset-4',
            'shadow-xl',
            'shadow-brand-sky/30',
            'duration-500',
            'z-10',
            'rounded-2xl',
          );
          setTimeout(() => {
            el.classList.remove(
              'ring-2',
              'ring-brand-sky',
              'ring-offset-4',
              'shadow-xl',
              'shadow-brand-sky/30',
              'z-10',
              'rounded-2xl',
            );
          }, 2000);
        }
      }, 100);
    },
    [points, visibleCount],
  );

  const handlePointUpdate = useCallback(
    async (id: string, patch: Parameters<typeof crud.update>[1]) => {
      const fullPatch = { ...patch };
      if ('title' in patch && patch.title) {
        (fullPatch as any).isTitleCustom = true;
      }
      await crud.update(id, fullPatch);
      if (('visitDate' in patch || 'duration' in patch) && routeInfo?.legs) {
        const fromIndex = points.findIndex((p) => p.id === id);
        if (fromIndex >= 0) {
          const cascadeUpdates = computeDateCascade(points, routeInfo.legs, fromIndex, fullPatch);
          if (cascadeUpdates.length > 0) {
            await crud.updateMany(
              cascadeUpdates.map((u) => ({ id: u.id, data: { visitDate: u.visitDate } })),
            );
          }
        }
      }
    },
    [crud, routeInfo, points],
  );

  useEffect(() => {
    const legs = routeInfo?.legs;
    const legsCount = legs?.length ?? 0;
    const legsDurationsKey = legs ? legs.map((l) => l.duration).join(',') : '';

    const legsCountChanged = legsCount > prevLegsCountRef.current;
    const legsDurationsChanged = legsDurationsKey !== prevLegsDurationsRef.current;

    if (!routeInfo) {
      prevLegsCountRef.current = 0;
      prevLegsDurationsRef.current = '';
      return;
    }

    if ((legsCountChanged || legsDurationsChanged) && legs && points.length > 1) {
      prevLegsCountRef.current = legsCount;
      prevLegsDurationsRef.current = legsDurationsKey;
      const firstDatedIdx = points.findIndex((p) => p.visitDate);
      if (firstDatedIdx >= 0) {
        const cascadeUpdates = computeDateCascade(points, legs, firstDatedIdx);
        if (cascadeUpdates.length > 0) {
          crud.updateMany(
            cascadeUpdates.map((u) => ({ id: u.id, data: { visitDate: u.visitDate } })),
          );
        }
      }
    } else {
      prevLegsCountRef.current = legsCount;
      prevLegsDurationsRef.current = legsDurationsKey;
    }
  }, [routeInfo, points, crud]);

  useEffect(() => {
    useTripStore.getState().setCachedRouteInfo(null);
  }, []);

  useEffect(() => {
    if (!currentTrip?.id || currentTrip.id.startsWith('guest-')) return;
    if (justMigratedRef.current) {
      justMigratedRef.current = false;
      return;
    }
    if (loadedTripIdsRef.current.has(currentTrip.id)) return;
    loadedTripIdsRef.current.add(currentTrip.id);

    pointsApi
      .getAll(currentTrip.id)
      .then((pts) => setPoints(pts, false))
      .catch((e) => {
        console.error('Failed to load points:', e);
        const message = e instanceof Error ? e.message : '';
        if (message.includes('Access denied') || message.includes('403')) {
          setCurrentTrip(null as unknown as Trip);
          loadedTripIdsRef.current.clear();
          return;
        }
        setPoints([], false);
      });
  }, [currentTrip?.id, setPoints]);

  useEffect(() => {
    if (!_hasHydrated) return;
    if (currentTrip) return;

    const incomingTripId = searchParams.get('applyTripId');
    if (incomingTripId) return;

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
  }, [currentTrip, setCurrentTrip, _hasHydrated, searchParams]);

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

      const oldSegmentModes = new Map<string, string>();
      points.slice(1).forEach((point, i) => {
        const fromId = points[i]!.id;
        const toId = point.id;
        const mode = point.transportMode || 'driving';
        oldSegmentModes.set(`${fromId}→${toId}`, mode);
      });

      const updatedOrder = newOrder.map((point, i) => {
        if (i === 0) return point;
        const fromId = newOrder[i - 1]!.id;
        const toId = point.id;
        const segmentKeyForward = `${fromId}→${toId}`;
        const segmentKeyReverse = `${toId}→${fromId}`;
        let mode = oldSegmentModes.get(segmentKeyForward);
        if (!mode) mode = oldSegmentModes.get(segmentKeyReverse);
        if (!mode) mode = 'driving';
        return { ...point, transportMode: mode as 'driving' | 'foot' | 'bike' | 'direct' };
      });

      const affectedIndices = new Set<number>();
      if (oldIndex > 0) affectedIndices.add(oldIndex - 1);
      if (oldIndex < newOrder.length - 1) affectedIndices.add(oldIndex);
      if (newIndex > 0) affectedIndices.add(newIndex - 1);
      if (newIndex < newOrder.length - 1) affectedIndices.add(newIndex);

      const pointsToUpdate: Array<{
        id: string;
        transportMode: 'driving' | 'foot' | 'bike' | 'direct';
      }> = [];
      updatedOrder.forEach((p, i) => {
        if (i > 0 && affectedIndices.has(i - 1)) {
          const tm = (p.transportMode as 'driving' | 'foot' | 'bike' | 'direct') || 'driving';
          pointsToUpdate.push({ id: p.id, transportMode: tm });
        }
      });

      crud.reorder(updatedOrder.map((p) => p.id));
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
            duration: p.duration ?? 0,
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

  const routeDistanceKm = useMemo(() => {
    if (!routeInfo?.distance || routeInfo.distance <= 0) return 0;
    return Number((routeInfo.distance / 1000).toFixed(1));
  }, [routeInfo]);

  const dailyBudgets = useMemo(() => {
    const map = new Map<string, number>();
    points.forEach((p) => {
      const d = p.visitDate ? format(new Date(p.visitDate), 'yyyy-MM-dd') : 'no-date';
      map.set(d, (map.get(d) ?? 0) + (p.budget ?? 0));
    });
    return Array.from(map.entries());
  }, [points]);

  const plannedBudget = currentTrip?.budget ?? 0;
  const budgetOverrun = Math.max(0, totalBudget - plannedBudget);
  const isBudgetExceeded = plannedBudget > 0 && budgetOverrun > 0;

  useEffect(() => {
    if (isBudgetExceeded) setShowBudgetWarning(true);
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
      let visitDate: string | undefined = undefined;
      const lastPoint = points[points.length - 1];

      if (lastPoint?.visitDate && hasTime(lastPoint.visitDate) && routeInfo?.legs) {
        const stayDurationMs = (lastPoint.duration ?? 0) * 60 * 1000;
        const lastLeg = routeInfo.legs[routeInfo.legs.length - 1];
        const travelDurationMs = (lastLeg?.duration ?? 0) * 1000;
        const nextMs = new Date(lastPoint.visitDate).getTime() + stayDurationMs + travelDurationMs;
        visitDate = new Date(nextMs).toISOString();
      } else if (lastPoint?.visitDate) {
        visitDate = lastPoint.visitDate;
      }

      await crud.add({
        ...payload,
        budget: 0,
        visitDate,
        transportMode: routeProfile as any,
      });
    },
    [crud, points, routeInfo, routeProfile],
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
                duration: p.duration ?? 0,
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
          distanceKm: routeDistanceKm,
          isActive: isActiveRoute,
        });
        updateCurrentTrip({
          title: autoTitle,
          budget: currentTrip?.budget || null,
          distanceKm: routeDistanceKm,
          isActive: isActiveRoute,
        });
        import('@/shared/socket/socket-client').then(({ getSocket }) => {
          getSocket().emit('trip:update', {
            trip_id: tripId,
            title: autoTitle,
            budget: currentTrip?.budget || null,
            distanceKm: routeDistanceKm,
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

  const handleEditWithAi = async () => {
    if (!isAuthenticated) {
      setModal('register');
      return;
    }
    try {
      const tripId = await ensureTripId();

      const pointsByDay = points.reduce<Record<string, RoutePoint[]>>((acc, p) => {
        const dayStr = p.visitDate ? format(new Date(p.visitDate), 'dd.MM.yyyy') : 'Без даты';
        if (!acc[dayStr]) acc[dayStr] = [];
        acc[dayStr].push(p);
        return acc;
      }, {});

      const pointsContext = Object.entries(pointsByDay)
        .map(([day, dayPoints]) => {
          const dayLines = dayPoints.map((p) => {
            const timeStr =
              p.visitDate && p.visitDate.includes('T')
                ? ` (Время: ${format(new Date(p.visitDate), 'HH:mm')})`
                : '';
            return `- ${p.title}${p.budget ? ` — ${p.budget} ₽` : ''}${timeStr} [${p.lat}, ${p.lon}]`;
          });
          return `**День: ${day}**\n${dayLines.join('\n')}`;
        })
        .join('\n\n');

      const routeTitle = currentTrip?.title || 'Мой маршрут';
      const query = `Маршрут: ${routeTitle}\n\nСейчас список мест разбит по дням и выглядит так:\n\n${pointsContext}\n\nЯ обновил маршрут. Спроси у меня, нужна ли мне помощь с анализом, оптимизацией или изменением мест. Не делай подробный анализ сразу, просто предложи варианты помощи.`;

      const sessionId = await openOrCreateSessionFromTrip(tripId);

      if (sessionId) {
        sessionStorage.setItem(
          'ai:pending-handoff',
          JSON.stringify({ query, targetSessionId: sessionId }),
        );
      } else {
        sessionStorage.setItem('ai:pending-query', query);
      }

      router.push('/ai-assistant');
    } catch (error) {
      console.error('Ошибка при переходе в AI:', error);
      toast.error('Не удалось синхронизировать маршрут с чатом');
    }
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
    } catch (e) {
      console.error('Не удалось добавить точку:', e);
    } finally {
      setIsSearching(false);
    }
  };

  const handleMapClick = useCallback(
    async (coords: { lon: number; lat: number }) => {
      const now = Date.now();
      if (now - mapClickDebounceRef.current < 500) return;
      mapClickDebounceRef.current = now;

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

        const startCount = addPointStartCountRef.current;
        const needed = startCount === 0 ? 2 : 1;
        const newCount = useTripStore.getState().currentTrip?.points?.length ?? 0;
        if (newCount >= startCount + needed) {
          setIsAddPointMode(false);
        }
      } catch (e) {
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
      points: points,
      selectedDays,
      focusCoords,
      draggable: true,
      readonly: false,
      routeProfile,
      fitKey: `planner-${currentTrip?.id || 'empty'}-${selectedDays.length > 0 ? selectedDays.sort().join(',') : 'all'}`,
      isDropdownOpen: showDropdown,
      isAddPointMode,
      onPointDragEnd: handlePointDragEnd,
      onMapClick: handleMapClick,
      onAddPointModeChange: handleAddPointModeChange,
      onRouteInfoUpdate: setRouteInfo,
      onRouteInfoLoading: setIsRouteLoading,
      onAffectedSegmentsChange: setAffectedSegments,
      onPointClick: handlePointClick,
    });
  }, [
    currentTrip?.id,
    points,
    focusCoords,
    routeProfile,
    showDropdown,
    isAddPointMode,
    handlePointDragEnd,
    handleMapClick,
    handleAddPointModeChange,
    selectedDays,
    handlePointClick,
  ]);

  useEffect(() => {
    return () => {
      clearConfig('planner-page');
    };
  }, []);

  const handleUpdatePlannedBudget = async (val: number) => {
    const newBudget = Math.max(0, val);
    updateCurrentTrip({ budget: newBudget });
    if (currentTrip && !currentTrip.id.startsWith('guest-')) {
      await tripsApi.update(currentTrip.id, { budget: newBudget });
      import('@/shared/socket/socket-client').then(({ getSocket }) => {
        getSocket().emit('trip:update', { trip_id: currentTrip.id, budget: newBudget });
      });
    }
  };

  const clearApplyTripParams = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('applyTripId');
    params.delete('draftMessageId');
    params.delete('from');
    const nextQuery = params.toString();
    router.replace(nextQuery ? `/planner?${nextQuery}` : '/planner');
  }, [router, searchParams]);

  const finalizeApplyFlow = useCallback(
    (clearQuery = true) => {
      setShowPlannerConflictModal(false);
      setPendingApplyTripId(null);
      setPendingDraftMessageId(null);
      if (clearQuery) clearApplyTripParams();
    },
    [clearApplyTripParams],
  );

  const applyIncomingTrip = useCallback(
    async (tripId: string) => {
      let target: Trip;
      try {
        target = await tripsApi.getOne(tripId);
      } catch (e) {
        console.error('Failed to fetch trip for apply:', e);
        return;
      }

      const targetPoints = await pointsApi.getAll(tripId);
      setCurrentTrip({ ...target, points: targetPoints });
      setSaved();

      const params = new URLSearchParams(searchParams.toString());
      const draftId = params.get('draftMessageId');
      const source = params.get('from');
      const autosavedRouteTitle = params.get('autosavedRouteTitle');
      const isProfileCardAutosaveFlow = source === 'profile-card-autosave';
      params.delete('applyTripId');
      params.delete('draftMessageId');
      params.delete('from');
      params.delete('autosavedRouteTitle');
      const nextQuery = params.toString();
      router.replace(nextQuery ? `/planner?${nextQuery}` : '/planner');

      if (isProfileCardAutosaveFlow && autosavedRouteTitle) {
        toast.success(`Маршрут «${autosavedRouteTitle}» сохранен`, {
          id: 'profile-planner-autosave',
        });
      } else if (!isProfileCardAutosaveFlow) {
        toast.success(draftId ? 'Маршрут из AI чата открыт' : 'Маршрут открыт в конструкторе', {
          id: 'planner-apply-success',
        });
      }
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
  }, [pendingApplyTripId, applyIncomingTrip, clearApplyTripParams, finalizeApplyFlow]);

  useEffect(() => {
    if (!_hasHydrated) return;

    const incomingTripId = searchParams.get('applyTripId');
    const draftMessageId = searchParams.get('draftMessageId');
    const source = searchParams.get('from');
    const isProfileCardAutosaveFlow = source === 'profile-card-autosave';

    if (!incomingTripId || incomingTripId.startsWith('guest-')) {
      handledApplyTripIdRef.current = null;
      return;
    }

    const currentKey = `${incomingTripId}-${draftMessageId || 'nodraft'}`;
    if (handledApplyTripIdRef.current === currentKey) return;

    const isDifferentRoute = currentTrip?.id !== incomingTripId;
    const hasIncomingDraftVersion = Boolean(draftMessageId);
    const hasPoints = (currentTrip?.points?.length ?? 0) > 0;
    const hasRealContentToLose = hasPoints || isDirty;

    if (isProfileCardAutosaveFlow || !hasRealContentToLose || !isDifferentRoute) {
      handledApplyTripIdRef.current = currentKey;
      void applyIncomingTrip(incomingTripId);
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
    currentTrip?.id,
    currentTrip?.points,
    isDirty,
  ]);

  const handleOptimize = async () => {
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

          import('@/shared/socket/socket-client').then(({ getSocket }) => {
            getSocket().emit('point:reorder', {
              trip_id: tripId,
              pointIds: result.optimizedPoints.map((p: RoutePoint) => p.id),
            });
          });

          setOptimizationResults({ status: 'success', metrics: result.metrics || null });
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
  };

  const handleSave = async () => {
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
              duration: p.duration ?? 0,
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
        distanceKm: routeDistanceKm,
        isActive: isActiveRoute,
      });
      updateCurrentTrip(updated);
      import('@/shared/socket/socket-client').then(({ getSocket }) => {
        getSocket().emit('trip:update', { trip_id: tripId, ...updated });
      });
      setSaved();
      toast.success('Маршрут сохранён');
    } catch {
      toast.error('Не удалось сохранить');
    }
  };

  return {
    // state
    activeTab,
    setActiveTab,
    searchInput,
    isSearching,
    showDropdown,
    setShowDropdown,
    suggestions,
    isActiveRoute,
    focusCoords,
    setFocusCoords,
    showBudgetWarning,
    setShowBudgetWarning,
    editingPointId,
    setEditingPointId,
    editingTitle,
    setEditingTitle,
    showClearConfirm,
    setShowClearConfirm,
    modal,
    setModal,
    isAddPointMode,
    isOptimizationExpanded,
    setIsOptimizationExpanded,
    isDailyBudgetsExpanded,
    setIsDailyBudgetsExpanded,
    showPlannerConflictModal,
    setShowPlannerConflictModal,
    pendingApplyTripId,
    pendingDraftMessageId,
    conflictType,
    visibleCount,
    routeInfo,
    isRouteLoading,
    affectedSegments,
    activeId,
    isOptimizing,
    optimisticProfile,
    selectedDays,
    // refs
    searchContainerRef,
    pointRefs,
    pointsContainerRef,
    userLocationRef,
    // data
    points,
    currentTrip,
    _hasHydrated,
    isDirty,
    optimizationResults,
    previousPoints,
    lastOptimizedProfile,
    // computed
    isAlreadyOptimal,
    isMixedRoute,
    mixedModes,
    routeProfile,
    totalBudget,
    dailyBudgets,
    plannedBudget,
    budgetOverrun,
    isBudgetExceeded,
    isAuthenticated,
    sensors,
    crud,
    // handlers
    toggleDayFilter,
    handleAddPointModeChange,
    handleProfileChange,
    handlePointClick,
    handlePointUpdate,
    handleDragStart,
    handleDragCancel,
    handleDragEnd,
    handlePointDragEnd,
    ensureTripId,
    geocode,
    handleSearchChange,
    handleAddByQuery,
    handleConfirmClear,
    handleEditWithAi,
    handleSelectSuggestion,
    handleMapClick,
    handleUpdatePlannedBudget,
    clearApplyTripParams,
    finalizeApplyFlow,
    applyIncomingTrip,
    handleConfirmPlannerReplace,
    handleOptimize,
    handleSave,
    // store actions
    setPreviousPoints,
    setOptimizationResults,
    setLastOptimizedPoints,
    setLastOptimizedProfile,
  };
}

export type PlannerState = ReturnType<typeof usePlanner>;

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Trip } from './trip.types';
import type { RoutePoint } from '@/entities/route-point/model/route-point.types';

export type RouteInfoCache = {
  duration: number;
  distance: number;
  legs: { duration: number; distance: number }[];
};

interface TripStore {
  _hasHydrated: boolean;
  setHasHydrated: (state: boolean) => void;
  isDirty: boolean;
  setSaved: () => void;
  currentTrip: Trip | null;
  trips: Trip[];
  cachedRouteInfo: RouteInfoCache | null;
  setCachedRouteInfo: (info: RouteInfoCache | null) => void;
  setCurrentTrip: (t: Trip) => void;
  setTrips: (ts: Trip[]) => void;
  addTrip: (t: Trip) => void;
  updateCurrentTrip: (data: Partial<Trip>) => void;
  // Helpers for nested points management
  setPoints: (ps: RoutePoint[], isDirty?: boolean) => void;
  addPoint: (p: RoutePoint) => void;
  updatePoint: (id: string, data: Partial<RoutePoint>) => void;
  updatePoints: (updates: Array<{ id: string; data: Partial<RoutePoint> }>) => void;
  removePoint: (id: string) => void;
  reorderPoints: (orderedIds: string[]) => void;
  clearPlanner: () => void;
  optimizationResults: {
    status: 'idle' | 'success' | 'optimal';
    metrics: {
      originalKm: number;
      newKm: number;
      originalHours: number;
      newHours: number;
      originalRub: number;
      newRub: number;
      isFuel?: boolean;
    } | null;
  };
  setOptimizationResults: (results: TripStore['optimizationResults']) => void;
  previousPoints: RoutePoint[] | null;
  setPreviousPoints: (points: RoutePoint[] | null) => void;
  lastOptimizedPoints: RoutePoint[] | null;
  setLastOptimizedPoints: (points: RoutePoint[] | null) => void;
  lastOptimizedProfile: string | null;
  setLastOptimizedProfile: (profile: string | null) => void;
}

export const useTripStore = create<TripStore>()(
  persist(
    (set) => ({
      _hasHydrated: false,
      setHasHydrated: (state) => set({ _hasHydrated: state }),
      isDirty: false,
      setSaved: () => set({ isDirty: false }),
      currentTrip: null,
      trips: [],
      cachedRouteInfo: null,
      setCachedRouteInfo: (cachedRouteInfo) => set({ cachedRouteInfo }),
      setCurrentTrip: (currentTrip) => set({ currentTrip, isDirty: false }),
      setTrips: (trips) => set({ trips }),
      addTrip: (t) => set((s) => ({ trips: [t, ...s.trips] })),
      updateCurrentTrip: (data) =>
        set((s) => {
          if (!s.currentTrip) return s;
          const hasChanges = Object.keys(data).some(
            (key) => (s.currentTrip as any)[key] !== (data as any)[key],
          );
          if (!hasChanges) return s;
          return { currentTrip: { ...s.currentTrip, ...data }, isDirty: true };
        }),
      setPoints: (points, isDirty = true) =>
        set((s) => {
          if (!s.currentTrip) return s;
          return { currentTrip: { ...s.currentTrip, points }, isDirty };
        }),
      addPoint: (p) =>
        set((s) => {
          if (!s.currentTrip) return s;
          return {
            currentTrip: {
              ...s.currentTrip,
              points: [...s.currentTrip.points, p],
            },
            isDirty: true,
          };
        }),
      updatePoint: (id, data) =>
        set((s) => {
          if (!s.currentTrip) return s;
          return {
            currentTrip: {
              ...s.currentTrip,
              points: s.currentTrip.points.map((p) => (p.id === id ? { ...p, ...data } : p)),
            },
            isDirty: true,
          };
        }),
      updatePoints: (updates) =>
        set((s) => {
          if (!s.currentTrip) return s;
          const updatesMap = new Map(updates.map((u) => [u.id, u.data]));
          const newPoints = s.currentTrip.points.map((p) => {
            const patch = updatesMap.get(p.id);
            return patch ? { ...p, ...patch } : p;
          });
          return {
            currentTrip: { ...s.currentTrip, points: newPoints },
            isDirty: true,
          };
        }),
      removePoint: (id) =>
        set((s) => {
          if (!s.currentTrip) return s;
          return {
            currentTrip: {
              ...s.currentTrip,
              points: s.currentTrip.points.filter((p) => p.id !== id),
            },
            isDirty: true,
          };
        }),
      reorderPoints: (orderedIds) =>
        set((s) => {
          if (!s.currentTrip) return s;
          const currentPoints = s.currentTrip.points || [];
          const newPoints = orderedIds
            .map((id, i) => {
              const p = currentPoints.find((p) => p.id === id);
              return p ? { ...p, order: i } : null;
            })
            .filter(Boolean) as RoutePoint[];

          if (newPoints.length === currentPoints.length) {
            const isSameOrder = newPoints.every((p, i) => p.id === currentPoints[i]?.id);
            if (isSameOrder) return s;
          }

          return {
            currentTrip: { ...s.currentTrip, points: newPoints },
            isDirty: true,
          };
        }),
      clearPlanner: () =>
        set({
          currentTrip: null,
          isDirty: false,
          optimizationResults: { status: 'idle', metrics: null },
          previousPoints: null,
          lastOptimizedPoints: null,
          lastOptimizedProfile: null,
        }),
      optimizationResults: { status: 'idle', metrics: null },
      setOptimizationResults: (optimizationResults) => set({ optimizationResults }),
      previousPoints: null,
      setPreviousPoints: (previousPoints) => set({ previousPoints }),
      lastOptimizedPoints: null,
      setLastOptimizedPoints: (lastOptimizedPoints) => set({ lastOptimizedPoints }),
      lastOptimizedProfile: null,
      setLastOptimizedProfile: (lastOptimizedProfile) => set({ lastOptimizedProfile }),
    }),
    {
      name: 'trip-planner-storage',
      // TRI-104: сохраняем isDirty в localStorage, чтобы Planner после перехода из AI
      // корректно понимал, есть ли несохранённые локальные изменения в открытом маршруте.
      partialize: (state) => ({
        currentTrip: state.currentTrip,
        isDirty: state.isDirty,
        optimizationResults: state.optimizationResults,
        previousPoints: state.previousPoints,
        lastOptimizedPoints: state.lastOptimizedPoints,
        lastOptimizedProfile: state.lastOptimizedProfile,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

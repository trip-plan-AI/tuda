import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Trip } from './trip.types'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'

export type RouteInfoCache = {
  duration: number
  distance: number
  legs: { duration: number; distance: number }[]
}

interface TripStore {
  _hasHydrated: boolean
  setHasHydrated: (state: boolean) => void
  isDirty: boolean
  setSaved: () => void
  currentTrip: Trip | null
  trips: Trip[]
  cachedRouteInfo: RouteInfoCache | null
  setCachedRouteInfo: (info: RouteInfoCache | null) => void
  setCurrentTrip: (t: Trip) => void
  setTrips: (ts: Trip[]) => void
  addTrip: (t: Trip) => void
  updateCurrentTrip: (data: Partial<Trip>) => void
  // Helpers for nested points management
  setPoints: (ps: RoutePoint[]) => void
  addPoint: (p: RoutePoint) => void
  updatePoint: (id: string, data: Partial<RoutePoint>) => void
  removePoint: (id: string) => void
  reorderPoints: (orderedIds: string[]) => void
  clearPlanner: () => void
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
      updateCurrentTrip: (data) => set((s) => {
        if (!s.currentTrip) return s
        return { currentTrip: { ...s.currentTrip, ...data }, isDirty: true }
      }),
      setPoints: (points) => set((s) => {
        if (!s.currentTrip) return s
        return { currentTrip: { ...s.currentTrip, points }, isDirty: false }
      }),
      addPoint: (p) => set((s) => {
        if (!s.currentTrip) return s
        return { 
          currentTrip: { ...s.currentTrip, points: [...s.currentTrip.points, p] },
          isDirty: true 
        }
      }),
      updatePoint: (id, data) => set((s) => {
        if (!s.currentTrip) return s
        return {
          currentTrip: {
            ...s.currentTrip,
            points: s.currentTrip.points.map(p => p.id === id ? { ...p, ...data } : p)
          },
          isDirty: true
        }
      }),
      removePoint: (id) => set((s) => {
        if (!s.currentTrip) return s
        return {
          currentTrip: {
            ...s.currentTrip,
            points: s.currentTrip.points.filter(p => p.id !== id)
          },
          isDirty: true
        }
      }),
      reorderPoints: (orderedIds) => set((s) => {
        if (!s.currentTrip) return s
        const newPoints = orderedIds.map((id, i) => {
          const p = s.currentTrip!.points.find(p => p.id === id)
          return p ? { ...p, order: i } : null
        }).filter(Boolean) as RoutePoint[]
        return { currentTrip: { ...s.currentTrip, points: newPoints }, isDirty: true }
      }),
      clearPlanner: () => set({ currentTrip: null, isDirty: false }),
    }),
    {
      name: 'trip-planner-storage',
      partialize: (state) => ({ currentTrip: state.currentTrip }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true)
      },
    }
  )
)

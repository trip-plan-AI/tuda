import { create } from 'zustand'
import type { Trip } from './trip.types'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'

interface TripStore {
  currentTrip: Trip | null
  trips: Trip[]
  points: RoutePoint[]
  setCurrentTrip: (t: Trip) => void
  setTrips: (ts: Trip[]) => void
  addTrip: (t: Trip) => void
  updateCurrentTrip: (data: Partial<Trip>) => void
  setPoints: (ps: RoutePoint[]) => void
  addPoint: (p: RoutePoint) => void
  updatePoint: (id: string, data: Partial<RoutePoint>) => void
  removePoint: (id: string) => void
  reorderPoints: (orderedIds: string[]) => void
}

export const useTripStore = create<TripStore>((set, get) => ({
  currentTrip: null,
  trips: [],
  points: [],
  setCurrentTrip: (currentTrip) => set({ currentTrip }),
  setTrips: (trips) => set({ trips }),
  addTrip: (t) => set((s) => ({ trips: [t, ...s.trips] })),
  updateCurrentTrip: (data) => set((s) => {
    if (!s.currentTrip) return s
    return { currentTrip: { ...s.currentTrip, ...data } }
  }),
  setPoints: (points) => set({ points }),
  addPoint: (p) => set((s) => ({ points: [...s.points, p] })),
  updatePoint: (id, data) => set((s) => ({
    points: [...s.points.map(p => p.id === id ? { ...p, ...data } : p)],
  })),
  removePoint: (id) => set((s) => ({ points: s.points.filter(p => p.id !== id) })),
  reorderPoints: (orderedIds) => set((s) => ({
    points: orderedIds.map((id, i) => ({ ...s.points.find(p => p.id === id)!, order: i })),
  })),
}))

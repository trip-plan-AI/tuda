// FSD Layer: entities
// Slice: trip
// Trip entity: Zustand store, types, TripCard, TripList components
// Imports allowed: shared

export type { Trip } from './model/trip.types'
export { useTripStore } from './model/trip.store'
export { tripsApi } from './api/trips.api'
export type { CreateTripPayload, UpdateTripPayload } from './api/trips.api'

export interface RoutePoint {
  id: string
  tripId: string
  title: string
  lat: number
  lon: number
  budget: number | null
  visitDate: string | null
  imageUrl: string | null
  address: string | null
  order: number
  transportMode?: 'driving' | 'foot' | 'bike' | 'direct'
  createdAt: string
}

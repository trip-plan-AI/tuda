export interface RoutePoint {
  id: string
  tripId: string
  title: string
  description?: string | null
  lat: number
  lon: number
  budget: number | null
  visitDate: string | null
  imageUrl: string | null
  address: string | null
  order: number
  isTitleCustom?: boolean
  transportMode?: 'driving' | 'foot' | 'bike' | 'direct'
  createdAt: string
}

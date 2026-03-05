import { NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? ''
  if (q.length < 2) return Response.json({ results: [] })

  try {
    // Use free Nominatim (OpenStreetMap) API
    const params = new URLSearchParams({
      q,
      format: 'json',
      limit: '5',
      countrycodes: 'ru', // Ограничиваем поиск только Россией
      language: 'ru',
    })

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      {
        headers: {
          'User-Agent': 'TravelPlanner/1.0 (travel-planner app)', // Required by Nominatim
        },
      }
    )

    const data = await res.json()

    // Transform Nominatim response to our format
    const results = Array.isArray(data)
      ? data.map((item: any) => ({
          displayName: item.display_name,
          uri: `ymapsbm1://geo?ll=${item.lon},${item.lat}&z=12`,
        }))
      : []

    return Response.json({ results })
  } catch (error) {
    console.error('Geocoding error:', error)
    return Response.json({ results: [] }, { status: 500 })
  }
}

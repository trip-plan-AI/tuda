import { NextRequest } from 'next/server'

const YANDEX_API_KEY = process.env.NEXT_PUBLIC_YANDEX_GEOSUGGEST_KEY

interface YandexSuggestion {
  title?: { text: string }
  subtitle?: { text: string }
  geometry?: { point: { lon: number; lat: number } }
}

interface NominatimItem {
  display_name: string
  lon: number
  lat: number
}

async function getYandexSuggestions(q: string): Promise<any[] | null> {
  if (!YANDEX_API_KEY) return null

  try {
    const res = await fetch('https://suggest-maps.yandex.ru/v1/suggest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: q,
        ll: '55.7558,37.6173', // Moscow center as default
        spn: '10,10',
        limit: 10,
        types: ['biz', 'geo'],
        apikey: YANDEX_API_KEY,
      }),
    })

    // Проверяем лимиты
    if (res.status === 429 || res.status === 403) {
      console.warn('Yandex Geosuggest: Rate limit or quota exceeded')
      return null
    }

    if (!res.ok) {
      console.error('Yandex Geosuggest error:', res.status)
      return null
    }

    const data = await res.json()
    const suggestions = data.suggestions || []

    return suggestions
      .map((item: YandexSuggestion) => {
        const title = item.title?.text || ''
        const subtitle = item.subtitle?.text || ''
        const coords = item.geometry?.point

        if (!coords) return null

        return {
          displayName: subtitle ? `${title}, ${subtitle}` : title,
          uri: `ymapsbm1://geo?ll=${coords.lon},${coords.lat}&z=12`,
        }
      })
      .filter(Boolean)
  } catch (error) {
    console.error('Yandex Geosuggest fetch error:', error)
    return null
  }
}

async function getNominatimSuggestions(q: string): Promise<any[]> {
  try {
    const params = new URLSearchParams({
      q,
      format: 'json',
      limit: '10',
      countrycodes: 'ru',
      language: 'ru',
      dedupe: '1',
    })

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      {
        headers: {
          'User-Agent': 'TravelPlanner/1.0 (travel-planner app)',
        },
      }
    )

    if (!res.ok) {
      console.error('Nominatim error:', res.status)
      return []
    }

    const data = await res.json()

    return Array.isArray(data)
      ? data.map((item: NominatimItem) => ({
          displayName: item.display_name,
          uri: `ymapsbm1://geo?ll=${item.lon},${item.lat}&z=12`,
        }))
      : []
  } catch (error) {
    console.error('Nominatim fetch error:', error)
    return []
  }
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? ''
  if (q.length < 2) return Response.json({ results: [] })

  try {
    // Сначала пробуем Яндекс (быстрее и релевантнее)
    let results = await getYandexSuggestions(q)

    // Если Яндекс не сработал, используем Nominatim (бесплатный fallback)
    if (!results || results.length === 0) {
      console.log(`Falling back to Nominatim for query: "${q}"`)
      results = await getNominatimSuggestions(q)
    }

    return Response.json({ results: results || [] })
  } catch (error) {
    console.error('Geocoding error:', error)
    return Response.json({ results: [] }, { status: 500 })
  }
}

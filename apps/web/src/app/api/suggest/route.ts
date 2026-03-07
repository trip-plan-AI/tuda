import { NextRequest } from 'next/server'

const YANDEX_API_KEY = process.env.YANDEX_SUGGEST_KEY
const DADATA_API_KEY = process.env.DADATA_API_KEY
const DADATA_SECRET_KEY = process.env.DADATA_SECRET_KEY

interface UserCoords {
  lat: number
  lon: number
}

interface CachedLocation {
  kladrId: string
  lat: number
  lon: number
  timestamp: number
}

// Simple in-memory cache: IP -> { kladrId, lat, lon, timestamp }
const locationCache = new Map<string, CachedLocation>()

async function getUserCoords(req: NextRequest): Promise<UserCoords | null> {
  try {
    const forwarded = req.headers.get('x-forwarded-for')
    const ip = forwarded?.split(',')[0]?.trim() ?? null

    // Skip for localhost/development
    if (!ip || ip === '::1' || ip.startsWith('127.')) {
      return null
    }

    const res = await fetch(`https://ipapi.co/${ip}/json/`)
    if (!res.ok) return null

    const data = await res.json()
    if (data.latitude && data.longitude) {
      console.log(`📍 User coords from IP ${ip}: lat=${data.latitude}, lon=${data.longitude}`)
      return { lat: data.latitude, lon: data.longitude }
    }
  } catch (error) {
    console.warn('⚠️ Failed to get user coords from IP:', error)
  }
  return null
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371 // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

async function getKladrByCoords(lat: number, lon: number): Promise<string | null> {
  if (!DADATA_API_KEY) return null

  try {
    console.log(`🔍 Reverse geocoding for KLADR: ${lat}, ${lon}`)
    const res = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/geolocate/address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${DADATA_API_KEY}`,
      },
      body: JSON.stringify({ lat, lon }),
    })

    if (!res.ok) {
      console.error('❌ DaData reverse geocoding error, status:', res.status)
      return null
    }

    const data = await res.json()
    const kladrId = data.suggestions?.[0]?.data?.kladr_id
    if (kladrId) {
      console.log(`✅ Found KLADR: ${kladrId}`)
      return kladrId
    }
  } catch (error) {
    console.error('❌ Reverse geocoding error:', error)
  }
  return null
}

async function getCachedKladrByCoords(ip: string, lat: number, lon: number): Promise<string | null> {
  // Check cache
  const cached = locationCache.get(ip)
  const CACHE_VALIDITY_HOURS = 24
  const LOCATION_CHANGE_KM = 50

  if (cached) {
    const ageHours = (Date.now() - cached.timestamp) / (1000 * 60 * 60)
    const distance = haversineKm(cached.lat, cached.lon, lat, lon)

    console.log(`📦 Cache check - age: ${ageHours.toFixed(1)}h, distance from cached: ${distance.toFixed(1)}km`)

    // Use cache if valid and location hasn't changed much
    if (ageHours < CACHE_VALIDITY_HOURS && distance < LOCATION_CHANGE_KM) {
      console.log(`✅ Using cached KLADR: ${cached.kladrId}`)
      return cached.kladrId
    }
    console.log(`⚠️ Cache invalid (age or distance), refreshing...`)
  }

  // Get new KLADR
  const kladrId = await getKladrByCoords(lat, lon)
  if (kladrId) {
    // Update cache
    locationCache.set(ip, {
      kladrId,
      lat,
      lon,
      timestamp: Date.now(),
    })
    console.log(`💾 Cached KLADR for IP ${ip}`)
  }
  return kladrId
}

async function getYandexSuggestions(q: string): Promise<any[] | null> {
  if (!YANDEX_API_KEY) {
    console.log('❌ YANDEX_API_KEY is not set')
    return null
  }

  console.log('🔍 Yandex Geosuggest attempt for query:', q)
  console.log('🔑 API Key (first 10 chars):', YANDEX_API_KEY.substring(0, 10) + '...')

  const params = new URLSearchParams({
    apikey: YANDEX_API_KEY,
    text: q,
  })
  const url = `https://suggest-maps.yandex.ru/v1/suggest?${params}`
  console.log('📦 Request URL:', url.replace(YANDEX_API_KEY, '***APIKEY***'))

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'TravelPlanner/1.0 (travel-planner app)',
      },
    })

    console.log('📡 Yandex response status:', res.status)

    // Проверяем лимиты
    if (res.status === 429 || res.status === 403) {
      console.warn('⚠️ Yandex Geosuggest: Rate limit (429) or quota exceeded (403)')
      return null
    }

    if (!res.ok) {
      // Read body once - can't read twice
      const bodyText = await res.text()
      let errorDetails = bodyText
      try {
        errorDetails = JSON.stringify(JSON.parse(bodyText))
      } catch {
        // Not JSON, use raw text
      }

      console.error('❌ Yandex Geosuggest error, status:', res.status)
      console.error('   Error body:', errorDetails)
      return null
    }

    const data = await res.json()
    const results = data.results || []

    console.log(`✅ Yandex returned ${results.length} results`)

    return results
      .map((item: any) => {
        const title = item.title?.text || ''
        const subtitle = item.subtitle?.text || ''

        if (!title) return null

        return {
          displayName: subtitle ? `${title}, ${subtitle}` : title,
          uri: `ymapsbm1://geo?text=${encodeURIComponent(title)}&z=12`,
        }
      })
      .filter(Boolean)
  } catch (error) {
    console.error('❌ Yandex Geosuggest fetch error:', error)
    return null
  }
}

async function getDadataSuggestions(q: string, userCoords?: UserCoords | null, ip?: string | null): Promise<any[]> {
  if (!DADATA_API_KEY || !DADATA_SECRET_KEY) {
    console.log('❌ DaData keys not set')
    return []
  }

  console.log(`🏠 DaData attempt for query: "${q}"`)
  console.log(`🔑 API Key (first 10 chars): ${DADATA_API_KEY.substring(0, 10)}...`)
  console.log(`🔑 Secret Key (first 10 chars): ${DADATA_SECRET_KEY.substring(0, 10)}...`)
  try {
    // Suggest endpoint for autocomplete (suggestions.dadata.ru, not suggest.dadata.ru)
    const body: any = { query: q }
    if (userCoords && ip) {
      // Get KLADR code for user's city with caching
      const kladrId = await getCachedKladrByCoords(ip, userCoords.lat, userCoords.lon)
      if (kladrId && typeof kladrId === 'string') {
        body.locations_boost = [{ kladr_id: kladrId }]
        console.log(`📍 Adding locations_boost with KLADR: ${kladrId}`)
      }
    }

    console.log(`📦 DaData request body:`, JSON.stringify(body))
    const res = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Token ${DADATA_API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    console.log('📡 DaData response status:', res.status)
    console.log('📡 DaData content-type:', res.headers.get('content-type'))

    if (!res.ok) {
      console.error('❌ DaData error, status:', res.status)
      return []
    }

    const bodyText = await res.text()
    let suggestions: any[] = []
    try {
      const data = JSON.parse(bodyText)
      suggestions = data.suggestions || []
    } catch {
      console.error('❌ DaData returned non-JSON response (probably HTML error page):')
      console.error('   Content-Type:', res.headers.get('content-type'))
      console.error('   First 300 chars:', bodyText.substring(0, 300))
      return []
    }

    console.log(`🔍 Processing ${suggestions.length} DaData suggestions`)
    const results = suggestions
      .map((item: any) => {
        const value = item.value || ''
        const unrestricted_value = item.unrestricted_value || ''

        if (!value) return null

        return {
          displayName: unrestricted_value || value,
          uri: `ymapsbm1://geo?text=${encodeURIComponent(value)}&z=12`,
        }
      })
      .filter(Boolean)

    console.log(`✅ DaData returned ${results.length} suggestions`)
    return results
  } catch (error) {
    console.error('❌ DaData fetch error:', error)
    return []
  }
}

async function getPhotonSuggestions(q: string, rusOnly: boolean = true, userCoords?: UserCoords | null): Promise<any[]> {
  console.log(`📸 Photon attempt for query: "${q}"${rusOnly ? ' (Russia only)' : ' (worldwide)'}`)
  try {
    const params = new URLSearchParams({
      q,
      limit: '10',
    })

    // Use user location as bias if available, otherwise use Russia bbox
    if (userCoords) {
      params.append('lat', String(userCoords.lat))
      params.append('lon', String(userCoords.lon))
    } else if (rusOnly) {
      // Limit search to Russia using bounding box
      // Russia bounds: 19.64°E to 169.4°E, 41.16°N to 81.86°N
      params.append('bbox', '19.64,41.16,169.4,81.86')
    }

    const res = await fetch(
      `https://photon.komoot.io/api/?${params}`,
      {
        headers: {
          'User-Agent': 'TravelPlanner/1.0 (travel-planner app)',
        },
      }
    )

    console.log('📡 Photon response status:', res.status)

    if (!res.ok) {
      console.error('❌ Photon error, status:', res.status)
      return []
    }

    const data = await res.json()
    const features = data.features || []
    const results = features
      .map((feature: any) => {
        const props = feature.properties
        const coords = feature.geometry?.coordinates
        if (!coords) return null

        const displayName = props.name || ''
        const city = props.city ? `, ${props.city}` : ''
        const country = props.country ? ` (${props.country})` : ''

        return {
          displayName: displayName + city + country,
          uri: `ymapsbm1://geo?ll=${coords[0]},${coords[1]}&z=12`,
        }
      })
      .filter(Boolean)

    console.log(`✅ Photon returned ${results.length} suggestions`)
    return results
  } catch (error) {
    console.error('❌ Photon fetch error:', error)
    return []
  }
}

async function getNominatimSuggestions(q: string, rusOnly: boolean = true, userCoords?: UserCoords | null): Promise<any[]> {
  console.log(`🌍 Nominatim attempt for query: "${q}"${rusOnly ? ' (Russia only)' : ' (worldwide)'}`)
  try {
    const params = new URLSearchParams({
      q,
      format: 'json',
      limit: '10',
      dedupe: '1',
    })

    // Priority search in Russia first
    if (rusOnly) {
      params.append('countrycodes', 'ru')
    }

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      {
        headers: {
          'User-Agent': 'TravelPlanner/1.0 (travel-planner app)',
        },
      }
    )

    console.log('📡 Nominatim response status:', res.status)

    if (!res.ok) {
      console.error('❌ Nominatim error, status:', res.status)
      return []
    }

    const data = await res.json()
    const withDistances = Array.isArray(data)
      ? data.map((item: any) => {
          const distance = userCoords ? haversineKm(userCoords.lat, userCoords.lon, item.lat, item.lon) : undefined
          return {
            displayName: item.display_name,
            uri: `ymapsbm1://geo?ll=${item.lon},${item.lat}&z=12`,
            importance: item.importance || 0,
            distance,
          }
        })
      : []

    const results = withDistances
      .sort((a, b) => {
        // If user coords available, sort by distance first
        if (a.distance !== undefined && b.distance !== undefined) {
          return a.distance - b.distance
        }
        // Fallback to importance/relevance score
        return (b.importance || 0) - (a.importance || 0)
      })
      .map(({ displayName, uri }) => ({ displayName, uri })) // remove importance and distance fields

    console.log(`✅ Nominatim returned ${results.length} suggestions`)
    return results
  } catch (error) {
    console.error('❌ Nominatim fetch error:', error)
    return []
  }
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? ''
  if (q.length < 2) return Response.json({ results: [] })

  console.log(`\n📍 === SUGGEST REQUEST: "${q}" ===`)
  console.log(`🔗 Request URL: ${req.url}`)

  // Get user's approximate location from IP
  const userCoords = await getUserCoords(req)
  console.log(`📌 userCoords result:`, userCoords)

  // Extract IP for caching
  const forwarded = req.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() ?? null

  try {
    const filterResults = (results: any[]) => results.filter(
      (result) => result.displayName && result.displayName.trim() && !result.displayName.trim().startsWith(',')
    )

    // Step 1: Try DaData in Russia (best for RU addresses)
    console.log(`🏠 Trying DaData (Russia)...`)
    let results = await getDadataSuggestions(q, userCoords, ip)
    let filtered = filterResults(results)

    if (filtered && filtered.length > 0) {
      console.log(`✅ DaData returned ${filtered.length} results`)
    } else {
      // Step 2: If DaData failed, try Photon in Russia
      console.log(`⚠️ DaData empty/filtered out, trying Photon (Russia)...`)
      results = await getPhotonSuggestions(q, true, userCoords)
      filtered = filterResults(results)

      if (filtered && filtered.length > 0) {
        console.log(`✅ Photon (Russia) returned ${filtered.length} results`)
      } else {
        // Step 3: If Photon Russia failed, try Nominatim in Russia
        console.log(`⚠️ Photon (Russia) empty/filtered out, trying Nominatim (Russia)...`)
        results = await getNominatimSuggestions(q, true, userCoords)
        filtered = filterResults(results)

        if (filtered && filtered.length > 0) {
          console.log(`✅ Nominatim (Russia) returned ${filtered.length} results`)
        } else {
          // Step 4: If still nothing, try Photon worldwide
          console.log(`⚠️ Nominatim (Russia) empty/filtered out, trying Photon (worldwide)...`)
          results = await getPhotonSuggestions(q, false, userCoords)
          filtered = filterResults(results)

          if (filtered && filtered.length > 0) {
            console.log(`✅ Photon (worldwide) returned ${filtered.length} results`)
          } else {
            // Step 5: Last fallback - Nominatim worldwide
            console.log(`⚠️ Photon (worldwide) empty/filtered out, trying Nominatim (worldwide)...`)
            results = await getNominatimSuggestions(q, false, userCoords)
            filtered = filterResults(results)
            console.log(`✅ Nominatim (worldwide) returned ${filtered.length} results`)
          }
        }
      }
    }

    console.log(`📤 Sending ${filtered.length} results to client\n`)
    return Response.json({ results: filtered })
  } catch (error) {
    console.error('❌ Geocoding error:', error)
    return Response.json({ results: [] }, { status: 500 })
  }
}

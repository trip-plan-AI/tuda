'use client'

import { useEffect, useRef, useState } from 'react'
import { loadYandexMaps } from '@/shared/lib/yandex-maps'
import { env } from '@/shared/config/env'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'
import '@yandex/ymaps3-default-ui-theme/dist/esm/index.css'

interface RouteMapProps {
  points: RoutePoint[]
  focusCoords?: { lon: number; lat: number } | null
  onPointDragEnd: (pointId: string, newCoords: { lon: number; lat: number }, newAddress: string, newTitle: string) => void
  isDropdownOpen?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const ymaps3: any

export function RouteMap({ points, focusCoords, onPointDragEnd, isDropdownOpen }: RouteMapProps) {
  const resolveCoords = async (coords: { lon: number; lat: number }) => {
    await loadYandexMaps(env.yandexMapsKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ymap = (window as any).ymaps3;
    if (!ymap) return null;
    try {
      const results = await ymap.search({
        coordinates: [coords.lon, coords.lat],
        results: 1,
        type: 'geo',
      });
      if (!results || results.length === 0) return null;
      const firstResult = results[0];
      const address = firstResult.properties?.name || firstResult.properties?.description || null;
      const title = firstResult.properties?.name || firstResult.properties?.description || null;
      return { address, title };
    } catch (error) {
      console.error("Geocoding error:", error);
      return null;
    }
  };
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const objectsRef = useRef<any[]>([])
  const polylineRef = useRef<any>(null)
  const pointsRef = useRef<RoutePoint[]>([])
  const skipNextFit = useRef(false)
  const controlsRef = useRef<any>(null)
  const [mapReady, setMapReady] = useState(false)
  const prevCoordsKey = useRef<string>('')

  // Инициализация карты
  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false

    loadYandexMaps(env.yandexMapsKey).then(async () => {
      if (cancelled || mapRef.current || !containerRef.current) return

      const { YMapZoomControl } = await import('@yandex/ymaps3-default-ui-theme')
      if (cancelled) return // проверяем после второго await

      // API 3.0: центр — [longitude, latitude], не [lat, lon]
      mapRef.current = new ymaps3.YMap(containerRef.current, {
        location: { center: [37.618423, 55.751244], zoom: 10 },
      })
      mapRef.current.addChild(new ymaps3.YMapDefaultSchemeLayer({}))
      mapRef.current.addChild(new ymaps3.YMapDefaultFeaturesLayer({}))

      // Добавляем контролы на карту
      const controls = new ymaps3.YMapControls({ position: 'left' })
      controls.addChild(new YMapZoomControl())
      mapRef.current.addChild(controls)
      controlsRef.current = controls; // Сохраняем

      setMapReady(true) // триггерит points-эффект если точки уже есть
    }).catch((err) => {
      console.warn('Yandex Maps не загружен:', err.message)
    })

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.destroy()
        mapRef.current = null
      }
    }
  }, [])

  // Эффект для скрытия/показа контролов
  useEffect(() => {
    if (controlsRef.current && controlsRef.current.element) {
      controlsRef.current.element.style.display = isDropdownOpen ? 'none' : '';
    }
  }, [isDropdownOpen]);

  // Перелёт к выбранной точке
  useEffect(() => {
    if (!mapRef.current || !focusCoords) return
    mapRef.current.update({
      location: { center: [focusCoords.lon, focusCoords.lat], zoom: 14, duration: 500 },
    })
  }, [focusCoords])

  // Обновление маркеров и полилинии при изменении точек
  useEffect(() => {
    if (!mapRef.current) return

    objectsRef.current.forEach((obj) => mapRef.current.removeChild(obj))
    objectsRef.current = []
    polylineRef.current = null

    if (points.length === 0) return

    pointsRef.current = points

    // Маркеры с номерами (DOM-элементы)
    points.forEach((point, index) => {
      const el = document.createElement('div')
      Object.assign(el.style, {
        background: '#0ea5e9',
        color: 'white',
        borderRadius: '50%',
        width: '28px',
        height: '28px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 'bold',
        fontSize: '12px',
        border: '2px solid white',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        cursor: 'pointer',
        transform: 'translate(-50%, -50%)',
      })
      el.textContent = String(index + 1)

      // API 3.0: coordinates — [lon, lat]
      const marker = new ymaps3.YMapMarker(
        {
          coordinates: [point.lon, point.lat],
          draggable: true,
          mapFollowsOnDrag: true,
          onDragMove: (newCoords: number[]) => {
            if (polylineRef.current && pointsRef.current.length > 1) {
              const updatedCoords = pointsRef.current.map((p, i) =>
                i === index ? newCoords : [p.lon, p.lat]
              )
              polylineRef.current.update({
                geometry: { type: 'LineString', coordinates: updatedCoords },
              })
            }
          },
          onDragEnd: (newCoords: number[]) => {
            const lon = newCoords[0]
            const lat = newCoords[1]
            if (lon === undefined || lat === undefined) return
            skipNextFit.current = true
            const coords = { lon, lat }
            resolveCoords(coords).then(geoData => {
              onPointDragEnd(
                point.id,
                coords,
                geoData?.address || `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`,
                point.title,
              );
            });
          },
        },
        el,
      )

      mapRef.current.addChild(marker)
      objectsRef.current.push(marker)

    })

    // Полилиния маршрута
    if (points.length > 1) {
      const polyline = new ymaps3.YMapFeature({
        geometry: {
          type: 'LineString',
          coordinates: points.map((p) => [p.lon, p.lat]), // [lon, lat]
        },
        style: {
          stroke: [{ color: '#0ea5e9', width: 3, opacity: 0.8 }],
        },
      })
      polylineRef.current = polyline
      mapRef.current.addChild(polyline)
      objectsRef.current.push(polyline)
    } else {
      polylineRef.current = null
    }

    // Подгоняем вид только если изменился набор координат (не метаданные, не драг)
    const coordsKey = points.map((p) => `${p.lon},${p.lat}`).join('|')
    const coordsChanged = coordsKey !== prevCoordsKey.current
    prevCoordsKey.current = coordsKey

    const shouldFit = coordsChanged && !skipNextFit.current
    skipNextFit.current = false

    if (shouldFit) {
      const lons = points.map((p) => p.lon)
      const lats = points.map((p) => p.lat)
      const minLon = Math.min(...lons)
      const maxLon = Math.max(...lons)
      const minLat = Math.min(...lats)
      const maxLat = Math.max(...lats)
      const centerLon = (minLon + maxLon) / 2
      const centerLat = (minLat + maxLat) / 2

      let zoom: number
      if (points.length === 1) {
        zoom = 13
      } else {
        const lonSpan = maxLon - minLon || 0.01
        const latSpan = maxLat - minLat || 0.01
        const lonZoom = Math.log2(360 / lonSpan)
        const latZoom = Math.log2(180 / latSpan)
        zoom = Math.max(2, Math.min(16, Math.floor(Math.min(lonZoom, latZoom)) - 1))
      }

      mapRef.current.update({
        location: { center: [centerLon, centerLat], zoom, duration: 500 },
      })
    }
  }, [points, mapReady])

  return (
    <div
      ref={containerRef}
      className="w-full h-full rounded-[2.5rem] overflow-hidden"
    />
  )
}

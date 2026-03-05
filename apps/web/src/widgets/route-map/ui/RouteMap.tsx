'use client'

import { useEffect, useRef, useState } from 'react'
import { loadYandexMaps } from '@/shared/lib/yandex-maps'
import { env } from '@/shared/config/env'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'
import '@yandex/ymaps3-default-ui-theme/dist/esm/index.css'

interface RouteMapProps {
  points: RoutePoint[]
  focusCoords?: { lon: number; lat: number } | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const ymaps3: any

export function RouteMap({ points, focusCoords }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const objectsRef = useRef<any[]>([])
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

    if (points.length === 0) return

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
      })
      el.textContent = String(index + 1)

      // API 3.0: coordinates — [lon, lat]
      const marker = new ymaps3.YMapMarker({ coordinates: [point.lon, point.lat] }, el)
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
      mapRef.current.addChild(polyline)
      objectsRef.current.push(polyline)
    }

    // Подгоняем вид только если изменился набор координат (не метаданные)
    const coordsKey = points.map((p) => `${p.lon},${p.lat}`).join('|')
    const shouldFit = coordsKey !== prevCoordsKey.current
    prevCoordsKey.current = coordsKey

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

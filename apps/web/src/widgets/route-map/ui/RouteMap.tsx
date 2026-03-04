'use client'

import { useEffect, useRef } from 'react'
import { loadYandexMaps } from '@/shared/lib/yandex-maps'
import { env } from '@/shared/config/env'
import type { RoutePoint } from '@/entities/route-point/model/route-point.types'

interface RouteMapProps {
  points: RoutePoint[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const ymaps: any

export function RouteMap({ points }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const objectsRef = useRef<any[]>([])

  // Инициализация карты
  useEffect(() => {
    if (!containerRef.current) return

    loadYandexMaps(env.yandexMapsKey).then(() => {
      if (mapRef.current || !containerRef.current) return

      mapRef.current = new ymaps.Map(containerRef.current, {
        center: [55.751244, 37.618423], // Москва
        zoom: 10,
        controls: ['zoomControl', 'fullscreenControl'],
      })
    })

    return () => {
      if (mapRef.current) {
        mapRef.current.destroy()
        mapRef.current = null
      }
    }
  }, [])

  // Обновление маркеров и полилинии при изменении точек
  useEffect(() => {
    if (!mapRef.current) return

    // Очищаем старые объекты
    objectsRef.current.forEach((obj) => mapRef.current.geoObjects.remove(obj))
    objectsRef.current = []

    if (points.length === 0) return

    const coords = points.map((p) => [p.lat, p.lon])

    // Маркеры с номерами
    points.forEach((point, index) => {
      const placemark = new ymaps.Placemark(
        [point.lat, point.lon],
        {
          balloonContent: `<b>${point.title}</b>${point.budget ? `<br>${point.budget.toLocaleString('ru-RU')} ₽` : ''}`,
          iconContent: String(index + 1),
        },
        {
          preset: 'islands#blueStretchyIcon',
        },
      )
      mapRef.current.geoObjects.add(placemark)
      objectsRef.current.push(placemark)
    })

    // Полилиния маршрута
    if (points.length > 1) {
      const polyline = new ymaps.Polyline(
        coords,
        {},
        {
          strokeColor: '#0ea5e9',
          strokeWidth: 3,
          strokeOpacity: 0.8,
        },
      )
      mapRef.current.geoObjects.add(polyline)
      objectsRef.current.push(polyline)
    }

    // Подгоняем границы карты под все точки
    if (points.length === 1) {
      mapRef.current.setCenter([points[0]!.lat, points[0]!.lon], 14)
    } else {
      mapRef.current.setBounds(mapRef.current.geoObjects.getBounds(), {
        checkZoomRange: true,
        zoomMargin: 40,
      })
    }
  }, [points])

  return (
    <div
      ref={containerRef}
      className="w-full h-full rounded-[2.5rem] overflow-hidden"
    />
  )
}

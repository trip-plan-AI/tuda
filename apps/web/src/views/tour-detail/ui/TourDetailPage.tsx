'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { PREDEFINED_ROUTES } from '@/shared/data/predefined-routes';
import { TOUR_ATTRACTIONS } from '@/shared/data/tour-attractions';
import { useTripStore } from '@/entities/trip';
import type { RoutePoint } from '@/entities/route-point';
import { Button } from '@/shared/ui';

const RouteMap = dynamic(() => import('@/widgets/route-map').then((m) => m.RouteMap), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full rounded-[2.5rem] bg-gray-100 animate-pulse flex items-center justify-center">
      <p className="text-sm text-gray-400">Загрузка карты...</p>
    </div>
  ),
});

interface TourDetailPageProps {
  tourId: number;
}

export function TourDetailPage({ tourId }: TourDetailPageProps) {
  const router = useRouter();
  const { setCurrentTrip, addPoint } = useTripStore();
  const [focusCoords, setFocusCoords] = useState<{ lon: number; lat: number } | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  const route = PREDEFINED_ROUTES.find((r) => r.id === tourId);
  const attractions = TOUR_ATTRACTIONS[tourId] ?? [];

  // Геокодируем город для центрирования карты
  useEffect(() => {
    if (!route) return;
    const city = route.title.split(':')[0]?.trim() ?? route.title;
    fetch(`/api/suggest?q=${encodeURIComponent(city)}`)
      .then((r) => r.json())
      .then((data) => {
        const first = data.results?.[0];
        if (!first?.uri) return;
        const match = first.uri.match(/[?&]ll=([^&]+)/);
        if (!match) return;
        const [lon, lat] = decodeURIComponent(match[1]).split(',').map(Number) as [number, number];
        if (Number.isFinite(lon) && Number.isFinite(lat)) setFocusCoords({ lon, lat });
      })
      .catch(() => undefined);
  }, [route]);

  const handleOpenRoute = useCallback(async () => {
    if (!route || isOpening) return;
    setIsOpening(true);
    try {
      const budgetNum = parseInt(route.total.replace(/\D/g, ''), 10) || 0;
      const city = route.title.split(':')[0]?.trim() ?? route.title;

      // Геокодируем для точки маршрута
      let coords: { lon: number; lat: number } | null = focusCoords;
      if (!coords) {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(city)}`);
        const data = await res.json();
        const first = data.results?.[0];
        if (first?.uri) {
          const match = first.uri.match(/[?&]ll=([^&]+)/);
          if (match) {
            const [lon, lat] = decodeURIComponent(match[1]).split(',').map(Number) as [number, number];
            if (Number.isFinite(lon) && Number.isFinite(lat)) coords = { lon, lat };
          }
        }
      }

      const tripId = `tour-${tourId}-${Date.now()}`;
      setCurrentTrip({
        id: tripId,
        ownerId: 'guest',
        title: route.title,
        description: route.desc,
        budget: budgetNum,
        startDate: null,
        endDate: null,
        isActive: false,
        isPredefined: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      if (coords) {
        const point: RoutePoint = {
          id: `point-${Date.now()}`,
          tripId,
          title: city,
          lat: coords.lat,
          lon: coords.lon,
          budget: budgetNum,
          visitDate: null,
          imageUrl: null,
          address: city,
          order: 0,
          createdAt: new Date().toISOString(),
        };
        addPoint(point);
      }

      router.push('/planner');
    } finally {
      setIsOpening(false);
    }
  }, [route, focusCoords, tourId, setCurrentTrip, addPoint, router, isOpening]);

  if (!route) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400 font-bold">
        Маршрут не найден
      </div>
    );
  }

  return (
    <div className="bg-white min-h-screen">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-8 md:py-12">
        {/* Назад */}
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-slate-400 hover:text-brand-indigo font-bold text-sm transition-colors mb-10 group"
        >
          <ArrowLeft size={16} className="group-hover:-translate-x-1 transition-transform" />
          Все маршруты
        </button>

        {/* Hero */}
        <div className="mb-10">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            {route.tags.map((tag) => (
              <span
                key={tag}
                className="px-3 py-1 rounded-full bg-brand-indigo/5 text-brand-indigo text-xs font-bold uppercase tracking-widest"
              >
                {tag}
              </span>
            ))}
            <span className="px-3 py-1 rounded-full bg-slate-100 text-slate-500 text-xs font-bold">
              {route.temp}
            </span>
          </div>

          <h1 className="text-4xl md:text-6xl font-black text-brand-indigo tracking-tight leading-[0.9] mb-6">
            {route.title}
          </h1>
          <p className="text-lg md:text-xl text-slate-500 font-medium max-w-2xl leading-relaxed">
            {route.desc}
          </p>

          <div className="mt-6 inline-flex items-center gap-2 bg-brand-yellow/10 rounded-2xl px-5 py-3">
            <span className="text-slate-500 font-bold text-sm uppercase tracking-widest">Стоимость:</span>
            <span className="text-brand-yellow font-black text-xl">{route.total}</span>
          </div>
        </div>

        {/* Карта */}
        <div className="w-full aspect-[4/5] md:aspect-[21/9] rounded-[2.5rem] overflow-hidden border border-slate-200 shadow-inner bg-slate-50 mb-8">
          <RouteMap
            points={[]}
            focusCoords={focusCoords}
            onPointDragEnd={() => undefined}
            isDropdownOpen={false}
          />
        </div>

        {/* Кнопка открытия маршрута */}
        <div className="flex justify-center mb-20">
          <Button
            onClick={handleOpenRoute}
            disabled={isOpening}
            className="bg-brand-sky hover:bg-brand-sky/90 text-white rounded-full px-10 py-5 font-black text-lg uppercase tracking-widest shadow-xl shadow-brand-sky/20 active:scale-95 transition-all disabled:opacity-70"
          >
            {isOpening ? 'Открываем...' : 'Открыть маршрут'}
          </Button>
        </div>

        {/* Достопримечательности */}
        {attractions.length > 0 && (
          <div>
            <h2 className="text-[clamp(2rem,5vw,3.5rem)] font-black text-brand-indigo tracking-tight leading-[0.9] mb-16">
              Что <span className="text-brand-sky">посмотреть</span>
            </h2>

            <div className="flex flex-col gap-20 md:gap-24">
              {attractions.map((place, idx) => {
                const isOdd = idx % 2 === 0; // нечётный индекс = изображение слева
                return (
                  <div
                    key={idx}
                    className={`flex flex-col md:flex-row items-center gap-10 md:gap-16 ${!isOdd ? 'md:flex-row-reverse' : ''}`}
                  >
                    {/* Изображение */}
                    <div className="w-full md:w-1/2 aspect-[4/3] rounded-[2rem] overflow-hidden shadow-2xl shrink-0">
                      <img
                        src={place.imageUrl}
                        alt={place.title}
                        className="w-full h-full object-cover transition-transform duration-500 hover:scale-105"
                      />
                    </div>

                    {/* Текст */}
                    <div className="w-full md:w-1/2 text-left">
                      <h3 className="text-2xl md:text-3xl font-black text-brand-indigo mb-4 tracking-tight">
                        {place.title}
                      </h3>
                      <p className="text-slate-500 text-base md:text-lg leading-relaxed font-medium">
                        {place.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Повторная CTA */}
        <div className="flex justify-center mt-24 mb-8">
          <Button
            onClick={handleOpenRoute}
            disabled={isOpening}
            className="bg-brand-sky hover:bg-brand-sky/90 text-white rounded-full px-10 py-5 font-black text-lg uppercase tracking-widest shadow-xl shadow-brand-sky/20 active:scale-95 transition-all disabled:opacity-70"
          >
            {isOpening ? 'Открываем...' : 'Открыть маршрут'}
          </Button>
        </div>
      </div>
    </div>
  );
}

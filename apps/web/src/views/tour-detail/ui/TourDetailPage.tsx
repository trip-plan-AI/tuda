'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Clock, Cloud, CloudSun, Route, Sun, Wind } from 'lucide-react';
import { useTripStore, tripsApi } from '@/entities/trip';
import type { Trip } from '@/entities/trip';
import type { RoutePoint } from '@/entities/route-point';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/shared/ui';
import { cn } from '@/shared/lib/utils';
import { env } from '@/shared/config/env';
import { clearConfig, setConfig } from '@/features/persistent-map';

interface TourDetailPageProps {
  tourId: string;
}

type RouteInfo = {
  duration: number;
  distance: number;
  legs: { duration: number; distance: number }[];
};

const weatherIcons = [Cloud, Sun, CloudSun, Wind];

function formatDuration(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d} д`);
  if (h > 0) parts.push(`${h} ч`);
  if (m > 0) parts.push(`${m} мин`);
  return parts.length > 0 ? parts.join(' ') : '< 1 мин';
}

function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} м`;
  return `${(meters / 1000).toFixed(1)} км`;
}

export function TourDetailPage({ tourId }: TourDetailPageProps) {
  const router = useRouter();
  const { currentTrip, setCurrentTrip, setPoints, clearPlanner, isDirty, setCachedRouteInfo } =
    useTripStore();
  const points = currentTrip?.points || [];
  const [focusCoords, setFocusCoords] = useState<{ lon: number; lat: number } | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [showConfirmOverwrite, setShowConfirmOverwrite] = useState(false);
  const [tour, setTour] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const [isRouteLoading, setIsRouteLoading] = useState(false);

  useEffect(() => {
    tripsApi
      .getPredefined()
      .then((tours) => {
        const found = tours.find((t) => t.id === tourId);
        setTour(found ?? null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [tourId]);

  const attractions = tour?.points ?? [];
  const tourIdHash = tourId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const WeatherIcon = weatherIcons[tourIdHash % weatherIcons.length] ?? Cloud;

  const geocodeCity = useCallback(
    async (cityName: string): Promise<{ lon: number; lat: number } | null> => {
      try {
        const url = `${env.apiUrl}/geosearch/suggest?q=${encodeURIComponent(cityName)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        const results = data.results ?? [];
        if (results.length > 0) {
          const first = results[0];
          const match = first.uri?.match(/[?&]ll=([^&]+)/);
          if (match) {
            const [lonStr, latStr] = decodeURIComponent(match[1]).split(',');
            const lon = Number(lonStr);
            const lat = Number(latStr);
            if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat };
          }
        }
        return null;
      } catch (e) {
        console.error('[Geosearch] City geocoding failed:', e);
        return null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!tour || attractions.length > 0) return;
    const city = tour.title.split(':')[0]?.trim() ?? tour.title;
    geocodeCity(city).then((coords) => {
      if (coords) setFocusCoords(coords);
    });
  }, [tour, attractions.length, geocodeCity]);

  useEffect(() => {
    setConfig({
      source: 'tour-detail-page',
      priority: 60,
      points: attractions,
      focusCoords: attractions.length === 0 ? focusCoords : null,
      readonly: true,
      draggable: false,
      routeProfile: 'driving',
      onPointDragEnd: () => undefined,
      onRouteInfoUpdate: setRouteInfo,
      onRouteInfoLoading: setIsRouteLoading,
    });

    return () => {
      clearConfig('tour-detail-page');
    };
  }, [attractions, focusCoords]);

  const doOpenRoute = useCallback(async () => {
    if (!tour) return;
    setIsOpening(true);
    try {
      const cityName = tour.title.split(':')[0]?.trim() ?? tour.title;
      let coords: { lon: number; lat: number } | null = focusCoords;
      if (!coords) coords = await geocodeCity(cityName);

      clearPlanner();

      const targetTripId = `guest-${Date.now()}`;

      const tourTrip: Trip = {
        id: targetTripId,
        ownerId: 'guest',
        title: tour.title,
        description: tour.description,
        budget: tour.budget,
        startDate: null,
        endDate: null,
        isActive: false,
        isPredefined: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        points: [],
      };
      setCurrentTrip(tourTrip);

      const newPoints: RoutePoint[] = [];
      const safeCoords = coords;
      if (attractions.length > 0) {
        attractions.forEach((attr, idx) => {
          newPoints.push({
            id: `tour-attr-${Date.now()}-${idx}`,
            tripId: targetTripId,
            title: attr.title,
            description: attr.description,
            address: attr.address ?? `${cityName}, ${attr.title}`,
            lat: attr.lat || (safeCoords ? safeCoords.lat + (Math.random() - 0.5) * 0.05 : 0),
            lon: attr.lon || (safeCoords ? safeCoords.lon + (Math.random() - 0.5) * 0.05 : 0),
            budget: attr.budget,
            visitDate: null,
            imageUrl: attr.imageUrl,
            order: idx,
            createdAt: new Date().toISOString(),
          });
        });
      } else if (safeCoords) {
        newPoints.push({
          id: `tour-city-${Date.now()}`,
          tripId: targetTripId,
          title: cityName,
          description: null,
          address: cityName,
          lat: safeCoords.lat,
          lon: safeCoords.lon,
          budget: 0,
          visitDate: null,
          imageUrl: null,
          order: 0,
          createdAt: new Date().toISOString(),
        });
      }
      setPoints(newPoints, false);
      if (routeInfo) setCachedRouteInfo(routeInfo);
      router.push('/planner?profile=driving');
    } catch (e) {
      console.error('[TourDetail] Failed to open route:', e);
    } finally {
      setIsOpening(false);
    }
  }, [
    tour,
    focusCoords,
    attractions,
    geocodeCity,
    clearPlanner,
    setCurrentTrip,
    setPoints,
    router,
    routeInfo,
    setCachedRouteInfo,
  ]);

  const handleOpenRoute = useCallback(() => {
    if (points && points.length > 0) {
      setShowConfirmOverwrite(true);
    } else {
      doOpenRoute();
    }
  }, [points, doOpenRoute]);

  const confirmOverwrite = () => {
    setShowConfirmOverwrite(false);
    doOpenRoute();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-brand-sky border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!tour) {
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
          onClick={() => router.push('/planner?tab=popular')}
          className="flex items-center gap-2 text-slate-400 hover:text-brand-indigo font-bold text-sm transition-colors mb-10 group"
        >
          <ArrowLeft size={16} className="group-hover:-translate-x-1 transition-transform" />
          Популярные
        </button>

        {/* Hero */}
        <div className="mb-10">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {(tour.tags ?? []).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white text-slate-500 border-2 border-slate-100 text-xs font-black uppercase tracking-widest shadow-sm"
              >
                {tag}
              </span>
            ))}
            <span className="inline-flex items-center px-4 py-2 rounded-full bg-white text-slate-500 border-2 border-slate-100 text-xs font-black shadow-sm gap-1.5">
              <WeatherIcon size={14} />
              {tour.temp}
            </span>
          </div>

          <h1 className="text-4xl md:text-6xl font-black text-brand-indigo tracking-tight leading-[0.9] mb-6">
            {tour.title}
          </h1>
          <p className="text-lg md:text-xl text-slate-500 font-medium max-w-2xl leading-relaxed">
            {tour.description}
          </p>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mt-8">
            {tour.budget != null && (
              <div className="inline-flex items-center gap-2 bg-brand-yellow/10 rounded-2xl px-5 py-3 shrink-0 whitespace-nowrap">
                <span className="text-slate-500 font-bold text-sm uppercase tracking-widest">
                  Стоимость:
                </span>
                <span className="text-brand-yellow font-black text-xl">
                  {tour.budget.toLocaleString('ru-RU')} ₽
                </span>
              </div>
            )}

            {/* Суммарный route info */}
            <div className="flex items-center gap-6 px-6 py-3 bg-brand-indigo/5 rounded-[1.25rem] border border-brand-indigo/10 relative overflow-hidden transition-all duration-300 min-h-[48px] w-full sm:w-auto lg:min-w-[24rem] lg:w-fit h-auto sm:ml-auto">
              {isRouteLoading && (
                <div className="absolute inset-0 bg-white/40 flex items-center justify-center z-10 animate-in fade-in duration-200">
                  <div className="w-5 h-5 border-2 border-brand-indigo border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              <div className={cn('flex items-center gap-6 w-full justify-center shrink-0', isRouteLoading && 'opacity-40')}>
                {routeInfo ? (
                  <>
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <Clock size={16} className="text-brand-blue" />
                      <span className="text-sm font-black text-slate-700 leading-none">
                        {formatDuration(routeInfo.duration)}
                      </span>
                    </div>
                    <div className="w-px h-6 bg-brand-indigo/10 shrink-0" />
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <Route size={16} className="text-emerald-500" />
                      <span className="text-sm font-black text-slate-700 leading-none">
                        {formatDistance(routeInfo.distance)}
                      </span>
                    </div>
                  </>
                ) : !isRouteLoading && (
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">
                    Расчёт маршрута...
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Кнопка в конструктор */}
        <div className="flex justify-center mb-20">
          <Button
            onClick={handleOpenRoute}
            disabled={isOpening}
            variant="brand-yellow"
            className="h-auto rounded-[2.5rem] px-12 py-6 font-black text-lg md:text-xl uppercase tracking-widest shadow-xl shadow-brand-yellow/20 active:scale-95 transition-all disabled:opacity-70 min-w-[300px]"
          >
            {isOpening ? 'Открываем...' : 'В конструктор'}
          </Button>
        </div>

        {/* Достопримечательности — детальные карточки */}
        {attractions.length > 0 && (
          <div>
            <h2 className="text-[clamp(1.5rem,5vw,3.5rem)] font-black text-brand-indigo tracking-tight leading-[0.9] mb-16">
              Что <span className="text-brand-sky">посмотреть</span>
            </h2>

            <div className="flex flex-col gap-20 md:gap-24">
              {attractions.map((place, idx) => {
                const isOdd = idx % 2 === 0;
                return (
                  <div
                    key={place.id}
                    className={`flex flex-col md:flex-row items-center gap-10 md:gap-16 ${!isOdd ? 'md:flex-row-reverse' : ''}`}
                  >
                    <div className="w-full md:w-1/2 aspect-[4/3] rounded-[2rem] overflow-hidden shadow-2xl shrink-0">
                      <img
                        src={place.imageUrl ?? ''}
                        alt={place.title}
                        className="w-full h-full object-cover transition-transform duration-500 hover:scale-105"
                      />
                    </div>

                    <div className="w-full md:w-1/2 text-left">
                      <div className="flex items-center gap-3 mb-4">
                        <span className="w-8 h-8 rounded-full bg-brand-indigo text-white text-sm font-black flex items-center justify-center shrink-0">
                          {idx + 1}
                        </span>
                        <h3 className="text-2xl md:text-3xl font-black text-brand-indigo tracking-tight">
                          {place.title}
                        </h3>
                      </div>
                      {place.budget != null && (
                        <div className="mb-4">
                          <span className="inline-flex items-center px-4 py-1.5 rounded-full bg-emerald-50 text-emerald-600 text-sm font-black tracking-widest uppercase">
                            {place.budget.toLocaleString('ru-RU')} ₽
                          </span>
                        </div>
                      )}
                      {place.description && (
                        <p className="text-slate-500 text-base md:text-lg leading-relaxed font-medium">
                          {place.description}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Dialog open={showConfirmOverwrite} onOpenChange={setShowConfirmOverwrite}>
        <DialogContent className="sm:max-w-md border-none shadow-2xl rounded-[2.5rem] p-10 overflow-hidden">
          <DialogHeader className="gap-4">
            <DialogTitle className="text-xl font-black text-brand-indigo uppercase tracking-widest leading-tight">
              Внимание
            </DialogTitle>
            <DialogDescription className="text-slate-500 font-bold text-lg leading-snug">
              В конструкторе уже есть непустой маршрут. При открытии нового маршрута старый будет
              очищен. Продолжить?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-3 mt-8">
            <Button
              variant="ghost"
              className="flex-1 font-bold text-slate-400 hover:text-slate-600 hover:bg-slate-50 h-12 rounded-xl"
              onClick={() => setShowConfirmOverwrite(false)}
            >
              ОТМЕНА
            </Button>
            <Button
              variant="brand-indigo"
              className="flex-1 font-black uppercase tracking-widest h-12 rounded-xl shadow-lg shadow-brand-indigo/20"
              onClick={confirmOverwrite}
            >
              ПРОДОЛЖИТЬ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

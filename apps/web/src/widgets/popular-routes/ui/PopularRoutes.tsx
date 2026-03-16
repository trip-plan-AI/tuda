'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { Search, Cloud, CloudSun, Sun, Wind } from 'lucide-react';
import { tripsApi, type Trip } from '@/entities/trip';
import { Chip } from '@/shared/ui/chip';

const FILTERS = ['Все', 'Активный', 'Зима', 'Экстрим'] as const;
type Filter = (typeof FILTERS)[number];

const weatherIcons = [Cloud, Sun, CloudSun, Wind];

export function PopularRoutes() {
  const [predefinedTrips, setPredefinedTrips] = useState<Trip[]>([]);
  const [popularSearch, setPopularSearch] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<Filter>('Все');

  useEffect(() => {
    tripsApi.getPredefined().then(setPredefinedTrips).catch(console.error);
  }, []);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-7xl mx-auto w-full">
      <div className="w-full mb-10">
        <div className="relative group mb-8">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-brand-blue transition-colors">
            <Search size={20} />
          </div>
          <input
            type="text"
            value={popularSearch}
            onChange={(e) => setPopularSearch(e.target.value)}
            placeholder="Куда"
            className="w-full pl-12 pr-4 py-4 md:py-5 bg-slate-50 rounded-xl md:rounded-2xl border-none focus:ring-2 focus:ring-brand-blue/20 outline-none text-slate-800 font-bold text-base md:text-lg transition-all placeholder:text-slate-400 shadow-sm"
          />
        </div>
        <div className="relative -mx-4 px-4 md:mx-0 md:px-0">
          <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2">
            {FILTERS.map((f) => (
              <Chip
                key={f}
                onClick={() => setSelectedFilter(f)}
                variant={selectedFilter === f ? 'active' : 'default'}
              >
                {f === 'Активный' && <span className="text-sm">⚡</span>}
                {f === 'Зима' && <span className="text-sm">❄️</span>}
                {f === 'Экстрим' && <span className="text-sm">⛰️</span>}
                {f}
              </Chip>
            ))}
            <div className="w-12 shrink-0 md:hidden" />
          </div>
          <div className="absolute top-0 right-0 bottom-0 w-16 bg-linear-to-l from-white via-white/80 to-transparent pointer-events-none md:hidden z-10" />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 md:gap-12 pb-10">
        {predefinedTrips
          .filter(
            (trip) =>
              selectedFilter === 'Все' ||
              (trip.tags ?? []).some((t) => t.includes(selectedFilter)),
          )
          .filter(
            (trip) =>
              !popularSearch.trim() ||
              trip.title.toLowerCase().includes(popularSearch.toLowerCase()),
          )
          .map((trip, idx) => {
            const WeatherIcon = weatherIcons[idx % weatherIcons.length] ?? Cloud;
            return (
              <Link
                key={trip.id}
                className="group block w-full cursor-pointer"
                href={`/tours/${trip.id}`}
              >
                <div className="relative aspect-4/3 md:aspect-16/10 rounded-[3rem] overflow-hidden mb-6 shadow-2xl">
                  <img
                    src={trip.img ?? ''}
                    className="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-110 will-change-transform"
                    alt={trip.title}
                  />
                  <div className="absolute inset-0 bg-linear-to-t from-black/90 via-black/20 to-transparent" />
                  <div className="absolute top-6 left-6">
                    <div className="bg-slate-900/40 backdrop-blur-md border border-white/10 rounded-xl px-3 py-1.5 text-white font-bold text-xs shadow-lg flex items-center gap-1.5">
                      <WeatherIcon size={14} /> {trip.temp}
                    </div>
                  </div>
                  <div className="absolute bottom-6 left-6 right-6 text-left">
                    <h3 className="text-2xl lg:text-4xl font-black text-white mb-4 tracking-tight leading-none drop-shadow-[0_25px_25px_rgba(0,0,0,0.15)]">
                      {trip.title}
                    </h3>
                    <div className="bg-brand-yellow text-white px-6 py-2.5 rounded-full text-sm font-black uppercase tracking-widest inline-block shadow-xl">
                      {trip.budget
                        ? `${trip.budget.toLocaleString('ru-RU')} ₽`
                        : 'По запросу'}
                    </div>
                  </div>
                </div>
                <p className="text-slate-500 text-lg font-medium leading-relaxed px-4 text-left">
                  {trip.description ?? ''}
                </p>
              </Link>
            );
          })}
      </div>
    </div>
  );
}

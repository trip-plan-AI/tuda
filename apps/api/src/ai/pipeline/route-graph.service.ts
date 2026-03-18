import { Injectable } from '@nestjs/common';
import type { FilteredPoi } from '../types/poi.types';

export interface RouteContext {
  averageSpeedKmH: number;
  currentPoiIndex: number;
}

@Injectable()
export class RouteGraphService {
  public calculateEdgeWeight(
    from: FilteredPoi,
    to: FilteredPoi,
    context: RouteContext,
  ): number {
    const distanceKm = this.haversineKm(
      from.coordinates.lat,
      from.coordinates.lon,
      to.coordinates.lat,
      to.coordinates.lon,
    );

    // Время в минутах
    const travelTime = (distanceKm / context.averageSpeedKmH) * 60;

    let penalty = 0;

    // Штраф за однообразие категорий (например: музей -> музей)
    if (from.category === to.category) {
      penalty += 20;
    }

    // "Ядерный" штраф за еду подряд (чтобы гарантированно разнести приемы пищи)
    const foodCategories = ['restaurant', 'cafe', 'bar', 'pub'];
    if (
      foodCategories.includes(from.category) &&
      foodCategories.includes(to.category)
    ) {
      penalty += 240; // +4 часа "виртуального" времени
    }

    // Штраф за усталость: чем длиннее маршрут к текущему моменту, тем больше штраф
    const fatigue = context.currentPoiIndex * 0.2;

    return travelTime + penalty + fatigue;
  }

  public getGeoDistanceKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    return this.haversineKm(lat1, lon1, lat2, lon2);
  }

  private haversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRad = (val: number) => (val * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

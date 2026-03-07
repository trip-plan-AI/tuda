import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

interface UserCoords {
  lat: number;
  lon: number;
}

interface CachedLocation {
  kladrId: string;
  lat: number;
  lon: number;
  timestamp: number;
}

interface NominatimItem {
  display_name: string;
  lon: string;
  lat: string;
  importance?: number;
}

export interface SuggestItem {
  displayName: string;
  uri: string;
}

@Injectable()
export class GeosearchService {
  // Простой кэш в памяти процесса для уменьшения количества geolocate-запросов
  private readonly locationCache = new Map<string, CachedLocation>();

  private get dadataApiKey() {
    return process.env.DADATA_API_KEY;
  }

  private get dadataSecretKey() {
    return process.env.DADATA_SECRET_KEY;
  }

  async suggest(query: string, req?: Request): Promise<SuggestItem[]> {
    const normalized = query.trim();
    if (normalized.length < 2) return [];

    const ip = this.extractClientIp(req);
    const userCoords = await this.getUserCoordsByIp(ip);

    // 1) Основной провайдер: DaData
    let results = await this.getDadataSuggestions(normalized, userCoords, ip);
    let filtered = this.filterResults(results);
    if (filtered.length > 0) return filtered;

    // 2) Fallback: Photon (RU)
    results = await this.getPhotonSuggestions(normalized, true, userCoords);
    filtered = this.filterResults(results);
    if (filtered.length > 0) return filtered;

    // 3) Fallback: Nominatim (RU)
    results = await this.getNominatimSuggestions(normalized, true, userCoords);
    filtered = this.filterResults(results);
    if (filtered.length > 0) return filtered;

    // 4) Fallback: Photon (world)
    results = await this.getPhotonSuggestions(normalized, false, userCoords);
    filtered = this.filterResults(results);
    if (filtered.length > 0) return filtered;

    // 5) Последний fallback: Nominatim (world)
    results = await this.getNominatimSuggestions(normalized, false, userCoords);
    return this.filterResults(results);
  }

  private filterResults(results: SuggestItem[]): SuggestItem[] {
    return results.filter(
      (item) =>
        Boolean(item.displayName?.trim()) && !item.displayName.trim().startsWith(','),
    );
  }

  private extractClientIp(req?: Request): string | null {
    const forwarded = req?.headers?.['x-forwarded-for'];

    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0]?.trim() ?? null;
    }

    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0]?.split(',')[0]?.trim() ?? null;
    }

    return req?.ip ?? null;
  }

  private async getUserCoordsByIp(ip: string | null): Promise<UserCoords | null> {
    try {
      if (!ip || ip === '::1' || ip.startsWith('127.')) return null;

      const res = await fetch(`https://ipapi.co/${ip}/json/`);
      if (!res.ok) return null;

      const data = (await res.json()) as { latitude?: number; longitude?: number };
      if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        return { lat: data.latitude, lon: data.longitude };
      }
    } catch {
      return null;
    }

    return null;
  }

  private haversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private async getKladrByCoords(lat: number, lon: number): Promise<string | null> {
    if (!this.dadataApiKey) return null;

    try {
      const res = await fetch(
        'https://suggestions.dadata.ru/suggestions/api/4_1/rs/geolocate/address',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Token ${this.dadataApiKey}`,
          },
          body: JSON.stringify({ lat, lon }),
        },
      );

      if (!res.ok) return null;
      const data = (await res.json()) as {
        suggestions?: Array<{ data?: { kladr_id?: string } }>;
      };
      return data.suggestions?.[0]?.data?.kladr_id ?? null;
    } catch {
      return null;
    }
  }

  private async getCachedKladrByCoords(
    ip: string,
    lat: number,
    lon: number,
  ): Promise<string | null> {
    const cached = this.locationCache.get(ip);
    const cacheHours = 24;
    const maxMoveKm = 50;

    if (cached) {
      const ageHours = (Date.now() - cached.timestamp) / (1000 * 60 * 60);
      const distance = this.haversineKm(cached.lat, cached.lon, lat, lon);

      if (ageHours < cacheHours && distance < maxMoveKm) {
        return cached.kladrId;
      }
    }

    const kladrId = await this.getKladrByCoords(lat, lon);
    if (kladrId) {
      this.locationCache.set(ip, { kladrId, lat, lon, timestamp: Date.now() });
    }

    return kladrId;
  }

  private async getDadataSuggestions(
    q: string,
    userCoords?: UserCoords | null,
    ip?: string | null,
  ): Promise<SuggestItem[]> {
    // Для совместимости со старым контрактом считаем обязательными оба ключа
    if (!this.dadataApiKey || !this.dadataSecretKey) return [];

    try {
      const body: {
        query: string;
        locations_boost?: Array<{ kladr_id: string }>;
      } = { query: q };

      if (userCoords && ip) {
        const kladrId = await this.getCachedKladrByCoords(
          ip,
          userCoords.lat,
          userCoords.lon,
        );
        if (kladrId) {
          body.locations_boost = [{ kladr_id: kladrId }];
        }
      }

      const res = await fetch(
        'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Token ${this.dadataApiKey}`,
          },
          body: JSON.stringify(body),
        },
      );

      if (!res.ok) return [];

      const data = (await res.json()) as {
        suggestions?: Array<{
          value?: string;
          data?: { geo_lat?: string; geo_lon?: string };
        }>;
      };

      return (data.suggestions ?? [])
        .map((item) => {
          const value = item.value?.trim();
          if (!value) return null;

          const lat = Number(item.data?.geo_lat);
          const lon = Number(item.data?.geo_lon);
          const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

          return {
            displayName: value,
            // Важно для текущего frontend: приоритетно отдаём ll=lon,lat
            uri: hasCoords
              ? `ymapsbm1://geo?ll=${lon},${lat}&z=12`
              : `ymapsbm1://geo?text=${encodeURIComponent(value)}&z=12`,
          };
        })
        .filter((item): item is SuggestItem => item !== null);
    } catch {
      return [];
    }
  }

  private async getPhotonSuggestions(
    q: string,
    rusOnly = true,
    userCoords?: UserCoords | null,
  ): Promise<SuggestItem[]> {
    try {
      const params = new URLSearchParams({ q, limit: '10' });

      if (userCoords) {
        params.append('lat', String(userCoords.lat));
        params.append('lon', String(userCoords.lon));
      } else if (rusOnly) {
        params.append('bbox', '19.64,41.16,169.4,81.86');
      }

      const res = await fetch(`https://photon.komoot.io/api/?${params}`, {
        headers: { 'User-Agent': 'TravelPlanner/1.0 (travel-planner app)' },
      });
      if (!res.ok) return [];

      const data = (await res.json()) as {
        features?: Array<{
          properties?: { name?: string; city?: string; country?: string };
          geometry?: { coordinates?: [number, number] };
        }>;
      };

      return (data.features ?? [])
        .map((feature) => {
          const coords = feature.geometry?.coordinates;
          if (!coords) return null;

          const name = feature.properties?.name ?? '';
          const city = feature.properties?.city ? `, ${feature.properties.city}` : '';
          const country = feature.properties?.country
            ? ` (${feature.properties.country})`
            : '';

          return {
            displayName: `${name}${city}${country}`,
            uri: `ymapsbm1://geo?ll=${coords[0]},${coords[1]}&z=12`,
          };
        })
        .filter((item): item is SuggestItem => item !== null);
    } catch {
      return [];
    }
  }

  private async getNominatimSuggestions(
    q: string,
    rusOnly = true,
    userCoords?: UserCoords | null,
  ): Promise<SuggestItem[]> {
    try {
      const params = new URLSearchParams({
        q,
        format: 'json',
        limit: '10',
        dedupe: '1',
        'accept-language': 'ru',
      });

      if (rusOnly) params.append('countrycodes', 'ru');

      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        { headers: { 'User-Agent': 'TravelPlanner/1.0 (travel-planner app)' } },
      );
      if (!res.ok) return [];

      const data = (await res.json()) as NominatimItem[];
      if (!Array.isArray(data)) return [];

      const scored = data.map((item) => {
        const lat = Number(item.lat);
        const lon = Number(item.lon);
        const distance =
          userCoords && Number.isFinite(lat) && Number.isFinite(lon)
            ? this.haversineKm(userCoords.lat, userCoords.lon, lat, lon)
            : Number.POSITIVE_INFINITY;

        return {
          displayName: item.display_name,
          uri: `ymapsbm1://geo?ll=${item.lon},${item.lat}&z=12`,
          importance: item.importance ?? 0,
          distance,
        };
      });

      return scored
        .sort((a, b) => {
          const hasA = Number.isFinite(a.distance);
          const hasB = Number.isFinite(b.distance);
          if (hasA && hasB) return a.distance - b.distance;
          return b.importance - a.importance;
        })
        .map(({ displayName, uri }) => ({ displayName, uri }));
    } catch {
      return [];
    }
  }
}

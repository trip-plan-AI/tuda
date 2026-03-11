import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { OptimizeTripDto } from './dto/optimize-trip.dto';

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function getOsrmDistanceMatrix(points: { lon: number; lat: number }[], profile: string): Promise<number[][] | null> {
  if (profile === 'direct') return null; // Use haversine for direct/transit
  try {
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
    const osrmUrl = process.env.OSRM_URL || 'http://localhost:5000';
    let fetchUrl = '';

    if (
      osrmUrl === 'http://localhost:5000' ||
      osrmUrl.includes('project-osrm.org')
    ) {
      if (profile === 'driving') {
        fetchUrl = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=distance`;
      } else {
        const mode = profile === 'bike' ? 'bike' : 'foot';
        fetchUrl = `https://routing.openstreetmap.de/routed-${mode}/table/v1/driving/${coords}?annotations=distance`;
      }
    } else {
      fetchUrl = `${osrmUrl}/table/v1/${profile}/${coords}?annotations=distance`;
    }

    const res = await fetch(fetchUrl);
    if (!res.ok) {
      console.warn(`[OptimizationService] OSRM matrix failed with status: ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data.code === 'Ok' && data.distances) {
      return data.distances as number[][]; // values are in meters
    }
    return null;
  } catch (err) {
    console.error('[OptimizationService] OSRM matrix error:', err);
    return null;
  }
}

@Injectable()
export class OptimizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async optimizeTrip(tripId: string, dto: OptimizeTripDto, userId: string) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isRealTrip = UUID_RE.test(tripId);

    if (isRealTrip) {
      const trip = await this.db.query.trips.findFirst({
        where: eq(schema.trips.id, tripId),
      });

      if (!trip) {
        throw new NotFoundException('Trip not found');
      }
    }

    // Use points from DTO (UI current state) or from DB (stored state)
    let points: any[] = [];
    if (dto.points && dto.points.length > 0) {
      points = dto.points;
    } else if (isRealTrip) {
      points = await this.db.query.routePoints.findMany({
        where: eq(schema.routePoints.tripId, tripId),
        orderBy: (points, { asc }) => [asc(points.order)],
      });
    }

    if (points.length < 3) {
      return { message: 'Not enough points to optimize' };
    }

    const transportMode = dto.transportMode || 'driving';
    const params = dto.params || {};

    // Filter points that don't have valid coordinates to prevent NaN
    const validPoints = points.filter(p => 
      typeof p.lat === 'number' && typeof p.lon === 'number' && 
      !isNaN(p.lat) && !isNaN(p.lon)
    );

    if (validPoints.length < 3) {
      return { message: 'Not enough points with valid coordinates to optimize', optimizedPoints: points };
    }

    // Try to get actual road distances from OSRM to improve TSP accuracy
    const distanceMatrix = await getOsrmDistanceMatrix(validPoints, transportMode);

    const getDistance = (p1Idx: number, p2Idx: number) => {
      if (distanceMatrix && distanceMatrix[p1Idx] && distanceMatrix[p1Idx][p2Idx] !== undefined) {
        return distanceMatrix[p1Idx][p2Idx] / 1000; // convert meters to km
      }
      return haversineDistance(validPoints[p1Idx].lat, validPoints[p1Idx].lon, validPoints[p2Idx].lat, validPoints[p2Idx].lon);
    };

    const getWeight = (p1Idx: number, p2Idx: number) => {
      const distance = getDistance(p1Idx, p2Idx);
      if (transportMode === 'driving') {
        const consumption = params.consumption ?? 8;
        const fuelPrice = params.fuelPrice ?? 55;
        const tollFeesPerKm = params.tollFees ?? 0;
        return (distance * consumption / 100 * fuelPrice) + (distance * tollFeesPerKm);
      }
      if (transportMode === 'direct') {
        const transitFarePerKm = params.transitFarePerKm ?? 3;
        return distance * transitFarePerKm;
      }
      return distance;
    };

    let originalDistance = 0;
    for (let i = 0; i < validPoints.length - 1; i++) {
      originalDistance += getDistance(i, i+1);
    }

    // Algorithm: Nearest-Neighbor
    const unvisitedIndices = Array.from({ length: validPoints.length }, (_, i) => i);
    const optimizedIndices: number[] = [];
    
    // Start with the first point
    const currentIdx = unvisitedIndices.shift()!;
    optimizedIndices.push(currentIdx);

    while (unvisitedIndices.length > 0) {
      let nearestUnvisitedListIdx = -1;
      let minWeight = Infinity;
      const lastIdx = optimizedIndices[optimizedIndices.length - 1];

      for (let i = 0; i < unvisitedIndices.length; i++) {
        const candidateIdx = unvisitedIndices[i];
        const w = getWeight(lastIdx, candidateIdx);
        if (!isNaN(w) && w < minWeight) {
          minWeight = w;
          nearestUnvisitedListIdx = i;
        }
      }

      if (nearestUnvisitedListIdx === -1) {
        // Fallback: just take the next one if weights are broken
        nearestUnvisitedListIdx = 0;
      }

      optimizedIndices.push(unvisitedIndices[nearestUnvisitedListIdx]);
      unvisitedIndices.splice(nearestUnvisitedListIdx, 1);
    }

    const optimizedPoints = optimizedIndices.map(idx => validPoints[idx]);

    // Re-add points that didn't have coordinates to the end
    const invalidPoints = points.filter(p => !validPoints.includes(p));
    const finalOptimizedPoints = [...optimizedPoints, ...invalidPoints];

    let newDistance = 0;
    for (let i = 0; i < optimizedIndices.length - 1; i++) {
      newDistance += getDistance(optimizedIndices[i], optimizedIndices[i+1]);
    }

    const savedKm = originalDistance - newDistance;

    const getMetricsForDistance = (km: number) => {
      let hours = 0;
      let rub = 0;
      let isFuel = false;

      if (transportMode === 'driving') {
        const consumption = params.consumption ?? 8;
        const fuelPrice = params.fuelPrice ?? 55;
        rub = km * (consumption / 100) * fuelPrice + (km * (params.tollFees ?? 0));
        hours = km / 80;
        isFuel = true;
      } else if (transportMode === 'direct') {
        const transitFarePerKm = params.transitFarePerKm ?? 3;
        rub = km * transitFarePerKm;
        hours = km / 30;
      } else if (transportMode === 'bike') {
        hours = km / 15;
      } else {
        hours = km / 5;
      }
      return { hours, rub, isFuel };
    };

    const originalMetrics = getMetricsForDistance(originalDistance);
    const newMetrics = getMetricsForDistance(newDistance);

    const savedHours = originalMetrics.hours - newMetrics.hours;
    const savedRub = originalMetrics.rub - newMetrics.rub;

    let optimizationResult: any = null;

    if (isRealTrip) {
      const updatePromises = finalOptimizedPoints
        .filter(p => typeof p.id === 'string' && UUID_RE.test(p.id))
        .map((p, index) => {
          return this.db.update(schema.routePoints)
            .set({ order: index })
            .where(eq(schema.routePoints.id, p.id));
        });
      
      if (updatePromises.length > 0) {
        await Promise.all(updatePromises);
      }

      const validOriginalIds = points.filter(p => typeof p.id === 'string' && UUID_RE.test(p.id)).map(p => p.id);
      const validOptimizedIds = finalOptimizedPoints.filter(p => typeof p.id === 'string' && UUID_RE.test(p.id)).map(p => p.id);

      [optimizationResult] = await this.db.insert(schema.optimizationResults).values({
        tripId,
        originalOrder: validOriginalIds,
        optimizedOrder: validOptimizedIds,
        savedKm: savedKm > 0 ? savedKm : 0,
        savedRub: savedRub > 0 ? savedRub : 0,
        savedHours: savedHours > 0 ? savedHours : 0,
        transportMode,
        params,
      }).returning();
    }

    return {
      optimizationResult,
      optimizedPoints: finalOptimizedPoints,
      metrics: {
        originalKm: originalDistance,
        newKm: newDistance,
        originalHours: originalMetrics.hours,
        newHours: newMetrics.hours,
        originalRub: originalMetrics.rub,
        newRub: newMetrics.rub,
        isFuel: originalMetrics.isFuel,
      }
    };
  }
}

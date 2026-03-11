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
    const trip = await this.db.query.trips.findFirst({
      where: eq(schema.trips.id, tripId),
    });

    if (!trip) {
      throw new NotFoundException('Trip not found');
    }

    const points = await this.db.query.routePoints.findMany({
      where: eq(schema.routePoints.tripId, tripId),
      orderBy: (points, { asc }) => [asc(points.order)],
    });

    if (points.length < 2) {
      return { message: 'Not enough points to optimize' };
    }

    const transportMode = dto.transportMode || 'driving';
    const params = dto.params || {};

    // Try to get actual road distances from OSRM to improve TSP accuracy
    const distanceMatrix = await getOsrmDistanceMatrix(points, transportMode);

    const getDistance = (p1Idx: number, p2Idx: number) => {
      if (distanceMatrix && distanceMatrix[p1Idx] && distanceMatrix[p1Idx][p2Idx] !== undefined) {
        return distanceMatrix[p1Idx][p2Idx] / 1000; // convert meters to km
      }
      return haversineDistance(points[p1Idx].lat, points[p1Idx].lon, points[p2Idx].lat, points[p2Idx].lon);
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
    for (let i = 0; i < points.length - 1; i++) {
      originalDistance += getDistance(i, i+1);
    }

    // Algorithm: Nearest-Neighbor
    const unvisitedIndices = Array.from({ length: points.length }, (_, i) => i);
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
        if (w < minWeight) {
          minWeight = w;
          nearestUnvisitedListIdx = i;
        }
      }

      optimizedIndices.push(unvisitedIndices[nearestUnvisitedListIdx]);
      unvisitedIndices.splice(nearestUnvisitedListIdx, 1);
    }

    const optimizedPoints = optimizedIndices.map(idx => points[idx]);

    let newDistance = 0;
    for (let i = 0; i < optimizedIndices.length - 1; i++) {
      newDistance += getDistance(optimizedIndices[i], optimizedIndices[i+1]);
    }

    const savedKm = originalDistance - newDistance;
    let savedRub = 0;
    let savedHours = 0;

    if (savedKm > 0) {
      if (transportMode === 'driving') {
        const consumption = params.consumption ?? 8;
        const fuelPrice = params.fuelPrice ?? 55;
        savedRub = savedKm * consumption / 100 * fuelPrice;
        savedHours = savedKm / 80; // 80 km/h average
      } else if (transportMode === 'direct') {
        const transitFarePerKm = params.transitFarePerKm ?? 3;
        savedRub = savedKm * transitFarePerKm;
        savedHours = savedKm / 30; // 30 km/h transit average
      } else if (transportMode === 'bike') {
        savedHours = savedKm / 15;
      } else {
        // foot
        savedHours = savedKm / 5;
      }
    }

    const updatePromises = optimizedPoints.map((p, index) => {
      return this.db.update(schema.routePoints)
        .set({ order: index })
        .where(eq(schema.routePoints.id, p.id));
    });
    await Promise.all(updatePromises);

    const [optimizationResult] = await this.db.insert(schema.optimizationResults).values({
      tripId,
      originalOrder: points.map(p => p.id),
      optimizedOrder: optimizedPoints.map(p => p.id),
      savedKm: savedKm > 0 ? savedKm : 0,
      savedRub: savedRub > 0 ? savedRub : 0,
      savedHours: savedHours > 0 ? savedHours : 0,
      transportMode,
      params,
    }).returning();

    return {
      optimizationResult,
      optimizedPoints,
      metrics: {
        originalKm: originalDistance,
        newKm: newDistance,
        originalHours: savedHours > 0 ? originalDistance / (transportMode === 'driving' ? 80 : transportMode === 'direct' ? 30 : transportMode === 'bike' ? 15 : 5) : 0,
        newHours: savedHours > 0 ? newDistance / (transportMode === 'driving' ? 80 : transportMode === 'direct' ? 30 : transportMode === 'bike' ? 15 : 5) : 0,
        originalRub: savedRub > 0 ? originalDistance * (transportMode === 'driving' ? (((params.consumption ?? 8) / 100 * (params.fuelPrice ?? 55)) + (params.tollFees ?? 0)) : (params.transitFarePerKm ?? 3)) : 0,
        newRub: savedRub > 0 ? newDistance * (transportMode === 'driving' ? (((params.consumption ?? 8) / 100 * (params.fuelPrice ?? 55)) + (params.tollFees ?? 0)) : (params.transitFarePerKm ?? 3)) : 0,
      }
    };
  }
}

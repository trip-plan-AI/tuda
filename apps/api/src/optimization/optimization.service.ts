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

    const getWeight = (p1: typeof points[0], p2: typeof points[0]) => {
      const distance = haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
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

    const getDistance = (p1: typeof points[0], p2: typeof points[0]) => {
      return haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
    };

    let originalDistance = 0;
    for (let i = 0; i < points.length - 1; i++) {
      originalDistance += getDistance(points[i], points[i+1]);
    }

    // Algorithm: Nearest-Neighbor
    const unvisited = [...points];
    const optimizedPoints: typeof points = [];
    
    // Start with the first point
    const current = unvisited.shift()!;
    optimizedPoints.push(current);

    while (unvisited.length > 0) {
      let nearestIdx = -1;
      let minWeight = Infinity;
      const lastPoint = optimizedPoints[optimizedPoints.length - 1];

      for (let i = 0; i < unvisited.length; i++) {
        const candidate = unvisited[i];
        const w = getWeight(lastPoint, candidate);
        if (w < minWeight) {
          minWeight = w;
          nearestIdx = i;
        }
      }

      optimizedPoints.push(unvisited[nearestIdx]);
      unvisited.splice(nearestIdx, 1);
    }

    let newDistance = 0;
    for (let i = 0; i < optimizedPoints.length - 1; i++) {
      newDistance += getDistance(optimizedPoints[i], optimizedPoints[i+1]);
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
    };
  }
}

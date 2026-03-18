import { Injectable, Logger } from '@nestjs/common';
import { point, featureCollection } from '@turf/helpers';
import dbscan from '@turf/clusters-dbscan';

@Injectable()
export class ClusteringService {
  private readonly logger = new Logger(ClusteringService.name);

  /**
   * Разбивает набор POI на кластеры по дистанции (DBSCAN).
   * @param pois Массив POI { id, coordinates: { lat, lon } }
   * @param maxDistanceKm Максимальная дистанция между точками в кластере
   */
  public clusterPois(pois: any[], maxDistanceKm: number = 2) {
    if (!pois || pois.length === 0) return { clusters: [], noise: [] };

    const validPois = pois.filter(
      (p) =>
        p.coordinates &&
        typeof p.coordinates.lon === 'number' &&
        typeof p.coordinates.lat === 'number',
    );

    if (validPois.length === 0) return { clusters: [], noise: [] };

    const points = validPois.map((p) =>
      point([p.coordinates.lon, p.coordinates.lat], { id: p.id }),
    );
    const fc = featureCollection(points);

    // minPoints = 2 для образования кластера (минимум 2 точки рядом)
    const clustered = dbscan(fc, maxDistanceKm, { minPoints: 2 });

    const clustersMap = new Map<number, string[]>();
    const noise: string[] = [];

    clustered.features.forEach((feat) => {
      const clusterId = feat.properties?.['cluster'];
      const poiId = feat.properties?.['id'] as string;

      if (clusterId === undefined) {
        noise.push(poiId);
      } else {
        if (!clustersMap.has(clusterId)) clustersMap.set(clusterId, []);
        clustersMap.get(clusterId)!.push(poiId);
      }
    });

    return {
      clusters: Array.from(clustersMap.entries()).map(([id, poiIds]) => ({
        id,
        poiIds,
      })),
      noise,
    };
  }
}

import { PointMutation } from '../types/mutations';

export interface BaseRoutePoint {
  id: string;
  [key: string]: any;
}

export function applyMutation<T extends BaseRoutePoint>(
  points: T[],
  mutation: PointMutation,
  pointBuilder?: (m: Extract<PointMutation, { type: 'ADD' }>) => T
): T[] {
  switch (mutation.type) {
    case 'ADD': {
      if (!pointBuilder) throw new Error('pointBuilder required for ADD mutation');
      const newPoint = pointBuilder(mutation as Extract<PointMutation, { type: 'ADD' }>);
      
      if (mutation.afterPointId === null) return [newPoint, ...points];
      if (!mutation.afterPointId) return [...points, newPoint];
      
      const idx = points.findIndex(p => p.id === mutation.afterPointId);
      if (idx === -1) return [...points, newPoint];
      
      return [
        ...points.slice(0, idx + 1),
        newPoint,
        ...points.slice(idx + 1),
      ];
    }
    case 'REMOVE_BY_ID':
      return points.filter(p => !mutation.pointIds.includes(p.id));

    case 'MOVE': {
      const moved = points.find(p => p.id === mutation.pointId);
      if (!moved) return points;
      
      const without = points.filter(p => p.id !== mutation.pointId);
      const insertIdx = mutation.afterPointId
        ? without.findIndex(p => p.id === mutation.afterPointId) + 1
        : 0;
        
      return [
        ...without.slice(0, insertIdx),
        moved,
        ...without.slice(insertIdx),
      ];
    }
    
    default:
      return points;
  }
}

export function applyMutations<T extends BaseRoutePoint>(
  points: T[],
  mutations: PointMutation[],
  pointBuilder?: (m: Extract<PointMutation, { type: 'ADD' }>) => T
): T[] {
  return mutations.reduce((acc, m) => applyMutation(acc, m, pointBuilder), points);
}

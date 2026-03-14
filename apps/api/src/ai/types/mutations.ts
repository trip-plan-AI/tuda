export type PointMutation =
  | { type: 'ADD'; name: string; category?: string; afterPointId?: string | null }
  | { type: 'REMOVE_BY_ID'; pointIds: string[] }
  | { type: 'REMOVE_BY_QUERY'; query: string; timeContext?: string; limit?: number | null }
  | { type: 'REPLACE'; pointId: string; newPlaceName: string }
  | { type: 'MOVE'; pointId: string; afterPointId: string | null }
  | { type: 'UPDATE_TIME'; pointId: string; time: string }
  | { type: 'OPTIMIZE_ROUTE' };

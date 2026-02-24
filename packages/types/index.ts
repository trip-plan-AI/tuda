import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import { trips } from '../../apps/api/src/db/schema';

export type Trip = InferSelectModel<typeof trips>;
export type NewTrip = InferInsertModel<typeof trips>;

export interface ApiResponse<T> {
  data: T;
  error?: string;
  status: number;
}

// HOTFIX (2026-03-03):
// В текущей ветке отсутствует `apps/api/src/db/schema`, из-за чего production-сборка падает.
// Временно используем локальные типы, чтобы разблокировать Docker build и деплой.
// После добавления/возврата backend schema нужно убрать этот хотфикс и вернуть типы от Drizzle.

// Original (disabled until apps/api exists again):
// import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
// import { trips } from '../../apps/api/src/db/schema';
// export type Trip = InferSelectModel<typeof trips>;
// export type NewTrip = InferInsertModel<typeof trips>;

export interface Trip {
  id?: number;
  title: string;
  budget: number;
  [key: string]: unknown;
}

export type NewTrip = Omit<Trip, 'id'>;

export interface ApiResponse<T> {
  data: T;
  error?: string;
  status: number;
}

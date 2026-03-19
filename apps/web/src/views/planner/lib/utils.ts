import type { RoutePoint } from '@/entities/route-point';
import { hasTime } from '@/shared/lib/route-utils';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSameDay(d1?: string | null, d2?: string | null): boolean {
  if (!d1 || !d2) return d1 === d2;
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

/**
 * Вычисляет даты для точек маршрута по цепочке.
 * Если у точки дата пустая или раньше (дата предыдущей + время пути), ставит автоматически.
 * Возвращает массив {id, visitDate} для точек, которые нужно обновить.
 */
export function computeDateCascade(
  points: RoutePoint[],
  legs: { duration: number; distance: number }[],
  fromIndex: number,
  updatedPatch?: { visitDate?: string | null; duration?: number },
): Array<{ id: string; visitDate: string }> {
  const updates: Array<{ id: string; visitDate: string }> = [];
  const dates = points.map((p) => p.visitDate);
  const durations = points.map((p) => p.duration ?? 0);

  if (updatedPatch?.visitDate !== undefined) dates[fromIndex] = updatedPatch.visitDate;
  if (updatedPatch?.duration !== undefined) durations[fromIndex] = updatedPatch.duration;

  for (let j = fromIndex + 1; j < points.length; j++) {
    const prevDate = dates[j - 1];
    if (!prevDate) break;

    const prevDateMs = new Date(prevDate).getTime();
    if (isNaN(prevDateMs)) break;

    const leg = legs[j - 1];
    if (!leg) break;

    const stayDurationSec = durations[j - 1] ?? 0;
    const stayDurationMs = stayDurationSec * 60 * 1000;
    const travelDurationMs = (leg.duration || 0) * 1000;
    const minMs = prevDateMs + stayDurationMs + travelDurationMs;

    const originalDate = points[j]?.visitDate;
    const newDateIso = new Date(minMs).toISOString();

    const hasTimeBefore = hasTime(originalDate ?? null);
    const finalDate = hasTimeBefore ? newDateIso : newDateIso.split('T')[0]!;

    const currentMs = originalDate ? new Date(originalDate).getTime() : null;

    if (currentMs === null || currentMs < minMs - 1000) {
      if (dates[j] !== finalDate) {
        dates[j] = finalDate;
        if (points[j]) {
          updates.push({ id: points[j]!.id, visitDate: finalDate as string });
        }
      }
    }
  }

  return updates;
}

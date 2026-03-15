'use client';

import { create } from 'zustand';
import type { RoutePoint } from '@/entities/route-point/model/route-point.types';

export type MapSheetState = 'collapsed' | 'medium' | 'expanded';

export interface PersistentMapConfig {
  points: RoutePoint[];
  focusCoords?: { lon: number; lat: number } | null;
  draggable?: boolean;
  readonly?: boolean;
  routeProfile?: 'driving' | 'foot' | 'bike' | 'direct';
  isDropdownOpen?: boolean;
  isAddPointMode?: boolean;
  onPointDragEnd?: (
    pointId: string,
    newCoords: { lon: number; lat: number },
    newAddress: string,
    newTitle: string,
  ) => void;
  onMapClick?: (coords: { lon: number; lat: number }) => void;
  onAddPointModeChange?: (active: boolean) => void;
  onRouteInfoUpdate?: (
    info: {
      duration: number;
      distance: number;
      legs: { duration: number; distance: number }[];
    } | null,
  ) => void;
  onRouteInfoLoading?: (loading: boolean) => void;
  onAffectedSegmentsChange?: (indices: Set<number>) => void;
  source: string;
  priority: number;
  fitKey?: string;
}

interface InternalEntry {
  config: PersistentMapConfig;
  updatedAt: number;
}

interface PersistentMapStore {
  config: PersistentMapConfig | null;
  sheetState: MapSheetState;
  setConfig: (config: PersistentMapConfig) => void;
  clearConfig: (source: string) => void;
  setSheetState: (sheetState: MapSheetState) => void;
}

const registry = new Map<string, InternalEntry>();

function pickActiveConfig(): PersistentMapConfig | null {
  const entries = Array.from(registry.values());
  if (entries.length === 0) return null;

  entries.sort((a, b) => {
    if (b.config.priority !== a.config.priority) return b.config.priority - a.config.priority;
    return b.updatedAt - a.updatedAt;
  });

  return entries[0]?.config ?? null;
}

// Ключ из стабильных данных — без колбэков. Используется чтобы не обновлять store
// когда менялись только функции-колбэки (иначе RouteMap ре-рендерится в цикле).
function configDataKey(c: PersistentMapConfig): string {
  const pts = c.points
    .map((p) => `${p.id}:${p.lon?.toFixed(6)},${p.lat?.toFixed(6)},${p.transportMode ?? ''}`)
    .join('|');
  return [
    c.source,
    c.priority,
    c.routeProfile ?? '',
    String(c.draggable ?? true),
    String(c.readonly ?? false),
    String(c.isAddPointMode ?? false),
    String(c.isDropdownOpen ?? false),
    c.fitKey ?? '',
    c.focusCoords ? `${c.focusCoords.lon},${c.focusCoords.lat}` : '',
    pts,
  ].join('\x00');
}

export const usePersistentMapStore = create<PersistentMapStore>((set, get) => ({
  config: null,
  sheetState: 'medium',
  setConfig: (config) => {
    registry.set(config.source, { config, updatedAt: Date.now() });
    const nextConfig = pickActiveConfig();
    const currentConfig = get().config;

    // Обновляем store только если изменились данные, а не только колбэки.
    // Это предотвращает цикл: onRouteInfoUpdate → setRouteInfo → ре-рендер PlannerPage
    // → новые колбэки → setConfig → ре-рендер RouteMap → onRouteInfoUpdate → ...
    const hasNext = !!nextConfig;
    const hasCurrent = !!currentConfig;

    if (
      hasNext !== hasCurrent ||
      (hasNext && hasCurrent && configDataKey(currentConfig!) !== configDataKey(nextConfig!))
    ) {
      set({ config: nextConfig });
    }
  },
  clearConfig: (source) => {
    registry.delete(source);
    set({ config: pickActiveConfig() });
  },
  setSheetState: (sheetState) => set({ sheetState }),
}));

export const setConfig = (config: PersistentMapConfig) => {
  usePersistentMapStore.getState().setConfig(config);
};

export const clearConfig = (source: string) => {
  usePersistentMapStore.getState().clearConfig(source);
};

export const setSheetState = (sheetState: MapSheetState) => {
  usePersistentMapStore.getState().setSheetState(sheetState);
};


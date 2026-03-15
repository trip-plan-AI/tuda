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

export const usePersistentMapStore = create<PersistentMapStore>((set) => ({
  config: null,
  sheetState: 'medium',
  setConfig: (config) => {
    registry.set(config.source, { config, updatedAt: Date.now() });
    set({ config: pickActiveConfig() });
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


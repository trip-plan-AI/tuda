'use client';

import dynamic from 'next/dynamic';
import { usePersistentMapStore } from '@/features/persistent-map';

const RouteMap = dynamic(() => import('@/widgets/route-map').then((m) => m.RouteMap), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-slate-100 animate-pulse" />,
});

export function PersistentMapShell() {
  const config = usePersistentMapStore((state) => state.config);

  if (!config) {
    return <div className="h-full w-full bg-slate-100" />;
  }

  return (
    <RouteMap
      points={config.points}
      focusCoords={config.focusCoords}
      draggable={config.draggable}
      readonly={config.readonly}
      routeProfile={config.routeProfile}
      isDropdownOpen={config.isDropdownOpen}
      isAddPointMode={config.isAddPointMode}
      onPointDragEnd={config.onPointDragEnd ?? (() => undefined)}
      onMapClick={config.onMapClick}
      onAddPointModeChange={config.onAddPointModeChange}
      onRouteInfoUpdate={config.onRouteInfoUpdate}
      onRouteInfoLoading={config.onRouteInfoLoading}
      onAffectedSegmentsChange={config.onAffectedSegmentsChange}
    />
  );
}


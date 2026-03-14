'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { setSheetState, usePersistentMapStore, type MapSheetState } from '@/features/persistent-map';
import { cn } from '@/shared/lib/utils';

const SNAP_POINTS: Record<MapSheetState, number> = {
  collapsed: 0.22,
  medium: 0.52,
  expanded: 0.9,
};

const ORDER: MapSheetState[] = ['collapsed', 'medium', 'expanded'];

function nearestState(value: number): MapSheetState {
  return ORDER.reduce((best, current) => {
    const bestDiff = Math.abs(value - SNAP_POINTS[best]);
    const currentDiff = Math.abs(value - SNAP_POINTS[current]);
    return currentDiff < bestDiff ? current : best;
  }, 'medium' as MapSheetState);
}

export function MobileContentSheet({ children }: { children: React.ReactNode }) {
  const sheetState = usePersistentMapStore((state) => state.sheetState);
  const [dragProgress, setDragProgress] = useState<number | null>(null);
  const dragProgressRef = useRef<number | null>(null);
  const dragStartY = useRef(0);
  const dragStartProgress = useRef(0);
  const isDragging = useRef(false);

  const currentProgress = dragProgress ?? SNAP_POINTS[sheetState];
  const top = useMemo(() => `${Math.round((1 - currentProgress) * 100)}%`, [currentProgress]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    isDragging.current = true;
    dragStartY.current = event.clientY;
    dragStartProgress.current = SNAP_POINTS[sheetState];
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [sheetState]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current || typeof window === 'undefined') return;
    const delta = dragStartY.current - event.clientY;
    const next = dragStartProgress.current + delta / window.innerHeight;
    const clamped = Math.max(SNAP_POINTS.collapsed, Math.min(SNAP_POINTS.expanded, next));
    dragProgressRef.current = clamped;
    setDragProgress(clamped);
  }, []);

  const onPointerUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const progress = dragProgressRef.current ?? dragProgress ?? SNAP_POINTS[sheetState];
    dragProgressRef.current = null;
    setDragProgress(null);
    setSheetState(nearestState(progress));
  }, [dragProgress, sheetState]);

  return (
    <section
      data-testid="mobile-content-sheet"
      data-sheet-state={sheetState}
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 rounded-t-3xl border-t border-slate-200 bg-white/95 shadow-2xl',
        'backdrop-blur-sm transition-[top] duration-200 ease-out',
      )}
      style={{ top }}
    >
      <div
        data-testid="mobile-sheet-handle"
        className="flex h-10 items-center justify-center touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="h-1.5 w-12 rounded-full bg-slate-300" />
      </div>
      <div className="h-[calc(100%-2.5rem)] overflow-y-auto px-4 pb-24">{children}</div>
    </section>
  );
}


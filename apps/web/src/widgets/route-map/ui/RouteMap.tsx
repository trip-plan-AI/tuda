'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { loadYandexMaps } from '@/shared/lib/yandex-maps';
import { env } from '@/shared/config/env';
import type { RoutePoint } from '@/entities/route-point/model/route-point.types';

interface RouteMapProps {
  points: RoutePoint[];
  focusCoords?: { lon: number; lat: number } | null;
  draggable?: boolean;
  onPointDragEnd: (
    pointId: string,
    newCoords: { lon: number; lat: number },
    newAddress: string,
    newTitle: string,
  ) => void;
  isDropdownOpen?: boolean;
  onMapClick?: (coords: { lon: number; lat: number }) => void;
  isAddPointMode?: boolean;
  onAddPointModeChange?: (active: boolean) => void;
  routeProfile?: 'driving' | 'foot' | 'bike' | 'direct';
  onRouteInfoUpdate?: (
    info: {
      duration: number;
      distance: number;
      legs: { duration: number; distance: number }[];
    } | null,
  ) => void;
  onRouteInfoLoading?: (loading: boolean) => void;
  onAffectedSegmentsChange?: (indices: Set<number>) => void;
  readonly?: boolean;
}

declare const ymaps3: any;

// In-memory кэш OSRM-ответов (переживает ремаунт компонента)
const osrmCache = new Map<string, { geometry: any; duration: number; distance: number } | null>();

// Module-level реестр инстансов карты по DOM-контейнеру.
const _mapRegistry = new WeakMap<HTMLElement, any>();
// Таймеры отложенного destroy — отменяются если компонент ремаунтится до истечения
const _destroyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

// Глобальный список всех активных инстансов для контроля лимита WebGL-контекстов (не более 6)
let _activeInstances: { container: HTMLElement; instance: any; timestamp: number }[] = [];
const MAX_WEBGL_CONTEXTS = 6;

function cleanupOldInstances() {
  if (_activeInstances.length >= MAX_WEBGL_CONTEXTS) {
    // Сортируем по времени (старые в начале) и удаляем лишние
    _activeInstances.sort((a, b) => a.timestamp - b.timestamp);
    const toDestroy = _activeInstances.slice(0, _activeInstances.length - MAX_WEBGL_CONTEXTS + 1);
    
    toDestroy.forEach(item => {
      try {
        item.instance.destroy();
        _mapRegistry.delete(item.container);
        const timer = _destroyTimers.get(item.container);
        if (timer) clearTimeout(timer);
        _destroyTimers.delete(item.container);
      } catch (e) {
        console.warn('[RouteMap] Force destroy failed:', e);
      }
    });
    
    _activeInstances = _activeInstances.filter(item => !toDestroy.includes(item));
  }
}

function getOsrmCacheKey(fromLon: number, fromLat: number, toLon: number, toLat: number, profile: string) {
  return `${fromLon},${fromLat};${toLon},${toLat}|${profile}`;
}

export function RouteMap({
  points,
  focusCoords,
  draggable = true,
  onPointDragEnd,
  isDropdownOpen,
  onMapClick,
  isAddPointMode = false,
  onAddPointModeChange,
  routeProfile = 'driving',
  onRouteInfoUpdate,
  onRouteInfoLoading,
  onAffectedSegmentsChange,
  readonly = false,
}: RouteMapProps) {
  console.log('[RouteMap] Render. isAddPointMode:', isAddPointMode, 'hasOnMapClick:', !!onMapClick, 'points:', points.length);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const objectsRef = useRef<any[]>([]);
  const polylineRef = useRef<any>(null);
  const pointsRef = useRef<RoutePoint[]>([]);
  const controlsRef = useRef<any>(null);
  const addPointBtnRef = useRef<HTMLButtonElement>(null);
  const cursorIndicatorRef = useRef<HTMLDivElement>(null);
  const dragPlaceholdersRef = useRef<any[]>([]);
  const draggedPointIndexRef = useRef<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [zoom, setZoom] = useState(12);

  interface SegmentData {
    geometry: any;
    info: { duration: number; distance: number } | null;
    profile: 'driving' | 'foot' | 'bike' | 'direct';
  }

  const [segmentsData, setSegmentsData] = useState<SegmentData[] | null>(null);
  const [loadingSegments, setLoadingSegments] = useState<Set<number>>(new Set());

  const onMapClickRef = useRef(onMapClick);
  const isAddPointModeRef = useRef(isAddPointMode);
  const onAddPointModeChangeRef = useRef(onAddPointModeChange);
  const hasInitialFitPerformed = useRef(false);
  const prevPointsRef = useRef<RoutePoint[] | null>(null);
  const prevSegmentsRef = useRef<SegmentData[] | null>(null);
  const prevRouteProfileRef = useRef(routeProfile);

  const pointsKey = useMemo(() => points.map(p => `${p.lon},${p.lat}`).join('|'), [points]);
  const transportModesKey = useMemo(
    () => points.map(p => p.transportMode || 'driving').join(','),
    [points],
  );
  const loadingSegmentsKey = useMemo(
    () => Array.from(loadingSegments).sort().join(','),
    [loadingSegments],
  );

  // Сброс флагов при полной очистке маршрута
  useEffect(() => {
    if (points.length === 0) {
      hasInitialFitPerformed.current = false;
    }
  }, [points.length]);

  // Карта цветов в зависимости от профиля маршрута
  const profileColors = {
    driving: '#0ea5e9', // brand-blue
    foot: '#f59e0b',    // brand-amber
    bike: '#10b981',    // emerald-500
    direct: '#6366f1',  // indigo-500
  };
  const activeColor = profileColors[routeProfile] || profileColors.driving;

  useEffect(() => {
    onMapClickRef.current = onMapClick;
    isAddPointModeRef.current = isAddPointMode;
    onAddPointModeChangeRef.current = onAddPointModeChange;
  }, [onMapClick, isAddPointMode, onAddPointModeChange]);

  // Управление кнопкой добавления точек
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!onAddPointModeChange || readonly) {
      if (addPointBtnRef.current) {
        addPointBtnRef.current.remove();
        addPointBtnRef.current = null;
      }
      return;
    }

    if (!addPointBtnRef.current) {
      const btn = document.createElement('button');
      btn.setAttribute('data-testid', 'route-map-add-point-toggle');
      Object.assign(btn.style, {
        position: 'absolute',
        left: '12px',
        top: '60px',
        width: '40px',
        height: '40px',
        borderRadius: '12px',
        border: 'none',
        background: 'white',
        color: 'black',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        transition: 'all 0.2s ease',
        zIndex: '1000',
      });
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="#4d4d4d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3" fill="none" stroke="#4d4d4d" stroke-width="1.5"/></svg>`;
      btn.addEventListener('click', () => onAddPointModeChange?.(!isAddPointModeRef.current));
      container.appendChild(btn);
      addPointBtnRef.current = btn;
    }

    if (addPointBtnRef.current) {
      addPointBtnRef.current.setAttribute('data-active', String(isAddPointMode));
      addPointBtnRef.current.style.background = isAddPointMode ? '#0ea5e9' : 'white';
      if (isAddPointMode) {
        addPointBtnRef.current.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#0ea5e9" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3" fill="none" stroke="white" stroke-width="1.5"/></svg>`;
      } else {
        addPointBtnRef.current.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="#4d4d4d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3" fill="none" stroke="#4d4d4d" stroke-width="1.5"/></svg>`;
      }
    }
  }, [isAddPointMode, onAddPointModeChange, readonly]);

  // Управление cursor indicator при добавлении точек
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Курсор-индикатор нужен только на устройствах с мышью
    const isTouchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (!cursorIndicatorRef.current && isAddPointMode && !isTouchOnly) {
      const indicator = document.createElement('div');
      Object.assign(indicator.style, {
        position: 'fixed',
        width: '32px',
        height: '32px',
        pointerEvents: 'none',
        zIndex: '999',
        display: 'none',
      });

      // SVG маркер с нашим стилем (полупрозрачная точка с синей обводкой)
      indicator.innerHTML = `
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));">
          <circle cx="16" cy="16" r="8" fill="#0ea5e9" opacity="0.6" stroke="white" stroke-width="2"/>
          <circle cx="16" cy="16" r="3" fill="#0ea5e9" opacity="0.8"/>
        </svg>
      `;

      document.body.appendChild(indicator);
      cursorIndicatorRef.current = indicator;
    }

    if (!isAddPointMode && cursorIndicatorRef.current) {
      cursorIndicatorRef.current.style.display = 'none';
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!isAddPointModeRef.current || !cursorIndicatorRef.current) return;
      cursorIndicatorRef.current.style.display = 'block';
      cursorIndicatorRef.current.style.left = e.clientX + 8 + 'px';
      cursorIndicatorRef.current.style.top = e.clientY + 8 + 'px';
    };

    const handleMouseLeave = () => {
      if (cursorIndicatorRef.current) {
        cursorIndicatorRef.current.style.display = 'none';
      }
    };

    const handleMouseEnter = () => {
      if (isAddPointModeRef.current && cursorIndicatorRef.current) {
        cursorIndicatorRef.current.style.display = 'block';
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      if (!isAddPointModeRef.current) return;
      e.preventDefault();
      onAddPointModeChangeRef.current?.(false);
    };

    if (isAddPointMode && container) {
      // Слушаем mousemove только над контейнером карты, не глобально
      container.addEventListener('mousemove', handleMouseMove);
      container.addEventListener('mouseleave', handleMouseLeave);
      container.addEventListener('mouseenter', handleMouseEnter);
      container.addEventListener('contextmenu', handleContextMenu);
      
      const debugClick = (e: MouseEvent) => {
        console.log('[RouteMap] DOM click on container. isAddPointMode:', isAddPointModeRef.current, 'target:', e.target);

        // E2E fallback: в headless-режиме карта может не пробрасывать onClick из SDK,
        // поэтому дублируем добавление точки по DOM-click только для Playwright.
        if (!(window as any).__PW_E2E__) return;
        const forceAddPoint = Boolean((window as Window & { __PW_FORCE_ADD_POINT__?: boolean }).__PW_FORCE_ADD_POINT__);
        if (!isAddPointModeRef.current && !forceAddPoint) return;
        if (!onMapClickRef.current) return;

        const rect = container.getBoundingClientRect();
        const nx = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
        const ny = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
        const lon = 37.618423 + (nx - 0.5) * 0.2;
        const lat = 55.751244 - (ny - 0.5) * 0.2;
        onMapClickRef.current({ lon, lat });
      };
      container.addEventListener('click', debugClick, true); // Use capture phase
      
      return () => {
        container.removeEventListener('mousemove', handleMouseMove);
        container.removeEventListener('mouseleave', handleMouseLeave);
        container.removeEventListener('mouseenter', handleMouseEnter);
        container.removeEventListener('contextmenu', handleContextMenu);
        container.removeEventListener('click', debugClick, true);
      };
    }
  }, [isAddPointMode]);

  // Инициализация карты
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;

    // Отменяем отложенный destroy если он был запланирован (Fast Refresh remount)
    const pendingDestroy = _destroyTimers.get(container);
    if (pendingDestroy !== undefined) {
      clearTimeout(pendingDestroy);
      _destroyTimers.delete(container);
    }

    // Переиспользуем инстанс если он уже существует для этого контейнера
    if (_mapRegistry.has(container)) {
      mapRef.current = _mapRegistry.get(container);
      // Обновляем таймштамп в списке активных
      const idx = _activeInstances.findIndex(i => i.container === container);
      if (idx !== -1 && _activeInstances[idx]) _activeInstances[idx]!.timestamp = Date.now();
      setMapReady(true);
      return () => { cancelled = true; };
    }

    loadYandexMaps(env.yandexMapsKey)
      .then(async () => {
        if (cancelled || mapRef.current || !container) return;
        const { YMapZoomControl } = await import('@yandex/ymaps3-default-ui-theme');
        if (cancelled) return;

        if (container.childElementCount > 0) {
          container.innerHTML = '';
        }

        // Очищаем старые инстансы перед созданием нового если лимит превышен
        cleanupOldInstances();

        mapRef.current = new ymaps3.YMap(container, {
          location: { center: [37.618423, 55.751244], zoom: 12 },
        });
        _mapRegistry.set(container, mapRef.current);
        _activeInstances.push({ container, instance: mapRef.current, timestamp: Date.now() });

        mapRef.current.addChild(new ymaps3.YMapDefaultSchemeLayer({}));
        mapRef.current.addChild(new ymaps3.YMapDefaultFeaturesLayer({}));

        const controls = new ymaps3.YMapControls({ position: 'left' });
        controls.addChild(new YMapZoomControl());
        mapRef.current.addChild(controls);
        controlsRef.current = controls;

        setMapReady(true);
      })
      .catch(console.warn);

    return () => {
      cancelled = true;
      const c = container;
      // Откладываем destroy — если это Fast Refresh remount, следующий mount
      // отменит таймер и переиспользует инстанс без создания нового WebGL-контекста.
      // Сокращаем до 100мс для более быстрой очистки при навигации.
      const timer = setTimeout(() => {
        _destroyTimers.delete(c);
        const instance = _mapRegistry.get(c);
        if (instance) {
          try {
            instance.destroy();
          } catch (e) {
            console.warn('[RouteMap] Destroy failed:', e);
          }
          _mapRegistry.delete(c);
          _activeInstances = _activeInstances.filter(i => i.container !== c);
        }
      }, 100);
      _destroyTimers.set(c, timer);
      mapRef.current = null;
    };
  }, []);

  // Управление слушателем событий карты
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;

    const listener = new ymaps3.YMapListener({
      onUpdate: (update: any) => {
        if (update.location?.zoom !== undefined) setZoom(update.location.zoom);
      },
      onClick: (_object: any, event: any) => {
        console.log('[RouteMap] Map click event:', { 
          isAddPointMode: isAddPointModeRef.current,
          hasOnMapClick: !!onMapClickRef.current,
          _object: !!_object,
          event: !!event
        });
        
        if (!isAddPointModeRef.current) return;
        
        // If we click on an object (like a marker), we might not want to add a point right there.
        // But for v3, click on map background often has _object = null.
        const coords = event?.coordinates || _object?.coordinates;
        console.log('[RouteMap] Extracted coordinates:', coords);
        
        if (coords) {
          onMapClickRef.current?.({ lon: coords[0], lat: coords[1] });
        }
      },
    });

    mapRef.current.addChild(listener);
    const m = mapRef.current;
    return () => {
      if (m) {
        try {
          m.removeChild(listener);
        } catch (e) {
          console.warn('[RouteMap] removeChild listener failed:', e);
        }
      }
    };
  }, [mapReady]);

  // Эффект запроса маршрутов для затронутых сегментов
  useEffect(() => {
    if (!mapReady || points.length < 2) {
      setSegmentsData(null);
      prevPointsRef.current = null;
      prevSegmentsRef.current = null;
      return;
    }

    let isCancelled = false;

    // Определяем затронутые сегменты
    const affectedSegments = new Set<number>();

    if (prevPointsRef.current && prevSegmentsRef.current && prevSegmentsRef.current.length === points.length - 1) {
      // Сравниваем только координаты и transport modes, игнорируя остальные поля
      for (let i = 0; i < points.length; i++) {
        const oldPoint = prevPointsRef.current[i];
        const newPoint = points[i];

        if (!oldPoint || !newPoint) continue;

        const coordsChanged = 
            oldPoint.lon !== newPoint.lon ||
            oldPoint.lat !== newPoint.lat;

        // transportMode точки i определяет режим передвижения сегмента (i-1) -> i
        const oldMode = oldPoint.transportMode || prevRouteProfileRef.current;
        const newMode = newPoint.transportMode || routeProfile;
        const modeChanged = oldMode !== newMode;

        if (coordsChanged || modeChanged) {
          // Сегмент i-1 (входящий в точку i) затронут если изменились координаты или режим
          if (i > 0) {
            affectedSegments.add(i - 1);
          }

          // Сегмент i (исходящий из точки i) затронут только если изменились координаты самой точки
          if (coordsChanged && i < points.length - 1) {
            affectedSegments.add(i);
          }
        }
      }
    } else {
      // Первый раз или размер массива изменился (добавление/удаление точки) - пересчитываем все
      for (let i = 0; i < points.length - 1; i++) {
        affectedSegments.add(i);
      }
    }

    if (affectedSegments.size === 0) {
      // Ничего не изменилось - не перезагружаем
      prevPointsRef.current = points;
      prevRouteProfileRef.current = routeProfile;
      return;
    }

    // Отправляем информацию о затронутых сегментах
    onAffectedSegmentsChange?.(affectedSegments);
    setLoadingSegments(affectedSegments);
    onRouteInfoLoading?.(true);

    const fetchAffectedSegments = async () => {
      const promises = Array.from(affectedSegments).map(async (segmentIndex) => {
        const from = points[segmentIndex]!;
        const to = points[segmentIndex + 1]!;
        // Режим сегмента i -> i+1 определяется настройкой точки i+1
        const profile = to.transportMode || routeProfile;

        if (profile === 'direct') {
          const dx = (to.lon - from.lon) * 111320 * Math.cos((from.lat * Math.PI) / 180);
          const dy = (to.lat - from.lat) * 110540;
          const dist = Math.sqrt(dx * dx + dy * dy);
          return {
            index: segmentIndex,
            data: {
              geometry: { type: 'LineString' as const, coordinates: [[from.lon, from.lat], [to.lon, to.lat]] },
              info: { duration: dist / 1.4, distance: dist },
              profile: 'direct' as const,
            },
          };
        }

        const cacheKey = getOsrmCacheKey(from.lon, from.lat, to.lon, to.lat, profile);
        const cached = osrmCache.get(cacheKey);
        if (cached !== undefined) {
          return {
            index: segmentIndex,
            data: cached
              ? { geometry: cached.geometry, info: { duration: cached.duration, distance: cached.distance }, profile }
              : { geometry: { type: 'LineString' as const, coordinates: [[from.lon, from.lat], [to.lon, to.lat]] }, info: null, profile },
          };
        }

        try {
          const coordsString = `${from.lon},${from.lat};${to.lon},${to.lat}`;
          const res = await fetch(`${env.apiUrl}/geosearch/route?profile=${profile}&coords=${coordsString}`);
          const data = await res.json();
          if (data.code === 'Ok' && data.routes?.[0]) {
            const r = data.routes[0];
            osrmCache.set(cacheKey, { geometry: r.geometry, duration: r.duration, distance: r.distance });
            return {
              index: segmentIndex,
              data: {
                geometry: r.geometry,
                info: { duration: r.duration, distance: r.distance },
                profile,
              },
            };
          }
        } catch {}
        // fallback: straight line
        osrmCache.set(cacheKey, null);
        return {
          index: segmentIndex,
          data: {
            geometry: { type: 'LineString' as const, coordinates: [[from.lon, from.lat], [to.lon, to.lat]] },
            info: null,
            profile,
          },
        };
      });

      const results = await Promise.all(promises);
      if (!isCancelled) {
        // Обновляем только затронутые сегменты
        const updatedSegments = prevSegmentsRef.current ? [...prevSegmentsRef.current] : new Array(points.length - 1);
        results.forEach(result => {
          updatedSegments[result.index] = result.data;
        });
        setSegmentsData(updatedSegments as SegmentData[]);
        prevSegmentsRef.current = updatedSegments as SegmentData[];
        prevPointsRef.current = points;
        prevRouteProfileRef.current = routeProfile;
      }
      setLoadingSegments(new Set());
      onRouteInfoLoading?.(false);
    };

    fetchAffectedSegments();

    return () => {
      isCancelled = true;
    };
  }, [pointsKey, transportModesKey, routeProfile, mapReady]);

  // Уведомление об инфо маршрута (собираем из segmentsData)
  useEffect(() => {
    if (!segmentsData) {
      onRouteInfoUpdate?.(null);
      return;
    }
    const legs = segmentsData.map((s) => s.info ?? { duration: 0, distance: 0 });
    const total = legs.reduce(
      (acc, l) => ({
        duration: acc.duration + l.duration,
        distance: acc.distance + l.distance,
      }),
      { duration: 0, distance: 0 }
    );
    onRouteInfoUpdate?.({ ...total, legs });
  }, [segmentsData]);

  // Эффект отрисовки объектов
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;

    objectsRef.current.forEach((obj) => mapRef.current.removeChild(obj));
    objectsRef.current = [];
    polylineRef.current = null;

    if (points.length < 1) return;
    pointsRef.current = points;

    const getStrokeWidth = (z: number) => {
      if (z <= 5) return 7;
      if (z <= 8) return 6;
      if (z <= 11) return 6;
      if (z <= 13) return 5;
      return 4;
    };
    const strokeWidth = getStrokeWidth(zoom);

    // Функция для получения цвета сегмента i→(i+1)
    const getSegmentColor = (segmentIndex: number) => {
      if (segmentIndex < 0 || segmentIndex >= points.length - 1) return null;
      const mode = points[segmentIndex + 1]!.transportMode || routeProfile;
      return profileColors[mode];
    };

    // Маркеры с поддержкой split-дизайна для переходных точек
    points.forEach((point, index) => {
      const leftColor = index > 0 ? getSegmentColor(index - 1) : null;
      const rightColor = index < points.length - 1 ? getSegmentColor(index) : null;
      const isSplit = leftColor && rightColor && leftColor !== rightColor;

      const el = document.createElement('div');
      el.setAttribute('data-testid', 'route-map-marker');
      el.setAttribute('data-marker-index', String(index));

      if (isSplit) {
        // Split маркер
        Object.assign(el.style, {
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          overflow: 'hidden',
          position: 'relative',
          border: '2px solid white',
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          cursor: 'pointer',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
        });

        const leftHalf = document.createElement('div');
        Object.assign(leftHalf.style, {
          position: 'absolute',
          left: '0',
          top: '0',
          width: '50%',
          height: '100%',
          background: leftColor,
        });
        el.appendChild(leftHalf);

        const rightHalf = document.createElement('div');
        Object.assign(rightHalf.style, {
          position: 'absolute',
          right: '0',
          top: '0',
          width: '50%',
          height: '100%',
          background: rightColor,
        });
        el.appendChild(rightHalf);

        const label = document.createElement('div');
        Object.assign(label.style, {
          position: 'absolute',
          inset: '0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontWeight: 'bold',
          fontSize: '11px',
          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
        });
        label.textContent = String(index + 1);
        el.appendChild(label);
      } else {
        // Обычный маркер одного цвета
        const bgColor = leftColor ?? rightColor ?? activeColor;
        Object.assign(el.style, {
          background: bgColor,
          color: 'white',
          borderRadius: '50%',
          width: '28px',
          height: '28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 'bold',
          fontSize: '12px',
          border: '2px solid white',
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          cursor: 'pointer',
          transform: 'translate(-50%, -50%)',
        });
        el.textContent = String(index + 1);
      }

      const marker = new ymaps3.YMapMarker(
        {
          coordinates: [point.lon, point.lat],
          draggable: !readonly,
          onDragMove: (newCoords: number[]) => {
            if (readonly || !mapRef.current || pointsRef.current.length < 2) return;

            draggedPointIndexRef.current = index;

            // Удаляем старые placeholder полилинии
            dragPlaceholdersRef.current.forEach((p) => mapRef.current.removeChild(p));
            dragPlaceholdersRef.current = [];

            // Показываем пунктирные линии только для затронутых сегментов
            const draggedPoint = pointsRef.current[index];
            if (!draggedPoint) return;

            // Сегмент перед точкой (если это не первая точка)
            if (index > 0) {
              const prevPoint = pointsRef.current[index - 1]!;
              const mode = draggedPoint.transportMode || routeProfile;
              const color = profileColors[mode];
              const stroke: any = { color, width: strokeWidth, opacity: 0.5, dash: [10, 10] };
              const pl = new ymaps3.YMapFeature({
                geometry: { type: 'LineString', coordinates: [[prevPoint.lon, prevPoint.lat], newCoords] },
                style: { stroke: [stroke] },
              });
              mapRef.current.addChild(pl);
              dragPlaceholdersRef.current.push(pl);
            }

            // Сегмент после точки (если это не последняя точка)
            if (index < pointsRef.current.length - 1) {
              const nextPoint = pointsRef.current[index + 1]!;
              const mode = nextPoint.transportMode || routeProfile;
              const color = profileColors[mode];
              const stroke: any = { color, width: strokeWidth, opacity: 0.5, dash: [10, 10] };
              const pl = new ymaps3.YMapFeature({
                geometry: { type: 'LineString', coordinates: [newCoords, [nextPoint.lon, nextPoint.lat]] },
                style: { stroke: [stroke] },
              });
              mapRef.current.addChild(pl);
              dragPlaceholdersRef.current.push(pl);
            }
          },
          onDragEnd: (nc: number[]) => {
            // Очищаем placeholder полилинии
            dragPlaceholdersRef.current.forEach((p) => {
              if (mapRef.current) mapRef.current.removeChild(p);
            });
            dragPlaceholdersRef.current = [];
            draggedPointIndexRef.current = null;

            if (nc[0] !== undefined && nc[1] !== undefined) {
              onPointDragEnd(point.id, { lon: nc[0], lat: nc[1] }, '', '');
            }
          },
        },
        el
      );

      mapRef.current.addChild(marker);
      objectsRef.current.push(marker);
    });

    // Полилинии для каждого сегмента
    if (points.length > 1) {
      if (segmentsData) {
        // Рисуем полилинию для каждого сегмента со своим цветом
        segmentsData.forEach((segment, i) => {
          // Пропускаем сегменты, которые затронуты перетаскиванием
          const dragIdx = draggedPointIndexRef.current;
          if (dragIdx !== null && (dragIdx === i || dragIdx === i + 1)) {
            return; // Не показываем маршрут для затронутых сегментов
          }

          // Пропускаем загружаемые сегменты - покажем пунктирные линии для них ниже
          if (loadingSegments.has(i)) {
            return;
          }

          const color = profileColors[segment.profile] || activeColor;
          const stroke: any = {
            color,
            width: strokeWidth,
            opacity: segment.info ? 0.9 : 0.5,
          };

          if (!segment.info) {
            stroke.dash = [10, 10];
          }

          const polyline = new ymaps3.YMapFeature({
            geometry: segment.geometry,
            style: { stroke: [stroke] },
          });

          if (i === 0) polylineRef.current = polyline;
          mapRef.current.addChild(polyline);
          objectsRef.current.push(polyline);
        });

        // Показываем пунктирные линии для загружаемых сегментов
        if (loadingSegments.size > 0) {
          loadingSegments.forEach((i) => {
            // Пропускаем сегменты, которые затронуты перетаскиванием
            const dragIdx = draggedPointIndexRef.current;
            if (dragIdx !== null && (dragIdx === i || dragIdx === i + 1)) {
              return;
            }

            const fromPoint = points[i]!;
            const toPoint = points[i + 1]!;
            if (!fromPoint || !toPoint) {
              console.warn('[RouteMap][debug] invalid segment in loadingSegments (segmentsData branch)', {
                segmentIndex: i,
                pointsLength: points.length,
                hasFromPoint: Boolean(fromPoint),
                hasToPoint: Boolean(toPoint),
                loadingSegments: Array.from(loadingSegments),
                pointsSnapshot: points.map((p, idx) => ({ idx, id: p.id, lat: p.lat, lon: p.lon })),
              });
              return;
            }
            const segmentMode = toPoint.transportMode || routeProfile;
            const segmentColor = profileColors[segmentMode];

            const stroke: any = {
              color: segmentColor,
              width: strokeWidth,
              opacity: 0.5,
              dash: [10, 10],
            };

            const coords: [number, number][] = [[fromPoint.lon, fromPoint.lat], [toPoint.lon, toPoint.lat]];
            const placeholderPolyline = new ymaps3.YMapFeature({
              geometry: { type: 'LineString', coordinates: coords },
              style: { stroke: [stroke] },
            });

            mapRef.current.addChild(placeholderPolyline);
            objectsRef.current.push(placeholderPolyline);
          });
        }
      } else if (loadingSegments.size > 0) {
        // Во время загрузки (нет segmentsData): показываем пунктирную линию только для загружаемых сегментов
        loadingSegments.forEach((i) => {
          // Пропускаем сегменты, которые затронуты перетаскиванием
          const dragIdx = draggedPointIndexRef.current;
          if (dragIdx !== null && (dragIdx === i || dragIdx === i + 1)) {
            return;
          }

          const fromPoint = points[i]!;
          const toPoint = points[i + 1]!;
          if (!fromPoint || !toPoint) {
            console.warn('[RouteMap][debug] invalid segment in loadingSegments (no segmentsData branch)', {
              segmentIndex: i,
              pointsLength: points.length,
              hasFromPoint: Boolean(fromPoint),
              hasToPoint: Boolean(toPoint),
              loadingSegments: Array.from(loadingSegments),
              pointsSnapshot: points.map((p, idx) => ({ idx, id: p.id, lat: p.lat, lon: p.lon })),
            });
            return;
          }
          const segmentMode = toPoint.transportMode || routeProfile;
          const segmentColor = profileColors[segmentMode];

          const stroke: any = {
            color: segmentColor,
            width: strokeWidth,
            opacity: 0.5,
            dash: [10, 10],
          };

          const coords: [number, number][] = [[fromPoint.lon, fromPoint.lat], [toPoint.lon, toPoint.lat]];
          const placeholderPolyline = new ymaps3.YMapFeature({
            geometry: { type: 'LineString', coordinates: coords },
            style: { stroke: [stroke] },
          });

          mapRef.current.addChild(placeholderPolyline);
          objectsRef.current.push(placeholderPolyline);
        });
      }
    }

    return () => {
      if (mapRef.current) {
        objectsRef.current.forEach((obj) => {
          try {
            mapRef.current.removeChild(obj);
          } catch (e) {
            console.warn('[RouteMap] Cleanup removeChild failed:', e);
          }
        });
        objectsRef.current = [];
      }
    };
  }, [pointsKey, transportModesKey, mapReady, routeProfile, zoom, segmentsData, loadingSegmentsKey, draggable]);

  // Прочие эффекты (зум при клике, фит на старте)
  useEffect(() => {
    if (!mapRef.current || !focusCoords) return;
    mapRef.current.update({ location: { center: [focusCoords.lon, focusCoords.lat], zoom: 14, duration: 500 } });
    hasInitialFitPerformed.current = true; // Отключаем авто-фит, если произошел фокус
  }, [focusCoords]);

  // Если режим добавления точек активируется — блокируем авто-зум навсегда
  useEffect(() => {
    if (isAddPointMode) {
      hasInitialFitPerformed.current = true;
    }
  }, [isAddPointMode]);

  useEffect(() => {
    if (!mapRef.current || !mapReady || points.length === 0 || hasInitialFitPerformed.current) return;
    
    const lons = points.map(p => p.lon);
    const lats = points.map(p => p.lat);
    
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    
    // Вычисляем охват и добавляем 10% запас с каждой стороны
    const lonSpan = maxLon - minLon;
    const latSpan = maxLat - minLat;
    
    const marginLon = Math.max(lonSpan * 0.1, 0.01);
    const marginLat = Math.max(latSpan * 0.1, 0.01);
    
    const bounds = [
      [minLon - marginLon, minLat - marginLat], 
      [maxLon + marginLon, maxLat + marginLat]
    ];
    
    mapRef.current.update({ location: { bounds, duration: 500 } });
    hasInitialFitPerformed.current = true;
  }, [points.length > 0, mapReady]);

  // Cleanup: удаляем cursor indicator при размонтировании
  useEffect(() => {
    return () => {
      if (cursorIndicatorRef.current && cursorIndicatorRef.current.parentNode) {
        cursorIndicatorRef.current.parentNode.removeChild(cursorIndicatorRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      data-testid="route-map"
      data-readonly={String(readonly)}
      data-draggable={String(draggable)}
    />
  );
}

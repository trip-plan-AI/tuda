import { useRef, useEffect, useCallback } from 'react';

/**
 * Hook для наблюдения за видимостью элемента и вызова callback
 * Полезен для infinite scroll / lazy loading
 *
 * @param callback - функция, вызываемая когда элемент видим
 * @param enabled - отключить наблюдение
 * @returns ref для подключения к элементу
 */
export function useIntersectionObserver(
  callback: () => void,
  enabled: boolean = true
) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [entry] = entries;
      if (entry.isIntersecting) {
        callback();
      }
    },
    [callback]
  );

  useEffect(() => {
    if (!enabled || !sentinelRef.current) return;

    const observer = new IntersectionObserver(handleIntersection, {
      rootMargin: '200px', // загружать за 200px до видимого экрана
    });

    observer.observe(sentinelRef.current);

    return () => observer.disconnect();
  }, [enabled, handleIntersection]);

  return sentinelRef;
}

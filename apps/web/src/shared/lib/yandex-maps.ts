let loadPromise: Promise<void> | null = null

export function loadYandexMaps(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (loadPromise) return loadPromise

  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${apiKey}&lang=ru_RU`
    script.onload = () => (window as any).ymaps.ready(resolve)
    script.onerror = () => { loadPromise = null; reject(new Error('Failed to load Yandex Maps')) }
    document.head.appendChild(script)
  })

  return loadPromise
}

let loadPromise: Promise<void> | null = null

export function loadYandexMaps(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (loadPromise) return loadPromise

  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://api-maps.yandex.ru/3.0/?apikey=${apiKey}&lang=ru_RU`
    script.onload = async () => {
      try {
        await (window as any).ymaps3.ready
        resolve()
      } catch (e) {
        loadPromise = null
        reject(e)
      }
    }
    script.onerror = () => {
      loadPromise = null
      reject(new Error('Failed to load Yandex Maps 3.0'))
    }
    document.head.appendChild(script)
  })

  return loadPromise
}

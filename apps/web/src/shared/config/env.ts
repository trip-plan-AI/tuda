const isLocalBrowser =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

export const env = {
  apiUrl:
    process.env.NEXT_PUBLIC_API_URL ??
    (isLocalBrowser ? 'http://localhost:3001/api' : '/api'),
  yandexMapsKey: process.env.NEXT_PUBLIC_YANDEX_MAPS_KEY ?? '',
  osrmUrl: process.env.NEXT_PUBLIC_OSRM_URL ?? 'http://localhost:5000',
};

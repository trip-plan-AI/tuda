export const env = {
  apiUrl:
    process.env.NEXT_PUBLIC_API_URL ??
    (process.env.NODE_ENV === 'development' ? 'http://localhost:3001/api' : '/api'),
  yandexMapsKey: process.env.NEXT_PUBLIC_YANDEX_MAPS_KEY ?? '',
};

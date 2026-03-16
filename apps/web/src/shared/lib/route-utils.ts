export interface GeoSuggestion {
  displayName: string;
  uri?: string; // ymapsbm1://geo?ll=LON,LAT&z=...
}

export function filterUniqueSuggestions(results: any[]): GeoSuggestion[] {
  const seenCoords = new Set<string>();
  const seenNames = new Set<string>();
  const unique: GeoSuggestion[] = [];

  for (const item of results) {
    const displayName = (item.displayName ?? '').trim();
    if (!displayName) continue;

    const uri = item.uri as string | undefined;
    const lat = item.lat ?? item.geometry?.point?.lat ?? item.data?.geo_lat;
    const lon = item.lon ?? item.geometry?.point?.lon ?? item.data?.geo_lon;

    if (seenNames.has(displayName.toLowerCase())) continue;

    let coordsKey = '';
    if (lat !== undefined && lon !== undefined && !isNaN(Number(lat)) && !isNaN(Number(lon))) {
      coordsKey = `${Number(lon).toFixed(5)},${Number(lat).toFixed(5)}`;
    } else if (uri) {
      const match = uri.match(/[?&]ll=([^&]+)/);
      if (match && match[1]) {
        const rawCoords = decodeURIComponent(match[1]);
        const [p0, p1] = rawCoords.split(',').map(Number);
        if (p0 !== undefined && p1 !== undefined && !isNaN(p0) && !isNaN(p1)) {
          coordsKey = `${p0.toFixed(5)},${p1.toFixed(5)}`;
        } else {
          coordsKey = rawCoords;
        }
      }
    }

    if (coordsKey) {
      if (seenCoords.has(coordsKey)) continue;
      seenCoords.add(coordsKey);
    }

    seenNames.add(displayName.toLowerCase());
    unique.push({ displayName, uri });
  }

  return unique;
}

export function hasTime(d?: string | null): boolean {
  if (!d) return false;
  return d.includes('T');
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (d > 0) parts.push(`${d} дн.`);
  if (h > 0) parts.push(`${h} ч`);
  if (m > 0) parts.push(`${m} мин`);

  return parts.length > 0 ? parts.join(' ') : '0 мин';
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} м`;
  return `${(meters / 1000).toFixed(1)} км`;
}

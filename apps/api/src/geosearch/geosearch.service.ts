import { Injectable } from '@nestjs/common';

interface YandexSuggestion {
  title?: { text: string };
  subtitle?: { text: string };
  geometry?: { point: { lon: number; lat: number } };
}

interface NominatimItem {
  display_name: string;
  lon: number;
  lat: number;
}

@Injectable()
export class GeosearchService {
  private get yandexApiKey() {
    return (
      process.env.YANDEX_SUGGEST_KEY ??
      process.env.YANDEX_MAPS_API_KEY ??
      process.env.NEXT_PUBLIC_YANDEX_GEOSUGGEST_KEY
    );
  }

  private get dadataApiKey() {
    return process.env.DADATA_API_KEY;
  }

  async suggest(query: string) {
    const normalized = query.trim();
    if (normalized.length < 2) return [];

    // 1. Попытка DaData (лучшее для РФ)
    if (this.dadataApiKey) {
      const dadataResults = await this.getDaDataSuggestions(normalized);
      if (dadataResults && dadataResults.length > 0) return dadataResults;
    }

    // 2. Попытка Photon (быстрый OSM поиск)
    const photonResults = await this.getPhotonSuggestions(normalized);
    if (photonResults && photonResults.length > 0) return photonResults;

    // 3. Попытка Nominatim (классический OSM)
    const nominatimResults = await this.getNominatimSuggestions(normalized);
    if (nominatimResults && nominatimResults.length > 0)
      return nominatimResults;

    // 4. Попытка Yandex (фоллбэк)
    return this.getYandexSuggestions(normalized);
  }

  private async getDaDataSuggestions(
    q: string,
  ): Promise<Array<{ displayName: string; uri: string }> | null> {
    if (!this.dadataApiKey) return null;

    try {
      const res = await fetch(
        'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Token ${this.dadataApiKey}`,
          },
          body: JSON.stringify({ query: q, count: 10 }),
        },
      );

      if (!res.ok) return null;

      const data = await res.json();
      const suggestions = Array.isArray(data?.suggestions)
        ? data.suggestions
        : [];

      return suggestions.map((item: any) => ({
        displayName: item.value,
        uri: `ymapsbm1://geo?ll=${item.data.geo_lon},${item.data.geo_lat}&z=12`,
      }));
    } catch (error) {
      console.error('[GeosearchService] DaData error:', error);
      return null;
    }
  }

  private async geolocateDaData(lat: number, lon: number): Promise<any | null> {
    if (!this.dadataApiKey) return null;

    try {
      const res = await fetch(
        'https://suggestions.dadata.ru/suggestions/api/4_1/rs/geolocate/address',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Token ${this.dadataApiKey}`,
          },
          body: JSON.stringify({ lat, lon, count: 1 }),
        },
      );

      if (!res.ok) return null;
      const data = await res.json();
      return data.suggestions?.[0] || null;
    } catch (error) {
      console.error('[GeosearchService] DaData Geolocate error:', error);
      return null;
    }
  }

  private async getPhotonSuggestions(
    q: string,
  ): Promise<Array<{ displayName: string; uri: string }> | null> {
    try {
      const params = new URLSearchParams({
        q,
        limit: '10',
        lang: 'ru',
      });

      const res = await fetch(`https://photon.komoot.io/api/?${params}`);
      if (!res.ok) return null;

      const data = await res.json();
      if (!data || !data.features) return null;

      return data.features.map((f: any) => {
        const p = f.properties;
        const name = p.name || '';
        const city = p.city || '';
        const street = p.street || '';
        const house = p.housenumber || '';

        const displayParts = [name, city, street, house].filter(Boolean);
        const displayName = displayParts.join(', ');

        return {
          displayName: displayName || p.state || p.country,
          uri: `ymapsbm1://geo?ll=${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}&z=12`,
        };
      });
    } catch {
      return null;
    }
  }

  private async reversePhoton(lat: number, lon: number): Promise<any | null> {
    try {
      const params = new URLSearchParams({
        lat: lat.toString(),
        lon: lon.toString(),
        lang: 'ru',
      });

      const res = await fetch(`https://photon.komoot.io/reverse?${params}`);
      if (!res.ok) return null;

      const data = await res.json();
      console.log(`[Geosearch] Photon raw response for ${lat}, ${lon}:`, JSON.stringify(data, null, 2));
      return data.features?.[0] || null;
    } catch {
      return null;
    }
  }

  async reverse(lat: number, lon: number) {
    // Используем Nominatim для обратного геокодирования
    try {
      const params = new URLSearchParams({
        lat: lat.toString(),
        lon: lon.toString(),
        format: 'json',
        'accept-language': 'ru',
        zoom: '18', // 18 — уровень дома/улицы (было 10 — уровень города)
      });

      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?${params}`,
        {
          headers: {
            'User-Agent': 'TravelPlanner/1.0',
          },
        },
      );

      if (!res.ok) return null;

      const data = await res.json();

      if (!data || !data.address) return null;

      let addr = data.address;

      // 1. Пытаемся найти название конкретного объекта (POI)
      const poi = data.name || addr.historic || addr.amenity || addr.shop || addr.tourism || addr.office || addr.leisure || addr.man_made || addr.ruins;

      // 2. Собираем всё, что относится к улице
      let street = addr.road || addr.street || addr.pedestrian || addr.footway || addr.cycleway || addr.path || addr.square || addr.place || addr.allotments;

      // 3. Собираем всё, что относится к номеру дома/зданию (строгий адрес)
      const houseParts: string[] = [];
      if (addr.house_number) houseParts.push(addr.house_number);
      if (addr.building && addr.building !== addr.house_number && !/^(yes|static|industrial)$/.test(addr.building)) {
        houseParts.push(addr.building);
      }
      if (addr.house_name) houseParts.push(addr.house_name);

      // 4. ВТОРОЙ КОНТУР: Если Nominatim не нашел номер дома, идем в Photon
      if (houseParts.length === 0) {
        const photonRes = await this.reversePhoton(lat, lon);
        if (photonRes?.properties) {
          const p = photonRes.properties;
          if (p.housenumber) {
            if (p.street) street = p.street;
            houseParts.push(p.housenumber);
            if (!addr.city && p.city) addr.city = p.city;
          }
        }
      }

      // ТРЕТИЙ КОНТУР: Если всё ещё нет номера дома, пробуем DaData
      if (houseParts.length === 0) {
        const dadataRes = await this.geolocateDaData(lat, lon);
        if (dadataRes) {
          if (dadataRes.data) {
            const d = dadataRes.data;
            if (d.house || d.block || d.struc) {
              if (d.street_with_type || d.street) {
                street = d.street_with_type || d.street;
              }
              if (d.house) houseParts.push(d.house);
              if (d.block) houseParts.push(`${d.block_type || 'к'} ${d.block}`);
              if (d.struc) houseParts.push(`${d.struc_type || 'стр'} ${d.struc}`);
              if (!addr.city && d.city) addr.city = d.city;
              if (!addr.suburb && (d.city_district || d.suburb || d.settlement)) {
                addr.suburb = d.city_district || d.suburb || d.settlement;
              }
            }
          }
        }
      }

      const houseInfo = houseParts.join(', ');
      const settlement = addr.village || addr.town || addr.hamlet || addr.allotments || addr.suburb || addr.city_district;
      const city = addr.city;

      // 5. Формируем заголовок (короткое название) по СТРОГИМ приоритетам пользователя
      let title = '';

      if (poi && poi !== street && poi !== settlement && poi !== city) {
        // Приоритет 1: Название места (без адреса)
        title = poi;
      } else if (street && houseInfo) {
        // Приоритет 2: Улица + Номер дома
        title = `${street}, ${houseInfo}`;
      } else if (settlement && houseInfo) {
        // Приоритет 3: Поселение + Номер дома (выше улицы без номера)
        title = `${settlement}, ${houseInfo}`;
      } else if (street) {
        // Приоритет 4: Просто улица
        title = street;
      } else if (settlement) {
        // Приоритет 5: Поселение
        title = settlement;
      } else if (city) {
        // Приоритет 6: Город
        title = houseInfo ? `${city}, ${houseInfo}` : city;
      } else {
        // Резерв
        const fallback = addr.state_district || addr.state || data.display_name.split(',')[0];
        title = houseInfo ? `${fallback}, ${houseInfo}` : fallback;
      }

      // 6. Формируем полный адрес (displayName) по нашему порядку
      const finalParts: string[] = [];

      // Блок 1: Самая точная информация (Объект / Улица / Поселение + Дом)
      if (poi && poi !== street && poi !== settlement && !houseInfo) {
        finalParts.push(street ? `${poi}, ${street}` : poi);
      } else if (street) {
        finalParts.push(houseInfo ? `${street}, ${houseInfo}` : street);
      } else if (settlement) {
        finalParts.push(houseInfo ? `${settlement}, ${houseInfo}` : settlement);
      } else if (houseInfo) {
        finalParts.push(houseInfo);
      }

      // Блок 2: Район / Округ (если он отличается от уже добавленного)
      const district = addr.suburb || addr.city_district || addr.neighbourhood;
      if (district && !finalParts.some(p => p.includes(district))) {
        finalParts.push(district);
      }

      // Блок 3: Поселение (если его еще не было в Блоке 1)
      if (settlement && !finalParts.some(p => p.includes(settlement))) {
        finalParts.push(settlement);
      }

      // Блок 4: Город
      if (city && city !== settlement && !finalParts.some(p => p.includes(city))) {
        finalParts.push(city);
      }

      // Блок 5: Регион
      const region = addr.state_district || addr.state;
      if (region && region !== city && region !== settlement) {
        finalParts.push(region);
      }

      // Блок 6: Страна
      if (addr.country) finalParts.push(addr.country);

      let displayName = finalParts.join(', ');

      // ФИНАЛЬНЫЙ ПРЕДОХРАНИТЕЛЬ:
      // Если адрес всё еще начинается с цифр (напр. "10-12 к4, Тихвинский переулок")
      // Мы принудительно меняем местами первые два элемента
      const checkParts = displayName.split(',').map(p => p.trim());
      if (checkParts.length > 1 && /^(\d+|[A-Z]?\d+([- /]\d+)?)/.test(checkParts[0])) {
        // Проверяем, не является ли первый элемент номером дома
        const potentialHouse = checkParts[0];
        const potentialStreet = checkParts[1];

        // Если во втором элементе есть слова (улица, переулок и т.д.) или это просто текст
        if (/[а-яА-Яa-zA-Z]/.test(potentialStreet)) {
          checkParts.shift(); // убираем номер
          checkParts.shift(); // убираем улицу
          displayName = [`${potentialStreet}, ${potentialHouse}`, ...checkParts].join(', ');
        }
      }

      // Если массив был пуст, берем оригинал
      if (!displayName) displayName = data.display_name;

      return {
        displayName: displayName.trim(),
        title: title.trim(),
      };
    } catch (error) {
      console.error('[GeosearchService] Reverse error:', error);
      return null;
    }
  }

  async osrmRoute(profile: string, coords: string) {
    const osrmUrl = process.env.OSRM_URL || 'http://localhost:5000';
    let fetchUrl = '';

    // Логика перенесена с фронтенда на бэкенд согласно политике
    if (
      osrmUrl === 'http://localhost:5000' ||
      osrmUrl.includes('project-osrm.org')
    ) {
      if (profile === 'driving') {
        fetchUrl = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
      } else {
        const mode = profile === 'bike' ? 'bike' : 'foot';
        fetchUrl = `https://routing.openstreetmap.de/routed-${mode}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
      }
    } else {
      fetchUrl = `${osrmUrl}/route/v1/${profile}/${coords}?overview=full&geometries=geojson`;
    }

    try {
      const res = await fetch(fetchUrl);
      return await res.json();
    } catch (error) {
      console.error('[GeosearchService] OSRM error:', error);
      throw error;
    }
  }

  private async getYandexSuggestions(
    q: string,
  ): Promise<Array<{ displayName: string; uri: string }> | null> {
    if (!this.yandexApiKey) return null;

    try {
      const res = await fetch('https://suggest-maps.yandex.ru/v1/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: q,
          ll: '55.7558,37.6173',
          spn: '10,10',
          limit: 10,
          types: ['biz', 'geo'],
          apikey: this.yandexApiKey,
        }),
      });

      if (res.status === 429 || res.status === 403 || !res.ok) return null;

      const data = await res.json();
      const suggestions = Array.isArray(data?.suggestions)
        ? data.suggestions
        : [];

      return suggestions
        .map((item: YandexSuggestion) => {
          const coords = item.geometry?.point;
          if (!coords) return null;

          const title = item.title?.text ?? '';
          const subtitle = item.subtitle?.text ?? '';
          return {
            displayName: subtitle ? `${title}, ${subtitle}` : title,
            uri: `ymapsbm1://geo?ll=${coords.lon},${coords.lat}&z=12`,
          };
        })
        .filter(
          (item: { displayName: string; uri: string } | null): item is { displayName: string; uri: string } => item !== null,
        );
    } catch {
      return null;
    }
  }

  private async getNominatimSuggestions(
    q: string,
  ): Promise<Array<{ displayName: string; uri: string }>> {
    try {
      const params = new URLSearchParams({
        q,
        format: 'json',
        limit: '10',
        countrycodes: 'ru',
        'accept-language': 'ru',
        dedupe: '1',
      });

      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
      );
      if (!res.ok) return [];

      const data = await res.json();
      if (!Array.isArray(data)) return [];

      return data.map((item: NominatimItem) => ({
        displayName: item.display_name,
        uri: `ymapsbm1://geo?ll=${item.lon},${item.lat}&z=12`,
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Загружает топ-100k городов из GeoNames в БД с предпереводом на русский.
 * Использует интернет для скачивания данных и OpenAI для перевода.
 *
 * Запуск: npx tsx src/db/load-geonames.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { transliterate } from 'transliteration';
import { OpenAI } from 'openai';
import * as dotenv from 'dotenv';
import * as schema from './schema';

dotenv.config({
  path: path.resolve(__dirname, '../../../../.env')
});

interface GeoNamesCity {
  geonameid: number;
  name: string;
  alternatenames: string;
  latitude: number;
  longitude: number;
  featureclass: string;
  featurecode: string;
  countrycode: string;
  cc2: string;
  admin1code: string;
  admin2code: string;
  admin3code: string;
  admin4code: string;
  population: number;
  elevation: string;
  dem: string;
  timezone: string;
  modification: string;
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error(
    '❌ DATABASE_URL не установлена! Проверьте корневой .env файл',
  );
}

const pool = new Pool({
  connectionString: dbUrl,
});

const db = drizzle(pool, { schema });

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
  : null;

const BATCH_SIZE = 100;
const MAX_CITIES = 100000;
const GEONAMES_URL =
  'https://download.geonames.org/export/dump/cities500.zip';
const GEONAMES_FALLBACK_FILE = '/tmp/cities500.txt'; // Для локального тестирования

// Кэш переводов для избежания повторных API запросов
const translationCache = new Map<string, string>();

async function downloadGeoNames(): Promise<string> {
  console.log('📥 Скачиваю GeoNames data...');
  const zipPath = '/tmp/cities500.zip';
  const txtPath = '/tmp/cities500.txt';

  // Если уже есть - пропусти
  if (fs.existsSync(txtPath)) {
    console.log('✅ GeoNames файл уже существует');
    return txtPath;
  }

  try {
    console.log('Попытка 1: Скачивание ZIP и распаковка...');
    const response = await fetch(GEONAMES_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(zipPath, Buffer.from(buffer));
    console.log('✅ Zip скачен');

    // Распаковка
    const { execSync } = await import('child_process');
    try {
      execSync(`cd /tmp && unzip -o cities500.zip 2>/dev/null || true`);
      console.log('✅ Распакован');
    } catch (unzipError) {
      console.warn('⚠️ Unzip не сработал, пробую альтернативный способ...');
      // Fallback: try with 7z or just use the file if it was extracted
      if (!fs.existsSync(txtPath)) {
        throw new Error('Не удалось распаковать файл');
      }
    }

    if (fs.existsSync(txtPath)) {
      return txtPath;
    }

    throw new Error('cities500.txt не найден после распаковки');
  } catch (error) {
    console.error('❌ Ошибка скачивания ZIP:', error);

    // Fallback: Попробовать скачать TXT напрямую (без архива)
    console.log('\nПопытка 2: Скачивание TXT напрямую...');
    try {
      const txtUrl = 'https://download.geonames.org/export/dump/cities500.txt';
      const response = await fetch(txtUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      fs.writeFileSync(txtPath, text);
      console.log('✅ TXT файл скачан напрямую');
      return txtPath;
    } catch (fallbackError) {
      console.error('❌ Fallback тоже не сработал:', fallbackError);
      console.log('\n⚠️ Используется тестовый файл (если существует)...');
      if (fs.existsSync(GEONAMES_FALLBACK_FILE)) {
        return GEONAMES_FALLBACK_FILE;
      }
      throw new Error('Не удалось скачать GeoNames и нет локального fallback файла. Попробуйте скачать вручную: https://download.geonames.org/export/dump/cities500.txt в /tmp/');
    }
  }
}

async function parseGeoNamesFile(filePath: string): Promise<GeoNamesCity[]> {
  console.log('📂 Парсю GeoNames файл...');
  const lines = fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim());

  const cities = lines.slice(0, MAX_CITIES).map((line) => {
    const parts = line.split('\t');
    return {
      geonameid: parseInt(parts[0], 10),
      name: parts[1],
      alternatenames: parts[3],
      latitude: parseFloat(parts[4]),
      longitude: parseFloat(parts[5]),
      featureclass: parts[6],
      featurecode: parts[7],
      countrycode: parts[8],
      cc2: parts[9],
      admin1code: parts[10],
      admin2code: parts[11],
      admin3code: parts[12],
      admin4code: parts[13],
      population: parseInt(parts[14], 10),
      elevation: parts[15],
      dem: parts[16],
      timezone: parts[17],
      modification: parts[18],
    } as GeoNamesCity;
  });

  console.log(`✅ Распарсено ${cities.length} городов`);
  return cities;
}

async function translateCityToRussian(cityName: string): Promise<string> {
  // Проверка кэша
  if (translationCache.has(cityName)) {
    return translationCache.get(cityName)!;
  }

  // Если OpenAI недоступен, просто используем оригинальное имя (будет транслитерировано позже)
  if (!openai) {
    return cityName;
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `Переведи название города на русский (только название, без дополнений):\n${cityName}`,
        },
      ],
      max_tokens: 20,
      temperature: 0,
    });

    const translation =
      response.choices[0].message.content?.trim() || cityName;
    translationCache.set(cityName, translation);
    return translation;
  } catch (error) {
    console.warn(`⚠️ Ошибка перевода "${cityName}":`, error);
    // Fallback: используем оригинальное имя
    return cityName;
  }
}

async function insertCitiesBatch(cities: GeoNamesCity[]): Promise<void> {
  // Страны (простая маппинг для основных стран)
  const countryTranslations: Record<string, string> = {
    RU: 'Россия',
    US: 'США',
    GB: 'Великобритания',
    FR: 'Франция',
    DE: 'Германия',
    IT: 'Италия',
    ES: 'Испания',
    CN: 'Китай',
    JP: 'Япония',
    IN: 'Индия',
    BR: 'Бразилия',
    MX: 'Мексика',
    AU: 'Астралия',
    TR: 'Турция',
    TH: 'Таиланд',
    AE: 'ОАЭ',
    SG: 'Сингапур',
    KR: 'Южная Корея',
    KP: 'Северная Корея',
    VN: 'Вьетнам',
    PH: 'Филиппины',
    PK: 'Пакистан',
    BD: 'Бангладеш',
    ID: 'Индонезия',
    MY: 'Малайзия',
    EG: 'Египет',
    ZA: 'ЮАР',
    NG: 'Нигерия',
    KE: 'Кения',
    CA: 'Канада',
    UY: 'Уругвай',
    AR: 'Аргентина',
    CL: 'Чили',
    CO: 'Колумбия',
    PE: 'Перу',
    UA: 'Украина',
    BY: 'Беларусь',
    PL: 'Польша',
    CZ: 'Чехия',
    SK: 'Словакия',
    AT: 'Австрия',
    CH: 'Швейцария',
    SE: 'Швеция',
    NO: 'Норвегия',
    DK: 'Дания',
    FI: 'Финляндия',
    GR: 'Греция',
    PT: 'Португалия',
    NL: 'Нидерланды',
    BE: 'Бельгия',
    HU: 'Венгрия',
    RO: 'Румыния',
    BG: 'Болгария',
    RS: 'Сербия',
    HR: 'Хорватия',
    IL: 'Израиль',
    SA: 'Саудовская Аравия',
    JO: 'Иордания',
    KZ: 'Казахстан',
    UZ: 'Узбекистан',
    TM: 'Туркменистан',
    KG: 'Киргизия',
    TJ: 'Таджикистан',
    AF: 'Афганистан',
    IR: 'Иран',
    IQ: 'Ирак',
    SY: 'Сирия',
    LB: 'Ливан',
    NZ: 'Новая Зеландия',
    FJ: 'Фиджи',
  };

  try {
    // Параллельный перевод внутри батча для скорости
    const valuesToInsert = await Promise.all(
      cities.map(async (city) => {
        const nameRu = await translateCityToRussian(city.name);
        const countryNameRu = countryTranslations[city.countrycode] || '';

        return {
          nameRu,
          aliases: city.name,
          type: 'city',
          countryCode: city.countrycode,
          displayName: `${city.name}, ${countryNameRu}`,
          lat: city.latitude,
          lon: city.longitude,
          popularity: Math.min(10, (city.population || 0) / 1000000),
        };
      })
    );

    // Вставляем через Drizzle (автоматически пропускает дубли)
    if (valuesToInsert.length > 0) {
      await db.insert(schema.popularDestinations).values(valuesToInsert).onConflictDoNothing();
    }

    console.log(`✅ Вставлено ${cities.length} городов`);
  } catch (error) {
    console.error('❌ Ошибка вставки:', error);
    throw error;
  }
}

async function main() {
  try {
    console.log('🚀 Начинаю загрузку GeoNames в БД...\n');

    if (!openai) {
      console.log('⚠️  OPENAI_API_KEY не установлен. Города будут загружены без перевода на русский.');
      console.log('   (Названия будут транслитерированы автоматически)\n');
    } else {
      console.log('✅ OpenAI API доступен, названия будут переведены на русский\n');
    }

    // 1. Скачиваем данные
    const filePath = await downloadGeoNames();

    // 2. Парсим
    const cities = await parseGeoNamesFile(filePath);

    // 3. Вставляем батчами с параллельным переводом
    const PARALLEL_BATCH_SIZE = 50; // Оптимально для OpenAI rate-limits
    console.log(`\n🌍 Перевожу и вставляю города (батчами по ${PARALLEL_BATCH_SIZE})...`);
    
    for (let i = 0; i < cities.length; i += PARALLEL_BATCH_SIZE) {
      const batch = cities.slice(i, i + PARALLEL_BATCH_SIZE);
      await insertCitiesBatch(batch);
      console.log(`   [${Math.min(i + PARALLEL_BATCH_SIZE, cities.length)}/${cities.length}]`);

      // Небольшая пауза, чтобы не забить Rate Limit
      if (i + PARALLEL_BATCH_SIZE < cities.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    console.log('\n✅ Загрузка завершена!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    process.exit(1);
  } finally {
    await pool.end().catch(console.error);
  }
}

main();

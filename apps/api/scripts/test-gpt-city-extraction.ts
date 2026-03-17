/**
 * Скрипт тестирует извлечение города из title/address через GPT-4o-mini
 *
 * Запуск: cd travel-planner/apps/api && npx ts-node scripts/test-gpt-city-extraction.ts
 */

import { Client } from 'pg';
import OpenAI from 'openai';

const OPENROUTER_API_KEY =
  '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';
const DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/travel_planner';

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

interface RoutePoint {
  id: string;
  trip_id: string;
  title: string | null;
  address: string | null;
  lat: number;
  lon: number;
}

interface CityExtractionResult {
  pointId: string;
  input: string;
  inputType: 'title' | 'address' | 'both';
  extractedCity: string | null;
  confidence: number;
  error?: string;
}

const CITY_EXTRACTION_PROMPT = `Ты — эксперт по извлечению названий городов из адресов и названий мест.

ЗАДАЧА:
Извлеки название города из предоставленного текста ИЛИ определи ближайший крупный город для туристического объекта.

ПРАВИЛА:
1. Возвращай ТОЛЬКО название города (населенного пункта) в именительном падеже.
2. Если это известный туристический объект — возвращай ближайший крупный город:
   - "Телецкое озеро" → "Горно-Алтайск" или "Артыбаш"
   - "Кижи" → "Петрозаводск"
   - "Приэльбрусье" → "Тырныауз" или "Нальчик"
   - "Красная Поляна" → "Сочи"
   - "Эльбрус" → "Тырныауз"
3. Если город не указан и не определяется — верни null.
4. Удаляй технические слова: "городской округ", "муниципальный округ", "район", "поселок", "село" и т.п.
5. Для сложных случаев (например, "Москва, Красная площадь") возвращай "Москва".

ПРИМЕРЫ:
- "Сочи, Курортный проспект" → "Сочи"
- "Казань, улица Баумана" → "Казань"
- "г.о. Красногорск, пос. Нахабино" → "Красногорск"
- "Москва, Смотровая площадка" → "Москва"
- "пос. городского типа Крымск" → "Крымск"
- "Телецкое озеро" → "Горно-Алтайск"
- "Кижи" → "Петрозаводск"
- "Красная Поляна" → "Сочи"
- "Приэльбрусье" → "Тырныауз"
- "г Москва" → "Москва"
- "Санкт-Петербург" → "Санкт-Петербург"

ФОРМАТ ОТВЕТА:
Верни JSON объект:
{
  "city": string | null,
  "confidence": number (0-1),
  "comment": string (краткое пояснение, если нужно)
}

ТЕКСТ ДЛЯ АНАЛИЗА:
`;

async function extractCityWithGPT(
  input: string,
): Promise<{ city: string | null; confidence: number; comment: string }> {
  try {
    const response = await openai.chat.completions.create({
      model: 'openai/gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Ты извлекаешь названия городов из адресов. Возвращай ТОЛЬКО валидный JSON.',
        },
        { role: 'user', content: CITY_EXTRACTION_PROMPT + input },
      ],
      temperature: 0.1,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      return { city: null, confidence: 0, comment: 'Empty response' };
    }

    // Пытаемся распарсить JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Пробуем извлечь город из простого ответа
      return {
        city: content.replace(/["{}]/g, '').trim() || null,
        confidence: 0.5,
        comment: 'Parsed from text',
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    return {
      city: result.city ?? null,
      confidence: result.confidence ?? 0.5,
      comment: result.comment ?? '',
    };
  } catch (error) {
    throw new Error(
      `GPT request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getRoutePointsFromDB(): Promise<RoutePoint[]> {
  const client = new Client(DATABASE_URL);

  try {
    await client.connect();

    // Берем все точки для полного тестирования
    const result = await client.query<RoutePoint>(`
      SELECT id, trip_id, title, address, lat, lon 
      FROM route_points 
      ORDER BY lat, lon 
      LIMIT 100
    `);

    return result.rows;
  } finally {
    await client.end();
  }
}

async function main() {
  console.log('🔍 Тестирование извлечения города через GPT-4o-mini\n');
  console.log('Загрузка точек из БД...');

  const points = await getRoutePointsFromDB();
  console.log(`✅ Загружено ${points.length} точек\n`);

  const results: CityExtractionResult[] = [];

  for (const point of points) {
    const input = point.title || point.address || '';
    const inputType =
      point.title && point.address ? 'both' : point.title ? 'title' : 'address';

    if (!input) {
      results.push({
        pointId: point.id,
        input: '',
        inputType,
        extractedCity: null,
        confidence: 0,
        error: 'No title or address',
      });
      continue;
    }

    console.log(`📍 Точка ${point.id}: "${input}"`);

    try {
      const { city, confidence, comment } = await extractCityWithGPT(input);

      results.push({
        pointId: point.id,
        input,
        inputType,
        extractedCity: city,
        confidence,
      });

      console.log(
        `   → Город: ${city ?? '❌ не найден'} (уверенность: ${(confidence * 100).toFixed(0)}%)\n`,
      );
    } catch (error) {
      results.push({
        pointId: point.id,
        input,
        inputType,
        extractedCity: null,
        confidence: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      console.log(`   → ❌ Ошибка: ${error}\n`);
    }
  }

  // Вывод сводной таблицы
  console.log('\n' + '='.repeat(100));
  console.log('📊 СВОДНАЯ ТАБЛИЦА РЕЗУЛЬТАТОВ');
  console.log('='.repeat(100));
  console.table(
    results.map((r) => ({
      ID: r.pointId.slice(0, 8) + '...',
      'Входные данные':
        r.input.length > 50 ? r.input.slice(0, 47) + '...' : r.input,
      Тип: r.inputType,
      Город: r.extractedCity ?? '❌',
      Уверенность: `${(r.confidence * 100).toFixed(0)}%`,
      Ошибка: r.error ?? '-',
    })),
  );

  // Статистика
  const successCount = results.filter(
    (r) => r.extractedCity && r.confidence >= 0.7,
  ).length;
  const partialCount = results.filter(
    (r) => r.extractedCity && r.confidence < 0.7,
  ).length;
  const nullCount = results.filter((r) => r.extractedCity === null).length;
  const failCount = results.filter(
    (r) => !r.extractedCity && r.confidence === 0,
  ).length;

  console.log('\n📈 СТАТИСТИКА:');
  console.log(
    `  ✅ Успешно (уверенность ≥70%): ${successCount} (${((successCount / results.length) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  ⚠️  Частично (уверенность <70%): ${partialCount} (${((partialCount / results.length) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  🔶 Null (возвратили null): ${nullCount} (${((nullCount / results.length) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  ❌ Не найдено (ошибка/пусто): ${failCount} (${((failCount / results.length) * 100).toFixed(0)}%)`,
  );

  // Покажем уникальные города
  const uniqueCities = [
    ...new Set(
      results
        .filter((r) => r.extractedCity)
        .map((r) => r.extractedCity as string),
    ),
  ].sort();
  console.log('\n🌍 УНИКАЛЬНЫЕ ГОРОДА:');
  console.log(`  Всего найдено городов: ${uniqueCities.length}`);
  console.log(`  Список: ${uniqueCities.join(', ')}`);
}

main().catch(console.error);

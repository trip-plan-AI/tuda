import { Client } from 'pg';
import OpenAI from 'openai';

const DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/travel_planner';
const OPENROUTER_API_KEY = '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';

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

const CITY_EXTRACTION_PROMPT = `Ты — эксперт по извлечению названий городов из адресов и названий мест.

ЗАДАЧА:
Извлеки название города из предоставленного текста ИЛИ определи ближайший крупный город для туристического объекта.

ПРАВИЛА:
1. Возвращай ТОЛЬКО название города (населенного пункта) в именительном падеже.
2. Если это известный туристический объект — возвращай ближайший крупный город:
   - "Телецкое озеро" → "Горно-Алтайск"
   - "Кижи" → "Петрозаводск"
   - "Приэльбрусье" → "Тырныауз"
   - "Красная Поляна" → "Сочи"
   - "Эльбрус" → "Тырныауз"
   - "Чегемские водопады" → "Нальчик"
   - "Долина Нарзанов" → "Кисловодск"
   - "Безенгийская стена" → "Нальчик"
   - "Голубые озёра" → "Нальчик" (Кабардино-Балкария)
   - "Навалищенское ущелье" → "Сочи"
   - "Курайская степь" → "Горно-Алтайск" (Республика Алтай)
   - "Чуйский тракт" → "Горно-Алтайск"
   - "Гора Белуха" → "Горно-Алтайск"
   - "Катунь и Мультинские озёра" → "Горно-Алтайск"
   - "Долина Чулышман" → "Горно-Алтайск"
   - "Тисо-самшитовая роща" → "Сочи"
   - "Агурские водопады" → "Сочи"
   - "Олимпийский парк" → "Сочи"
   - "Дендрарий" → "Сочи"
3. Если указан регион без города — возвращай столицу региона.
4. Если город не указан и не определяется — верни null.

ФОРМАТ ОТВЕТА:
Верни ТОЛЬКО JSON объект без markdown:
{
  "city": string | null,
  "region": string | null,
  "confidence": number (0-1),
  "comment": string (краткое пояснение)
}

ТЕКСТ ДЛЯ АНАЛИЗА:
`;

async function extractCity(input: string) {
  const response = await openai.chat.completions.create({
    model: 'openai/gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Ты извлекаешь названия городов из адресов. Возвращай ТОЛЬКО валидный JSON без markdown.' },
      { role: 'user', content: CITY_EXTRACTION_PROMPT + input }
    ],
    temperature: 0.1,
    max_tokens: 250,
  });

  const content = response.choices[0]?.message?.content?.trim();
  const jsonMatch = content?.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { city: null, region: null, confidence: 0, comment: 'Invalid JSON' };
  
  return JSON.parse(jsonMatch[0]);
}

async function testReverseGeocoding(lat: number, lon: number) {
  const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&accept-language=ru`;
  const response = await fetch(nominatimUrl, {
    headers: { 'User-Agent': 'TravelPlanner/1.0' },
  });

  if (!response.ok) return null;
  
  const data = await response.json();
  const addr = data?.address;
  
  return addr?.city || addr?.town || addr?.village || addr?.state_district || addr?.county || null;
}

async function main() {
  const tripId = '1e05e3a6-ef00-4822-b5d1-8971f8db8b2e';
  
  console.log(`🔍 Тестируем маршрут: ${tripId}\n`);
  
  const client = new Client(DATABASE_URL);
  await client.connect();
  
  const trip = await client.query('SELECT id, title, img FROM trips WHERE id = $1', [tripId]);
  console.log(`📍 Trip: ${trip.rows[0]?.title || 'not found'}`);
  console.log(`   Current img: ${trip.rows[0]?.img || 'null'}\n`);
  
  const points = await client.query(
    'SELECT id, title, address, lat, lon FROM route_points WHERE trip_id = $1 ORDER BY "order"',
    [tripId]
  );
  
  console.log(`📍 Points: ${points.rows.length}\n`);
  
  for (const point of points.rows) {
    console.log(`---\nPoint: "${point.title}"`);
    console.log(`Address: "${point.address}"`);
    console.log(`Coords: ${point.lat}, ${point.lon}`);
    
    // Контур 1: Reverse Geocoding
    console.log('\n🔍 Контур 1: Reverse Geocoding...');
    const reverseCity = await testReverseGeocoding(point.lat, point.lon);
    console.log(`   Result: ${reverseCity || 'null'}`);
    
    // Контур 2: GPT fallback
    if (!reverseCity) {
      console.log('\n🔍 Контур 2: GPT-4o-mini fallback...');
      const input = point.title || point.address || '';
      const gptResult = await extractCity(input);
      console.log(`   Input: "${input}"`);
      console.log(`   GPT Result: ${gptResult.city || 'null'} (region: ${gptResult.region || 'N/A'}, confidence: ${(gptResult.confidence * 100).toFixed(0)}%)`);
    }
    
    console.log('');
  }
  
  await client.end();
}

main().catch(console.error);

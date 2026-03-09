import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';

// Загружаем ENV из корня проекта (путь к travel-planner/.env относительно запущенного файла)
config({ path: path.resolve(__dirname, '../../../../../.env') });

const YANDEX_GPT_API_KEY = process.env.YANDEX_GPT_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

if (!YANDEX_GPT_API_KEY || !YANDEX_FOLDER_ID || !OPENROUTER_API_KEY) {
  console.error('Missing API keys in .env');
  process.exit(1);
}

// Заглушка типов POI
type PoiItem = {
  id: string;
  name: string;
  category: string;
  rating?: number;
  description?: string; // для результата
};

// 3 тестовых набора
const TEST_CASES = [
  {
    name: 'Сценарий 1: Семья с детьми, парки и развлечения',
    intent: {
      preferences_text:
        'Хотим погулять на свежем воздухе и чтобы детям было интересно. Бюджет средний.',
      party_type: 'family',
      budget_total: 5000,
    },
    pois: [
      { id: '1', name: 'Парк Горького', category: 'park', rating: 4.8 },
      {
        id: '2',
        name: 'Музей современного искусства',
        category: 'museum',
        rating: 4.5,
      },
      {
        id: '3',
        name: 'Московский зоопарк',
        category: 'entertainment',
        rating: 4.7,
      },
      {
        id: '4',
        name: 'Ресторан "Пушкин"',
        category: 'restaurant',
        rating: 4.9,
      },
      { id: '5', name: 'Кафе "Андерсон"', category: 'cafe', rating: 4.6 },
      { id: '6', name: 'Красная площадь', category: 'attraction', rating: 4.9 },
      { id: '7', name: 'Планетарий', category: 'entertainment', rating: 4.6 },
      { id: '8', name: 'ТЦ "Европейский"', category: 'shopping', rating: 4.2 },
      { id: '9', name: 'Парк Зарядье', category: 'park', rating: 4.8 },
      {
        id: '10',
        name: 'Третьяковская галерея',
        category: 'museum',
        rating: 4.7,
      },
    ],
  },
  {
    name: 'Сценарий 2: Молодая пара, романтика и вкусная еда',
    intent: {
      preferences_text:
        'Ищем красивые романтичные места для вечерних прогулок и шикарный ужин с видом.',
      party_type: 'couple',
      budget_total: 15000,
    },
    pois: [
      {
        id: '1',
        name: 'Ресторан White Rabbit',
        category: 'restaurant',
        rating: 4.9,
      },
      { id: '2', name: 'Патриаршие пруды', category: 'park', rating: 4.8 },
      { id: '3', name: 'Бар Клава', category: 'restaurant', rating: 4.5 },
      { id: '4', name: 'Крейсер "Аврора"', category: 'museum', rating: 4.6 },
      { id: '5', name: 'Кафе Зингер', category: 'cafe', rating: 4.7 },
      { id: '6', name: 'Мост влюбленных', category: 'attraction', rating: 4.4 },
      {
        id: '7',
        name: 'Смотровая площадка Москва-Сити',
        category: 'attraction',
        rating: 4.8,
      },
      {
        id: '8',
        name: 'Квест-комната',
        category: 'entertainment',
        rating: 4.1,
      },
      { id: '9', name: 'Эрмитаж', category: 'museum', rating: 4.9 },
      {
        id: '10',
        name: 'Ресторан Карлсон',
        category: 'restaurant',
        rating: 4.7,
      },
    ],
  },
  {
    name: 'Сценарий 3: Соло-путешественник, жесткая экономия, история',
    intent: {
      preferences_text:
        'Я люблю историю и архитектуру, денег почти нет, хожу пешком.',
      party_type: 'solo',
      budget_total: 1000,
    },
    pois: [
      {
        id: '1',
        name: 'Бесплатный музей метро',
        category: 'museum',
        rating: 4.5,
      },
      {
        id: '2',
        name: 'Исторический центр',
        category: 'attraction',
        rating: 4.9,
      },
      {
        id: '3',
        name: 'Ресторан "Турандот"',
        category: 'restaurant',
        rating: 4.8,
      },
      { id: '4', name: 'Столовая №1', category: 'cafe', rating: 4.1 },
      { id: '5', name: 'Парк Победы', category: 'park', rating: 4.7 },
      { id: '6', name: 'Музей Фаберже', category: 'museum', rating: 4.9 },
      {
        id: '7',
        name: 'Дворцовая площадь',
        category: 'attraction',
        rating: 4.9,
      },
      { id: '8', name: 'ТРЦ Галерея', category: 'shopping', rating: 4.5 },
      { id: '9', name: 'Пышечная на Желябова', category: 'cafe', rating: 4.8 },
      {
        id: '10',
        name: 'Парк аттракционов Диво Остров',
        category: 'entertainment',
        rating: 4.6,
      },
    ],
  },
];

function buildPrompt(pois: PoiItem[], intent: any): string {
  return `Выбери от 3 до 5 самых подходящих мест для посещения.
Предпочтения: ${intent.preferences_text}
Тип группы: ${intent.party_type}
Бюджет: ${intent.budget_total ?? 'не указан'} руб.

Список мест (JSON):
${JSON.stringify(
  pois.map((poi, index) => ({
    id: String(index + 1),
    name: poi.name,
    category: poi.category,
    rating: poi.rating,
  })),
  null,
  2,
)}

КРИТИЧЕСКИ ВАЖНО:
1. Используй ТОЛЬКО значение поля "id" из списка мест выше.
2. Верни только JSON без markdown (без \`\`\`json):
{
  "selected": [
    { "id": "1", "description": "1-2 предложения на русском о месте, почему оно подходит под запрос" }
  ]
}`;
}

async function askYandexGPT(prompt: string) {
  const response = await fetch(
    'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
    {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${YANDEX_GPT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        modelUri: `gpt://${YANDEX_FOLDER_ID}/yandexgpt-lite`,
        completionOptions: { stream: false, temperature: 0.2, maxTokens: 2000 },
        messages: [{ role: 'user', text: prompt }],
      }),
    },
  );

  if (!response.ok)
    throw new Error(
      `YandexGPT error: ${response.status} ${await response.text()}`,
    );
  const data = await response.json();
  const text = data.result?.alternatives?.[0]?.message?.text ?? '{}';
  return JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
}

async function askOpenRouter(prompt: string) {
  const response = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'Ты отбираешь POI для маршрута. Верни только JSON формата {"selected":[{"id":"...","description":"..."}]} без markdown.',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      }),
    },
  );

  if (!response.ok)
    throw new Error(
      `OpenRouter error: ${response.status} ${await response.text()}`,
    );
  const data = await response.json();
  const text = data.choices[0]?.message?.content ?? '{}';
  return JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
}

async function runTests() {
  console.log('Starting A/B test: YandexGPT vs GPT-4o-mini\n');

  for (const t of TEST_CASES) {
    console.log(`===========================================`);
    console.log(`📝 ${t.name}`);
    console.log(`Предпочтения: "${t.intent.preferences_text}"`);
    console.log(`===========================================\n`);

    const prompt = buildPrompt(t.pois, t.intent);

    try {
      console.log('🤖 Запрос к YandexGPT...');
      const yandexStart = Date.now();
      const yandexRes = await askYandexGPT(prompt);
      const yandexTime = Date.now() - yandexStart;
      console.log(`✅ YandexGPT ответил за ${yandexTime}ms:`);

      yandexRes.selected.forEach((item: any) => {
        const poi = t.pois[Number(item.id) - 1];
        console.log(`  - [${poi.name}] (${poi.category}): ${item.description}`);
      });
    } catch (e: any) {
      console.error(`❌ YandexGPT Error: ${e.message}`);
    }

    console.log('\n-------------------------------------------\n');

    try {
      console.log('🤖 Запрос к GPT-4o-mini (OpenRouter)...');
      const openRouterStart = Date.now();
      const openRouterRes = await askOpenRouter(prompt);
      const openRouterTime = Date.now() - openRouterStart;
      console.log(`✅ GPT-4o-mini ответил за ${openRouterTime}ms:`);

      openRouterRes.selected.forEach((item: any) => {
        const poi = t.pois[Number(item.id) - 1];
        console.log(
          `  - [${poi?.name || 'Unknown'}] (${poi?.category || 'unknown'}): ${item.description}`,
        );
      });
    } catch (e: any) {
      console.error(`❌ GPT-4o-mini Error: ${e.message}`);
    }

    console.log('\n\n');
  }
}

runTests().catch(console.error);

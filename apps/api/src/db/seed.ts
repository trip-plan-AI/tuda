import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import * as schema from './schema';
import * as bcrypt from 'bcrypt';
import { DESTINATIONS } from './seed-destinations';

const SYSTEM_EMAIL = 'system@travel-planner.local';
const SYSTEM_PASSWORD = 'system-no-login';

const TOURS = [
  {
    title: 'Сочи: Горы и Море',
    description:
      'Идеальный баланс: 2 дня в горах, 3 дня на побережье с живописными видами.',
    budget: 45000,
    img: '/assets/images/sochi.webp',
    tags: ['⚡ Активный', 'РФ'],
    temp: '+15°',
    slug: 'sochi',
    attractions: [
      {
        title: 'Красная Поляна',
        description:
          'Горнолыжный курорт мирового уровня с трассами для любого уровня подготовки. Зимой — лыжи и сноуборд, летом — трекинг и скай-парки с захватывающими видами на Кавказский хребет.',
        price: 15000,
        lat: 43.6819,
        lon: 40.2045,
      },
      {
        title: 'Олимпийский парк',
        description:
          'Наследие зимних Олимпийских игр 2014 года — уникальный комплекс стадионов и арен у берега Чёрного моря. Здесь проходят концерты, гонки «Формулы-1» и крупнейшие выставки России.',
        price: 5000,
        lat: 43.4033,
        lon: 39.9556,
      },
      {
        title: 'Тисо-самшитовая роща',
        description:
          'Реликтовый лес возрастом более 30 миллионов лет, сохранившийся с доледниковой эпохи. Пешие тропы проведут вас сквозь вековые тисы и самшиты, мхи и папоротники — настоящие живые ископаемые.',
        price: 2000,
        lat: 43.5267,
        lon: 39.8747,
      },
      {
        title: 'Агурские водопады',
        description:
          'Каскад из трёх живописных водопадов в скалистом ущелье реки Агуры. Маршрут к ним проходит через субтропические джунгли и открывает вид на орлиные скалы и Орлиные стражи.',
        price: 3000,
        lat: 43.5592,
        lon: 39.8256,
      },
      {
        title: 'Дендрарий',
        description:
          'Один из лучших ботанических садов России, основанный в 1892 году. Поднимитесь на канатной дороге к верхнему парку и прогуляйтесь среди экзотических деревьев с видом на море.',
        price: 4000,
        lat: 43.5763,
        lon: 39.7339,
      },
      {
        title: 'Навалищенское ущелье',
        description:
          'Живописное ущелье с бирюзовой горной рекой, водопадами и скалами высотой до 100 метров. Популярное место для каньонинга, верёвочных переправ и фотосессий среди нетронутой природы.',
        price: 16000,
        lat: 43.5536,
        lon: 39.896,
      },
    ],
  },
  {
    title: 'Алтай: Золотые Горы',
    description: 'Дикая природа, бирюзовая Катунь и бескрайние степи Алтая.',
    budget: 55000,
    img: '/assets/images/altay.webp',
    tags: ['⚡ Активный', 'РФ'],
    temp: '+8°',
    slug: 'altay',
    attractions: [
      {
        title: 'Телецкое озеро',
        description:
          'Самое большое озеро Алтая и одно из глубочайших в России — природная жемчужина с кристально чистой водой и нетронутой тайгой по берегам. Водопад Корбу в конце озера поразит вас своей мощью.',
        price: 10000,
        lat: 51.7814,
        lon: 87.2742,
      },
      {
        title: 'Чуйский тракт',
        description:
          'Один из красивейших автомобильных маршрутов мира по версии National Geographic. Дорога ведёт сквозь горные перевалы, степи и долины Катуни — каждый поворот открывает новую панораму.',
        price: 8000,
        lat: 50.3,
        lon: 87.7,
      },
      {
        title: 'Долина Чулышман',
        description:
          'Грандиозный каньон глубиной более километра с отвесными скалами и редкими базальтовыми столбами — «Каменными грибами». Сюда добираются немногие, и именно это делает долину особенной.',
        price: 15000,
        lat: 50.9112,
        lon: 88.2175,
      },
      {
        title: 'Гора Белуха',
        description:
          'Высочайшая точка Сибири (4506 м) и сакральное место для буддистов. К подножию ведут трекинговые маршруты через альпийские луга — здесь можно увидеть ледники и вечные снега.',
        price: 12000,
        lat: 49.807,
        lon: 86.5897,
      },
      {
        title: 'Катунь и Мультинские озёра',
        description:
          'Бирюзовые воды реки Катунь разлиты среди скалистых берегов. Недалеко — цепочка Мультинских озёр с водопадами, соединяющими их, — место, от которого перехватывает дыхание.',
        price: 7000,
        lat: 51.285,
        lon: 86.592,
      },
      {
        title: 'Курайская степь',
        description:
          'Высокогорная степь на высоте 1500 м с панорамным видом на Северо-Чуйский хребет. Осенью трава становится золотой, а снежные пики создают контраст — идеальный кадр для фотографа.',
        price: 3000,
        lat: 50.2167,
        lon: 87.9,
      },
    ],
  },
  {
    title: 'Карелия Winter',
    description:
      'Северные озёра, зимние активности и уютные локации для камерного отдыха.',
    budget: 42500,
    img: '/assets/images/karelia.webp',
    tags: ['❄️ Зима', 'РФ'],
    temp: '-3°',
    slug: 'karelia',
    attractions: [
      {
        title: 'Кижи',
        description:
          'Объект всемирного наследия ЮНЕСКО — остров с уникальным архитектурным ансамблем из деревянных церквей XVIII века. Двадцатидвухглавая Преображенская церковь построена без единого гвоздя.',
        price: 8500,
        lat: 62.0833,
        lon: 34.5,
      },
      {
        title: 'Водопад Кивач',
        description:
          'Один из крупнейших равнинных водопадов Европы, воспетый Державиным. Падение воды с высоты 11 метров создаёт постоянный гул и облако брызг — особенно впечатляет в период весеннего паводка.',
        price: 3000,
        lat: 62.2681,
        lon: 33.9803,
      },
      {
        title: 'Ладожские шхеры',
        description:
          'Лабиринт из тысяч скалистых островков и проливов в северной части Ладожского озера. Путешествие на байдарке или катере среди розового гранита и сосен — незабываемый опыт.',
        price: 12000,
        lat: 61.6,
        lon: 30.8333,
      },
      {
        title: 'Рускеала',
        description:
          'Мраморный горный парк в живописном каньоне — бывший финский карьер, затопленный грунтовыми водами. Зимой здесь устраивают световые шоу, летом — снорклинг в прозрачной изумрудной воде.',
        price: 7000,
        lat: 61.9458,
        lon: 30.5756,
      },
      {
        title: 'Петрозаводск',
        description:
          'Столица Карелии на берегу Онежского озера с набережной, украшенной скульптурами городов-побратимов. Отсюда отходят суда на Кижи, а местные рестораны угощают карельской кухней — рыбой и калитками.',
        price: 8000,
        lat: 61.7849,
        lon: 34.3469,
      },
      {
        title: 'Белые ночи на Онего',
        description:
          'С конца мая по начало июля солнце почти не заходит — небо окрашивается в перламутровые тона, а озеро превращается в зеркало. Наблюдать рассвет в 2 ночи на берегу Онего — особое карельское удовольствие.',
        price: 4000,
        lat: 61.8,
        lon: 34.3833,
      },
    ],
  },
  {
    title: 'Кавказ Peaks',
    description:
      'Высокогорные маршруты и захватывающие виды для любителей эмоций.',
    budget: 68800,
    img: '/assets/images/kavkaz.webp',
    tags: ['⛰️ Экстрим', 'РФ'],
    temp: '+5°',
    slug: 'kavkaz',
    attractions: [
      {
        title: 'Приэльбрусье',
        description:
          'Высочайшая точка России и Европы (5642 м) возвышается над Баксанской долиной. Канатная дорога поднимает на станцию «Мир» (3500 м) — отсюда открывается панорама Большого Кавказа на сотни километров.',
        price: 18800,
        lat: 43.325,
        lon: 42.455,
      },
      {
        title: 'Чегемские водопады',
        description:
          'Веер из нескольких водопадов, ниспадающих прямо со скальных стен Чегемского ущелья. Зимой они замерзают, образуя исполинские ледяные колонны — фантастическое природное зрелище.',
        price: 5000,
        lat: 43.4167,
        lon: 43.2167,
      },
      {
        title: 'Голубые озёра',
        description:
          'Пять карстовых озёр с водой невероятного бирюзово-синего цвета, не замерзающих даже в сильные морозы. Нижнее Голубое — одно из самых глубоких озёр мира (258 м) при небольших размерах.',
        price: 4000,
        lat: 43.2327,
        lon: 43.539,
      },
      {
        title: 'Верхняя Балкария',
        description:
          'Высокогорное балкарское село, окружённое снежными вершинами. Средневековые башни-крепости, сохранившиеся на склонах, и традиционные блюда в местных кафе создают атмосферу другого века.',
        price: 10000,
        lat: 43.137,
        lon: 43.47,
      },
      {
        title: 'Безенгийская стена',
        description:
          'Самый высокий горный массив России — цепь вершин высотой более 5000 м протяжённостью 12 км. Отправная точка для альпинистов и место паломничества фотографов за идеальными кадрами.',
        price: 25000,
        lat: 43.05,
        lon: 43.1333,
      },
      {
        title: 'Долина Нарзанов',
        description:
          'В Приэльбрусье бьют десятки холодных нарзанных источников разного состава и вкуса. Прогулка по долине среди пузырящихся минеральных ключей — уникальный природный спа-опыт.',
        price: 6000,
        lat: 43.325,
        lon: 42.615,
      },
    ],
  },
];

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  console.log('Seeding predefined tours...\n');

  let systemUser = await db.query.users.findFirst({
    where: eq(schema.users.email, SYSTEM_EMAIL),
  });

  if (!systemUser) {
    const hash = await bcrypt.hash(SYSTEM_PASSWORD, 10);
    const [created] = await db
      .insert(schema.users)
      .values({ email: SYSTEM_EMAIL, passwordHash: hash, name: 'System' })
      .returning();
    systemUser = created;
    console.log('Created system user:', systemUser.id);
  } else {
    console.log('System user exists:', systemUser.id);
  }

  await db.delete(schema.trips).where(eq(schema.trips.isPredefined, true));
  console.log('Cleared old predefined trips\n');

  for (const tour of TOURS) {
    const [trip] = await db
      .insert(schema.trips)
      .values({
        title: tour.title,
        description: tour.description,
        budget: tour.budget,
        ownerId: systemUser.id,
        isPredefined: true,
        img: tour.img,
        tags: tour.tags,
        temp: tour.temp,
      })
      .returning();

    console.log(`Tour: ${trip.title} (${trip.id})`);

    const pointValues = tour.attractions.map((attr, idx) => ({
      tripId: trip.id,
      title: attr.title,
      description: attr.description,
      lat: attr.lat,
      lon: attr.lon,
      budget: attr.price,
      imageUrl: `/assets/tours/${tour.slug}/attraction-${idx}.webp`,
      order: idx,
    }));

    await db.insert(schema.routePoints).values(pointValues);
    console.log(`  → ${pointValues.length} attractions inserted`);
  }

  console.log('\nChecking popular destinations...');
  const existingCountResult = await db.select({ count: sql<number>`count(*)` }).from(schema.popularDestinations);
  const existingCount = Number(existingCountResult[0]?.count || 0);
  
  if (existingCount > 1000) {
    console.log(`Popular destinations already seeded (${existingCount} records). Skipping large seed.`);
  } else {
    console.log('Seeding popular destinations from compressed dump...');
    const dumpPath = path.join(__dirname, 'popular_destinations.json.gz');
    if (fs.existsSync(dumpPath)) {
      const compressed = fs.readFileSync(dumpPath);
      const decompressed = zlib.gunzipSync(compressed);
      const destinations = JSON.parse(decompressed.toString());
      
      const CHUNK_SIZE = 500;
      for (let i = 0; i < destinations.length; i += CHUNK_SIZE) {
        const chunk = destinations.slice(i, i + CHUNK_SIZE);
        await db.insert(schema.popularDestinations).values(chunk).onConflictDoNothing();
        if (i % 5000 === 0) {
          console.log(`  → Inserted ${i} / ${destinations.length}`);
        }
      }
      console.log(`Inserted ${destinations.length} popular destinations from dump.`);
    } else {
      console.log('Dump file not found, using small seed-destinations.ts fallback...');
      const destinationChunks: (typeof DESTINATIONS)[] = [];
      const CHUNK_SIZE = 50;
      for (let i = 0; i < DESTINATIONS.length; i += CHUNK_SIZE) {
        destinationChunks.push(DESTINATIONS.slice(i, i + CHUNK_SIZE));
      }

      for (const chunk of destinationChunks) {
        await db.insert(schema.popularDestinations).values(chunk).onConflictDoNothing();
      }
      console.log(`Inserted ${DESTINATIONS.length} popular destinations from fallback.`);
    }
  }

  console.log('\nSeed completed!');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

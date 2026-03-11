import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Из apps/api/src/db/ три уровня вверх = apps/, затем web/public/assets/tours
const TOURS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'web',
  'public',
  'assets',
  'tours',
);

interface PhotoEntry {
  slug: string;
  index: number;
  url: string;
}

const PHOTOS: PhotoEntry[] = [
  // Sochi
  {
    slug: 'sochi',
    index: 0,
    url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80',
  },
  {
    slug: 'sochi',
    index: 1,
    url: 'https://images.unsplash.com/photo-1574691250077-03a929faece5?w=800&q=80',
  },
  {
    slug: 'sochi',
    index: 2,
    url: 'https://rider-skill.ru/wp-content/uploads/2019/01/tiso-2.jpg',
  },
  {
    slug: 'sochi',
    index: 3,
    url: 'https://rider-skill.ru/wp-content/uploads/2019/01/agura-2.jpg',
  },
  {
    slug: 'sochi',
    index: 4,
    url: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=800&q=80',
  },
  {
    slug: 'sochi',
    index: 5,
    url: 'https://kukarta.ru/navalishhenskoe-ushhele/_mg_9304-kopiya',
  },
  // Altay
  { slug: 'altay', index: 0, url: 'https://trackt.ru/images/blog/telec2.jpg' },
  {
    slug: 'altay',
    index: 1,
    url: 'https://b1.vpoxod.ru/ckeditor/6d/d2/34/146880.jpg',
  },
  {
    slug: 'altay',
    index: 2,
    url: 'https://s12.stc.all.kpcdn.net/russia/wp-content/uploads/2025/01/CHulyshmanskaya-dolina-na-Altae-foto.jpg',
  },
  {
    slug: 'altay',
    index: 3,
    url: 'https://rgo.ru/upload/content_block/images/aa9fa9da148937fdfe5aaea15e772501/67eea5429321a705898c19d5f19354b9e.jpg',
  },
  {
    slug: 'altay',
    index: 4,
    url: 'https://altaicholmon.ru/wp-content/uploads/2018/10/mult1.jpg',
  },
  {
    slug: 'altay',
    index: 5,
    url: 'https://cs9.pikabu.ru/post_img/big/2016/10/09/8/1476017298160424896.jpg',
  },
  // Karelia
  {
    slug: 'karelia',
    index: 0,
    url: 'https://img7.arrivo.ru/cfcd/81/206/1/icom_russia_state_museum_kizhi2.jpg',
  },
  {
    slug: 'karelia',
    index: 1,
    url: 'https://media-1.gorbilet.com/69/09/eb/a7/5e/c8/shutterstock_1219908790_1_UixLZgr.jpg',
  },
  {
    slug: 'karelia',
    index: 2,
    url: 'https://im.bolshayastrana.com/1200x00/b0a03c8a36eb1616ed4f2509e48baf30798a290cc5a7604b6af16982bc6cc7f2.jpeg',
  },
  {
    slug: 'karelia',
    index: 3,
    url: 'https://resize.tripster.ru/-7pvgD-sb88zkCw425vAmK-bdUc=/fit-in/800x600/filters:no_upscale()/https://cdn.tripster.ru/photos/f5f76758-a882-490a-9321-824a20b5890d.png',
  },
  {
    slug: 'karelia',
    index: 4,
    url: 'https://static.tildacdn.com/tild6435-3264-4937-a637-303366333135/photo.jpg',
  },
  {
    slug: 'karelia',
    index: 5,
    url: 'https://sorola.ru/upload/medialibrary/82d/82de5f694484c9cb93b6e04fffb7c904.jpg',
  },
  // Kavkaz
  {
    slug: 'kavkaz',
    index: 0,
    url: 'https://ic.pics.livejournal.com/mg5642/66429722/3172696/3172696_original.jpg',
  },
  {
    slug: 'kavkaz',
    index: 1,
    url: 'https://resize.tripster.ru/rowd1rhtW9fswhgsZBxdrLc5qHU=/fit-in/600x800/filters:no_upscale()/https://cdn.tripster.ru/photos/43ca4123-5bfb-46b1-b97d-0d145feb070b.jpg?width=1200&height=630',
  },
  {
    slug: 'kavkaz',
    index: 2,
    url: 'https://turby.by/images/06.2024/Screenshot_6015.jpg',
  },
  {
    slug: 'kavkaz',
    index: 3,
    url: 'https://mashuk-tour.ru/wp-content/uploads/2020/03/Чегемское-ущелье-2.jpg',
  },
  {
    slug: 'kavkaz',
    index: 4,
    url: 'https://photocentra.ru/images/main120/1205828_main.jpg',
  },
  {
    slug: 'kavkaz',
    index: 5,
    url: 'https://extraguide.ru/images/sp/d922ebf6933350b207736b2877edc836441b6362.jpg',
  },
];

async function downloadPhoto(entry: PhotoEntry): Promise<void> {
  const dir = join(TOURS_DIR, entry.slug);
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, `attraction-${entry.index}.webp`);

  const res = await fetch(entry.url);
  if (!res.ok) {
    console.error(
      `FAIL [${res.status}] ${entry.slug}/attraction-${entry.index} — ${entry.url}`,
    );
    return;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buffer);
  console.log(
    `OK   ${entry.slug}/attraction-${entry.index}.webp (${(buffer.length / 1024).toFixed(0)} KB)`,
  );
}

async function main() {
  console.log(`Downloading ${PHOTOS.length} photos to ${TOURS_DIR}\n`);

  const results = await Promise.allSettled(PHOTOS.map(downloadPhoto));

  const failed = results.filter((r) => r.status === 'rejected');
  console.log(
    `\nDone: ${results.length - failed.length} OK, ${failed.length} failed`,
  );
}

main().catch(console.error);

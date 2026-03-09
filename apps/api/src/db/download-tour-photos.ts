import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Из apps/api/src/db/ три уровня вверх = apps/, затем web/public/assets/tours
const TOURS_DIR = join(__dirname, '..', '..', '..', 'web', 'public', 'assets', 'tours')

interface PhotoEntry {
  slug: string
  index: number
  url: string
}

const PHOTOS: PhotoEntry[] = [
  // Sochi
  { slug: 'sochi', index: 0, url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80' },
  { slug: 'sochi', index: 1, url: 'https://images.unsplash.com/photo-1574691250077-03a929faece5?w=800&q=80' },
  { slug: 'sochi', index: 2, url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=800&q=80' },
  { slug: 'sochi', index: 3, url: 'https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?w=800&q=80' },
  { slug: 'sochi', index: 4, url: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=800&q=80' },
  { slug: 'sochi', index: 5, url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80' },
  // Altay
  { slug: 'altay', index: 0, url: 'https://images.unsplash.com/photo-1501854140801-50d01698950b?w=800&q=80' },
  { slug: 'altay', index: 1, url: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=800&q=80' },
  { slug: 'altay', index: 2, url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80' },
  { slug: 'altay', index: 3, url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80' },
  { slug: 'altay', index: 4, url: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=800&q=80' },
  { slug: 'altay', index: 5, url: 'https://images.unsplash.com/photo-1508193638397-1c4234db14d8?w=800&q=80' },
  // Karelia
  { slug: 'karelia', index: 0, url: 'https://images.unsplash.com/photo-1547448415-e9f5b28e570d?w=800&q=80' },
  { slug: 'karelia', index: 1, url: 'https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?w=800&q=80' },
  { slug: 'karelia', index: 2, url: 'https://images.unsplash.com/photo-1501854140801-50d01698950b?w=800&q=80' },
  { slug: 'karelia', index: 3, url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80' },
  { slug: 'karelia', index: 4, url: 'https://images.unsplash.com/photo-1524850011238-e3d235c7d4c9?w=800&q=80' },
  { slug: 'karelia', index: 5, url: 'https://images.unsplash.com/photo-1508193638397-1c4234db14d8?w=800&q=80' },
  // Kavkaz
  { slug: 'kavkaz', index: 0, url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80' },
  { slug: 'kavkaz', index: 1, url: 'https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?w=800&q=80' },
  { slug: 'kavkaz', index: 2, url: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=800&q=80' },
  { slug: 'kavkaz', index: 3, url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80' },
  { slug: 'kavkaz', index: 4, url: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=800&q=80' },
  { slug: 'kavkaz', index: 5, url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=800&q=80' },
]

async function downloadPhoto(entry: PhotoEntry): Promise<void> {
  const dir = join(TOURS_DIR, entry.slug)
  await mkdir(dir, { recursive: true })

  const filePath = join(dir, `attraction-${entry.index}.webp`)

  const res = await fetch(entry.url)
  if (!res.ok) {
    console.error(`FAIL [${res.status}] ${entry.slug}/attraction-${entry.index} — ${entry.url}`)
    return
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  await writeFile(filePath, buffer)
  console.log(`OK   ${entry.slug}/attraction-${entry.index}.webp (${(buffer.length / 1024).toFixed(0)} KB)`)
}

async function main() {
  console.log(`Downloading ${PHOTOS.length} photos to ${TOURS_DIR}\n`)

  const results = await Promise.allSettled(PHOTOS.map(downloadPhoto))

  const failed = results.filter((r) => r.status === 'rejected')
  console.log(`\nDone: ${results.length - failed.length} OK, ${failed.length} failed`)
}

main().catch(console.error)

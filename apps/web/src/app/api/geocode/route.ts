import { NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? ''
  if (!q) return Response.json({ error: 'No query' }, { status: 400 })

  const params = new URLSearchParams({
    apikey: process.env.YANDEX_SUGGEST_KEY ?? '',
    geocode: q,
    format: 'json',
    lang: 'ru_RU',
    results: '1',
  })

  try {
    const res = await fetch(`https://geocode-maps.yandex.ru/1.x/?${params}`)
    const data = await res.json()
    return Response.json(data)
  } catch {
    return Response.json({ error: 'Geocode failed' }, { status: 500 })
  }
}

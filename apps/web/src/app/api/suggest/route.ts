import { NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? ''
  if (q.length < 3) return Response.json({ results: [] })

  const params = new URLSearchParams({
    apikey: process.env.YANDEX_SUGGEST_KEY ?? '',
    text: q,
    lang: 'ru_RU',
    results: '7',
    bbox: '19.6,41.2~190.0,81.9',
  })

  try {
    const res = await fetch(`https://suggest-maps.yandex.ru/v1/suggest?${params}`)
    const data = await res.json()
    return Response.json(data)
  } catch {
    return Response.json({ results: [] }, { status: 500 })
  }
}

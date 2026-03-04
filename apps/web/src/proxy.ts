import { NextRequest, NextResponse } from 'next/server'

const PROTECTED = ['/planner', '/ai-assistant', '/profile']

export function proxy(req: NextRequest) {
  const token = req.cookies.get('token')?.value
  const isProtected = PROTECTED.some(p => req.nextUrl.pathname.startsWith(p))
  if (isProtected && !token) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/planner/:path*', '/ai-assistant/:path*', '/profile/:path*'] }

import { NextRequest, NextResponse } from 'next/server';

const PROTECTED = ['/profile'];

export function proxy(req: NextRequest) {
  const token = req.cookies.get('token')?.value;
  const isProtected = PROTECTED.some((p) => req.nextUrl.pathname.startsWith(p));
  if (isProtected && !token) {
    return NextResponse.redirect(new URL('/', req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/profile/:path*'] };

import { NextResponse } from 'next/server';
import { clearSession } from '@/lib/auth/session';
import { loginRedirectUrl } from '@/lib/auth/urls';

export async function POST(request: Request): Promise<Response> {
  await clearSession();
  return NextResponse.redirect(loginRedirectUrl(request.url), { status: 303 });
}

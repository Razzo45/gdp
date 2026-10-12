const LIVE_LOGIN = 'https://gdp.wirestock.io/login';

/** After logout, land on the public login page — not the Railway / internal host. */
export function loginRedirectUrl(requestUrl: string): string {
  const origin = new URL(requestUrl).origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return `${origin}/login`;
  return LIVE_LOGIN;
}

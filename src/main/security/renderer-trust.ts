const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function resolveDevelopmentRendererUrl(
  configuredUrl: string | undefined,
  isPackaged: boolean,
): URL | undefined {
  if (isPackaged || !configuredUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error('VITE_DEV_SERVER_URL 不是有效 URL。');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    || parsed.username
    || parsed.password
  ) {
    throw new Error('VITE_DEV_SERVER_URL 必须是无凭据的本机回环 HTTP(S) 地址。');
  }
  return parsed;
}

export function isTrustedRendererUrl(
  candidateUrl: string,
  entryUrl: string,
  isDevelopment: boolean,
): boolean {
  let candidate: URL;
  let entry: URL;
  try {
    candidate = new URL(candidateUrl);
    entry = new URL(entryUrl);
  } catch {
    return false;
  }
  if (candidate.username || candidate.password) return false;
  if (isDevelopment) return candidate.origin === entry.origin;
  return candidate.protocol === 'file:'
    && candidate.host === entry.host
    && candidate.pathname === entry.pathname
    && candidate.search === entry.search;
}

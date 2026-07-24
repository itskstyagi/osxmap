// Monument is local-only. A hosting page may set a different loopback API URL
// before app.js, but shared URLs and persisted browser state cannot override it.
const DEFAULT_API_URL = 'http://127.0.0.1:8787';

function loopbackApiUrl(value) {
  if (typeof value !== 'string' || !value) return DEFAULT_API_URL;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(host) ? url.toString().replace(/\/$/, '') : DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
}

export const API_BASE_URL = loopbackApiUrl(window.MONUMENT_API_URL);

export function agentSocketUrl(apiBaseUrl = API_BASE_URL) {
  const url = new URL(apiBaseUrl);
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = Number(url.port || defaultPort);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = String(port + 1);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export const AGENT_SOCKET_URL = agentSocketUrl();

export function apiPath(path) {
  return `${API_BASE_URL}${path}`;
}

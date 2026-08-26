let csrf = '';

export const setCsrf = (value: string) => {
  csrf = value;
};

export async function api<T = any>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (csrf && init.method && init.method !== 'GET') {
    headers.set('x-csrf-token', csrf);
  }

  const response = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (await response.json()).error?.message ?? message;
    } catch {
      // Preserve the HTTP status message when the response body is not JSON.
    }
    throw new Error(message);
  }

  return response.status === 204 ? (undefined as T) : response.json();
}

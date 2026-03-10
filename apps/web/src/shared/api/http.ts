import { useAuthStore } from '@/features/auth/model/auth.store';
import { useUserStore } from '@/entities/user';

function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;

  if (typeof window === 'undefined') {
    return configured ?? '/api';
  }

  const host = window.location.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';

  if (!configured) {
    return isLocalHost ? 'http://localhost:3001/api' : '/api';
  }

  const pointsToLocalhost = /localhost|127\.0\.0\.1/i.test(configured);
  if (!isLocalHost && pointsToLocalhost) {
    return '/api';
  }

  return configured;
}

const BASE = resolveApiBase();

function handleSessionExpired() {
  if (typeof window === 'undefined') {
    return;
  }

  const alreadyHandled = sessionStorage.getItem('auth:session-expired') === '1';
  if (alreadyHandled) {
    if (window.location.pathname !== '/') {
      window.location.href = '/';
    }
    return;
  }

  localStorage.removeItem('accessToken');
  document.cookie = 'token=; path=/; max-age=0';
  useUserStore.getState().clearUser();
  useAuthStore.setState({ isAuthenticated: false, accessToken: null });

  sessionStorage.setItem('auth:session-expired', '1');
  window.dispatchEvent(new Event('auth:session-expired'));

  if (window.location.pathname !== '/') {
    window.location.href = '/';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (res.status === 401) {
    handleSessionExpired();
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }

  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

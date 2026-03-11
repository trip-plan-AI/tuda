import { useAuthStore } from '@/features/auth/model/auth.store';
import { useUserStore } from '@/entities/user';

interface ApiRequestError {
  status: number;
  message: string;
  code?: string;
  session_id?: string;
}

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
    window.dispatchEvent(new Event('auth:session-expired'));
    return;
  }

  localStorage.removeItem('accessToken');
  document.cookie = 'token=; path=/; max-age=0';
  useUserStore.getState().clearUser();
  useAuthStore.setState({ isAuthenticated: false, accessToken: null });

  sessionStorage.setItem('auth:session-expired', '1');
  window.dispatchEvent(new Event('auth:session-expired'));
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

    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: стабильно извлекать code/session_id даже из вложенных форматов ошибок NestJS,
    //    чтобы frontend мог корректно продолжать тот же AI-чат после NEED_CITY.
    // 3) Если убрать: потеряется session_id в ошибках, и follow-up запросы уйдут в другой/новый чат.
    // 4) Возможен конфликт с ветками, где backend унифицирует error envelope и убирает вложенный payload.
    const responseObj =
      err && typeof err.response === 'object' && err.response !== null
        ? (err.response as Record<string, unknown>)
        : null;
    const nested =
      err && typeof err.message === 'object' && err.message !== null
        ? (err.message as Record<string, unknown>)
        : responseObj && typeof responseObj.message === 'object'
          ? (responseObj.message as Record<string, unknown>)
          : null;

    const resolvedMessage =
      typeof err.message === 'string'
        ? err.message
        : typeof nested?.message === 'string'
          ? nested.message
          : `HTTP ${res.status}`;

    const apiError: ApiRequestError = {
      status: res.status,
      message: resolvedMessage,
      code:
        typeof err.code === 'string'
          ? err.code
          : typeof nested?.code === 'string'
            ? nested.code
            : undefined,
      session_id:
        typeof err.session_id === 'string'
          ? err.session_id
          : typeof nested?.session_id === 'string'
            ? nested.session_id
            : undefined,
    };
    throw apiError;
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

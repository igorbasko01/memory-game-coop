import type { Player, RoomView } from './types';

/**
 * The online server: the same site the game is served from (/api).
 * Override at build time with VITE_API_URL, e.g. a local `wrangler dev` while running `vite`.
 */
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/** This device's player: kept in the browser. */
export interface Identity {
  player: Player;
  token: string;
}

const IDENTITY_KEY = 'memory-coop-identity';

export const loadIdentity = (): Identity | null => {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    const id = raw ? (JSON.parse(raw) as Identity) : null;
    return id?.token && id.player?.id ? id : null;
  } catch {
    return null;
  }
};

export const saveIdentity = (id: Identity | null) => {
  try {
    if (id) localStorage.setItem(IDENTITY_KEY, JSON.stringify(id));
    else localStorage.removeItem(IDENTITY_KEY);
  } catch {
    // Storage can be unavailable (private mode); the identity then lasts this visit only.
  }
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const call = async <T>(path: string, token?: string, data?: unknown): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    throw new ApiError(0, 'Can’t reach the game server. Check your connection.');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Server error (${res.status})`);
  return body as T;
};

export const api = {
  register: (nickname: string) => call<Identity>('/api/players', undefined, { nickname }),
  rename: (token: string, nickname: string) => call<{ player: Player }>('/api/me', token, { nickname }),
  currentRoom: (token: string) => call<{ room: RoomView | null }>('/api/me/room', token),
  createRoom: (token: string, rows: number, cols: number) => call<RoomView>('/api/rooms', token, { rows, cols }),
  join: (token: string, code: string) => call<RoomView>('/api/rooms/join', token, { code }),
  room: (token: string, id: string) => call<RoomView>(`/api/rooms/${id}`, token),
  settings: (token: string, id: string, rows: number, cols: number) => call<RoomView>(`/api/rooms/${id}/settings`, token, { rows, cols }),
  start: (token: string, id: string) => call<RoomView>(`/api/rooms/${id}/start`, token, {}),
  flip: (token: string, id: string, n: number, cell: number) => call<RoomView>(`/api/rooms/${id}/flip`, token, { n, cell }),
  end: (token: string, id: string) => call<RoomView>(`/api/rooms/${id}/end`, token, {}),
  leave: (token: string, id: string) => call<{ ok: true }>(`/api/rooms/${id}/leave`, token, {}),
  tv: (code: string) => call<RoomView>(`/api/tv/${code}`),
};

/** A link to the game with a query, e.g. `?join=ABCD` or `?tv=ABCD`. */
export const linkWith = (key: 'join' | 'tv', code: string) => {
  const url = new URL(window.location.href);
  url.search = `?${key}=${code}`;
  url.hash = '';
  return url.toString();
};

// Minimal ThingsBoard CE REST client. Environment-agnostic: runs in Node 20+ and in a browser page.
// Paths verified against demo.thingsboard.io /v3/api-docs (TB CE 4.3.0.3DEMO) on 2026-09-25.
// Used by all Phase-1 scripts (setup, backfill, simulator, teardown). Features: serialised, throttled
// requests; retry with exponential backoff on network errors, 429 and 5xx; one token refresh on 401.
// Auth is pluggable: passwordAuth (Node, .env credentials) or externalTokenAuth (browser page JWT, D-001).
// Separate from widgets/src/core/api.ts, which is the widgets' client.

export type Log = (msg: string) => void;

/** Supplies the JWT sent as `X-Authorization: Bearer <token>`. */
export interface TokenProvider {
  getToken(): Promise<string>;
  /** Called once after a 401; should obtain a fresh token. */
  refresh(): Promise<void>;
}

export interface EntityId {
  id: string;
  entityType: string;
}

/** Non-2xx response; the message holds method, path, status and the first 300 chars of the body. */
export class TbHttpError extends Error {
  constructor(public status: number, public method: string, public path: string, public body: string) {
    super(`TB ${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TbClientOptions {
  /** Minimum gap between the end of one request and the start of the next (default 150 ms). */
  minDelayMs?: number;
  /** Retries for network errors, 429 and 5xx (default 5). */
  maxRetries?: number;
  log?: Log;
}

/** ThingsBoard REST client. All requests go through one queue, so calls never run in parallel. */
export class TbClient {
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();
  readonly minDelayMs: number;
  readonly maxRetries: number;
  readonly log: Log;

  constructor(public readonly baseUrl: string, private readonly auth: TokenProvider, opts: TbClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.minDelayMs = opts.minDelayMs ?? 150;
    this.maxRetries = opts.maxRetries ?? 5;
    this.log = opts.log ?? (() => {});
  }

  /** Serialises calls and spaces them by minDelayMs so scripts stay under the demo server's rate limits. */
  private throttle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.last + this.minDelayMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Sends one request with retries: network errors and 429/5xx back off exponentially (max 30 s);
   * a 401 triggers one auth.refresh() and a retry. Returns the final Response (possibly non-2xx).
   */
  private async send(method: string, path: string, body: unknown, withAuth: boolean): Promise<Response> {
    let attempt = 0;
    let refreshed = false;
    for (;;) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (withAuth) headers['X-Authorization'] = `Bearer ${await this.auth.getToken()}`;
      let res: Response;
      try {
        res = await this.throttle(() =>
          fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
        );
      } catch (e) {
        if (attempt++ >= this.maxRetries) throw e;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && withAuth && !refreshed) {
        refreshed = true;
        await this.auth.refresh();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        attempt++;
        const backoff = Math.min(30000, 1000 * 2 ** attempt);
        this.log(`  ${method} ${path} -> ${res.status}, retry ${attempt}/${this.maxRetries} in ${backoff} ms`);
        await sleep(backoff);
        continue;
      }
      return res;
    }
  }

  /**
   * Authenticated JSON request. Returns the parsed body (null for an empty body, or for 404 when
   * `allow404`). Throws TbHttpError for other non-2xx responses.
   */
  async request<T = any>(method: string, path: string, body?: unknown, opts: { allow404?: boolean } = {}): Promise<T | null> {
    const res = await this.send(method, path, body, true);
    if (res.status === 404 && opts.allow404) return null;
    const text = await res.text();
    if (!res.ok) throw new TbHttpError(res.status, method, path, text);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** GET; throws on 404. */
  get<T = any>(path: string) { return this.request<T>('GET', path) as Promise<T>; }
  /** GET that returns null on 404 (TB's name lookups return 404 when nothing matches). */
  find<T = any>(path: string) { return this.request<T>('GET', path, undefined, { allow404: true }); }
  post<T = any>(path: string, body?: unknown) { return this.request<T>('POST', path, body) as Promise<T>; }
  del(path: string) { return this.request('DELETE', path); }

  /** Device transport API (no JWT; the access token is in the path). */
  async postDeviceTelemetry(accessToken: string, payload: unknown): Promise<void> {
    const res = await this.send('POST', `/api/v1/${encodeURIComponent(accessToken)}/telemetry`, payload, false);
    if (!res.ok) throw new TbHttpError(res.status, 'POST', '/api/v1/<token>/telemetry', await res.text());
  }

  // ---- attribute helpers ----
  /** SERVER_SCOPE attributes of an entity as {key: value}; all keys when `keys` is empty. */
  async getServerAttributes(entity: EntityId, keys?: string[]): Promise<Record<string, unknown>> {
    const q = keys?.length ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
    const rows = await this.get<{ key: string; value: unknown }[]>(
      `/api/plugins/telemetry/${entity.entityType}/${entity.id}/values/attributes/SERVER_SCOPE${q}`,
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Writes/merges SERVER_SCOPE attributes (POST .../attributes/SERVER_SCOPE). One call per invocation. */
  saveServerAttributes(entity: EntityId, attrs: Record<string, unknown>) {
    return this.post(`/api/plugins/telemetry/${entity.entityType}/${entity.id}/attributes/SERVER_SCOPE`, attrs);
  }

  /** True if the entity has server attribute `poc` = true (boolean or "true"); the POC marker (D-006). */
  async isPoc(entity: EntityId): Promise<boolean> {
    const a = await this.getServerAttributes(entity, ['poc']);
    return a.poc === true || a.poc === 'true';
  }
}

/** Tenant service account: logs in with username/password, refreshes with /api/auth/token. */
export function passwordAuth(baseUrl: string, username: string, password: string): TokenProvider {
  const base = baseUrl.replace(/\/+$/, '');
  let token = '';
  let refreshToken = '';
  let expiresAt = 0;

  // JWT expiry in ms; if the token can't be decoded, assume 10 minutes. Uses Buffer, so Node only.
  const decodeExp = (jwt: string) => {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
      return (payload.exp ?? 0) * 1000;
    } catch {
      return Date.now() + 10 * 60 * 1000;
    }
  };

  const store = (j: { token: string; refreshToken: string }) => {
    token = j.token;
    refreshToken = j.refreshToken;
    expiresAt = decodeExp(token);
  };

  const login = async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`Tenant login failed: ${res.status} ${await res.text()}`);
    store(await res.json());
  };

  // Prefer the refresh token; fall back to a full login.
  const refresh = async () => {
    if (refreshToken) {
      const res = await fetch(`${base}/api/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (res.ok) return store(await res.json());
    }
    await login();
  };

  return {
    // Logs in lazily and refreshes 60 s before expiry.
    async getToken() {
      if (!token) await login();
      else if (Date.now() > expiresAt - 60_000) await refresh();
      return token;
    },
    refresh,
  };
}

/** Uses a token supplied by the host (e.g. the logged-in ThingsBoard page's JWT). */
export function externalTokenAuth(get: () => string | null): TokenProvider {
  return {
    async getToken() {
      const t = get();
      if (!t) throw new Error('No ThingsBoard token available; log in to ThingsBoard first.');
      return t;
    },
    async refresh() {
      /* the ThingsBoard UI refreshes its own token */
    },
  };
}

/** Walks all pages of a TB PageData endpoint. `path` must already contain other query params or none. */
export async function fetchAll<T>(tb: TbClient, path: string, pageSize = 100): Promise<T[]> {
  const out: T[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 0; ; page++) {
    const r = await tb.get<{ data: T[]; hasNext: boolean }>(`${path}${sep}pageSize=${pageSize}&page=${page}`);
    out.push(...r.data);
    if (!r.hasNext) return out;
  }
}

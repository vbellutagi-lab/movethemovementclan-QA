import { env } from "./env";

export interface ApiResult<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  body: T;
  rawText: string;
}

interface RequestOpts {
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip attaching the client's stored session cookie for this one call. */
  noCookie?: boolean;
  /**
   * Abort the request after this many ms and surface it as {@link TIMED_OUT} instead of
   * hanging. Matters because a wedged server is a real, observed failure mode here (a
   * connection-pool deadlock under concurrent booking — docs/scenarios.md §4.12): without a
   * bound, a test that trips it blocks until vitest's own timeout kills the whole file and
   * reports nothing useful about *which* requests never came back.
   */
  timeoutMs?: number;
}

/**
 * Synthetic status for "the server never answered". Deliberately not a real HTTP code so it can
 * never be mistaken for one the server actually sent, and so status assertions fail loudly.
 */
export const TIMED_OUT = -1;

/**
 * A black-box HTTP client for movethemovementclan's API. Deliberately does not import any
 * app source — only talks over HTTP, exactly like a real browser/attacker would. Maintains
 * its own cookie jar so we can do things a normal SDK would hide from us: swap cookies
 * between two signed-in identities, replay a stale cookie, tamper with a cookie value, or
 * hold no cookie at all.
 *
 * `/api/*`      — the tRPC-to-OpenAPI REST surface (business routes: bookings, credits, ...).
 * `/api/auth/*` — Better Auth's own REST handler (sign-in, sign-up, organization, ...).
 * Both are same-origin, so both share this one cookie jar — exactly as a browser would.
 */
export class ApiClient {
  private cookies = new Map<string, string>();

  /**
   * `defaultHeaders` are merged into every request this client makes (below `opts.headers`,
   * above nothing else). It exists so a client can carry a stable transport-level identity
   * that is not its cookie jar — see src/support/client-pool.ts, which uses it to give each
   * pooled fixture client its own `x-forwarded-for` and therefore its own IP-keyed
   * rate-limit bucket during provisioning.
   */
  constructor(
    private readonly baseUrl: string = env.apiBaseUrl,
    private readonly defaultHeaders: Record<string, string> = {},
  ) {}

  /** Returns a snapshot of the current cookie jar (e.g. to hand a "stolen" session to another client). */
  exportCookies(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }

  /** Overwrite/inject a cookie directly — used for session-tampering and fixation scenarios. */
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  importCookies(cookies: Record<string, string>): void {
    for (const [k, v] of Object.entries(cookies)) this.cookies.set(k, v);
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorbSetCookies(res: Response): void {
    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const firstPair = sc.split(";")[0];
      if (!firstPair) continue;
      const idx = firstPair.indexOf("=");
      if (idx === -1) continue;
      const name = firstPair.slice(0, idx).trim();
      const value = firstPair.slice(idx + 1).trim();
      this.cookies.set(name, value);
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: RequestOpts = {},
  ): Promise<ApiResult<T>> {
    // Better Auth rejects state-changing requests with no Origin header ("MISSING_OR_NULL_ORIGIN")
    // as part of its own CSRF defense — a real browser always sends one, so we always do too.
    const headers: Record<string, string> = {
      origin: env.webBaseUrl,
      ...this.defaultHeaders,
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const cookie = opts.noCookie ? undefined : this.cookieHeader();
    if (cookie) headers["cookie"] = cookie;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: "manual",
        signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      });
    } catch (error) {
      // Only a timeout we asked for is turned into a result; anything else (connection
      // refused, DNS, a genuine bug in the test) must still throw, or a down server would
      // masquerade as an ordinary failed assertion.
      const timedOut =
        opts.timeoutMs !== undefined &&
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      if (!timedOut) throw error;
      const message = `${method} ${path} did not respond within ${opts.timeoutMs}ms`;
      return {
        status: TIMED_OUT,
        ok: false,
        headers: new Headers(),
        body: undefined as T,
        rawText: message,
      };
    }
    this.absorbSetCookies(res);

    const rawText = await res.text();
    let body: T;
    try {
      body = rawText ? JSON.parse(rawText) : (undefined as T);
    } catch {
      body = rawText as unknown as T;
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body, rawText };
  }

  // ---- REST business surface: /api/* ----
  get<T = unknown>(path: string, opts?: RequestOpts) {
    return this.request<T>("GET", `/api${path}`, opts);
  }
  post<T = unknown>(path: string, body: unknown = {}, opts?: RequestOpts) {
    // The OpenAPI adapter 415s a bodyless POST before auth even runs — always send at least
    // `{}` so auth/authorization checks (the thing most tests here care about) are what's
    // actually exercised, not an unrelated content-type quirk.
    return this.request<T>("POST", `/api${path}`, { ...opts, body });
  }
  patch<T = unknown>(path: string, body: unknown = {}, opts?: RequestOpts) {
    return this.request<T>("PATCH", `/api${path}`, { ...opts, body });
  }
  put<T = unknown>(path: string, body: unknown = {}, opts?: RequestOpts) {
    return this.request<T>("PUT", `/api${path}`, { ...opts, body });
  }
  delete<T = unknown>(path: string, opts?: RequestOpts) {
    return this.request<T>("DELETE", `/api${path}`, opts);
  }

  // ---- Better Auth surface: /api/auth/* ----
  authGet<T = unknown>(path: string, opts?: RequestOpts) {
    return this.request<T>("GET", `/api/auth${path}`, opts);
  }
  authPost<T = unknown>(path: string, body?: unknown, opts?: RequestOpts) {
    return this.request<T>("POST", `/api/auth${path}`, { ...opts, body });
  }

  // ---- Native tRPC surface: /trpc/* (for probing batch/link edge cases) ----
  trpcRaw<T = unknown>(path: string, opts?: RequestOpts) {
    return this.request<T>("GET", `/trpc${path}`, opts);
  }
}

export function newClient(defaultHeaders: Record<string, string> = {}): ApiClient {
  return new ApiClient(env.apiBaseUrl, defaultHeaders);
}

/**
 * REST client for minimal-agent-ts Web UI API.
 */

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getMinimalBaseUrl(): string {
  return trimSlash(
    process.env.NEXT_PUBLIC_MINIMAL_BASE_URL?.trim() ||
      "http://127.0.0.1:7788",
  );
}

export function getMinimalToken(): string {
  return (
    process.env.NEXT_PUBLIC_MINIMAL_TOKEN?.trim() ||
    (typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("token")?.trim() ||
        localStorage.getItem("minimal_web_token") ||
        ""
      : "") ||
    ""
  );
}

export function rememberToken(token: string): void {
  if (typeof window === "undefined" || !token) return;
  localStorage.setItem("minimal_web_token", token);
}

function authHeaders(token: string): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function withTokenQuery(path: string, token: string): string {
  if (!token) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

export class MinimalApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "MinimalApiError";
  }
}

export async function minimalFetch<T = unknown>(
  path: string,
  init?: RequestInit & { token?: string },
): Promise<T> {
  const base = getMinimalBaseUrl();
  const token = init?.token ?? getMinimalToken();
  const url = `${base}${withTokenQuery(path, token)}`;
  const { token: _t, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: {
        ...authHeaders(token),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new MinimalApiError(
      `Network error calling ${url}: ${why}. ` +
        `Is minimal web running? (CORS fixed on server — restart npm run web if needed.)`,
      0,
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data as { error?: string; message?: string; detail?: string }).message ||
      (data as { error?: string }).error ||
      (data as { detail?: string }).detail ||
      `HTTP ${res.status}`;
    throw new MinimalApiError(String(msg), res.status, data);
  }
  return data as T;
}

export function wsUrl(token?: string): string {
  const base = getMinimalBaseUrl();
  const t = token ?? getMinimalToken();
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/v1/ws";
  u.search = t ? `token=${encodeURIComponent(t)}` : "";
  return u.toString();
}

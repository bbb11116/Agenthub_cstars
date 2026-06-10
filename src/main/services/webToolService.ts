import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const WEB_REQUEST_TIMEOUT_MS = 20_000;
const WEB_FETCH_MAX_CHARS = 24_000;
const WEB_FETCH_MAX_BYTES = 1_000_000;

export type WebToolName = "web_search" | "web_fetch";

export type WebToolDefinition = {
  name: WebToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type WebToolCall = {
  id: string;
  name: WebToolName;
  arguments: Record<string, unknown>;
};

export type WebSearchItem = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
};

export type WebSearchResult = {
  query: string;
  provider: string;
  results: WebSearchItem[];
};

export type WebFetchResult = {
  url: string;
  title?: string;
  content: string;
  contentType?: string;
  fetchedAt: string;
  truncated: boolean;
};

type SearchArgs = {
  query: string;
  maxResults: number;
  domains?: string[];
  recencyDays?: number;
};

type ToolEnv = Record<string, string | undefined>;

export const WEB_TOOL_DEFINITIONS: Record<WebToolName, WebToolDefinition> = {
  web_search: {
    name: "web_search",
    description: "Search the public web and return concise result titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query."
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_RESULTS,
          description: "Maximum number of results to return."
        },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to prefer or restrict where the search provider supports it."
        },
        recencyDays: {
          type: "integer",
          minimum: 1,
          description: "Optional recency window in days where the search provider supports it."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  web_fetch: {
    name: "web_fetch",
    description: "Fetch a public HTTP/HTTPS page and return cleaned text content.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public HTTP or HTTPS URL to fetch."
        },
        maxChars: {
          type: "integer",
          minimum: 1000,
          maximum: WEB_FETCH_MAX_CHARS,
          description: "Maximum characters of cleaned content to return."
        }
      },
      required: ["url"],
      additionalProperties: false
    }
  }
};

function getEnv(name: string, env: ToolEnv = {}): string | undefined {
  const value = env[name] ?? process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => readString(item))
    .filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

function normalizeSearchArgs(args: Record<string, unknown>): SearchArgs {
  const query = readString(args.query);
  if (!query) {
    throw new Error("web_search requires a non-empty query.");
  }
  return {
    query,
    maxResults: clampInteger(args.maxResults, DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS),
    domains: readStringArray(args.domains),
    recencyDays: clampInteger(args.recencyDays, 0, 0, 3650) || undefined
  };
}

function getSearchProvider(env: ToolEnv): string {
  const configured = getEnv("AGENTHUB_WEB_SEARCH_PROVIDER", env)?.toLowerCase();
  if (configured) {
    return configured;
  }
  if (getEnv("AGENTHUB_BRAVE_SEARCH_API_KEY", env)) return "brave";
  if (getEnv("AGENTHUB_TAVILY_API_KEY", env)) return "tavily";
  if (getEnv("AGENTHUB_SERPAPI_API_KEY", env)) return "serpapi";
  if (getEnv("AGENTHUB_SEARXNG_URL", env)) return "searxng";
  return "";
}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const timeout = withTimeout(WEB_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: timeout.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return await response.json() as unknown;
  } finally {
    timeout.clear();
  }
}

function appendDomainFilter(query: string, domains: string[] | undefined): string {
  if (!domains?.length) {
    return query;
  }
  const filter = domains.map((domain) => `site:${domain}`).join(" OR ");
  return `${query} ${filter}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSearchItem(item: {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  source?: unknown;
  publishedAt?: unknown;
}): WebSearchItem | null {
  const title = readString(item.title);
  const url = readString(item.url);
  if (!title || !url) {
    return null;
  }
  return {
    title,
    url,
    snippet: readString(item.snippet) ?? "",
    ...(readString(item.source) ? { source: readString(item.source) } : {}),
    ...(readString(item.publishedAt) ? { publishedAt: readString(item.publishedAt) } : {})
  };
}

function compactResults(results: Array<WebSearchItem | null>, maxResults: number): WebSearchItem[] {
  const seen = new Set<string>();
  const out: WebSearchItem[] = [];
  for (const result of results) {
    if (!result || seen.has(result.url)) {
      continue;
    }
    seen.add(result.url);
    out.push(result);
    if (out.length >= maxResults) {
      break;
    }
  }
  return out;
}

async function braveSearch(args: SearchArgs, env: ToolEnv): Promise<WebSearchResult> {
  const apiKey = getEnv("AGENTHUB_BRAVE_SEARCH_API_KEY", env);
  if (!apiKey) {
    throw new Error("AGENTHUB_BRAVE_SEARCH_API_KEY is required for Brave web search.");
  }
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", appendDomainFilter(args.query, args.domains));
  url.searchParams.set("count", String(args.maxResults));
  const data = await fetchJson(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey
    }
  });
  const web = isRecord(data) && isRecord(data.web) && Array.isArray(data.web.results)
    ? data.web.results
    : [];
  return {
    query: args.query,
    provider: "brave",
    results: compactResults(
      web.map((item) => isRecord(item)
        ? normalizeSearchItem({
            title: item.title,
            url: item.url,
            snippet: item.description,
            source: item.profile && isRecord(item.profile) ? item.profile.name : undefined,
            publishedAt: item.age
          })
        : null),
      args.maxResults
    )
  };
}

async function tavilySearch(args: SearchArgs, env: ToolEnv): Promise<WebSearchResult> {
  const apiKey = getEnv("AGENTHUB_TAVILY_API_KEY", env);
  if (!apiKey) {
    throw new Error("AGENTHUB_TAVILY_API_KEY is required for Tavily web search.");
  }
  const data = await fetchJson("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: appendDomainFilter(args.query, args.domains),
      max_results: args.maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      ...(args.recencyDays ? { days: args.recencyDays } : {})
    })
  });
  const results = isRecord(data) && Array.isArray(data.results) ? data.results : [];
  return {
    query: args.query,
    provider: "tavily",
    results: compactResults(
      results.map((item) => isRecord(item)
        ? normalizeSearchItem({
            title: item.title,
            url: item.url,
            snippet: item.content,
            source: item.source
          })
        : null),
      args.maxResults
    )
  };
}

async function serpApiSearch(args: SearchArgs, env: ToolEnv): Promise<WebSearchResult> {
  const apiKey = getEnv("AGENTHUB_SERPAPI_API_KEY", env);
  if (!apiKey) {
    throw new Error("AGENTHUB_SERPAPI_API_KEY is required for SerpAPI web search.");
  }
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", appendDomainFilter(args.query, args.domains));
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", String(args.maxResults));
  const data = await fetchJson(url.toString());
  const results = isRecord(data) && Array.isArray(data.organic_results)
    ? data.organic_results
    : [];
  return {
    query: args.query,
    provider: "serpapi",
    results: compactResults(
      results.map((item) => isRecord(item)
        ? normalizeSearchItem({
            title: item.title,
            url: item.link,
            snippet: item.snippet,
            source: item.source,
            publishedAt: item.date
          })
        : null),
      args.maxResults
    )
  };
}

async function searxngSearch(args: SearchArgs, env: ToolEnv): Promise<WebSearchResult> {
  const baseUrl = getEnv("AGENTHUB_SEARXNG_URL", env);
  if (!baseUrl) {
    throw new Error("AGENTHUB_SEARXNG_URL is required for SearXNG web search.");
  }
  const url = new URL("/search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.searchParams.set("q", appendDomainFilter(args.query, args.domains));
  url.searchParams.set("format", "json");
  const data = await fetchJson(url.toString(), {
    headers: { Accept: "application/json" }
  });
  const results = isRecord(data) && Array.isArray(data.results) ? data.results : [];
  return {
    query: args.query,
    provider: "searxng",
    results: compactResults(
      results.map((item) => isRecord(item)
        ? normalizeSearchItem({
            title: item.title,
            url: item.url,
            snippet: item.content,
            source: item.engine,
            publishedAt: item.publishedDate
          })
        : null),
      args.maxResults
    )
  };
}

async function executeSearch(args: Record<string, unknown>, env: ToolEnv): Promise<WebSearchResult> {
  const normalized = normalizeSearchArgs(args);
  const provider = getSearchProvider(env);
  if (provider === "brave") return braveSearch(normalized, env);
  if (provider === "tavily") return tavilySearch(normalized, env);
  if (provider === "serpapi") return serpApiSearch(normalized, env);
  if (provider === "searxng") return searxngSearch(normalized, env);
  throw new Error(
    "Web search is not configured. Set AGENTHUB_WEB_SEARCH_PROVIDER with the matching provider API key."
  );
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mappedIPv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIPv4) {
    return isPrivateIPv4(mappedIPv4[1]);
  }
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

function assertPublicAddress(address: string): void {
  const version = isIP(address);
  if (version === 4 && isPrivateIPv4(address)) {
    throw new Error(`web_fetch blocked non-public address: ${address}`);
  }
  if (version === 6 && isPrivateIPv6(address)) {
    throw new Error(`web_fetch blocked non-public address: ${address}`);
  }
  if (version === 0) {
    throw new Error(`web_fetch could not validate address: ${address}`);
  }
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch only supports http and https URLs.");
  }
  if (url.username || url.password) {
    throw new Error("web_fetch does not allow URLs with embedded credentials.");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new Error("web_fetch blocked localhost.");
  }
  if (isIP(url.hostname)) {
    assertPublicAddress(url.hostname);
    return;
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0) {
    throw new Error(`web_fetch could not resolve host: ${url.hostname}`);
  }
  for (const address of addresses) {
    assertPublicAddress(address.address);
  }
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1]).trim().replace(/\s+/g, " ") : undefined;
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  return decodeHtml(
    withoutScripts
      .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readResponseTextLimited(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: await response.text(), truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      bytes += value.byteLength;
      if (bytes > WEB_FETCH_MAX_BYTES) {
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

async function fetchPublicUrl(
  initialUrl: URL,
  init: RequestInit,
  maxRedirects = 5
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertPublicUrl(currentUrl);
    const response = await fetch(currentUrl.toString(), {
      ...init,
      redirect: "manual"
    });
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has("location")
    ) {
      const location = response.headers.get("location");
      if (!location) {
        return { response, finalUrl: currentUrl };
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }
    return { response, finalUrl: currentUrl };
  }
  throw new Error(`web_fetch exceeded ${maxRedirects} redirects.`);
}

async function executeFetch(args: Record<string, unknown>): Promise<WebFetchResult> {
  const rawUrl = readString(args.url);
  if (!rawUrl) {
    throw new Error("web_fetch requires a non-empty url.");
  }
  const maxChars = clampInteger(args.maxChars, WEB_FETCH_MAX_CHARS, 1000, WEB_FETCH_MAX_CHARS);
  const url = new URL(rawUrl);

  const timeout = withTimeout(WEB_REQUEST_TIMEOUT_MS);
  try {
    const { response, finalUrl } = await fetchPublicUrl(url, {
      headers: {
        Accept: "text/html, text/plain, application/xhtml+xml, application/xml;q=0.8, */*;q=0.5",
        "User-Agent": "AgentHub-WebFetch/1.0"
      },
      signal: timeout.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
    const contentType = response.headers.get("content-type") ?? undefined;
    const { text, truncated: byteTruncated } = await readResponseTextLimited(response);
    const isHtml = contentType?.toLowerCase().includes("html") ?? /<html[\s>]/i.test(text);
    const cleaned = isHtml ? htmlToText(text) : text.trim();
    const truncated = byteTruncated || cleaned.length > maxChars;
    return {
      url: finalUrl.toString(),
      ...(isHtml ? { title: extractTitle(text) } : {}),
      content: cleaned.slice(0, maxChars),
      ...(contentType ? { contentType } : {}),
      fetchedAt: new Date().toISOString(),
      truncated
    };
  } finally {
    timeout.clear();
  }
}

export function createWebToolCall(name: WebToolName, args: Record<string, unknown>): WebToolCall {
  return {
    id: `web-${randomUUID()}`,
    name,
    arguments: args
  };
}

export async function executeWebTool(
  call: WebToolCall,
  env: ToolEnv = {}
): Promise<WebSearchResult | WebFetchResult> {
  if (call.name === "web_search") {
    return executeSearch(call.arguments, env);
  }
  if (call.name === "web_fetch") {
    return executeFetch(call.arguments);
  }
  throw new Error(`Unsupported web tool: ${String(call.name)}`);
}

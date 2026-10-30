export interface UpdateSettings { repository: string; checkOnStartup: boolean; includePrereleases: boolean }
export interface UpdateRelease { version: string; tag: string; name: string; url: string; publishedAt: string }
export interface UpdateResult {
  status: "not-configured" | "not-checked" | "no-releases" | "up-to-date" | "available" | "unavailable" | "error" | "rate-limited";
  currentVersion: string;
  repository: string;
  includePrereleases: boolean;
  checkedAt?: string;
  release?: UpdateRelease;
  message?: string;
  retryAt?: string;
}

const TIMEOUT = 15_000, COOLDOWN = 60_000, PAGE_SIZE = 100, PAGE_LIMIT = 10;
const PAGE_BYTES = 4 * 1024 * 1024, TOTAL_BYTES = 16 * 1024 * 1024;

/** Configuration stores an explicit public GitHub identity, without URLs or credentials. */
export function isUpdateRepository(value: unknown): value is string {
  return typeof value === "string" && (value === "" || /^(?=.{1,39}\/)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(value) && ![".", ".."].includes(value.split("/")[1]));
}
export function parseUpdateRepository(value: unknown): string {
  if (!isUpdateRepository(value)) throw new Error("Update repository must be empty or a GitHub owner/repository name.");
  return value;
}

interface Version { text: string; core: bigint[]; prerelease: string[] }
function version(value: unknown): Version | undefined {
  if (typeof value !== "string" || value.length > 256) return;
  const match = /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some(part => /^0[0-9]+$/.test(part))) return;
  return { text: value.replace(/^v/, ""), core: match.slice(1, 4).map(part => BigInt(part)), prerelease };
}
function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index++) { if (left.core[index] < right.core[index]) return -1; if (left.core[index] > right.core[index]) return 1; }
  if (!left.prerelease.length || !right.prerelease.length) return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index], b = right.prerelease[index];
    if (a === undefined) return -1; if (b === undefined) return 1; if (a === b) continue;
    const an = /^[0-9]+$/.test(a), bn = /^[0-9]+$/.test(b);
    if (an && bn) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}
class ResponseError extends Error {}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d\d-\d\dT/.test(value)) return;
  const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
async function boundedJson(response: Response, budget: { remaining: number }, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > Math.min(PAGE_BYTES, budget.remaining))) { void response.body?.cancel().catch(() => {}); throw new ResponseError("GitHub returned a response exceeding the update check size limit."); }
  if (!response.body) throw new ResponseError("GitHub returned an empty update response.");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      signal.throwIfAborted(); const chunk = await abortable(reader.read(), signal); signal.throwIfAborted(); if (chunk.done) break;
      bytes += chunk.value.byteLength; budget.remaining -= chunk.value.byteLength;
      if (bytes > PAGE_BYTES || budget.remaining < 0) throw new ResponseError("GitHub returned a response exceeding the update check size limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode(); return JSON.parse(text);
  } catch (error) { void reader.cancel().catch(() => {}); if (error instanceof ResponseError || signal.aborted) throw error; throw new ResponseError("GitHub returned invalid update data."); }
  finally { reader.releaseLock(); }
}
function retryTimestamp(response: Response, now: number): number {
  const after = response.headers.get("retry-after"), reset = response.headers.get("x-ratelimit-reset");
  const candidates = [now + COOLDOWN];
  if (after) { const timestamp = /^[0-9]+$/.test(after) ? now + Number(after) * 1000 : Date.parse(after); if (Number.isFinite(timestamp) && timestamp > now) candidates.push(timestamp); }
  if (reset && /^[0-9]+$/.test(reset)) { const timestamp = Number(reset) * 1000; if (Number.isFinite(timestamp) && timestamp > now) candidates.push(timestamp); }
  // A malformed or wildly future server header must not disable checking indefinitely.
  return Math.min(Math.max(...candidates), now + 24 * 60 * 60 * 1000);
}

export class UpdateChecker {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private key = "";
  private epoch = 0;
  private result?: UpdateResult;
  private pending?: { key: string; controller: AbortController; promise: Promise<UpdateResult> };
  private nextCheck = 0;
  private closed = false;
  constructor(private readonly options: { version: string; fetch?: typeof fetch; now?: () => number }) { this.fetcher = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now; }
  private base(settings: UpdateSettings): UpdateResult { return { status: settings.repository ? "not-checked" : "not-configured", currentVersion: this.options.version, repository: settings.repository, includePrereleases: settings.includePrereleases }; }
  private select(settings: UpdateSettings): string {
    parseUpdateRepository(settings.repository);
    const key = JSON.stringify([settings.repository, settings.includePrereleases]);
    if (this.key !== key) { this.key = key; this.epoch++; this.pending?.controller.abort(); this.pending = undefined; this.result = undefined; this.nextCheck = 0; }
    return key;
  }
  status(settings: UpdateSettings): UpdateResult { this.select(settings); return structuredClone(this.result ?? this.base(settings)); }
  check(settings: UpdateSettings): Promise<UpdateResult> {
    const key = this.select(settings), base = this.base(settings);
    if (!settings.repository) return Promise.resolve(base);
    if (this.closed) return Promise.resolve({ ...base, status: "error", message: "The update checker has stopped." });
    if (this.pending?.key === key) return this.pending.promise.then(result => structuredClone(result));
    if (this.result && this.now() < this.nextCheck) return Promise.resolve(structuredClone(this.result));
    const epoch = this.epoch, controller = new AbortController(), snapshot = { ...settings };
    const promise = this.perform(snapshot, controller).then(result => {
      if (!this.closed && this.epoch === epoch) { this.result = structuredClone(result); this.nextCheck = Math.max(this.now() + COOLDOWN, result.retryAt ? Date.parse(result.retryAt) : 0); }
      return result;
    }).finally(() => { if (this.pending?.controller === controller) this.pending = undefined; });
    this.pending = { key, controller, promise }; return promise.then(result => structuredClone(result));
  }
  close(): void { this.closed = true; this.epoch++; this.pending?.controller.abort(); this.pending = undefined; }
  private async perform(settings: UpdateSettings, controller: AbortController): Promise<UpdateResult> {
    const base = this.base(settings), current = version(this.options.version);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("timeout")); }, TIMEOUT);
    try {
      if (!current) return { ...base, status: "unavailable", checkedAt: new Date(this.now()).toISOString(), message: "This build does not have a supported semantic version." };
      let latest: { parsed: Version; release: UpdateRelease } | undefined, published = 0;
      const budget = { remaining: TOTAL_BYTES };
      for (let page = 1; page <= PAGE_LIMIT; page++) {
        controller.signal.throwIfAborted();
        const response = await abortable(this.fetcher(`https://api.github.com/repos/${settings.repository}/releases?per_page=${PAGE_SIZE}&page=${page}`, {
          method: "GET", credentials: "omit", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": `Delta-Backupper/${this.options.version}` }
        }), controller.signal);
        controller.signal.throwIfAborted();
        if (response.status === 404) { void response.body?.cancel().catch(() => {}); return { ...base, status: "unavailable", checkedAt: new Date(this.now()).toISOString(), message: "The GitHub repository is unavailable or is not public." }; }
        if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))) {
          void response.body?.cancel().catch(() => {}); return { ...base, status: "rate-limited", checkedAt: new Date(this.now()).toISOString(), retryAt: new Date(retryTimestamp(response, this.now())).toISOString(), message: "GitHub temporarily limited update checks. Try again after the indicated time." };
        }
        if (response.status === 403) {
          const denial = await boundedJson(response, budget, controller.signal);
          if (record(denial) && typeof denial.message === "string" && /(?:secondary\s+)?rate\s+limit/i.test(denial.message)) return { ...base, status: "rate-limited", checkedAt: new Date(this.now()).toISOString(), retryAt: new Date(retryTimestamp(response, this.now())).toISOString(), message: "GitHub temporarily limited update checks. Try again after the indicated time." };
          throw new ResponseError("GitHub update check failed (HTTP 403).");
        }
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ResponseError(`GitHub update check failed (HTTP ${response.status}).`); }
        const data = await boundedJson(response, budget, controller.signal);
        if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new ResponseError("GitHub returned an invalid release list.");
        for (const item of data) {
          if (!record(item) || typeof item.draft !== "boolean" || typeof item.prerelease !== "boolean" || typeof item.tag_name !== "string") throw new ResponseError("GitHub returned invalid release metadata.");
          if (item.draft) continue;
          const publishedAt = safeDate(item.published_at); if (!publishedAt) throw new ResponseError("GitHub returned release metadata without a publication time.");
          published++;
          const parsed = version(item.tag_name); if (!parsed || (!settings.includePrereleases && (item.prerelease || parsed.prerelease.length))) continue;
          if (!latest || compare(parsed, latest.parsed) > 0) latest = { parsed, release: { version: parsed.text, tag: item.tag_name, name: typeof item.name === "string" && item.name.length <= 512 ? item.name : item.tag_name, url: `https://github.com/${settings.repository}/releases/tag/${encodeURIComponent(item.tag_name)}`, publishedAt } };
        }
        const anotherPage = data.length === PAGE_SIZE || /<[^>]+>\s*;\s*rel="next"/.test(response.headers.get("link") ?? "");
        if (!anotherPage) {
          const checkedAt = new Date(this.now()).toISOString();
          if (!published) return { ...base, status: "no-releases", checkedAt, message: "No releases have been published yet. Preproduction builds do not require tags or releases." };
          if (!latest) return { ...base, status: "unavailable", checkedAt, message: settings.includePrereleases ? "No published release has a supported semantic version." : "No stable release with a supported semantic version has been published yet." };
          return { ...base, status: compare(latest.parsed, current) > 0 ? "available" : "up-to-date", checkedAt, release: latest.release };
        }
      }
      return { ...base, status: "unavailable", checkedAt: new Date(this.now()).toISOString(), message: "The release history exceeds the update check limit. View GitHub Releases to check manually." };
    } catch (error) {
      return { ...base, status: "error", checkedAt: new Date(this.now()).toISOString(), message: controller.signal.aborted ? timedOut || controller.signal.reason?.message === "timeout" ? "The GitHub update check timed out." : "The update check was cancelled." : error instanceof ResponseError ? error.message : "Could not contact GitHub. Check your connection and try again." };
    } finally { clearTimeout(timer); }
  }
}

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(path.join(tmpdir(), "delta-updates-"));
after(async () => { await rm(directory, { recursive: true, force: true }); });
const bundle = path.join(directory, "updates.mjs");
await build({ entryPoints: ["src/service/updates.ts"], outfile: bundle, bundle: true, platform: "node", target: "node24", format: "esm", logLevel: "silent" });
const { UpdateChecker, parseUpdateRepository, isUpdateRepository } = await import(pathToFileURL(bundle).href);
const settings = { repository: "example/delta-backupper", includePrereleases: false, checkOnStartup: false };
const release = (tag, extra = {}) => ({ draft: false, prerelease: false, tag_name: tag, name: `Release ${tag}`, published_at: "2026-10-20T09:00:00Z", html_url: "https://malicious.example/installer", ...extra });
const json = (value, options = {}) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...options.headers }, ...options });
function checker(value, options = {}) { return new UpdateChecker({ version: "0.0.0-stage0", fetch: async () => json(value), ...options }); }

test("repository configuration accepts only explicit GitHub identities, including an empty preproduction setting", () => {
  for (const value of ["", "example/delta-backupper", "A/re.po_name-1", `${"a".repeat(39)}/${"r".repeat(100)}`]) { assert.equal(parseUpdateRepository(value), value); assert.equal(isUpdateRepository(value), true); }
  for (const value of [null, false, 1, {}, [], "example", "https://github.com/example/delta", "example/delta?token=secret", "example/delta/extra", "../delta", "example/..", "example/.", "-owner/delta", "owner-/delta", " example/delta", "example/delta\n", "example/del ta", "example/delta%2fnext", `${"a".repeat(40)}/delta`, `example/${"r".repeat(101)}`]) { assert.equal(isUpdateRepository(value), false, String(value)); assert.throws(() => parseUpdateRepository(value)); }
});

test("an unconfigured build performs no request and does not require any tags", async () => {
  let requests = 0; const updates = checker([], { fetch: async () => { requests++; throw new Error("must not fetch"); } });
  const unconfigured = { ...settings, repository: "" };
  assert.equal(updates.status(unconfigured).status, "not-configured"); assert.equal((await updates.check(unconfigured)).status, "not-configured"); assert.equal(requests, 0);
  assert.equal(updates.status(settings).status, "not-checked"); updates.close();
});

test("an empty public release list is the normal preproduction state, separate from a missing repository", async () => {
  const updates = checker([]), result = await updates.check(settings);
  assert.equal(result.status, "no-releases"); assert.equal(result.currentVersion, "0.0.0-stage0"); assert.match(result.message, /Preproduction/); assert(result.checkedAt); assert.equal(result.release, undefined); updates.close();
  const missing = checker([], { fetch: async () => json({ message: "Not Found" }, { status: 404 }) }); assert.equal((await missing.check(settings)).status, "unavailable"); missing.close();
});

test("requests use the pinned public HTTPS API, omit credentials, reject redirects and expose only constructed release URLs", async () => {
  const calls = [], updates = checker([], { fetch: async (url, options) => { calls.push({ url, options }); return json([release("v1.2.3")]); } });
  const result = await updates.check(settings); updates.close();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://api.github.com/repos/example/delta-backupper/releases?per_page=100&page=1");
  assert.equal(calls[0].options.credentials, "omit"); assert.equal(calls[0].options.redirect, "error"); assert.equal(calls[0].options.method, "GET"); assert(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.headers["X-GitHub-Api-Version"], "2026-03-10"); assert.match(calls[0].options.headers["User-Agent"], /Delta-Backupper/); assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(result.status, "available"); assert.equal(result.release.version, "1.2.3"); assert.equal(result.release.tag, "v1.2.3"); assert.equal(result.release.url, "https://github.com/example/delta-backupper/releases/tag/v1.2.3");
});

test("release precedence is semantic rather than chronological or lexical, and supports large integers", async () => {
  const updates = checker([release("1.9.99"), release("1.10.0"), release("v1.2.3"), release("2.0.0", { published_at: "2026-01-01T00:00:00Z" })], { version: "1.10.0" });
  assert.equal((await updates.check(settings)).release.version, "2.0.0"); updates.close();
  const big = checker([release("9007199254740992.0.0"), release("9007199254740993.0.0")], { version: "9007199254740992.0.0" }); assert.equal((await big.check(settings)).release.version, "9007199254740993.0.0"); big.close();
});

test("stable defaults exclude drafts, API prereleases and semantic prereleases even when mislabeled", async () => {
  const updates = checker([release("999.0.0", { draft: true, published_at: null }), release("5.0.0", { prerelease: true }), release("4.0.0-beta.1"), release("1.0.0")]);
  assert.equal((await updates.check(settings)).release.version, "1.0.0"); updates.close();
  const onlyPrerelease = checker([release("1.0.0-beta.1")]); assert.equal((await onlyPrerelease.check(settings)).status, "unavailable"); onlyPrerelease.close();
});

test("opted-in prereleases follow numeric and identifier SemVer rules; stable outranks its prereleases", async () => {
  const optedIn = { ...settings, includePrereleases: true };
  const values = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let index = 1; index < values.length; index++) {
    const updates = checker([release(values[index - 1]), release(values[index])], { version: values[index - 1] });
    const result = await updates.check(optedIn); assert.equal(result.status, "available", values[index]); assert.equal(result.release.version, values[index]); updates.close();
  }
  const next = checker([release("2.0.0-beta.10", { prerelease: true }), release("2.0.0-beta.2")], { version: "2.0.0-beta.3" }); assert.equal((await next.check(optedIn)).release.version, "2.0.0-beta.10"); next.close();
});

test("equal or older releases never offer a downgrade and build metadata does not affect precedence", async () => {
  for (const current of ["1.2.3", "1.2.3+local", "2.0.0-beta.1"]) {
    const updates = checker([release("v1.2.3+release")], { version: current }); assert.equal((await updates.check(settings)).status, "up-to-date"); updates.close();
  }
});

test("unsupported tags are ignored; a release list without compatible versions is not reported as up to date", async () => {
  const invalid = ["latest", "2026-10-29", "1.2", "01.2.3", "1.2.3-beta.01", "1.2.3-", "1.2.3+", "1.2.3/next", "vV1.2.3", "1.2.3\n"];
  const updates = checker(invalid.map(tag => release(tag))); assert.equal((await updates.check(settings)).status, "unavailable"); updates.close();
  const valid = checker([...invalid.map(tag => release(tag)), release("1.0.0")]); assert.equal((await valid.check(settings)).release.version, "1.0.0"); valid.close();
  let requests = 0; const unsupported = checker([], { version: "not-a-version", fetch: async () => { requests++; return json([]); } }); assert.equal((await unsupported.check(settings)).status, "unavailable"); assert.equal(requests, 0); unsupported.close();
});

test("all bounded pages are considered and hostile Link URLs are never followed", async () => {
  const urls = [], updates = checker([], { version: "1.0.0", fetch: async url => { urls.push(url); return urls.length === 1 ? json([release("1.0.0")], { headers: { Link: '<http://127.0.0.1/private>; rel="next"' } }) : json([release("2.0.0")]); } });
  assert.equal((await updates.check(settings)).release.version, "2.0.0"); updates.close();
  assert.deepEqual(urls, ["https://api.github.com/repos/example/delta-backupper/releases?per_page=100&page=1", "https://api.github.com/repos/example/delta-backupper/releases?per_page=100&page=2"]);
});

test("pagination limits never falsely claim the latest version is installed", async () => {
  let requests = 0; const updates = checker([], { fetch: async () => { requests++; return json(Array.from({ length: 100 }, () => release("0.0.0"))); } });
  const result = await updates.check(settings); assert.equal(requests, 10); assert.equal(result.status, "unavailable"); assert.match(result.message, /limit/); assert.equal(result.release, undefined); updates.close();
});

test("malformed, oversized and incompletely published responses produce bounded errors", async () => {
  const cases = [
    () => json({ releases: [] }),
    () => json([release("1.0.0", { published_at: null })]),
    () => json([release("1.0.0", { published_at: "yesterday" })]),
    () => json([release("1.0.0", { draft: "false" })]),
    () => json(Array.from({ length: 101 }, () => release("1.0.0"))),
    () => new Response("broken JSON"),
    () => new Response("[]", { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }),
    () => new Response(" ".repeat(4 * 1024 * 1024 + 1))
  ];
  for (const response of cases) { const updates = checker([], { fetch: async () => response() }); const result = await updates.check(settings); assert.equal(result.status, "error"); assert.equal(result.release, undefined); updates.close(); }
});

test("the combined response budget limits many individually valid release pages", async () => {
  let requests = 0; const updates = checker([], { fetch: async () => { requests++; return json([release("1.0.0", { body: "x".repeat(3 * 1024 * 1024) })], { headers: { Link: '<https://api.github.com/next>; rel="next"' } }); } });
  const result = await updates.check(settings); assert.equal(result.status, "error"); assert.match(result.message, /size limit/); assert.equal(requests, 6); updates.close();
});

test("network failures and ordinary HTTP denials stay distinct from a release-free preproduction repository", async () => {
  for (const response of [async () => { throw new Error("secret token must not leak"); }, async () => json({ message: "Forbidden" }, { status: 403 }), async () => json({}, { status: 500 })]) {
    const updates = checker([], { fetch: response }); const result = await updates.check(settings); assert.equal(result.status, "error"); assert.doesNotMatch(result.message, /secret token/); updates.close();
  }
});

test("primary and secondary rate limits honor retry timing without disclosing server messages", async () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const cases = [
    { status: 429, headers: { "retry-after": "120" } },
    { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 120) } },
    { status: 403, headers: { "retry-after": "Thu, 29 Oct 2026 12:02:00 GMT" } }
  ];
  for (const response of cases) { const updates = checker([], { now: () => now, fetch: async () => json({}, response) }); const result = await updates.check(settings); assert.equal(result.status, "rate-limited"); assert.equal(result.retryAt, "2026-10-29T12:02:00.000Z"); updates.close(); }
  const secondary = checker([], { now: () => now, fetch: async () => json({ message: "You have exceeded a secondary rate limit. private detail" }, { status: 403 }) }); const result = await secondary.check(settings); assert.equal(result.status, "rate-limited"); assert.equal(result.retryAt, "2026-10-29T12:01:00.000Z"); assert.doesNotMatch(result.message, /private detail/); secondary.close();
});

test("concurrent checks coalesce and completed results have a manual cooldown", async () => {
  let complete, requests = 0, now = 100_000; const updates = checker([], { now: () => now, fetch: () => { requests++; return new Promise(resolve => { complete = resolve; }); } });
  const a = updates.check(settings), b = updates.check(settings); assert.equal(requests, 1); complete(json([])); assert.deepEqual(await a, await b);
  const altered = await updates.check(settings); altered.status = "available"; assert.equal(updates.status(settings).status, "no-releases"); assert.equal(requests, 1);
  now += 59_999; assert.equal((await updates.check(settings)).status, "no-releases"); assert.equal(requests, 1);
  now++; const c = updates.check(settings); assert.equal(requests, 2); complete(json([release("1.0.0")])); assert.equal((await c).status, "available"); updates.close();
});

test("rate-limit retries cannot bypass the server delay using repeated manual checks", async () => {
  let now = 1_000_000, requests = 0; const updates = checker([], { now: () => now, fetch: async () => { requests++; return json({}, { status: 429, headers: { "retry-after": "120" } }); } });
  assert.equal((await updates.check(settings)).status, "rate-limited"); now += 60_000; assert.equal((await updates.check(settings)).status, "rate-limited"); assert.equal(requests, 1); now += 60_000; await updates.check(settings); assert.equal(requests, 2); updates.close();
});

test("changing repository or channel cancels the old check and never caches stale results for the new settings", async () => {
  const pending = [], updates = checker([], { fetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve })) });
  const first = updates.check(settings); assert.equal(pending.length, 1);
  const other = { ...settings, repository: "another/delta" }; assert.equal(updates.status(other).status, "not-checked"); assert.equal(pending[0].options.signal.aborted, true);
  const second = updates.check(other); pending[1].resolve(json([])); assert.equal((await second).status, "no-releases"); pending[0].resolve(json([release("99.0.0")])); assert.equal((await first).status, "error"); assert.equal(updates.status(other).status, "no-releases");
  assert.equal(updates.status({ ...other, includePrereleases: true }).status, "not-checked"); assert.equal(updates.status(settings).status, "not-checked"); updates.close();
});

test("close promptly aborts an in-flight request even when a transport ignores AbortSignal", async () => {
  let signal, requests = 0; const updates = checker([], { fetch: (_url, options) => { requests++; signal = options.signal; return new Promise(() => {}); } });
  const pending = updates.check(settings); updates.close(); updates.close(); assert.equal(signal.aborted, true); assert.equal((await pending).status, "error"); assert.match((await updates.check(settings)).message, /stopped/); assert.equal(requests, 1);
});

test("one total timeout bounds a stalled request and a stalled response body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stalledRequest = checker([], { fetch: () => new Promise(() => {}) }), first = stalledRequest.check(settings);
  t.mock.timers.tick(15_000); const firstResult = await first; assert.equal(firstResult.status, "error"); assert.match(firstResult.message, /timed out/); stalledRequest.close();
  let cancelled = false, responseDelivered; const ready = new Promise(resolve => { responseDelivered = resolve; });
  const stalledBody = checker([], { fetch: async () => { const response = new Response(new ReadableStream({ start() { responseDelivered(); }, cancel() { cancelled = true; } })); return response; } }), second = stalledBody.check(settings);
  await ready; await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(15_000);
  const secondResult = await second; assert.equal(secondResult.status, "error"); assert.match(secondResult.message, /timed out/); assert.equal(cancelled, true); stalledBody.close();
});

test("a stalled stream cancellation cannot extend the check deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let delivered; const ready = new Promise(resolve => { delivered = resolve; });
  const updates = checker([], { fetch: async () => { const response = new Response(new ReadableStream({ start() { delivered(); }, cancel() { return new Promise(() => {}); } })); return response; } });
  const pending = updates.check(settings); await ready; await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(15_000);
  const result = await pending; assert.equal(result.status, "error"); assert.match(result.message, /timed out/); updates.close();
});

// Acceptance test of the merged and deployed product (branch feature/selfhost-release). It runs the product the way a
// user does, in the deployed configuration: stage a on a plain web space (tests/selfhost/server.js, which sends no CSP
// header) and on the full compose stack behind its proxy, the accounts of stage b, the teams of stage c, the embed view,
// injected markup, forged requests from other sites and from a user subdomain, and the headers of the stack.
//
// Three rules hold in every browser context. An init script records each securitypolicyviolation event. Each request to
// a host outside the site, its subdomains and the pages of this test is recorded (and aborted, so that the test never
// talks to the internet). Each console error counts. Each of them fails the check, unless the check expects it. The
// init script also reports each write to window.__xss, the flag of the injected markup in check 8, from every page.
//
// The stack must run with the site of node build_selfhost.js (npm run test:release builds it first), and the run proves
// that it does: the stack serves each built file byte for byte. The addresses come from the environment, then from
// server/.env: BASE_URL and MAILPIT_PORT (or MAILPIT_URL). The run reads the subdomains from the stack itself: the first
// map of the owner names its subdomain address, or none when BASE_DOMAIN is empty. Without subdomains, the run checks that
// no subdomain answers, and every other check runs as with them.
//
// Limits of the stack: each run registers 4 accounts (owner, editor, reader, and the account of the checks of the
// languages) and signs in about 7 times. The stack allows RATE_LIMIT_REGISTER_IP registrations per IP address (10 per hour
// in server/.env.example) and RATE_LIMIT_LOGIN_IP logins (20 in 15 minutes). So with these values a third run within one
// hour gets 429, and the run then stops with a message that names the limit. Each run also asks for one new password,
// against RATE_LIMIT_RESET_IP. Raise the limits in server/.env of a test stack, or wait.
//
// Every wait of the run has a limit. A wait that runs out fails its check and says what did not arrive.
// Each check prints one line: PASS <name> (<time>) or FAIL <name>: <reason>. With E2E_VERBOSE=1 the run prints every step
// of each check. The checks run one after another. A check that needs the state of an earlier check that failed says
// "not run". The run deletes its accounts and its team at the end, also after a failure.
// Usage: node tests/release/run.js [part of a check name ...]
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), http = require("http"), https = require("https");
const { chromium } = require("playwright");
const { serve } = require("../selfhost/server");
const { chooseLanguage } = require("../e2e/site");

const repo = path.join(__dirname, "..", "..");
const SITE = path.join(repo, "dist", "selfhost");
const VERBOSE = !!process.env.E2E_VERBOSE;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (x) => Array.isArray(x) ? x.map(sorted) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sorted(x[k])])) : x;
const uniq = (list) => [...new Set(list)];
const short = (text, n = 220) => { const t = String(text).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const kb = (bytes) => bytes < 1024 ? bytes + " B" : (bytes / 1024).toFixed(0) + " KB";
// A wait with a limit: the promise, or an error that names what did not arrive within ms. Each check as a whole has a
// limit too: 6 minutes, as the downloads of a map can take minutes on a slow computer. RELEASE_CHECK_LIMIT_S changes it.
const CHECK_LIMIT_MS = (Number(process.env.RELEASE_CHECK_LIMIT_S) || 360) * 1000;
class Late extends Error {}
function within(promise, ms, what) {
  let timer;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Late(`${what}: no answer within ${ms / 1000} s`)), ms); });
  return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(timer));
}

// The addresses of the stack, as in tests/server/run.js. The domain of the subdomains comes from the stack (domainFrom):
// null until the first map of the owner names it, then "" without subdomains.
function settings() {
  const file = path.join(repo, "server", ".env"), env = {};
  if (fs.existsSync(file)) fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line) => { const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2]; });
  const get = (name, fallback) => process.env[name] || env[name] || fallback;
  const base = get("BASE_URL", "https://it-skills.localhost:8443").replace(/\/+$/, "");
  return { base, domain: null, mailpit: (process.env.MAILPIT_URL || "http://127.0.0.1:" + get("MAILPIT_PORT", "8025")).replace(/\/+$/, "") };
}
const S = settings(), BASE = new URL(S.base);
// The domain of the subdomains from the API answer of a map of the owner: subdomainUrl is https://<handle>.<domain>/<slug>,
// or null when the stack serves no subdomains.
function domainFrom(meta, handle) {
  if (!meta || !("subdomainUrl" in meta)) return null;
  if (meta.subdomainUrl === null) return "";
  const host = new URL(meta.subdomainUrl).hostname;
  return host.startsWith(handle + ".") ? host.slice(handle.length + 1) : null;
}
// Without subdomains, the subdomain of a handle below the host of the site must not answer: no certificate, no site, or
// an answer that is no page of the stack.
async function noSubdomain(check, handle, rest = "/") {
  const url = `${BASE.protocol}//${handle}.${BASE.hostname}${BASE.port ? ":" + BASE.port : ""}${rest}`;
  const status = await stackFetch(url).then((a) => a.status, () => null), page = status !== null && status >= 200 && status < 300;
  check(!page, `without subdomains: ${where(url)} does not serve a page` + (page ? `: it answers ${status}` : ""));
}
const subdomainOrigin = (handle) => `${BASE.protocol}//${handle}.${S.domain}${BASE.port ? ":" + BASE.port : ""}`;
const WRITE = { "X-Requested-With": "it-skills", Origin: S.base };

// Requests of Node to the stack, for the setup, the reads of the database and the headers. The browser resolves every
// name below .localhost to the loopback address, Node does not on every system: so a name below .localhost goes to
// 127.0.0.1, with the name of the site as Host header and as TLS server name. The local CA of the proxy is not trusted.
function stackFetch(url, { method = "GET", headers = {}, body = null } = {}) {
  const u = new URL(url), secure = u.protocol === "https:";
  const host = u.hostname === "localhost" || u.hostname.endsWith(".localhost") ? "127.0.0.1" : u.hostname;
  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).request({
      host, port: u.port || (secure ? 443 : 80), method, path: u.pathname + u.search, servername: u.hostname, rejectUnauthorized: false,
      headers: { Host: u.host, ...headers, ...(body !== null ? { "Content-Length": Buffer.byteLength(body) } : {}) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => { const body = Buffer.concat(chunks); resolve({ status: response.statusCode, headers: response.headers, body, text: body.toString("utf8") }); });
    });
    request.on("error", reject);
    request.setTimeout(20000, () => request.destroy(new Error("no answer within 20 s: " + url)));
    if (body !== null) request.write(body);
    request.end();
  });
}
// The Cookie header of a browser context for the main domain, or a Cookie header as it is.
const cookieOf = async (who) => typeof who === "string" ? who : (await who.context.cookies(S.base)).map((c) => `${c.name}=${c.value}`).join("; ");
// An API call with the session of a person: to set up a state or to read the database for a check.
async function api(who, method, url, body) {
  const headers = { ...WRITE, Cookie: await cookieOf(who), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) };
  const answer = await stackFetch(S.base + url, { method, headers, body: body === undefined ? null : JSON.stringify(body) });
  let data = null;
  try { data = JSON.parse(answer.text); } catch (error) { data = null; }
  return { status: answer.status, data, headers: answer.headers };
}
// Signs in through the API and gives the Cookie header of the new session, or null.
async function signIn(p) {
  const answer = await api("", "POST", "/api/auth/login", { email: p.email, password: p.password });
  if (answer.status === 429) console.error(`The stack refused the login of ${p.handle} with 429: RATE_LIMIT_LOGIN_IP or RATE_LIMIT_LOGIN_ACCOUNT in server/.env. The run could not delete this account.`);
  return answer.status === 200 ? [].concat(answer.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ") : null;
}

// The people of this run: an owner, an editor and a reader, with new handles each time, and their team.
const RUN = crypto.randomBytes(3).toString("hex");
const person = (role, letter) => {
  const handle = `rel-${RUN}-${letter}`;
  return { role, handle, email: handle + "@example.org", password: "ein langes Passwort " + crypto.randomBytes(4).toString("hex"), s: null };
};
const people = { owner: person("owner", "o"), editor: person("editor", "e"), reader: person("reader", "r") };
// The account of the checks of the languages. It registers through the API, in English, and deletes itself.
const speaker = person("speaker", "l");
const team = { name: "Release-Team " + RUN, handle: `rel-${RUN}-team`, made: false, map: null };
// What the checks hand on: the stage a contexts and maps, the account map and the map with markup.
const state = { a: {}, map: null, markup: null };
// The values of the checks with injected markup (check 8).
const MARKUP = ['<img src=x onerror="window.__xss=1">', "<script>window.__xss=1</script>", '"><svg onload="window.__xss=1">'];
const MARKUP_TITLE = MARKUP.join(" ");

// The origins of this test: the plain web space and the pages of other sites (hostSite).
const testOrigins = new Set();
function ours(url) {
  let u;
  try { u = new URL(url); } catch (error) { return false; }
  if (u.protocol === "data:" || u.protocol === "blob:") return true;
  if (u.origin === BASE.origin || testOrigins.has(u.origin)) return true;
  return !!S.domain && u.protocol === BASE.protocol && u.port === BASE.port && u.hostname.endsWith("." + S.domain);
}
const onStack = (url) => { try { const u = new URL(url); return u.origin === BASE.origin || (!!S.domain && u.port === BASE.port && u.hostname.endsWith("." + S.domain)); } catch (error) { return false; } };
const where = (url) => { try { const u = new URL(url); return (u.origin === BASE.origin ? "" : u.origin) + u.pathname; } catch (error) { return String(url); } };

// Every HTML answer of the stack that a browser of this run got, and the Set-Cookie headers of the logins (check 11).
const htmlAnswers = new Map();
const loginCookies = [];
function recordAnswer(response) {
  const url = response.url().split("#")[0];
  if (!onStack(url)) return;
  const headers = response.headers();
  if ((headers["content-type"] || "").includes("text/html")) htmlAnswers.set(url, { status: response.status(), csp: headers["content-security-policy"] || null });
  if (url === S.base + "/api/auth/login" && response.status() === 200) response.headerValue("set-cookie").then((v) => { if (v) loginCookies.push(v); }, () => {});
}

// A browser context with the three rules. s.allow: console errors that the check expects. s.allowCsp: violations that
// the check expects, as "<directive> <blocked address>". s.downloads: the downloads of all its pages.
const contexts = new Set();
let browser = null;
// language: the language of the pages, German by default (tests/e2e/site.js), so every check keeps its name.
async function site({ bypassCSP = false, storageState = undefined, viewport = { width: 1400, height: 900 }, language = "de" } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, reducedMotion: "reduce", acceptDownloads: true, bypassCSP, storageState });
  if (language) await context.addInitScript(chooseLanguage, language);
  context.setDefaultTimeout(20000);
  contexts.add(context);
  context.on("close", () => contexts.delete(context));
  const s = { context, errors: [], external: [], csp: [], markup: [], allow: [], allowCsp: [], downloads: [] };
  await context.exposeBinding("__releaseViolation", (source, v) => { s.csp.push(v); });
  // Injected markup sets window.__xss (check 8). The setter reports it at once, also from a page that the test left.
  await context.exposeBinding("__releaseMarkup", (source, page) => { s.markup.push(page); });
  await context.addInitScript(() => {
    addEventListener("securitypolicyviolation", (event) => {
      try {
        window.__releaseViolation({ directive: event.effectiveDirective || event.violatedDirective, blocked: event.blockedURI || "", page: location.href, sample: event.sample || "" });
      } catch (error) { /* the page closes */ }
    }, true);
    let value;
    Object.defineProperty(window, "__xss", { configurable: true, get: () => value, set: (v) => { value = v; try { window.__releaseMarkup(location.href); } catch (error) { /* the page closes */ } } });
  });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (ours(url)) return route.continue();
    s.external.push(url);
    return route.abort("blockedbyclient");
  });
  context.on("page", (page) => {
    page.on("pageerror", (error) => s.errors.push("page error: " + error.message));
    page.on("console", (message) => {
      if (message.type() !== "error" || s.allow.some((re) => re.test(message.text()))) return;
      const at = (message.location() || {}).url;
      s.errors.push(message.text() + (at ? " at " + where(at) : ""));
    });
    page.on("response", recordAnswer);
    page.on("download", (download) => s.downloads.push(download));
  });
  s.page = await context.newPage();
  return s;
}
const violationText = (v) => `${v.directive} blocked ${v.blocked || "inline code"} on ${where(v.page)}`;
// The three rules as checks; they reset the records for the next check.
function clean(check, s, what = "") {
  const csp = s.csp.filter((v) => !s.allowCsp.some((re) => re.test(`${v.directive} ${v.blocked}`)));
  check(!csp.length, "no CSP violation" + what + (csp.length ? ": " + uniq(csp.map(violationText)).join(", ") : ""));
  check(!s.errors.length, "no console error" + what + (s.errors.length ? ": " + uniq(s.errors.map((e) => short(e, 180))).join(" | ") : ""));
  check(!s.external.length, "no request leaves the site" + what + (s.external.length ? ": " + uniq(s.external).join(", ") : ""));
  check(!s.markup.length, "no injected markup ran" + what + (s.markup.length ? ": window.__xss was set on " + uniq(s.markup.map(where)).join(", ") : ""));
  s.csp.length = 0; s.errors.length = 0; s.external.length = 0; s.markup.length = 0;
}
// A check with a fresh context that closes at the end.
const fresh = (body, options) => async ({ check }) => {
  const s = await site(options);
  try { await body(s, check); } finally { clean(check, s); await s.context.close(); }
};
// A check in the context of a person of the run, which stays open for the next checks. note(text) reports something
// that the verdict does not depend on, such as a slow clean-up step.
const as = (who, body) => async ({ check, note }) => {
  const s = need(people[who].s, `${who} is not signed in`);
  try { await body(s, check, note); } finally { clean(check, s, ` (${who})`); s.allow = []; s.allowCsp = []; }
};

// The checks, run one after another. A check that misses the state of an earlier check throws NotRun.
class NotRun extends Error {}
const need = (value, what) => { if (!value) throw new NotRun(what); return value; };
const tests = [];
const test = (name, fn, always = false) => tests.push({ name, fn, always });

// Page helpers, as in tests/server/run.js and tests/selfhost/run.js.
const go = (page, where_) => page.goto(/^https?:/.test(where_) ? where_ : S.base + where_);
const h2 = (page) => page.locator("#panel h2").first().textContent().then((t) => (t || "").trim());
async function mapReady(page, { owner = true, heading = null } = {}) {
  await page.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 });
  if (owner) await page.waitForFunction(() => document.getElementById("save-state").textContent === "Gespeichert" && document.getElementById("cfg-groups").children.length > 0, null, { timeout: 15000 });
  if (heading) await page.waitForFunction((h) => document.querySelector("#panel h2").textContent === h, heading, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(250);
}
const saved = (page) => page.waitForFunction(() => document.getElementById("save-state").textContent === "Gespeichert", null, { timeout: 10000 }).then(() => page.waitForTimeout(200));
async function clickPanel(page, text) { await page.locator("#panel button", { hasText: text }).first().click(); await page.waitForTimeout(150); }
async function submitForm(page) { await page.locator("#catalog-form button[type=submit]").click(); await page.waitForTimeout(300); }
async function toOverview(page) {
  if ((await page.locator("#projects-btn").getAttribute("aria-pressed")) === "true") { await page.click("#projects-btn"); await page.waitForTimeout(150); }
  const back = page.locator('#panel [data-go="overview|"]');
  if (await back.count()) { await back.first().click(); await page.waitForTimeout(150); }
}
const stored = (page) => page.evaluate((key) => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith(key)).map((k) => [k.slice(key.length), JSON.parse(localStorage.getItem(k))])), "it-skills-map/");
const mapIdOf = (page) => new URL(page.url()).searchParams.get("id");
const pick = (page, selector, name, text) => page.setInputFiles(selector, { name, mimeType: "application/json", buffer: Buffer.from(text, "utf8") });
async function exportFrom(page, click) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), click()]);
  return { name: download.suggestedFilename(), text: fs.readFileSync(await within(download.path(), 30000, "the file of " + download.suggestedFilename()), "utf8") };
}
async function openShare(page) {
  await page.click("#share-open");
  await page.waitForFunction(() => { const d = document.getElementById("share-dialog"); return d && d.open && d.querySelector("#share-title"); }, null, { timeout: 10000 });
}
const dialogSays = (page, text) => page.waitForFunction((t) => document.getElementById("share-dialog").textContent.includes(t), text, { timeout: 10000 }).then(() => true, () => false);
// Waits until get() gives a value that ok() accepts, and gives the last value.
async function until(get, ok, timeout = 8000) {
  const end = Date.now() + timeout;
  let value = await get();
  while (!ok(value) && Date.now() < end) { await new Promise((done) => setTimeout(done, 250)); value = await get(); }
  return value;
}
// A word of the subject of each mail, in each language of the server (server/app/i18n/<language>/mail.json). A mail goes
// out in the language of its recipient: an account that registers on the page has the language of the page.
const SUBJECT = { confirm: ["bestätige", "Please confirm"], invitation: ["Einladung", "Invitation"], reset: ["Neues Passwort", "New password"] };
// Mail through the API of mailpit: the newest mail to "to" whose subject holds subject, or one of a list of subjects.
async function mailTo(to, subject, timeout = 20000) {
  const end = Date.now() + timeout, subjects = [].concat(subject);
  while (Date.now() < end) {
    const list = await (await fetch(S.mailpit + "/api/v1/search?query=" + encodeURIComponent(`to:"${to}"`), { signal: AbortSignal.timeout(10000) })).json();
    const found = (list.messages || []).filter((m) => subjects.some((s) => m.Subject.includes(s)));
    if (found.length) return (await fetch(S.mailpit + "/api/v1/message/" + found[0].ID, { signal: AbortSignal.timeout(10000) })).json();
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`no mail "${subject}" to ${to} within ${timeout / 1000} s`);
}

// Pages of other sites: a small server on 127.0.0.1 with a free port, with pages that the test writes.
function hostSite() {
  const pages = new Map();
  const server = http.createServer((request, response) => {
    const html = pages.get(new URL(request.url, "http://127.0.0.1").pathname);
    response.writeHead(html === undefined ? 404 : 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html === undefined ? "" : html);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const origin = "http://127.0.0.1:" + server.address().port;
    testOrigins.add(origin);
    done({
      origin,
      show(name, body) {
        pages.set("/" + name, `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Andere Website</title></head><body><h1>Andere Website</h1>${body}</body></html>`);
        return origin + "/" + name;
      },
      close: () => new Promise((closed) => { server.closeAllConnections(); server.close(closed); }),
    });
  }));
}
let hosts = null;
const hostSites = async () => hosts || (hosts = await Promise.all([hostSite(), hostSite()]));
const frameTag = (src) => `<iframe id="map-frame" src="${src.replace(/&/g, "&amp;")}" title="Skill-Map" style="width:100%;height:600px;border:0"></iframe>`;
async function frameOf(page) {
  const frame = await (await page.waitForSelector("#map-frame")).contentFrame();
  await frame.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
  const shown = await frame.waitForFunction(() => !!document.querySelector("#map") && !!document.querySelector("#panel h2"), null, { timeout: 8000 }).then(() => true, () => false);
  return { frame, shown };
}
const FRAME_REFUSED = [/Refused to (frame|display)/, /frame-ancestors/];

// ---------------------------------------------------------------------------------------------------------------
// Downloads (checks 2 to 5): each button must give a file with a sensible name and type, above a floor of size.
const FILES = [
  { kind: "svg", label: "SVG", ext: "svg", floor: 20 * 1024 },
  { kind: "png", label: "PNG", ext: "png", floor: 20 * 1024 },
  { kind: "png4", label: "PNG 4×", ext: "png", floor: 40 * 1024 },
  { kind: "pdf", label: "PDF", ext: "pdf", floor: 3 * 1024 },
];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const W3_NAMESPACE = /^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace|2000\/xmlns\/?)$/;
const pngSize = (data) => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) });
function fileProblems(f, name, data) {
  const problems = [];
  if (!new RegExp(`^[^\\\\/:*?"<>|\\s.][^\\\\/:*?"<>|]*\\.${f.ext}$`).test(name) || /^download/i.test(name)) problems.push(`the name is no .${f.ext} file name`);
  if (data.length < f.floor) problems.push(`only ${kb(data.length)}, below ${kb(f.floor)}`);
  if (f.ext === "png" && !data.subarray(0, 8).equals(PNG_MAGIC)) problems.push("no PNG data");
  if (f.ext === "pdf" && data.subarray(0, 4).toString("latin1") !== "%PDF") problems.push("does not start with %PDF");
  if (f.ext === "svg") {
    const text = data.toString("utf8");
    if (!/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/.test(text)) problems.push("no SVG document");
    if (!/@font-face[^}]*url\(\s*["']?data:font\//.test(text)) problems.push("its fonts are not embedded as data");
    const foreign = uniq((text.match(/https?:\/\/[^\s"'<>)]+/g) || []).filter((u) => !W3_NAMESPACE.test(u)));
    if (foreign.length) problems.push("foreign addresses: " + foreign.slice(0, 4).join(", "));
  }
  return problems;
}
// Clicks the four downloads of the map page, one after another, and checks each file.
async function downloadEach(s, page, check, label) {
  const sizes = {}, names = {};
  for (const f of FILES) {
    const button = page.locator(`#downloads button[data-file="${f.kind}"]`);
    if (!(await button.isVisible().catch(() => false))) { check(false, `${label}: ${f.label}: the button is not shown`); continue; }
    const before = s.downloads.length;
    await button.click();
    // The page is done when its buttons are enabled again. A file can arrive a moment later.
    await page.waitForFunction(() => [...document.querySelectorAll("#downloads button")].every((b) => !b.disabled), null, { timeout: 90000 }).catch(() => {});
    const said = short(await page.locator("#download-state").textContent().catch(() => "") || "", 160);
    const error = (await page.locator("#download-state.error").count().catch(() => 0)) > 0;
    const end = Date.now() + (error ? 500 : 10000);
    while (s.downloads.length === before && Date.now() < end) await page.waitForTimeout(100);
    const download = s.downloads[before];
    if (!download) { check(false, `${label}: ${f.label}: no file arrives, the page says „${said}“`); continue; }
    // The browser can keep a download open: failure() and path() wait until it ends, so each wait has a limit.
    const failure = await within(download.failure(), 30000, "the end of the download").catch((error) => error instanceof Late ? error.message : String(error));
    if (failure) { check(false, `${label}: ${f.label}: the browser does not save the file: ${failure}`); continue; }
    const file = await within(download.path(), 30000, "the file of the download").catch((error) => { check(false, `${label}: ${f.label}: ${error.message}`); return null; });
    if (!file) continue;
    const name = download.suggestedFilename(), data = fs.readFileSync(file);
    const problems = fileProblems(f, name, data);
    check(!problems.length, `${label}: ${f.label} saves as ${name} (${kb(data.length)})` + (problems.length ? ": " + problems.join("; ") : ""));
    names[f.kind] = name;
    if (f.ext === "png" && data.subarray(0, 8).equals(PNG_MAGIC)) sizes[f.kind] = pngSize(data);
  }
  if (names.png && names.png4) check(names.png !== names.png4, `${label}: PNG and PNG 4× have different names: ${names.png}, ${names.png4}`);
  if (sizes.png && sizes.png4) check(sizes.png4.width > sizes.png.width, `${label}: PNG 4× is larger than PNG: ${sizes.png4.width} × ${sizes.png4.height} against ${sizes.png.width} × ${sizes.png.height} px`);
}

// ---------------------------------------------------------------------------------------------------------------
// Content Security Policy: a policy as a map of directives, and what keeps it from being strict.
function policyOf(text) {
  const directives = new Map();
  for (const part of String(text || "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values);
  }
  return directives;
}
// The script-src (or default-src) must be 'self', with no 'unsafe-inline', no other host and no scheme.
function scriptProblems(directives) {
  const script = directives.get("script-src") || directives.get("default-src");
  if (!script) return ["no script-src"];
  const problems = [];
  if (!script.includes("'self'")) problems.push("script-src without 'self'");
  const loose = script.filter((v) => !/^'(self|strict-dynamic|report-sample|nonce-[^']+|sha(256|384|512)-[^']+)'$/i.test(v));
  if (loose.length) problems.push("script-src " + loose.join(" "));
  return problems;
}
// A full policy in a header: default-src, a strict script-src and frame-ancestors.
function headerProblems(text) {
  if (!text) return ["no CSP header"];
  const directives = policyOf(text), problems = [];
  if (!directives.has("default-src")) problems.push("no default-src");
  problems.push(...scriptProblems(directives));
  if (!directives.has("frame-ancestors")) problems.push("no frame-ancestors");
  return problems.length ? [`${problems.join(", ")} (CSP: ${short(text, 90)})`] : [];
}
const metaPolicy = (html) => { const m = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]*)"|'([^']*)')/i); return m ? m[1] || m[2] || "" : null; };

// ---------------------------------------------------------------------------------------------------------------
// Map files of stage a: the frame of the format, and a map with injected markup in every kind of name and note.
const mapFile = (title, collections) => ({ format: "it-skills-map", schema: 1, title, exportedAt: "2026-10-19T08:00:00Z", collections });
function markupFile() {
  const collections = { areas: { web: { name: "Bereich", color: "#2c5fc4", at: [0, 0], order: 0 } }, groups: {}, skills: {}, stations: {}, projects: {} };
  MARKUP.forEach((value, i) => {
    collections.groups["web-g" + i] = { name: value, area: "web", order: i };
    collections.stations["STATION" + (i + 1)] = { name: "Station " + (i + 1), short: "", kind: "Arbeitgeber", when: `${2018 + i} – ${2019 + i}`, months: 24, note: value, order: i };
    collections.skills["k" + i] = { name: value, group: "web-g" + i, rating: 2, places: ["STATION" + (i + 1)], order: i };
    collections.projects["p" + i] = { name: value, station: "STATION" + (i + 1), base: false, order: i + 1, when: "", skills: [value] };
  });
  return mapFile(MARKUP_TITLE, collections);
}
// Elements that injected markup would have made, and the flag that its code would have set.
const leaked = (frameOrPage) => frameOrPage.evaluate(() => {
  // Where an element sits: its tag and the tags, ids and classes of up to four ancestors.
  const place = (e) => { const parts = []; for (let x = e; x && x !== document.body && parts.length < 5; x = x.parentElement) parts.unshift(x.localName + (x.id ? "#" + x.id : "") + (typeof x.className === "string" && x.className ? "." + x.className.trim().split(/\s+/).join(".") : "")); return parts.join(" > "); };
  const elements = [...document.querySelectorAll('img[src="x"], [onerror], [onload]')], scripts = [...document.scripts].filter((s) => s.textContent.trim() === "window.__xss=1");
  return { xss: typeof window.__xss, elements: elements.length, scripts: scripts.length, at: [...elements, ...scripts].map(place) };
});
async function noMarkupRan(page, check, label) {
  const v = await leaked(page);
  check(v.xss === "undefined" && v.elements === 0 && v.scripts === 0, `${label}: no markup ran: window.__xss is ${v.xss}, ${v.elements} injected elements, ${v.scripts} injected scripts` + (v.at.length ? " at " + v.at.join(", ") : ""));
}
// Opens the panel of each skill, category, station and project with markup, searches each skill and reads its tooltip.
// It expects the map of markupFile (or the same items written through the forms).
async function inspectMarkup(page, check, label) {
  check((await page.locator("#title").textContent()) === MARKUP_TITLE, `${label}: the header shows the title as text`);
  check((await page.title()).startsWith(MARKUP_TITLE), `${label}: the tab shows the title as text: ${short(await page.title(), 80)}`);
  for (let i = 0; i < MARKUP.length; i++) {
    const value = MARKUP[i], n = i + 1;
    await toOverview(page);
    await page.fill("#q", value);
    await page.waitForTimeout(200);
    const heading = await h2(page), matches = await page.locator("#map .node.match").count();
    check(heading === `1 Treffer für „${value}“` && matches === 1, `${label}: the search for value ${n} finds its skill: „${short(heading, 80)}“, ${matches} marked`);
    const chip = page.locator("#panel .chips .chip").filter({ hasText: value });
    if (await chip.count()) {
      await chip.first().click();
      await page.waitForTimeout(200);
      check((await h2(page)) === value, `${label}: the panel of skill ${n} names it as text`);
    } else check(false, `${label}: the search for value ${n} lists no skill to open`);
    const tip = await page.evaluate((v) => {
      const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__ && e.__data__.type === "skill" && e.__data__.label === v);
      if (!g) return null;
      const box = g.querySelector("circle.hit").getBoundingClientRect(), title = g.querySelector("title");
      return { x: box.x + box.width / 2, y: box.y + box.height / 2, text: title ? title.textContent : null, children: title ? title.children.length : -1 };
    }, value);
    if (tip) {
      await page.mouse.move(tip.x, tip.y);
      await page.waitForTimeout(150);
      check(tip.text !== null && tip.text.startsWith(value) && tip.children === 0, `${label}: the tooltip of skill ${n} holds it as text: ${short(tip.text, 80)}`);
    } else check(false, `${label}: skill ${n} has no node on the map`);
    await page.fill("#q", "");
    await page.waitForTimeout(100);
    await toOverview(page);
    await page.locator("#areas .chip").filter({ hasText: /^Bereich$/ }).first().click();
    await page.waitForTimeout(150);
    const group = page.locator('#panel [data-go^="group|"]').filter({ hasText: value });
    if (await group.count()) {
      await group.first().click();
      await page.waitForTimeout(150);
      check((await h2(page)) === value, `${label}: the panel of category ${n} names it as text`);
    } else check(false, `${label}: the area lists no category ${n}`);
    await toOverview(page);
    const station = page.locator("#panel .chips .chip", { hasText: "Station " + n });
    if (await station.count()) {
      await station.first().click();
      await page.waitForTimeout(150);
      check((await page.locator("#panel").textContent()).includes(value), `${label}: the panel of station ${n} shows its note as text`);
    } else check(false, `${label}: the overview lists no station ${n}`);
    await toOverview(page);
    await page.click("#projects-btn");
    await page.waitForTimeout(150);
    const project = page.locator("#panel .plist button").filter({ hasText: value });
    if (await project.count()) {
      await project.first().click();
      await page.waitForTimeout(150);
      check((await h2(page)) === value, `${label}: the panel of project ${n} names it as text`);
    } else check(false, `${label}: the list of projects has no project ${n}`);
    await toOverview(page);
  }
  await noMarkupRan(page, check, label);
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The built files.
function builtFiles(dir = SITE, rel = "") {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? builtFiles(dir, path.posix.join(rel, e.name)) : [path.posix.join(rel, e.name)]);
}
test("the built files: no file names the claude.ai runtime or a CDN", async ({ check }) => {
  const files = builtFiles();
  check(files.length > 20, `dist/selfhost has ${files.length} files`);
  const words = ["window.claude", "claude.ai", "cdnjs", "jsdelivr", "unpkg", "googleapis", "gstatic"];
  // A library in vendor/ is its published file as it is. It may name a CDN in code that the page never runs: jsPDF names
  // cdnjs for its viewer pdfobject. The browser checks catch every request that leaves the site.
  const library = (file, word) => file.startsWith("vendor/") && !word.includes("claude");
  for (const file of files) {
    const text = fs.readFileSync(path.join(SITE, file)).toString("latin1");
    const hits = words.filter((w) => text.includes(w) && !library(file, w));
    if (hits.length) check(false, `${file} names ${hits.join(", ")}`);
  }
  check(true, `searched ${files.length} files for ${words.join(", ")}`);
});
// Reserved names for examples (RFC 2606) are allowed in texts: the help text of "Einbetten" shows one as a pattern.
const EXAMPLE_ADDRESS = /^https?:\/\/([a-z0-9-]+\.)*example\.(org|com|net)([/:?#]|$)/i;
// The footer of the start page links the source code. The browser loads nothing from it until the reader follows the link.
const SOURCE_ADDRESS = "https://github.com/JustusTimmerer/skill-map";
test("the built files: no page, style or script outside vendor/ holds the address of another host, besides the link to the source code", async ({ check }) => {
  const files = builtFiles().filter((f) => /\.(html|css|js)$/.test(f) && !f.startsWith("vendor/"));
  for (const file of files) {
    const text = fs.readFileSync(path.join(SITE, file), "utf8");
    const found = uniq((text.match(/https?:\/\/[^\s"'`<>()\\,;]+/g) || []).map((u) => u.replace(/[.:]+$/, "")).filter((u) => !W3_NAMESPACE.test(u) && !EXAMPLE_ADDRESS.test(u) && u !== SOURCE_ADDRESS));
    if (found.length) check(false, `${file}: ${found.join(", ")}`);
  }
  check(true, `searched ${files.length} files`);
});
test("the built files: each HTML page carries a CSP meta tag whose script-src is 'self' without 'unsafe-inline'", async ({ check }) => {
  const pages = builtFiles().filter((f) => f.endsWith(".html"));
  for (const file of pages) {
    const meta = metaPolicy(fs.readFileSync(path.join(SITE, file), "utf8"));
    if (!meta) { check(false, `${file}: no CSP meta tag`); continue; }
    const problems = scriptProblems(policyOf(meta));
    check(!problems.length, `${file}: ` + (problems.length ? problems.join(", ") : "script-src 'self'"));
  }
});
// The files of the account page, which the app sends from its image, by their address.
const STATIC = path.join(repo, "server", "app", "static");
const ACCOUNT_FILES = [["/account", "account.html"], ["/account/account.js", "account.js"], ["/account/account.css", "account.css"]];
// The app sends the start page and the account page with its data block (the start page also with <base href="/">) right
// after <head>, as server/app/pages.py adds it. The rest of the page is the file of the build or of the checkout.
const withoutBlock = (html) => html.replace(/^(<!doctype html>\s*<html[^>]*>\s*<head[^>]*>)(?:<base href="\/">)?<script type="application\/json" id="it-skills-server">[^<]*<\/script>/i, "$1");
// The data block of a page of the app.
const dataBlock = (html) => { const m = html.match(/<script type="application\/json" id="it-skills-server">([^<]*)<\/script>/); return m ? JSON.parse(m[1]) : null; };
test("the built files: the stack serves each file of dist/selfhost and of server/app/static, byte for byte", async ({ check }) => {
  const files = builtFiles(), differ = [];
  for (const file of files) {
    const answer = await stackFetch(S.base + "/" + file), built = fs.readFileSync(path.join(SITE, file));
    if (answer.status !== 200) { differ.push(`${file}: ${answer.status}`); continue; }
    const served = file === "index.html" ? Buffer.from(withoutBlock(answer.text), "utf8") : answer.body;
    if (!served.equals(built)) differ.push(`${file}: ${served.length} bytes served, ${built.length} built`);
  }
  check(!differ.length, `the stack serves the ${files.length} files of dist/selfhost as built` + (differ.length ? ": " + differ.slice(0, 8).join(", ") : ""));
  for (const address of ["/", "/index.html"]) {
    const answer = await stackFetch(S.base + address), built = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
    const page = withoutBlock(answer.text);
    check(answer.status === 200 && page !== answer.text && page === built, `the app sends the built start page at ${address}, with its data block after <head>`);
  }
  for (const [address, name] of ACCOUNT_FILES) {
    const answer = await stackFetch(S.base + address), own = fs.readFileSync(path.join(STATIC, name));
    // The account page carries its data block after <head>, as the start page does.
    const served = name === "account.html" ? Buffer.from(withoutBlock(answer.text), "utf8") : answer.body;
    const block = name !== "account.html" || served.length < answer.body.length;
    check(answer.status === 200 && block && served.equals(own), `the app sends server/app/static/${name} at ${address} as it is in the checkout (${answer.status}, ${served.length} of ${own.length} bytes)`);
  }
  const statics = fs.readdirSync(STATIC).sort();
  check(same(statics, ACCOUNT_FILES.map(([, name]) => name).sort()), "server/app/static holds only these files: " + statics.join(", "));
});
// The cache rules (T4 of the review): each address of a script, a style or an image in a built page carries the version
// of its file, so a browser never runs old page code with a new page after an update.
// The version is the start of the SHA-256 of the content, as build_selfhost.js writes it; the test computes it itself.
const contentHash = (content) => crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
const ASSET_TAG = /<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"#]+)"/gi;
function assetAddresses() {
  const found = [];
  for (const page of builtFiles().filter((f) => f.endsWith(".html"))) {
    for (const m of fs.readFileSync(path.join(SITE, page), "utf8").matchAll(ASSET_TAG)) if (!/^[a-z]+:/i.test(m[1]) && !m[1].split("?")[0].endsWith(".html")) found.push({ page, address: m[1] });
  }
  const css = fs.readFileSync(path.join(SITE, "vendor", "fonts", "fonts.css"), "utf8");
  for (const m of css.matchAll(/url\("([^"]+)"\)/g)) found.push({ page: "vendor/fonts/fonts.css", address: "vendor/fonts/" + m[1] });
  return found;
}
test("the built files: each address of a script, a style, a font or an image carries the version of its content", async ({ check }) => {
  const found = assetAddresses(), wrong = [];
  for (const { page, address } of found) {
    const [file, query = ""] = address.split("?"), at = path.join(SITE, file);
    const v = new URLSearchParams(query).get("v");
    if (!fs.existsSync(at)) wrong.push(`${page}: ${address} names no built file`);
    else if (v !== contentHash(fs.readFileSync(at))) wrong.push(`${page}: ${address} has not the version ${contentHash(fs.readFileSync(at))}`);
  }
  check(found.length > 30 && !wrong.length, `${found.length} addresses in the pages and in fonts.css carry the version of their file` + (wrong.length ? ": " + wrong.slice(0, 6).join(", ") : ""));
});

// ---------------------------------------------------------------------------------------------------------------
// 2 to 4. Stage a: on the plain web space and on the full stack. The same flows run on both.
let plain = null;
function stageA(label, baseOf) {
  const a = () => state.a[label] || (state.a[label] = { s: null, mapUrl: null });
  const ctx = async () => { const x = a(); if (!x.s) x.s = await site(); return x.s; };
  const keep = (body) => async ({ check }) => {
    const s = await ctx();
    try { await body(s, check, baseOf()); } finally { clean(check, s); }
  };
  test(`${label}: a visitor opens the start page and the example map`, keep(async (s, check, base) => {
    const page = s.page;
    await go(page, base + "/");
    check((await page.locator("h1").first().textContent()) === "Skill-Map", "the start page shows its heading");
    check(await page.locator("#new-default").isVisible(), "and offers a new map with the default set");
    const frame = await (await page.waitForSelector('iframe[src="example.html"]')).contentFrame();
    const shown = await frame.waitForFunction(() => /Kenntnisse in 6 Bereichen$/.test((document.querySelector("#panel h2") || {}).textContent || ""), null, { timeout: 15000 }).then(() => true, () => false);
    check(shown, "the start page shows the example map");
    await go(page, base + "/example.html");
    await mapReady(page, { owner: false });
    check(/^\d+ Kenntnisse in 6 Bereichen$/.test(await h2(page)), "the example map opens: " + await h2(page));
  }));
  test(`${label}: a visitor makes a map from the default set, adds a skill, renames it, exports it, deletes it and imports the file again`, keep(async (s, check, base) => {
    const page = s.page, title = "Release-Map (Test)", skill = "Kenntnis aus dem Release-Test";
    await go(page, base + "/");
    await page.click("#new-default");
    await page.waitForURL(/\/map\.html\?id=/);
    await mapReady(page);
    check((await h2(page)) === "12 Kenntnisse in 3 Bereichen", "a new map from the default set: " + await h2(page));
    await page.locator("#areas .chip").first().click(); await page.waitForTimeout(150);
    await page.locator("#panel h3 .linkbtn").first().click(); await page.waitForTimeout(150);
    await clickPanel(page, "+ Skill");
    await page.fill("#cf-name", skill);
    await page.selectOption("#cf-rating", "2");
    await submitForm(page);
    check(await page.locator("#panel .chips").getByText(skill).count() === 1 && await page.locator("#panel button", { hasText: "+ Skill" }).count() === 1, "the skill is on the map, and the panel stays on its category");
    await toOverview(page);
    await clickPanel(page, "Titel ändern");
    await page.fill("#cf-name", title);
    await submitForm(page);
    check((await page.locator("#title").textContent()) === title && (await page.title()) === title + " · Skill-Map", "Titel ändern renames the map");
    await saved(page);
    const before = (await stored(page))[mapIdOf(page)];
    const file = await exportFrom(page, () => page.click("#file-export"));
    check(file.name === title + ".it-skills-map.json", "Exportieren saves the map file " + file.name);
    const json = JSON.parse(file.text);
    check(json.title === title && same(sorted(json.collections), sorted(before.collections)), "the file holds the title and the documents of the map");
    await go(page, base + "/");
    await page.locator("#map-list li", { hasText: title }).locator("button", { hasText: "Löschen" }).click();
    await page.locator("#map-list button", { hasText: "Endgültig löschen" }).click();
    await page.waitForTimeout(200);
    check(Object.keys(await stored(page)).length === 0 && await page.locator("#map-list li").count() === 0, "the map is gone from the browser");
    await pick(page, "#file-input", file.name, file.text);
    await page.waitForURL(/\/map\.html\?id=/);
    await mapReady(page);
    const after = (await stored(page))[mapIdOf(page)];
    check(!!after && after.title === title && same(sorted(after.collections), sorted(before.collections)), "the import gives the same title and data");
    check((await h2(page)) === "13 Kenntnisse in 3 Bereichen" && (await page.locator("#title").textContent()) === title, "and the same map: " + await h2(page));
    a().mapUrl = page.url();
  }));
  test(`${label}: a visitor downloads SVG, PNG, PNG 4× and PDF of the example map`, keep(async (s, check, base) => {
    await go(s.page, base + "/example.html");
    await mapReady(s.page, { owner: false });
    await downloadEach(s, s.page, check, "example map");
  }));
  test(`${label}: a visitor downloads SVG, PNG, PNG 4× and PDF of the own map`, keep(async (s, check) => {
    await go(s.page, need(a().mapUrl, "the own map of the check before"));
    await mapReady(s.page);
    await downloadEach(s, s.page, check, "own map");
  }));
  test(`${label}: a map file with injected markup imports, and its map and the start page show the markup as text`, async ({ check }) => {
    const s = await ctx(), base = baseOf();
    try {
      const page = s.page;
      await go(page, base + "/");
      await pick(page, "#file-input", "markup.it-skills-map.json", JSON.stringify(markupFile(), null, 2));
      await page.waitForURL(/\/map\.html\?id=/);
      await mapReady(page);
      check((await h2(page)) === "3 Kenntnisse in 1 Bereich", "the file opens as a map: " + await h2(page));
      await inspectMarkup(page, check, "the map");
      await go(page, base + "/");
      const titles = await page.locator("#map-list .map-title").allTextContents();
      check(titles.includes(MARKUP_TITLE), "the start page lists the title as text");
      await noMarkupRan(page, check, "the start page");
    } finally { clean(check, s); await s.context.close(); delete state.a[label]; }
  });
}
stageA("plain web space", () => need(plain, "the plain web space does not run").url.replace(/\/$/, ""));
stageA("full stack", () => S.base);

// ---------------------------------------------------------------------------------------------------------------
// 5. Accounts.
async function register(s, p, check, fromStart) {
  const page = s.page;
  if (fromStart) {
    await go(page, "/");
    await page.click("#account-register");
    await page.waitForURL(/\/account#register$/);
  } else await go(page, "/account#register");
  await page.waitForFunction(() => !document.getElementById("register").hidden, null, { timeout: 10000 });
  await page.fill("#register input[name=email]", p.email);
  await page.fill("#register input[name=handle]", p.handle);
  await page.fill("#register input[name=password]", p.password);
  const [sent] = await Promise.all([page.waitForResponse((r) => r.url() === S.base + "/api/auth/register" && r.request().method() === "POST", { timeout: 15000 }).catch(() => null),
    page.click("#register button[type=submit]")]);
  if (sent && sent.status() === 429) {
    throw new Error(`the stack refused the registration of the ${p.role} with 429 Too Many Requests. RATE_LIMIT_REGISTER_IP in server/.env limits the registrations `
      + "of one IP address (10 per hour by default), and each run registers 3 accounts. Wait for the window to pass, or raise the limit of this test stack and restart it.");
  }
  await page.waitForFunction(() => !document.getElementById("message").hidden, null, { timeout: 10000 });
  check((await page.locator("#message").textContent()).includes("E-Mail"), `${p.role}: the page asks to check the mail`);
  const mail = await mailTo(p.email, SUBJECT.confirm);
  const link = (mail.Text.match(/https?:\/\/\S+#confirm=[A-Za-z0-9_-]+/) || [""])[0];
  check(link.startsWith(S.base + "/account#confirm="), `${p.role}: the mail links to the account page`);
  await page.goto("about:blank");
  await go(page, link);
  await page.waitForSelector("#confirm-form input[name=password]", { state: "visible", timeout: 10000 });
  await page.fill("#confirm-form input[name=password]", p.password);
  await page.click("#confirm-form button[type=submit]");
  await page.waitForFunction(() => /bestätigt/.test(document.getElementById("message").textContent), null, { timeout: 10000 });
  await page.fill("#login input[name=email]", p.email);
  await page.fill("#login input[name=password]", p.password);
  await page.click("#login button[type=submit]");
  await page.waitForFunction(() => !document.getElementById("signed-in").hidden, null, { timeout: 10000 });
  check((await page.locator("#who").textContent()).includes(p.handle), `${p.role}: signed in as ${p.handle}`);
}
test("account: a visitor registers on the page, confirms through the link in the mail and signs in", async ({ check }) => {
  const s = await site();
  try {
    await register(s, people.owner, check, true);
    people.owner.s = s;
  } finally { clean(check, s); if (!people.owner.s) await s.context.close(); }
});
test("account: the owner makes a map, edits it on its map page and renames it", as("owner", async (s, check) => {
  const page = s.page, skill = "Kenntnis aus dem Release-Test", title = "Release-Map";
  await go(page, "/");
  await page.click("#account-new-default");
  await page.waitForURL(new RegExp(`/${people.owner.handle}/meine-skills$`));
  await mapReady(page);
  const id = await page.evaluate(() => window.IT_SKILLS_SERVER.api.split("/").pop());
  check((await h2(page)) === "12 Kenntnisse in 3 Bereichen", "the map from the default set: " + await h2(page));
  await page.locator("#areas .chip").first().click(); await page.waitForTimeout(150);
  await page.locator("#panel h3 .linkbtn").first().click(); await page.waitForTimeout(150);
  await clickPanel(page, "+ Skill");
  await page.fill("#cf-name", skill);
  await page.selectOption("#cf-rating", "2");
  await submitForm(page);
  await saved(page);
  const docs = (await api(s, "GET", `/api/maps/${id}/docs`)).data;
  check(!!docs && docs.docs.some((d) => d.collection === "skills" && d.data.name === skill), "the server holds the new skill");
  await toOverview(page);
  await clickPanel(page, "Titel ändern");
  await page.fill("#cf-name", title);
  await submitForm(page);
  const meta = await until(async () => (await api(s, "GET", "/api/maps/" + id)).data || {}, (m) => m.title === title);
  check((await page.locator("#title").textContent()) === title && meta.title === title && meta.slug === "meine-skills", `the map is renamed on the page and on the server: ${meta.title}, ${meta.slug}`);
  state.map = { id, slug: meta.slug, url: page.url(), heading: "13 Kenntnisse in 3 Bereichen" };
  // The setting BASE_DOMAIN of the stack, from its answer: the later checks open the subdomains, or check that none answers.
  S.domain = domainFrom(meta, people.owner.handle);
  check(S.domain !== null, S.domain ? `the stack serves the subdomains below ${S.domain}` : S.domain === "" ? "the stack serves no subdomains (BASE_DOMAIN is empty)" : "the stack names no subdomain address: " + JSON.stringify(meta.subdomainUrl));
}));
test("account: a share link opens the map in a browser without a session, and the revoked link shows the error page", as("owner", async (s, check) => {
  const map = need(state.map, "no map of the owner");
  const page = s.page;
  // A map has one read link (his decision of 2026-10-19). The dialog shows it every time, and a new link, which
  // revokes it, needs a second step in the dialog, never a dialog of the browser.
  const dialogs = [];
  const onDialog = (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); };
  page.on("dialog", onDialog);
  await s.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: S.base });
  try {
    await go(page, map.url); await mapReady(page);
    await openShare(page);
    await page.click("#share-create");
    await page.waitForSelector("#share-link-url", { timeout: 10000 });
    const link = await page.inputValue("#share-link-url");
    check(link.startsWith(S.base + "/s/"), "Link erstellen gives a link: " + link.replace(/\/s\/.*/, "/s/…"));
    await page.click("#share-close");
    await openShare(page);
    check(await page.inputValue("#share-link-url") === link && await page.locator("#share-create").count() === 0, "the dialog shows the same link again when it opens again");
    await page.locator("#share-link-url + button").click();
    await page.waitForTimeout(200);
    check(await page.evaluate(() => navigator.clipboard.readText()) === link, "Kopieren copies the link again");
    await page.click("#share-close");
    const r = await site();
    try {
      r.allow = [/status of 404/];
      await go(r.page, link);
      await mapReady(r.page, { owner: false, heading: map.heading });
      const v = await r.page.evaluate(() => ({ cfg: !document.getElementById("cfg").hidden, share: !!document.getElementById("share-open"), add: document.querySelectorAll("#panel .add, #panel [data-act^='new'], #panel [data-act^='edit']").length }));
      check((await h2(r.page)) === map.heading && !v.cfg && !v.share && v.add === 0, "the link shows the map read-only: " + await h2(r.page));
      await openShare(page);
      await page.click("#share-renew");
      const ask = page.locator("#share-renew-ask");
      check(await ask.isVisible() && await page.locator("#share-renew").isHidden() && (await ask.innerText()).includes("Der aktuelle Link gilt sofort nicht mehr, auch nicht in Rahmen auf anderen Websites."),
        "Widerrufen und neuen Link erzeugen asks first, and says that the link stops at once, also in frames on other websites");
      await page.click("#share-renew-cancel");
      const kept = (await api(s, "GET", `/api/maps/${map.id}/shares`)).data || {};
      check(await ask.isHidden() && await page.inputValue("#share-link-url") === link && (kept.shares || []).map((x) => x.url).join() === link, "Abbrechen keeps the link");
      await page.click("#share-renew");
      await page.click("#share-renew-yes");
      await page.waitForFunction((old) => { const x = document.getElementById("share-link-url"); return x && x.value !== old; }, link, { timeout: 10000 });
      const fresh = await page.inputValue("#share-link-url");
      check(fresh.startsWith(S.base + "/s/") && fresh !== link && (await page.locator("#share-renewed").innerText()) === "Neuer Link. Der alte Link gilt nicht mehr.", "the confirmation gives a new link and says that the old one no longer works");
      await page.click("#share-close");
      const again = await r.page.goto(link);
      check(again.status() === 404 && (await r.page.locator("body").innerText()).includes("Nicht gefunden"), "the revoked link shows the error page: " + again.status());
      const token = link.split("/s/")[1];
      const dead = [];
      for (const path of [`/e/s/${token}`, `/api/shared/${token}/docs`]) dead.push((await r.page.goto(S.base + path)).status());
      check(same(dead, [404, 404]), "its embed view and its API give 404 too: " + dead.join(", "));
      await go(r.page, fresh);
      await mapReady(r.page, { owner: false, heading: map.heading });
      check((await h2(r.page)) === map.heading, "the new link shows the map");
      clean(check, r, " (visitor without a session)");
    } finally { await r.context.close(); }
    check(dialogs.length === 0, "no dialog of the browser: " + dialogs.join(" | "));
  } finally { page.off("dialog", onDialog); }
}));
test("account: the owner makes the map public, and a reader opens it by path and on the subdomain", as("owner", async (s, check) => {
  const map = need(state.map, "no map of the owner");
  const page = s.page;
  await go(page, map.url); await mapReady(page);
  await openShare(page);
  await page.locator("#share-dialog input[name=share-visibility][value=public]").check();
  check(await dialogSays(page, "Jeder mit der Adresse liest die Map."), "the dialog says that the map is public");
  await page.click("#share-close");
  const r = await site();
  try {
    await go(r.page, `/${people.owner.handle}/${map.slug}`);
    await mapReady(r.page, { owner: false, heading: map.heading });
    check((await h2(r.page)) === map.heading && await r.page.locator("#share-open").count() === 0, "by path: the map, read-only");
    if (S.domain) {
      await go(r.page, `${subdomainOrigin(people.owner.handle)}/${map.slug}`);
      await mapReady(r.page, { owner: false, heading: map.heading });
      check((await h2(r.page)) === map.heading && await r.page.locator("#share-open").count() === 0, "on the subdomain: the map, read-only");
    } else if (S.domain === "") await noSubdomain(check, people.owner.handle, "/" + map.slug);
    else check(false, "not run: the stack named no subdomain address");
    clean(check, r, " (reader)");
    map.public = true;
  } finally { await r.context.close(); }
}));
// The address of the owner, <BASE_URL>/<handle> (his answer of 2026-10-19 to finding A5): the start map while it is public,
// else the list of the public maps. The later checks read that list, so the owner ends the start map again at the end.
test("account: the owner picks the public map as the start map below its address, and a reader gets it at the address of the owner", as("owner", async (s, check) => {
  const map = need(state.map && state.map.public && state.map, "no public map");
  const page = s.page, owner = `${S.base}/${people.owner.handle}`;
  await go(page, map.url); await mapReady(page);
  await openShare(page);
  check((await page.locator("#share-start-label").innerText()) === `Diese Map auch unter ${owner} zeigen` && !(await page.locator("#share-start").isChecked()),
    "Teilen offers the start map below the public address");
  await page.locator("#share-start").click();
  check(await dialogSays(page, `${owner} zeigt jetzt diese Map.`), "the dialog says that the address of the owner shows the map now");
  await page.click("#share-close");
  const r = await site();
  try {
    await go(r.page, owner);
    await mapReady(r.page, { owner: false, heading: map.heading });
    check((await h2(r.page)) === map.heading && await r.page.locator("#share-open").count() === 0, "at the address of the owner: the start map, read-only");
    if (S.domain) {
      await go(r.page, subdomainOrigin(people.owner.handle) + "/");
      await mapReady(r.page, { owner: false, heading: map.heading });
      check((await h2(r.page)) === map.heading, "at the root of the subdomain: the start map too");
    } else if (S.domain === "") check(true, "without subdomains the path address is the only one");
    else check(false, "not run: the stack named no subdomain address");
    clean(check, r, " (reader)");
  } finally { await r.context.close(); }
  await openShare(page);
  await page.locator("#share-start").click();
  check(await dialogSays(page, "Dort steht nur eine Map."), "a second click ends the start map");
  await page.click("#share-close");
  const list = await stackFetch(owner);
  check(list.status === 200 && !list.text.includes('id="it-skills-server"') && list.text.includes(`href="/${people.owner.handle}/${map.slug}"`),
    "then the address of the owner lists the public maps again");
}));
// Finding A5: www and the other reserved names under the wildcard served the main site, and each write there failed with
// 403 csrf. Now www goes to the main domain, and every other reserved name serves nothing.
test("subdomains: www goes to the main domain with 308, and a reserved name such as api serves no page, no file and no API", async ({ check }) => {
  need(S.domain !== null, "the stack named no subdomain address");
  if (S.domain === "") { await noSubdomain(check, "www"); await noSubdomain(check, "api"); return; }
  if (BASE.hostname === "www." + S.domain) { check(true, "www is the main host, so it serves the main site"); return; }
  const origin = (name) => `${BASE.protocol}//${name}.${S.domain}${BASE.port ? ":" + BASE.port : ""}`;
  for (const [rest, label] of [["/", "/"], ["/example.html?lang=de", "/example.html?lang=de"], ["/assets/site.css", "/assets/site.css"], ["/api/health", "/api/health"],
    ["/" + people.owner.handle, "/<handle>"]]) {
    const answer = await stackFetch(origin("www") + rest);
    check(answer.status === 308 && answer.headers.location === S.base + rest, `www${label} goes to the same address on the main domain with 308: ${answer.status} ${where(answer.headers.location || "")}`);
  }
  const json = { "Content-Type": "application/json" };
  const written = await stackFetch(origin("www") + "/api/auth/login", { method: "POST", headers: { ...WRITE, ...json, Origin: origin("www") }, body: "{}" });
  check(written.status === 308 && written.headers.location === S.base + "/api/auth/login", "a write on www gets the 308 too, and no 403 csrf: " + written.status);
  for (const name of ["api", "mail", "vendor"]) {
    const answers = [];
    for (const rest of ["/", "/index.html", "/example.html", "/assets/site.css", "/account", "/api/health"]) answers.push(rest + " " + (await stackFetch(origin(name) + rest)).status);
    check(answers.every((a) => a.endsWith(" 404")), `${name} below the domain: 404 for a page, a file of the site and the API: ` + answers.join(", "));
  }
  const refused = await stackFetch(origin("api") + "/api/auth/login", { method: "POST", headers: { ...WRITE, ...json, Origin: origin("api") }, body: "{}" });
  let error = null;
  try { error = JSON.parse(refused.text).error; } catch (problem) { error = null; }
  check(refused.status === 404 && error === "not_found", "a write on api gets 404, and no 403 csrf: " + refused.status + " " + error);
});
test("account: the owner downloads SVG, PNG, PNG 4× and PDF on the map page", as("owner", async (s, check) => {
  const map = need(state.map, "no map of the owner");
  await go(s.page, map.url); await mapReady(s.page);
  await downloadEach(s, s.page, check, "map page of the owner");
}));
test("account: a reader downloads SVG, PNG, PNG 4× and PDF on the public page", fresh(async (s, check) => {
  const map = need(state.map && state.map.public && state.map, "no public map");
  await go(s.page, `/${people.owner.handle}/${map.slug}`);
  await mapReady(s.page, { owner: false, heading: map.heading });
  await downloadEach(s, s.page, check, "public page");
}));

// ---------------------------------------------------------------------------------------------------------------
// 6. Teams: an owner, an editor and a reader share one team.
const teamItem = (page) => page.locator("#team-list > li", { hasText: team.handle });
async function konto(page) {
  await go(page, "/account");
  await page.waitForFunction(() => !document.getElementById("signed-in").hidden, null, { timeout: 10000 });
}
test("team: the owner makes a team on the account page, and an editor and a reader join through the mail of their invitation", async ({ check }) => {
  const owner = need(people.owner.s, "the owner is not signed in");
  for (const p of [people.editor, people.reader]) {
    const s = await site();
    try { await register(s, p, check, false); p.s = s; } finally { clean(check, s, ` (${p.role})`); if (!p.s) await s.context.close(); }
  }
  need(people.editor.s && people.reader.s, "the editor or the reader could not register");
  const page = owner.page;
  try {
    await konto(page);
    await page.fill("#new-team input[name=name]", team.name);
    await page.fill("#new-team input[name=handle]", team.handle);
    await page.click("#new-team button[type=submit]");
    await teamItem(page).waitFor({ timeout: 10000 });
    team.made = true;
    check(true, "Team anlegen makes the team " + team.handle);
    await teamItem(page).locator(".actions button", { hasText: "Öffnen" }).click();
    for (const p of [people.editor, people.reader]) {
      const form = teamItem(page).locator("form", { has: page.locator("h3", { hasText: "Einladen" }) });
      await form.waitFor({ timeout: 10000 });
      await form.locator("input[name=email]").fill(p.email);
      await form.locator("select[name=role]").selectOption(p.role);
      await form.locator("button[type=submit]").click();
      await teamItem(page).getByText(p.email).waitFor({ timeout: 10000 });
      check(true, `the owner invites the ${p.role}`);
    }
    for (const p of [people.editor, people.reader]) {
      const mail = await mailTo(p.email, SUBJECT.invitation);
      const link = (mail.Text.match(/https?:\/\/\S+#invite=[A-Za-z0-9_-]+/) || [""])[0];
      check(link.startsWith(S.base + "/account#invite="), `${p.role}: the mail links to the invitation`);
      const ip = p.s.page;
      await ip.goto("about:blank");
      await go(ip, link);
      await ip.waitForSelector("#accept-invitation:not([hidden])", { timeout: 10000 });
      await ip.click("#accept-invitation");
      await ip.waitForFunction(() => /Du bist jetzt im Team/.test(document.getElementById("message").textContent), null, { timeout: 10000 });
      check((await ip.locator("#message").textContent()).includes(team.name), `${p.role}: Einladung annehmen: ` + await ip.locator("#message").textContent());
      clean(check, p.s, ` (${p.role})`);
    }
    const view = (await api(owner, "GET", "/api/teams/" + team.handle)).data || { members: [] };
    const roles = Object.fromEntries(view.members.map((m) => [m.handle, m.role]));
    check(roles[people.owner.handle] === "owner" && roles[people.editor.handle] === "editor" && roles[people.reader.handle] === "reader", "the team has the three roles: " + JSON.stringify(roles));
    await konto(page);
    if (await teamItem(page).locator(".actions button", { hasText: "Öffnen" }).count()) await teamItem(page).locator(".actions button", { hasText: "Öffnen" }).click();
    const create = teamItem(page).locator("form", { hasText: "Neue Map im Team" });
    await create.waitFor({ timeout: 10000 });
    await create.locator("input[name=title]").fill("Team-Map");
    await create.locator("select[name=template]").selectOption("empty");
    await create.locator("button[type=submit]").click();
    await teamItem(page).locator(".maps a.title", { hasText: "Team-Map" }).waitFor({ timeout: 10000 });
    const maps = ((await api(owner, "GET", `/api/teams/${team.handle}/maps`)).data || { maps: [] }).maps;
    const made = maps.find((m) => m.title === "Team-Map");
    check(!!made && made.ownerType === "team", "the owner makes the team map on the account page");
    if (made) team.map = { id: made.id, slug: made.slug, url: `${S.base}/${team.handle}/${made.slug}` };
  } finally { clean(check, owner, " (owner)"); }
});
test("team: the editor changes the team map on its map page", as("editor", async (s, check) => {
  const map = need(team.map, "no team map");
  const page = s.page;
  await go(page, map.url); await mapReady(page);
  check(await page.locator("#share-open").count() === 0, "the editor has no Teilen");
  await clickPanel(page, "+ Bereich");
  await page.fill("#cf-name", "Bereich des Bearbeiters");
  await submitForm(page);
  await saved(page);
  const docs = (await api(people.owner.s, "GET", `/api/maps/${map.id}/docs`)).data || { docs: [] };
  check(docs.docs.some((d) => d.collection === "areas" && d.data.name === "Bereich des Bearbeiters"), "the server holds the area of the editor, as the owner reads it");
}));
test("team: the reader sees no edit controls, and a write through the API gets 403", as("reader", async (s, check) => {
  const map = need(team.map, "no team map");
  const page = s.page;
  await go(page, map.url);
  await mapReady(page, { owner: false, heading: "0 Kenntnisse in 1 Bereich" });
  const v = await page.evaluate(() => ({ h2: document.querySelector("#panel h2").textContent, cfg: !document.getElementById("cfg").hidden || !document.getElementById("cfg-show").hidden,
    share: !!document.getElementById("share-open"), edit: document.querySelectorAll("#panel .add, #panel [data-act^='new'], #panel [data-act^='edit']").length }));
  check(v.h2 === "0 Kenntnisse in 1 Bereich" && !v.cfg && !v.share && v.edit === 0, "the reader sees the map without edit controls: " + JSON.stringify(v));
  const write = await api(s, "PUT", `/api/maps/${map.id}/docs/areas/leser`, { name: "Bereich des Lesers", color: "#2c5fc4", at: [0, 0], order: 9 });
  check(write.status === 403 && write.data && write.data.error === "forbidden", `a write through the API gets ${write.status} ${write.data && write.data.error}`);
}));
test("team: the editor gets 403 for a change of the visibility and of the embed setting", as("editor", async (s, check) => {
  const map = need(team.map, "no team map");
  const visibility = await api(s, "PATCH", "/api/maps/" + map.id, { visibility: "public" });
  check(visibility.status === 403, `a change of the visibility gets ${visibility.status} ${visibility.data && visibility.data.error}`);
  const embed = await api(s, "PATCH", "/api/maps/" + map.id, { embed: { allow: "origins", origins: ["https://example.org"] } });
  check(embed.status === 403, `a change of the embed setting gets ${embed.status} ${embed.data && embed.data.error}`);
  const now = (await api(s, "GET", "/api/maps/" + map.id)).data || {};
  check(now.visibility === "private" && now.embed && now.embed.allow === "all", "the map stays private and embeddable by every site: " + JSON.stringify({ visibility: now.visibility, embed: now.embed }));
}));
test("team: the owner makes the team map public and lets only one site embed it, in the dialog Teilen", as("owner", async (s, check) => {
  const map = need(team.map, "no team map");
  const [A] = await hostSites();
  const page = s.page;
  await go(page, map.url); await mapReady(page);
  await openShare(page);
  await page.locator("#share-dialog input[name=share-visibility][value=public]").check();
  check(await dialogSays(page, "Jeder mit der Adresse liest die Map."), "the dialog says that the team map is public");
  // The addresses that the dialog offers must open the team map.
  const shown = [await page.inputValue("#share-page-url").catch(() => ""), await page.inputValue("#share-subdomain-url").catch(() => "")].filter(Boolean);
  check(shown.length === (S.domain ? 2 : 1), "the dialog offers the public addresses: " + shown.join(", "));
  const named = (await api(s, "GET", "/api/maps/" + map.id)).data || {};
  for (const address of shown) {
    const answer = await stackFetch(address);
    check(answer.status === 200, `the dialog offers ${address}, which answers ${answer.status} to a reader (the API names ${named.pageUrl} and ${named.subdomainUrl})`);
  }
  await page.locator("#embed-allow input[value=origins]").check();
  await page.waitForSelector("#embed-origins", { timeout: 10000 });
  await page.fill("#embed-origins", A.origin);
  await page.click("#embed-save");
  await page.waitForFunction(() => !document.getElementById("embed-origins-empty"), null, { timeout: 10000 }).catch(() => {});
  await page.click("#share-close");
  const now = (await api(s, "GET", "/api/maps/" + map.id)).data || {};
  check(now.visibility === "public" && now.embed && now.embed.allow === "origins" && same(now.embed.origins, [A.origin]), "the server holds both changes: " + JSON.stringify({ visibility: now.visibility, embed: now.embed }));
}));

// ---------------------------------------------------------------------------------------------------------------
// 7. Embed: a page of a second site on 127.0.0.1 frames the embed view of the public map of the owner.
const embedSrc = () => `${S.base}/e/${people.owner.handle}/${need(state.map && state.map.public && state.map, "no public map").slug}`;
async function embedSetting(page, origins) {
  await go(page, state.map.url); await mapReady(page);
  await openShare(page);
  if (!(await page.locator("#embed-origins").count())) {
    await page.locator("#embed-allow input[value=origins]").check();
    await page.waitForSelector("#embed-origins", { timeout: 10000 });
  }
  await page.fill("#embed-origins", origins.join("\n"));
  await page.click("#embed-save");
  await page.waitForTimeout(600);
  await page.click("#share-close");
}
test("embed: a page of another site frames the public map with the setting for every site, and the embed view sets no cookie", fresh(async (r, check) => {
  const src = embedSrc();
  const now = (await api(need(people.owner.s, "the owner is not signed in"), "GET", "/api/maps/" + state.map.id)).data || {};
  check(now.embed && now.embed.allow === "all", "the setting is: every site may embed the map");
  const [A] = await hostSites();
  const answers = [];
  r.context.on("response", (response) => { if (onStack(response.url())) answers.push(response); });
  await go(r.page, A.show("cv", frameTag(src)));
  const { frame, shown } = await frameOf(r.page);
  check(shown && (await frame.locator("#panel h2").textContent()) === state.map.heading, "the frame shows the map");
  check((await r.context.cookies()).length === 0, "the browser holds no cookie");
  const cookies = (await Promise.all(answers.map((x) => within(x.headerValue("set-cookie"), 5000, "the headers of " + where(x.url())).catch((error) => error instanceof Late ? error.message : null)))).filter(Boolean);
  check(answers.length > 3 && cookies.length === 0, `no answer of the embed view sets a cookie (${answers.length} answers)` + (cookies.length ? ": " + uniq(cookies).slice(0, 4).join(" | ") : ""));
}));
test("embed: with a list of sites without that site, the browser refuses the frame", as("owner", async (s, check) => {
  const src = embedSrc();
  const [A, B] = await hostSites();
  await embedSetting(s.page, [B.origin]);
  const now = (await api(s, "GET", "/api/maps/" + state.map.id)).data || {};
  check(now.embed && now.embed.allow === "origins" && same(now.embed.origins, [B.origin]), "the owner allows only another site: " + JSON.stringify(now.embed));
  const r = await site();
  try {
    r.allow = FRAME_REFUSED; r.allowCsp = [/^frame-ancestors /];
    // The proof is a signal of the browser that it refused the frame: its console names the refusal, or the page gets
    // a violation of frame-ancestors. Then the frame holds no map. The header check of the embed view covers the rule too.
    const said = [];
    r.page.on("console", (message) => { if (FRAME_REFUSED.some((re) => re.test(message.text()))) said.push(message.text()); });
    await go(r.page, A.show("refused", frameTag(src)));
    const refusal = await until(() => said[0] || (r.csp.some((v) => v.directive === "frame-ancestors") ? "a violation of frame-ancestors" : null), Boolean, 15000);
    const frame = await (await r.page.waitForSelector("#map-frame")).contentFrame();
    const maps = frame ? await frame.locator("#map").count().catch(() => 0) : 0;
    check(!!refusal && maps === 0, "the browser refuses the frame: " + (refusal ? short(refusal, 160) : "no sign of a refusal within 15 s") + ", " + (frame ? frame.url() : "no frame"));
    clean(check, r, " (reader on the other site)");
  } finally { await r.context.close(); }
}));
test("embed: with that site on the list, the frame shows the map again", as("owner", async (s, check) => {
  const src = embedSrc();
  const [A, B] = await hostSites();
  await embedSetting(s.page, [B.origin, A.origin]);
  const now = (await api(s, "GET", "/api/maps/" + state.map.id)).data || {};
  check(now.embed && same(now.embed.origins, [B.origin, A.origin]), "the list holds both sites: " + JSON.stringify(now.embed));
  const r = await site();
  try {
    await go(r.page, A.show("allowed", frameTag(src)));
    const { shown } = await frameOf(r.page);
    check(shown, "the frame shows the map");
    clean(check, r, " (reader on the other site)");
  } finally {
    await r.context.close();
    await api(s, "PATCH", "/api/maps/" + state.map.id, { embed: { allow: "all" } });
  }
}));

// ---------------------------------------------------------------------------------------------------------------
// 8. Injected markup, written by the owner through the forms of the map page.
test("injected markup: the owner writes markup into skills, categories, station notes, projects and the title, and the map shows it as text", as("owner", async (s, check) => {
  const page = s.page;
  await go(page, "/");
  await page.click("#account-new-default");
  await page.waitForURL(new RegExp(`/${people.owner.handle}/meine-skills-\\d+$`));
  await mapReady(page);
  const id = await page.evaluate(() => window.IT_SKILLS_SERVER.api.split("/").pop());
  // The default set has three areas; the first one becomes "Bereich", so that inspectMarkup finds it.
  await page.locator("#areas .chip").first().click(); await page.waitForTimeout(150);
  await clickPanel(page, "Bereich bearbeiten");
  await page.fill("#cf-name", "Bereich");
  await submitForm(page);
  for (let i = 0; i < MARKUP.length; i++) {
    const value = MARKUP[i], n = i + 1;
    await toOverview(page);
    await page.locator("#areas .chip").filter({ hasText: /^Bereich$/ }).first().click(); await page.waitForTimeout(150);
    await clickPanel(page, "+ Kategorie");
    await page.fill("#cf-name", value);
    await submitForm(page);
    check((await h2(page)) === value, `category ${n}: the form shows the new name as text`);
    await clickPanel(page, "+ Skill");
    await page.fill("#cf-name", value);
    await page.selectOption("#cf-rating", "2");
    await submitForm(page);
    check((await h2(page)) === value, `skill ${n}: the form shows the new name as text`);
    await toOverview(page);
    await clickPanel(page, "+ Station");
    await page.fill("#cf-name", "Station " + n);
    await page.fill("#cf-when", `${2018 + i} – ${2019 + i}`);
    await page.fill("#cf-note", value);
    await submitForm(page);
    check((await h2(page)) === "Station " + n && (await page.locator("#panel").textContent()).includes(value), `station ${n}: the panel shows the note as text`);
    await toOverview(page);
    await page.click("#projects-btn"); await page.waitForTimeout(150);
    await clickPanel(page, "Neues Projekt");
    await page.fill("#pf-name", value);
    await page.selectOption("#pf-station", { label: "Station " + n });
    await page.locator("#project-form button[type=submit]").click(); await page.waitForTimeout(300);
    check((await page.locator("#panel").textContent()).includes(value), `project ${n}: the panel shows the name as text`);
    // Readers see a project only with a skill: "Skills zuweisen" and a click on the skill in the map.
    await clickPanel(page, "Skills zuweisen");
    const node = await page.evaluate((v) => {
      const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__ && e.__data__.type === "skill" && e.__data__.label === v);
      const box = g && g.querySelector("circle.hit").getBoundingClientRect();
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    }, value);
    if (node) await page.mouse.click(node.x, node.y);
    await page.waitForTimeout(150);
    await page.click("#editbar-done"); await page.waitForTimeout(200);
    check((await page.locator("#panel h3").first().textContent()).trim().toLowerCase() === "1 kenntnis", `project ${n}: Skills zuweisen gives it skill ${n}`);
    await saved(page);
  }
  await toOverview(page);
  await clickPanel(page, "Titel ändern");
  await page.fill("#cf-name", MARKUP_TITLE);
  await submitForm(page);
  await saved(page);
  const meta = await until(async () => (await api(s, "GET", "/api/maps/" + id)).data || {}, (m) => m.title === MARKUP_TITLE);
  check(meta.title === MARKUP_TITLE, "the server holds the title with markup");
  state.markup = { id, slug: meta.slug, url: page.url() };
  await page.reload();
  await mapReady(page);
  await inspectMarkup(page, check, "the owner");
}));
test("injected markup: a reader opens the public map, its panels, the search and the tooltips, and sees the markup as text", fresh(async (r, check) => {
  const map = need(state.markup, "no map with markup");
  const set = await api(need(people.owner.s, "the owner is not signed in"), "PATCH", "/api/maps/" + map.id, { visibility: "public" });
  check(set.status === 200, "the owner makes the map public through the API: " + set.status);
  await go(r.page, `/${people.owner.handle}/${map.slug}`);
  await mapReady(r.page, { owner: false, heading: "15 Kenntnisse in 3 Bereichen" });
  check((await h2(r.page)) === "15 Kenntnisse in 3 Bereichen", "the reader sees the map: " + await h2(r.page));
  await inspectMarkup(r.page, check, "the reader");
}));
test("injected markup: the start page, the account page and the lists of public maps show the title as text", as("owner", async (s, check) => {
  need(state.markup, "no map with markup");
  const page = s.page;
  await go(page, "/");
  await page.waitForFunction(() => document.querySelectorAll("#account-list li").length > 1, null, { timeout: 10000 });
  check((await page.locator("#account-list .map-title").allTextContents()).includes(MARKUP_TITLE), "the start page lists the title as text");
  await noMarkupRan(page, check, "the start page");
  await konto(page);
  await page.waitForFunction(() => document.querySelectorAll("#maps li").length > 1, null, { timeout: 10000 });
  check((await page.locator("#maps a.title").allTextContents()).includes(MARKUP_TITLE), "the account page lists the title as text");
  await noMarkupRan(page, check, "the account page");
  const lists = [`${S.base}/${people.owner.handle}`];
  if (S.domain) lists.push(subdomainOrigin(people.owner.handle) + "/");
  for (const url of lists) {
    await go(page, url);
    check((await page.locator("main li a").allTextContents()).includes(MARKUP_TITLE), `the list at ${where(url)} shows the title as text`);
    await noMarkupRan(page, check, "the list at " + where(url));
  }
}));

// ---------------------------------------------------------------------------------------------------------------
// 9. Forged requests from another site, in the browser of the signed-in owner.
async function mapsOf(s) {
  const own = ((await api(s, "GET", "/api/maps")).data || { maps: [] }).maps;
  const teamMaps = team.made ? ((await api(s, "GET", `/api/teams/${team.handle}/maps`)).data || { maps: [] }).maps : [];
  return [...own, ...teamMaps].map((m) => `${m.id} ${m.version} ${m.title}`).sort();
}
const unchanged = (check, before, after) => check(before.length > 0 && same(before, after), `the maps of the owner did not change (${before.length} before, ${after.length} after)`);
const FORGERY_ERRORS = [/CORS policy/, /Failed to load resource/];
// The POSTs of a page to /api/maps of the main domain: whether each one carried the session cookie, and its answer.
// While a route is set, Playwright answers CORS preflights itself, so a POST with X-Requested-With leaves the browser
// even where a browser without the test would stop at the preflight. The server must refuse it on its own.
// The record reads the headers and the answer of each POST as soon as the browser sends it, each read with a limit.
// settled() waits for these reads, with a limit too. Then the check closes the page and reads the record: a read on an
// open page can wait for ever, for example for the answer of a form that the page still loads.
function watchPosts(page) {
  const posts = [], reads = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || request.url() !== S.base + "/api/maps") return;
    const post = { cookie: false, status: null, failure: null, late: [] };
    posts.push(post);
    const late = (error) => { if (error instanceof Late) post.late.push(error.message); };
    reads.push(Promise.all([
      within(request.allHeaders(), 5000, "the headers of the POST").then((h) => { post.cookie = /__Host-session=/.test((h && h.cookie) || ""); }, late),
      within(request.response(), 5000, "the answer of the POST").then((answer) => { if (answer) post.status = answer.status(); }, late),
    ]).then(() => { const failure = request.failure(); post.failure = failure ? failure.errorText : null; }));
  });
  return { settled: () => within(Promise.all(reads), 8000, "the record of the POSTs").catch(() => {}), list: () => posts };
}
// Without CORS headers the browser hides the answer of a cross-origin fetch, also from Playwright.
const postsText = (list) => list.length ? list.map((p) => `a POST ${p.cookie ? "with" : "without"} the session cookie, `
  + (p.status !== null ? "answer " + p.status : "its answer hidden by the browser" + (p.failure ? ` (${p.failure})` : "")) + (p.late.length ? " (" + p.late.join(", ") + ")" : "")).join("; ") : "no POST left the browser";
const postsLate = (list) => list.some((p) => p.late.length);
// Runs in the page of the forger: page.evaluate sends only the source of the function, so the headers are an argument.
// The fetch gives up after 10 s, so the page always answers.
async function forgedFetch([url, headers]) {
  try { const response = await fetch(url, { method: "POST", credentials: "include", headers, body: JSON.stringify({ title: "Gefälscht" }), signal: AbortSignal.timeout(10000) }); return "the page reads answer " + response.status; }
  catch (error) { return "the page gets " + (error.name === "TimeoutError" ? "no answer within 10 s" : error.message); }
}
// The forged fetch in a page, with a limit for the answer of page.evaluate.
const forge = (page, url, headers) => within(page.evaluate(forgedFetch, [url, headers]), 15000, "the forged fetch").catch((error) => "the test gets " + error.message);
const forgeLate = (result) => / no answer within /.test(result);
test("forged requests: a page of another site sends a fetch with credentials and X-Requested-With to POST /api/maps, and nothing changes", as("owner", async (s, check) => {
  const [A] = await hostSites();
  const before = await mapsOf(s);
  s.allow = FORGERY_ERRORS;
  const page = await within(s.context.newPage(), 20000, "a new page");
  const posts = watchPosts(page);
  let result = "no fetch";
  try {
    await page.goto(A.show("fetch", "<p>Eine andere Website.</p>"));
    result = await forge(page, S.base + "/api/maps", { "X-Requested-With": "it-skills", "Content-Type": "application/json" });
    await page.waitForTimeout(300);
    await posts.settled();
  } finally { await within(page.close(), 20000, "the close of the page"); }
  check(!forgeLate(result) && !postsLate(posts.list()), `the fetch of the other site: ${result}; ${postsText(posts.list())}`);
  unchanged(check, before, await mapsOf(s));
}));
test("forged requests: a page of another site submits a form to POST /api/maps, and nothing changes", as("owner", async (s, check, note) => {
  const [A] = await hostSites();
  const before = await mapsOf(s);
  // The page of the other site runs in a browser context of its own with the session of the owner. So its clean-up
  // never holds the context of the owner, and a slow close of it is a note, not a failure (finding E8 of the final
  // review): the verdict comes from the record of the POSTs and from the maps of the owner.
  const f = await site({ storageState: await s.context.storageState() });
  f.allow = FORGERY_ERRORS;
  const page = f.page, posts = watchPosts(page);
  try {
    await page.goto(A.show("form", `<form id="forge" method="post" action="${S.base}/api/maps" enctype="text/plain">`
      + `<input type="hidden" name='{"title":"Gefälscht","x":"' value='"}'><button type="submit">Senden</button></form>`));
    await Promise.all([page.waitForResponse((x) => x.url() === S.base + "/api/maps", { timeout: 10000 }).catch(() => null), page.click("#forge button")]);
    await posts.settled();
    clean(check, f, " (the page of the other site)");
  } finally {
    const t0 = Date.now();
    await within(f.context.close(), 20000, "the close of the context of the other site").catch((error) => note(error.message));
    if (Date.now() - t0 > 5000) note(`the close of the context of the other site took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  // The context is closed: the record holds what the browser sent, and no read waits on the page any more.
  check(!postsLate(posts.list()), "the form of the other site: " + postsText(posts.list()));
  unchanged(check, before, await mapsOf(s));
}));

// ---------------------------------------------------------------------------------------------------------------
// 10. Forged requests from the subdomain of the owner. The browser counts <handle>.<BASE_DOMAIN> as the same site as
// the main domain, so it sends the session cookie of the main domain. The context copies the session of the owner and
// bypasses the CSP of the page: the attack assumes script on the subdomain, and the server must refuse on its own.
async function fromSubdomain(check, headers) {
  const map = need(state.map && state.map.public && state.map, "no public map");
  const owner = need(people.owner.s, "the owner is not signed in");
  need(S.domain !== null, "the stack named no subdomain address");
  // Without subdomains no page on a subdomain exists that could send the request.
  if (S.domain === "") { await noSubdomain(check, people.owner.handle, "/" + map.slug); return; }
  const before = await mapsOf(owner);
  const s = await site({ bypassCSP: true, storageState: await owner.context.storageState() });
  s.allow = FORGERY_ERRORS;
  try {
    const posts = watchPosts(s.page);
    await go(s.page, `${subdomainOrigin(people.owner.handle)}/${map.slug}`);
    await mapReady(s.page, { owner: false, heading: map.heading });
    const result = await forge(s.page, S.base + "/api/maps", headers);
    await s.page.waitForTimeout(300);
    await posts.settled();
    const sent = posts.list();
    check(!forgeLate(result) && !postsLate(sent), `the fetch on the subdomain: ${result}; ${postsText(sent)}`);
    check(sent.length === 1 && sent[0].cookie, "the browser sends the POST with the session cookie of the main domain");
    clean(check, s, " (subdomain)");
    unchanged(check, before, await mapsOf(owner));
  } finally { await s.context.close(); }
}
test("forged requests: a page on the subdomain of the owner sends a simple text/plain POST with credentials to the main domain, and nothing changes", async ({ check }) => {
  await fromSubdomain(check, { "Content-Type": "text/plain" });
});
test("forged requests: a page on the subdomain of the owner sends a POST with X-Requested-With to the main domain, and nothing changes", async ({ check }) => {
  await fromSubdomain(check, { "X-Requested-With": "it-skills", "Content-Type": "application/json" });
});

// ---------------------------------------------------------------------------------------------------------------
// 11. Headers.
test("headers: the session cookie is __Host-session with HttpOnly, Secure and SameSite=Lax", async ({ check }) => {
  const owner = need(people.owner.s, "the owner is not signed in");
  const cookies = await owner.context.cookies(S.base);
  const session = cookies.find((c) => c.name === "__Host-session");
  check(!!session, "the browser holds the cookie __Host-session: " + cookies.map((c) => c.name).join(", "));
  if (session) check(session.httpOnly && session.secure && session.sameSite === "Lax" && session.path === "/" && session.domain === BASE.hostname, "with HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain: " + JSON.stringify({ httpOnly: session.httpOnly, secure: session.secure, sameSite: session.sameSite, path: session.path, domain: session.domain }));
  check(loginCookies.length >= 3, `${loginCookies.length} logins set a cookie`);
  for (const header of uniq(loginCookies.map((h) => h.replace(/=[^;]*/, "=…").replace(/expires=[^;]*/i, "expires=…").replace(/max-age=\d+/i, "max-age=…")))) {
    const ok = /^__Host-session=/.test(header) && /;\s*HttpOnly/i.test(header) && /;\s*Secure/i.test(header) && /;\s*SameSite=Lax/i.test(header) && /;\s*Path=\/(;|$)/i.test(header) && !/;\s*Domain=/i.test(header);
    check(ok, "the header of the login: " + header);
  }
});
test("headers: each HTML answer of the stack carries a full CSP header with script-src 'self' and without 'unsafe-inline'", async ({ check }) => {
  const owner = need(people.owner.s, "the owner is not signed in");
  const map = need(state.map && state.map.public && state.map, "no public map");
  const h = people.owner.handle;
  const link = (await api(owner, "POST", `/api/maps/${map.id}/shares`)).data || {};
  const addresses = ["/", "/index.html", "/map.html", "/example.html", "/server-map.html", "/imprint.html", "/privacy.html", "/account",
    `/${h}`, `/${h}/${map.slug}`, `/e/${h}/${map.slug}`, "/e/niemand-hier/nichts", "/niemand-hier/nichts", link.url, link.embedUrl,
    ...(S.domain ? [subdomainOrigin(h) + "/", `${subdomainOrigin(h)}/${map.slug}`] : [])].filter(Boolean);
  const answers = new Map();
  const ask = async (address, cookie = "") => {
    const url = /^https?:/.test(address) ? address : S.base + address;
    const answer = await stackFetch(url, { headers: cookie ? { Cookie: cookie } : {} });
    answers.set(url + (cookie ? " (owner)" : ""), { status: answer.status, type: answer.headers["content-type"] || "", csp: answer.headers["content-security-policy"] || null });
  };
  for (const address of addresses) await ask(address);
  for (const address of ["/", team.map ? team.map.url : null].filter(Boolean)) await ask(address, await cookieOf(owner));
  for (const [url, a] of htmlAnswers) if (!answers.has(url)) answers.set(url, { ...a, type: "text/html" });
  let html = 0;
  const byProblem = new Map();
  for (const [url, a] of answers) {
    if (!a.type.includes("text/html")) continue;
    html++;
    for (const problem of headerProblems(a.csp)) byProblem.set(problem, [...(byProblem.get(problem) || []), `${where(url.replace(/\?.*$/, ""))} (${a.status})`]);
  }
  check(html > 15, `${html} HTML answers of the stack`);
  for (const [problem, urls] of byProblem) check(false, `${problem}: ${uniq(urls).length} answers, e.g. ${uniq(urls).slice(0, 6).join(", ")}`);
});
test("headers: a static host without headers keeps the CSP meta tag on each page", async ({ check }) => {
  const host = need(plain, "the plain web space does not run");
  const pages = builtFiles().filter((f) => f.endsWith(".html"));
  for (const file of pages) {
    const answer = await fetch(host.url + file, { signal: AbortSignal.timeout(10000) });
    const text = await answer.text(), meta = metaPolicy(text);
    check(!answer.headers.get("content-security-policy"), `${file}: the static host sends no CSP header`);
    const problems = meta ? scriptProblems(policyOf(meta)) : ["no CSP meta tag"];
    check(!problems.length, `${file}: the page keeps a strict meta tag` + (problems.length ? ": " + problems.join(", ") : ""));
  }
});
// The cache rules of the proxy (server/proxy/Caddyfile, selfhost/DEPLOY.md): a browser keeps an address with a version
// for a year and checks every other file of the site again on each use. The app sends no-store for the pages that name
// the account or a map.
test("headers: an address with a version is kept for a year, and the pages and every other file are checked again on each use", async ({ check }) => {
  const look = async (url, cookie = "") => { const a = await stackFetch(url, { headers: cookie ? { Cookie: cookie } : {} }); return `${a.status} ${a.headers["cache-control"] || "without Cache-Control"}`; };
  const KEEP = "200 public, max-age=31536000, immutable", AGAIN = "200 no-cache", NEVER = "200 no-store";
  const versioned = uniq(assetAddresses().map((x) => x.address)), wrong = [];
  for (const address of versioned) { const v = await look(S.base + "/" + address); if (v !== KEEP) wrong.push(`${address}: ${v}`); }
  check(versioned.length > 15 && !wrong.length, `${versioned.length} addresses with a version: Cache-Control ${KEEP.slice(4)}` + (wrong.length ? ": " + wrong.slice(0, 6).join(", ") : ""));
  for (const file of ["example.html", "map.html", "server-map.html", "imprint.html", "privacy.html", "assets/page.js", "vendor/fonts/fonts.css", "vendor/licenses/d3-ISC.txt"]) {
    const v = await look(S.base + "/" + file);
    check(v === AGAIN, `${file} without a version: ${v}`);
  }
  const owner = people.owner.s ? await cookieOf(people.owner.s) : "";
  for (const address of ["/", "/index.html"]) {
    const v = await look(S.base + address, owner);
    check(v === NEVER, `the start page of the app at ${address}: ${v}`);
  }
  const map = state.map && state.map.public ? state.map : null;
  if (map) check((await look(`${S.base}/${people.owner.handle}/${map.slug}`)) === NEVER, "the public map page of the app: no-store");
  if (S.domain && map) {
    const [address] = versioned, v = await look(`${subdomainOrigin(people.owner.handle)}/${address}`);
    check(v === KEEP, `${address.split("?")[0]} with its version on the subdomain of the owner: ${v}`);
  }
});
test("headers: /account sends frame-ancestors 'none' and X-Frame-Options: DENY", async ({ check }) => {
  const answer = await stackFetch(S.base + "/account");
  const csp = policyOf(answer.headers["content-security-policy"]);
  check(answer.status === 200 && same(csp.get("frame-ancestors"), ["'none'"]), "frame-ancestors " + (csp.get("frame-ancestors") || []).join(" "));
  check(answer.headers["x-frame-options"] === "DENY", "X-Frame-Options " + answer.headers["x-frame-options"]);
});
test("headers: the embed view sends the frame-ancestors of its map setting", async ({ check }) => {
  const owner = need(people.owner.s, "the owner is not signed in");
  const src = embedSrc();
  const [A] = await hostSites();
  const look = async () => { const answer = await stackFetch(src); return { status: answer.status, fa: policyOf(answer.headers["content-security-policy"]).get("frame-ancestors") || [], xfo: answer.headers["x-frame-options"] || null }; };
  try {
    let v = await look();
    check(v.status === 200 && same(v.fa, ["*"]) && v.xfo === null, "every site: frame-ancestors " + v.fa.join(" ") + ", X-Frame-Options " + v.xfo);
    await api(owner, "PATCH", "/api/maps/" + state.map.id, { embed: { allow: "origins", origins: [A.origin] } });
    v = await look();
    check(same(v.fa, ["'self'", A.origin]) && v.xfo === null, "one site: frame-ancestors " + v.fa.join(" ") + ", X-Frame-Options " + v.xfo);
  } finally {
    await api(owner, "PATCH", "/api/maps/" + state.map.id, { embed: { allow: "all" } });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 12. The languages of the server, in English: the mails in the language of their recipient, the language of the
// account in the data block of each page, and the English message of an error with the values of its text. The checks
// use the API and the mail catcher of the stack, with an account of their own.
const host = BASE.hostname;
test("languages: a registration in English through the API gets an English mail with its link", async ({ check }) => {
  const p = speaker;
  const sent = await api("", "POST", "/api/auth/register", { email: p.email, handle: p.handle, password: p.password, language: "en" });
  check(sent.status === 202 && sent.data && sent.data.status === "check_mail", "the registration in English: " + sent.status);
  p.registered = sent.status === 202;
  const mail = await mailTo(p.email, "Please confirm");
  const text = (mail.Text || "").replace(/\r\n/g, "\n"), token = (text.match(/#confirm=([A-Za-z0-9_-]+)/) || [])[1];
  check(mail.Subject === `Please confirm your account at ${host}`, "the subject is English: " + mail.Subject);
  check(text.startsWith(`Hello ${p.handle},\n\nplease confirm your e-mail address with this link:\n\n${S.base}/account#confirm=`) && text.includes("The link is valid for 48 hours."),
    "the text is English, with the link to the account page: " + short(text.split("#confirm=")[0], 160));
  const confirmed = await api("", "POST", "/api/auth/confirm", { token, password: p.password });
  p.cookie = confirmed.status === 200 ? await signIn(p) : null;
  const login = p.cookie ? await api(p.cookie, "GET", "/api/account") : { status: "no login" };
  check(!!p.cookie && login.data && login.data.language === "en", `the link confirms the account, and the account is English: ${confirmed.status}, ${login.data && login.data.language}`);
});
test("languages: after PATCH /api/account with de, the mail for a new password is German", async ({ check }) => {
  const p = speaker, cookie = need(p.cookie, "the account of the languages is not signed in");
  const changed = await api(cookie, "PATCH", "/api/account", { language: "de" });
  check(changed.status === 200 && changed.data.language === "de" && changed.data.handle === p.handle, "PATCH /api/account sets de and gives the account: " + changed.status);
  const session = await api(cookie, "GET", "/api/auth/session");
  check(session.data && session.data.language === "de", "the session names de: " + JSON.stringify(session.data));
  const asked = await api("", "POST", "/api/auth/reset-request", { email: p.email });
  check(asked.status === 202, "the request for a new password: " + asked.status);
  const mail = await mailTo(p.email, "Neues Passwort");
  const text = (mail.Text || "").replace(/\r\n/g, "\n");
  check(mail.Subject === `Neues Passwort für ${host}`, "the subject is German: " + mail.Subject);
  check(text.startsWith(`Hallo ${p.handle},\n\nmit diesem Link setzt du ein neues Passwort:\n\n${S.base}/account#reset=`) && text.includes("Der Link gilt eine Stunde und nur einmal."),
    "the text is German, with the link to the account page: " + short(text.split("#reset=")[0], 160));
});
test("languages: the data block of each page names the language of the signed-in account", async ({ check }) => {
  const p = speaker, cookie = need(p.cookie, "the account of the languages is not signed in");
  const made = await api(cookie, "POST", "/api/maps", { title: "Sprachen" });
  check(made.status === 201, "the account makes a map: " + made.status);
  // The private map has no page without the session, so only the other pages name null without one.
  const mapPage = made.status === 201 ? `/${p.handle}/${made.data.slug}` : null;
  const pages = ["/", "/index.html", "/account", ...(mapPage ? [mapPage] : [])];
  for (const address of pages) {
    const signedIn = dataBlock((await stackFetch(S.base + address, { headers: { Cookie: cookie } })).text);
    const signedOut = dataBlock((await stackFetch(S.base + address)).text);
    check(signedIn && signedIn.language === "de" && (address === mapPage || (signedOut && signedOut.language === null)),
      `${address}: the data block names de with the session` + (address === mapPage ? "" : ", and null without one") + `: ${signedIn && signedIn.language}, ${signedOut && signedOut.language}`);
  }
});
test("languages: an error answer has the English message and the values of its text", async ({ check }) => {
  const p = speaker, cookie = need(p.cookie, "the account of the languages is not signed in");
  const weak = await api(cookie, "POST", "/api/account/password", { current: p.password, new: "kurz" });
  check(weak.status === 400 && same(weak.data, { error: "weak_password", message: "The password needs at least 12 characters.", params: { min: 12, variant: "short" } }),
    "a short new password: " + weak.status + " " + JSON.stringify(weak.data));
  const language = await api(cookie, "PATCH", "/api/account", { language: "xx" });
  check(language.status === 400 && same(language.data, { error: "bad_language", message: "This language is not available. The languages are en, de.", params: { languages: "en, de" } }),
    "an unknown language: " + language.status + " " + JSON.stringify(language.data));
  const anonymous = await api("", "GET", "/api/maps");
  check(anonymous.status === 401 && same(anonymous.data, { error: "not_logged_in", message: "Please sign in.", params: {} }), "without a session: " + JSON.stringify(anonymous.data));
  const page = await stackFetch(S.base + "/nobody-here-" + RUN);
  check(page.status === 404 && page.text.includes('<p data-i18n="error.not_found">Not found.</p>') && page.text.includes('<script src="/assets/i18n.js" defer></script>'),
    "the error page of a browser holds the English text with its key, and loads the texts: " + page.status);
  const gone = await api(cookie, "POST", "/api/account/delete", { password: p.password });
  p.deleted = gone.status === 204;
  check(p.deleted, "the account of these checks deletes itself: " + gone.status);
});

// ---------------------------------------------------------------------------------------------------------------
// The clean-up: the team, then the three accounts with their maps. It runs after every failure too.
let cleaned = false;
async function cleanUp(check) {
  cleaned = true;
  // The account of the checks of the languages deletes itself in its last check; after a failure it goes here.
  if (speaker.registered && !speaker.deleted) {
    const cookie = await signIn(speaker);
    if (cookie) await api(cookie, "POST", "/api/account/delete", { password: speaker.password }).catch(() => {});
  }
  const owner = await signIn(people.owner);
  if (team.made) {
    const status = owner ? (await api(owner, "POST", `/api/teams/${team.handle}/delete`, { password: people.owner.password })).status : "no login";
    check(status === 204, "the team is deleted: " + status);
  }
  for (const p of Object.values(people)) {
    const cookie = p === people.owner ? owner : await signIn(p);
    if (!cookie) { check(!p.s, `${p.role}: no account to delete`); continue; }
    const status = (await api(cookie, "POST", "/api/account/delete", { password: p.password })).status;
    check(status === 204, `${p.role}: the account and its maps are deleted: ${status}`);
  }
}
test("clean up: the team and the three accounts are deleted", async ({ check }) => { await cleanUp(check); }, true);

// ---------------------------------------------------------------------------------------------------------------
(async () => {
  const started = Date.now();
  if (!fs.existsSync(path.join(SITE, "index.html"))) { console.error("dist/selfhost is missing: run node build_selfhost.js first"); process.exit(1); }
  browser = await chromium.launch();
  const probe = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  // The proxy starts before the app is ready (server/compose.yaml), so a 502 can last a few seconds after the start.
  let answer = null;
  for (const end = Date.now() + 60000; ;) {
    answer = await probe.goto(S.base + "/api/health", { timeout: 10000 }).catch(() => null);
    if (!answer || answer.status() !== 502 || Date.now() > end) break;
    await probe.waitForTimeout(1000);
  }
  await probe.context().close();
  if (!answer || answer.status() !== 200) {
    console.error(`The stack does not answer at ${S.base}/api/health. Start it first: docker compose -p skillmap-release -f server/compose.yaml up -d --build`);
    await browser.close(); process.exit(1);
  }
  if (!(await fetch(S.mailpit + "/api/v1/info", { signal: AbortSignal.timeout(10000) }).then((x) => x.ok, () => false))) { console.error(`mailpit does not answer at ${S.mailpit}. The stack needs COMPOSE_PROFILES=local.`); await browser.close(); process.exit(1); }
  const limit = (name) => process.env[name] || (fs.existsSync(path.join(repo, "server", ".env")) && (fs.readFileSync(path.join(repo, "server", ".env"), "utf8").match(new RegExp("^" + name + "=(\\S*)", "m")) || [])[1]) || "the default of compose.yaml";
  console.log(`This run registers 4 accounts and signs in about 7 times. Limits of server/.env: RATE_LIMIT_REGISTER_IP ${limit("RATE_LIMIT_REGISTER_IP")}, RATE_LIMIT_LOGIN_IP ${limit("RATE_LIMIT_LOGIN_IP")} (count/seconds).`);
  plain = await serve(SITE);
  testOrigins.add(plain.origin);
  const only = process.argv.slice(2);
  const chosen = only.length ? tests.filter((t) => t.always || only.some((o) => t.name.includes(o))) : tests;
  let passed = 0;
  try {
    for (const t of chosen) {
      const lines = [], failures = [], notes = [], t0 = Date.now();
      const check = (ok, text) => { lines.push((ok ? "ok   " : "FAIL ") + text); if (!ok) failures.push(short(text, 400)); };
      const note = (text) => notes.push(short(text, 300));
      // The last limit: a check that has not ended after CHECK_LIMIT_MS fails, and the run goes on with the next one.
      try { await within(t.fn({ check, note }), CHECK_LIMIT_MS, "the whole check"); } catch (error) {
        if (error instanceof NotRun) check(false, "not run: " + error.message);
        else if (error instanceof Late) check(false, `${error.message}: one of its waits did not end`);
        else check(false, "threw: " + String(error && error.message || error).split("\n")[0]);
      }
      const seconds = ((Date.now() - t0) / 1000).toFixed(1) + " s";
      if (failures.length) console.log(`FAIL ${t.name}: ${failures.join(" | ")}`);
      else { passed++; console.log(`PASS ${t.name} (${seconds})`); }
      notes.forEach((text) => console.log(`NOTE ${t.name}: ${text}`));
      if (VERBOSE) lines.forEach((line) => console.log("      " + line));
    }
  } finally {
    if (!cleaned) await cleanUp(() => {}).catch((error) => console.error("clean-up failed: " + error.message));
    await within(Promise.all([...contexts].map((c) => c.close().catch(() => {}))), 30000, "the close of the browser contexts").catch((error) => console.error(error.message));
    await within(browser.close(), 30000, "the close of the browser").catch((error) => console.error(error.message));
    await plain.close();
    if (hosts) await Promise.all(hosts.map((x) => x.close()));
  }
  console.log(`\n${passed} of ${chosen.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  process.exitCode = passed === chosen.length ? 0 : 1;
  // A browser that did not close keeps the process alive: the run ends anyway.
  setTimeout(() => process.exit(), 5000).unref();
})();

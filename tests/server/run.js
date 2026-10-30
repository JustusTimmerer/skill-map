// Browser tests of stage b against the running compose stack (server/compose.yaml): registration with the mail in
// mailpit, maps of an account, the import of a map file of stage a, share links, polling, public maps by path and by
// subdomain, the messages of the runtime (selfhost/runtime/server.js), the account page (server/app/static/account.js)
// with its map, team and account flows, and stage a on the same site without an account.
// The stack must run with the site of node build_selfhost.js (npm run test:server builds it first).
// The addresses come from the environment, then from server/.env: BASE_URL, BASE_DOMAIN and MAILPIT_PORT (or MAILPIT_URL).
// Every test fails on a request to another host. The tests run one after another, because they share one account,
// and the last one deletes it. The embed tests frame the maps in pages of two small servers on 127.0.0.1, each on a free
// port of its own, so that they are two other sites.
// One run makes two accounts: the owner, who registers through the page, and a second account for the tests of the
// account page, which registers through the API. The second account joins a team of the owner, resets and changes
// its password, and deletes itself. Against the rate limits of the server, one run makes 2 registrations, 10 logins
// and confirmations from one IP address, at most 8 requests that count for one account (logins, password changes and
// deletes), 2 requests of the password reset, and 3 invitations, at most 2 to one address. The two clean-up tests at
// the end delete both accounts and the team, also after a failure.
// Usage: node tests/server/run.js [part of a test name ...]    E2E_VERBOSE=1 prints every check.
// A test that does not end within 6 minutes fails with its name (E2E_TEST_LIMIT_S of tests/e2e/harness.js changes it).
const fs = require("fs"), path = require("path"), crypto = require("crypto"), http = require("http"), zlib = require("zlib");
const { run } = require("../e2e/harness");
const { chooseLanguage, englishOf, germanIn, textOf } = require("../e2e/site");
const repo = path.join(__dirname, "..", ".."), OUT = path.join(__dirname, "out");
const same =(a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (x) => Array.isArray(x) ? x.map(sorted) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sorted(x[k])])) : x;

function settings() {
  const file = path.join(repo, "server", ".env"), env = {};
  if (fs.existsSync(file)) fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line) => { const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2]; });
  const get = (name, fallback) => process.env[name] || env[name] || fallback;
  const base = get("BASE_URL", "https://it-skills.localhost:8443").replace(/\/+$/, "");
  return { base, domain: get("BASE_DOMAIN", ""), mailpit: (process.env.MAILPIT_URL || "http://127.0.0.1:" + get("MAILPIT_PORT", "8025")).replace(/\/+$/, "") };
}
const S = settings(), BASE = new URL(S.base);
const subdomainOrigin = (handle) => `${BASE.protocol}//${handle}.${S.domain}${BASE.port ? ":" + BASE.port : ""}`;

// The test data of the e2e suite as a map file of stage a.
const FIXTURE = new Function(fs.readFileSync(path.join(repo, "tests", "e2e", "fixture.js"), "utf8") + "\nreturn { COLORS, CLUSTERS, GROUPS, SKILLS, PROJECTS, WHERE, STANDARD };")();
const FIXTURE_PROJECTS = JSON.parse(fs.readFileSync(path.join(repo, "tests", "e2e", "fixture.projects.json"), "utf8"));
function collectionsOf(d, projects = []) {
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
  return {
    areas: Object.fromEntries(d.CLUSTERS.map((c, i) => [c.id, { name: c.name, color: d.COLORS[c.id], at: c.at, order: i }])),
    stations: Object.fromEntries(Object.entries(d.PROJECTS).map(([k, p], i) => [k, { name: p.name, short: d.WHERE[k] || "", kind: p.kind, when: p.when, months: p.months, note: p.note, order: i }])),
    groups: Object.fromEntries(d.GROUPS.map(([id, area, name], i) => [id, { name, area, order: i }])),
    skills: Object.fromEntries(d.SKILLS.map(([name, group, rating, where], i) => [slug(name) + "-" + i, { name, group, rating, places: where ? where.split(" ") : [], order: i,
      ...(d.STANDARD[name] ? { standard: d.STANDARD[name] } : {}) }])),
    projects: Object.fromEntries(projects.map(({ id, ...p }) => [id, p])),
  };
}
const STAGE_A_FILE = { format: "it-skills-map", schema: 1, title: "Testdaten", exportedAt: "2026-10-18T22:00:00Z", collections: collectionsOf(FIXTURE, FIXTURE_PROJECTS) };

// The account of this run: a new handle each time.
const handle = "rt-" + crypto.randomBytes(4).toString("hex");
const account = { handle, email: handle + "@example.org", password: "ein langes Passwort " + crypto.randomBytes(3).toString("hex") };
const state = { owner: null, itMap: null, testMap: null, shareUrl: null };

// A browser context on the stack. Every request must stay on the site or on a subdomain of it, or go to one of the
// origins in also: the pages of other sites that frame a map (hostSite). allow: console errors that the test expects,
// for example the 404 of a revoked link.
// language: the language of the pages, German by default (tests/e2e/site.js); null keeps English of a first visit.
async function site(browser, also = [], { language = "de" } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 }, reducedMotion: "reduce", acceptDownloads: true });
  if (language) await context.addInitScript(chooseLanguage, language);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: S.base });
  const s = { context, errors: [], external: [], requests: [], allow: [], also: [...also] };
  const ours = (url) => { try { const u = new URL(url); return u.origin === BASE.origin || s.also.includes(u.origin) || (S.domain && u.hostname.endsWith("." + S.domain) && u.port === BASE.port); } catch (error) { return false; } };
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (ours(url)) return route.continue();
    s.external.push(url);
    return route.abort();
  });
  context.on("page", (page) => {
    page.on("pageerror", (error) => s.errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !s.allow.some((re) => re.test(message.text()))) s.errors.push(message.text()); });
    page.on("request", (request) => { s.requests.push(request.method() + " " + request.url()); });
  });
  s.page = await context.newPage();
  return s;
}
const clean = (check, s, what = "") => {
  check(s.errors.length === 0, "no console errors" + what + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
  check(s.external.length === 0, "no request leaves the site" + what + (s.external.length ? ": " + [...new Set(s.external)].join(", ") : ""));
  s.errors.length = 0; s.external.length = 0;
};
// A test with a fresh context that closes at the end.
const withSite = (body) => async ({ browser, check }) => {
  const s = await site(browser);
  try { await body(s, check); } finally { clean(check, s); await s.context.close(); }
};
// A test in the context of the signed-in owner, which stays open for the next test.
const asOwner = (body) => async ({ check }) => {
  if (!state.owner) throw new Error("the owner is not signed in (the first test failed)");
  try { await body(state.owner, check); } finally { clean(check, state.owner); state.owner.allow = []; }
};
const go = (page, where) => page.goto(/^https?:/.test(where) ? where : S.base + where);
const h2 = (page) => page.locator("#panel h2").first().innerText();
// The map page has drawn its panel; for the owner its database has answered, for a reader the h2 is the expected one.
async function mapReady(page, { owner = true, heading = null } = {}) {
  await page.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 });
  if (owner) await page.waitForFunction(() => document.getElementById("save-state").textContent === "Gespeichert" && document.getElementById("cfg-groups").children.length > 0, null, { timeout: 15000 });
  if (heading) await page.waitForFunction((h) => document.querySelector("#panel h2").textContent === h, heading, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(250);
}
const saved = (page) => page.waitForFunction(() => document.getElementById("save-state").textContent === "Gespeichert", null, { timeout: 10000 }).then(() => page.waitForTimeout(200));
async function clickPanel(page, text) { await page.locator("#panel button", { hasText: text }).first().click(); await page.waitForTimeout(150); }
async function submitForm(page) { await page.locator("#catalog-form button[type=submit]").click(); await page.waitForTimeout(300); }
const alertText = (page) => page.locator("#runtime-alert").innerText().catch(() => "");
const waitAlert = (page, text, timeout = 15000) => page.waitForFunction((t) => { const box = document.getElementById("runtime-alert"); return !!box && box.textContent.includes(t); }, text, { timeout }).then(() => true, () => false);
// The documents of a map as the server holds them, read from the page with its session.
const serverDocs = (page, api) => page.evaluate(async (a) => (await (await fetch(a + "/docs", { cache: "no-store" })).json()).docs, api);
async function exportFrom(page, click) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), click()]);
  return { name: download.suggestedFilename(), text: fs.readFileSync(await download.path(), "utf8") };
}
const pick = (page, selector, name, text) => page.setInputFiles(selector, { name, mimeType: "application/json", buffer: Buffer.from(text, "utf8") });
// A part of the subject of each mail, in each language of the server (server/app/i18n/<language>/mail.json). A mail goes
// out in the language of its recipient: the owner registers on the page and has the language of the page, and the second
// account registers through the API in German.
const SUBJECT = { confirm: ["bestätige", "Please confirm"], reset: ["Neues Passwort", "New password"],
  invitation: (team) => ["Einladung in das Team " + team, "Invitation to the team " + team] };
// Mail through the API of mailpit: the newest mail to "to" whose subject holds subject, or one of a list of subjects.
async function mailTo(to, subject, timeout = 20000) {
  const until = Date.now() + timeout, subjects = [].concat(subject);
  while (Date.now() < until) {
    const list = await (await fetch(S.mailpit + "/api/v1/search?query=" + encodeURIComponent(`to:"${to}"`))).json();
    const found = (list.messages || []).filter((m) => subjects.some((part) => m.Subject.includes(part)));
    if (found.length) return (await fetch(S.mailpit + "/api/v1/message/" + found[0].ID)).json();
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`no mail "${subject}" to ${to} within ${timeout / 1000} s`);
}
async function openShare(page) {
  await page.click("#share-open");
  await page.waitForFunction(() => { const d = document.getElementById("share-dialog"); return d && d.open && d.querySelector("#share-title"); }, null, { timeout: 10000 });
}
// The tests of the account page. The second account is a member of a team of the owner, then it resets and changes
// its password and deletes itself. passwords holds each password that it had, the newest last, so that the clean-up
// finds the right one after a failure.
const member = { handle: handle + "-b", email: handle + "-b@example.org", registered: false, deleted: false,
  passwords: ["ein zweites langes Passwort " + crypto.randomBytes(3).toString("hex")] };
const memberPassword = () => member.passwords[member.passwords.length - 1];
// The team of the account tests. Its name and handle change when the owner renames it.
const crew = { name: "Testcrew", handle: handle + "-crew", created: false, deleted: false };
// The maps that the account page makes, by their titles: their ids.
const kontoMaps = {};
// The API of the site, called from a page with its session: the status and the JSON answer, or null for another answer.
const apiCall = (page, method, where, body) => page.evaluate(async ([m, p, b]) => {
  const options = { method: m, cache: "no-store", headers: { "X-Requested-With": "it-skills" } };
  if (b !== null) { options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(b); }
  const response = await fetch(p, options);
  let json = null;
  try { json = await response.json(); } catch (error) { json = null; }
  return { status: response.status, body: json };
}, [method, where, body === undefined ? null : body]);
const apiGet = (page, where) => apiCall(page, "GET", where);
const membersOf = async (page, team) => { const r = await apiGet(page, `/api/teams/${team}`); return r.status === 200 ? r.body.members.map((x) => [x.handle, x.role]) : r.status; };
const docsAsCollections = (docs) => docs.reduce((all, d) => { (all[d.collection] = all[d.collection] || {})[d.id] = d.data; return all; }, {});
const kontoReady = (page, part = "signed-in") => page.waitForFunction((id) => !document.getElementById(id).hidden, part, { timeout: 10000 });
// An action on the account page and the message that it shows below the heading: its text and whether it is an error.
async function kontoSays(page, action) {
  await page.evaluate(() => { const box = document.getElementById("message"); box.textContent = ""; box.hidden = true; box.classList.remove("error"); });
  await action();
  await page.waitForFunction(() => { const box = document.getElementById("message"); return !box.hidden && box.textContent; }, null, { timeout: 10000 }).catch(() => {});
  return page.evaluate(() => { const box = document.getElementById("message"); return { text: box.textContent, error: box.classList.contains("error") }; });
}
// The next dialog of a page (confirm): accepts or dismisses it and gives its text, or null after 10 s without one.
function nextDialog(page, accept) {
  return new Promise((done) => {
    const answer = async (dialog) => { clearTimeout(timer); const text = dialog.message(); await (accept ? dialog.accept() : dialog.dismiss()); done(text); };
    const timer = setTimeout(() => { page.off("dialog", answer); done(null); }, 10000);
    page.once("dialog", answer);
  });
}
// A team in the list of the account page, and the same team opened.
const teamRow = (page, team) => page.locator("#team-list > li", { hasText: `(${team})` });
async function openTeam(page, team) {
  const row = teamRow(page, team);
  await row.waitFor({ timeout: 10000 });
  if (await row.locator(":scope > .team").isHidden()) await row.locator(":scope > .actions button", { hasText: "Öffnen" }).click();
  await row.locator(".team h3", { hasText: "Mitglieder" }).waitFor({ timeout: 10000 });
  return row;
}
// The entry of a member in an opened team: "(du)" for the own entry.
const memberRow = (row, text) => row.locator(".team ul.plain > li", { hasText: text });
async function inviteFrom(page, row, email, role) {
  const form = row.locator(".team form", { hasText: "Einladen" });
  await form.locator("input[name=email]").fill(email);
  await form.locator("select[name=role]").selectOption(role);
  return kontoSays(page, () => form.locator("button[type=submit]").click());
}
// The link of a mail in mailpit with #<kind>=<token>, and the same link opened in a fresh page, as from a mail program.
const mailLink = (letter, kind) => (letter.Text.match(new RegExp(`https?://\\S+#${kind}=[A-Za-z0-9_-]+`)) || [""])[0];
async function openLink(page, link) { await page.goto("about:blank"); await go(page, link); }
// The files of a ZIP file, read through its central directory: { name: Buffer }.
function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a ZIP file");
  const files = {};
  for (let i = 0, at = buffer.readUInt32LE(end + 16); i < buffer.readUInt16LE(end + 10); i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("a broken ZIP directory");
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20), length = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42), start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files[buffer.toString("utf8", at + 46, at + 46 + length)] = method === 8 ? zlib.inflateRawSync(data) : data;
    at += 46 + length + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return files;
}
// A test of the account page with the owner and the second account, each in a browser context of its own.
const asOwnerAndMember = (body) => asOwner(async (s, check) => {
  if (!state.member) throw new Error("the second account is not signed in (an earlier test failed)");
  try { await body(s, state.member, check); } finally { clean(check, state.member, " (second account)"); state.member.allow = []; }
});
// The tests build on each other: after a failed test the next ones only report that they did not run.
// A test with always: true (the clean-up) runs anyway.
let failedBefore = false;
const tests = [];
const test = (name, fn, always = false) => tests.push({ name, fn: async (t) => {
  if (failedBefore && !always) { t.check(false, "not run: an earlier test failed"); return; }
  let failed = false;
  const check = (ok, text) => { if (!ok) failed = true; t.check(ok, text); };
  try { await fn({ ...t, check }); } catch (error) { failed = true; throw error; } finally { if (failed) failedBefore = true; }
} });

test("the start page offers both ways; register, confirm through the mail and sign in", async ({ browser, check }) => {
  const s = await site(browser);
  state.owner = s;
  const page = s.page;
  await go(page, "/");
  check(await page.locator("#account-card h2").innerText() === "Maps auf dem Server speichern", "signed out, the start page offers the account: " + await page.locator("#account-card h2").innerText());
  check((await page.locator("#intro-label").textContent()) === "Ohne Konto im Browser" && (await page.locator("#intro-store").textContent()) === "Ohne Konto speichert der Server nichts.", "and names the other way Ohne Konto im Browser");
  check(await page.locator("#account-card .label").textContent() === "Mit Konto speichern", "the account card is Mit Konto speichern");
  check(await page.locator("#new-default").isVisible() && await page.locator("#account-login").isVisible() && await page.locator("#account-register").isVisible(), "the buttons of stage a, Anmelden and Registrieren");
  await page.click("#account-register");
  await page.waitForURL(/\/account#register$/);
  await page.waitForFunction(() => !document.getElementById("register").hidden, null, { timeout: 10000 });
  check(!(await page.locator("main").innerText()).includes("Karte"), "the account page says Map, not Karte");
  await page.fill("#register input[name=email]", account.email);
  await page.fill("#register input[name=handle]", account.handle);
  // The strength meter asks the check of the server, which the registration applies too.
  const meter = () => page.evaluate(() => {
    const box = document.querySelector("#password-hint + .strength");
    return box && !box.hidden ? [box.dataset.score, box.querySelector(".strength-label").textContent, box.querySelector(".strength-warning").textContent,
      ...[...box.querySelectorAll(".strength-tips li")].map((li) => li.textContent)].join(" | ") : "";
  });
  await page.fill("#register input[name=password]", "Sommer2026!!");
  await page.waitForFunction(() => { const box = document.querySelector("#password-hint + .strength"); return box && !box.hidden; }, null, { timeout: 10000 });
  check(await meter() === "3 | Fast stark genug | Namen sind leicht zu erraten. | Füge ein oder zwei Wörter hinzu, am besten ungewöhnliche. | Ein Großbuchstabe am Anfang oder nur Großbuchstaben helfen wenig.",
    "the strength meter rates Sommer2026!! with the check of the server: " + await meter());
  await page.fill("#register input[name=password]", account.password);
  await page.waitForFunction(() => { const box = document.querySelector("#password-hint + .strength"); return box && box.dataset.score === "4"; }, null, { timeout: 10000 });
  check(await meter() === "4 | Stark | " && await page.locator("#password-hint + .strength.ok").count() === 1, "and Stark for the password of the account: " + await meter());
  await page.click("#register button[type=submit]");
  await page.waitForFunction(() => !document.getElementById("message").hidden, null, { timeout: 10000 });
  check((await page.locator("#message").innerText()).includes("E-Mail"), "the page asks to check the mail: " + await page.locator("#message").innerText());
  const mail = await mailTo(account.email, SUBJECT.confirm);
  const link = (mail.Text.match(/https?:\/\/\S+#confirm=[A-Za-z0-9_-]+/) || [""])[0];
  check(link.startsWith(S.base + "/account#confirm="), "the mail links to the account page of the site: " + link.replace(/=.*/, "=…"));
  await go(page, link);
  await page.waitForSelector("#confirm-form input[name=password]", { state: "visible", timeout: 10000 });
  s.allow = [/status of 401/];
  await page.fill("#confirm-form input[name=password]", account.password + " falsch");
  await page.click("#confirm-form button[type=submit]");
  await page.waitForFunction(() => document.getElementById("message").classList.contains("error"), null, { timeout: 10000 });
  check((await page.locator("#message").innerText()).includes("Passwort passt nicht") && await page.locator("#confirm").isVisible(),
    "the link asks for the password of the registration, and a wrong one confirms nothing: " + await page.locator("#message").innerText());
  s.allow = [];
  await page.fill("#confirm-form input[name=password]", account.password);
  await page.click("#confirm-form button[type=submit]");
  await page.waitForFunction(() => /bestätigt/.test(document.getElementById("message").textContent), null, { timeout: 10000 });
  check(await page.locator("#confirm").isHidden() && !page.url().includes("#confirm"), "the link with the password confirms the account");
  await page.fill("#login input[name=email]", account.email);
  await page.fill("#login input[name=password]", account.password);
  await page.click("#login button[type=submit]");
  await page.waitForFunction(() => !document.getElementById("signed-in").hidden, null, { timeout: 10000 });
  check((await page.locator("#who").innerText()).includes(account.handle), "signed in: " + await page.locator("#who").innerText());
  await go(page, "/");
  await page.waitForFunction(() => document.getElementById("account-empty") && !document.getElementById("account-empty").hidden, null, { timeout: 10000 });
  check(await page.locator("#account-card h2").innerText() === "Deine Maps im Konto" && (await page.locator("#account-who").innerText()).includes(account.handle), "the start page shows Deine Maps im Konto with the handle");
  check(await page.locator("#account-list li").count() === 0, "no map in the account yet");
  clean(check, s);
});

test("a map from the default set: the owner adds an area, a category and a skill; a reload shows them", asOwner(async (s, check) => {
  const page = s.page;
  await go(page, "/");
  await page.click("#account-new-default");
  await page.waitForURL(new RegExp(`/${handle}/meine-skills$`));
  await mapReady(page);
  state.itMap = { url: page.url(), api: await page.evaluate(() => window.IT_SKILLS_SERVER.api) };
  check((await page.locator("#title").innerText()) === "Meine Skills" && (await h2(page)) === "12 Kenntnisse in 3 Bereichen", "the default set: " + await h2(page));
  check(await page.locator("#cfg").isVisible() && await page.locator("#file-export").isVisible() && await page.locator("#share-open").isVisible() && await page.locator("#account-link").isVisible(),
    "the owner gets the force menu, Exportieren, Teilen and Konto");
  check((await page.locator("#subtitle").innerText()).includes("in deinem Konto auf dem Server"), "the subtitle says where the map lives");
  check(await page.locator("a.tool-link", { hasText: "Start" }).getAttribute("href") === S.base + "/", "Start leads to the start page of the site");
  await clickPanel(page, "+ Bereich");
  await page.fill("#cf-name", "Testbereich");
  await submitForm(page);
  await clickPanel(page, "+ Kategorie");
  await page.fill("#cf-name", "Testkategorie");
  await submitForm(page);
  check((await h2(page)) === "Testkategorie", "the area and the category");
  await clickPanel(page, "+ Skill");
  await page.fill("#cf-name", "Testkenntnis");
  await page.selectOption("#cf-rating", "3");
  await submitForm(page);
  check((await h2(page)) === "Testkenntnis", "the skill");
  await saved(page);
  const docs = await serverDocs(page, state.itMap.api);
  check(docs.some((d) => d.collection === "areas" && d.id === "testbereich" && d.data.name === "Testbereich")
    && docs.some((d) => d.collection === "groups" && d.data.name === "Testkategorie" && d.data.area === "testbereich")
    && docs.some((d) => d.collection === "skills" && d.data.name === "Testkenntnis" && d.data.rating === 3), "the server holds the area, the category and the skill");
  await page.reload();
  await mapReady(page);
  check((await page.locator("#areas .chip").allInnerTexts()).includes("Testbereich") && (await h2(page)) === "13 Kenntnisse in 4 Bereichen", "after a reload: " + await h2(page));
  await clickPanel(page, "Titel ändern");
  await page.fill("#cf-name", "Meine Skills (Test)");
  await submitForm(page);
  check((await page.locator("#title").innerText()) === "Meine Skills (Test)" && (await page.title()) === "Meine Skills (Test) · Skill-Map", "Titel ändern renames the map");
  const meta = await page.evaluate(async (id) => (await (await fetch("/api/maps/" + id, { cache: "no-store" })).json()), state.itMap.api.split("/").pop());
  check(meta.title === "Meine Skills (Test)" && meta.slug === "meine-skills", "on the server too, and the address stays: " + meta.title + ", " + meta.slug);
}));

test("a map file of stage a becomes a new map of the account; the export gives the same file", asOwner(async (s, check) => {
  const page = s.page;
  await go(page, "/");
  await page.waitForFunction(() => document.querySelectorAll("#account-list li").length === 1, null, { timeout: 10000 });
  await pick(page, "#account-file-input", "Testdaten.it-skills-map.json", JSON.stringify(STAGE_A_FILE, null, 2));
  await page.waitForURL(new RegExp(`/${handle}/testdaten$`));
  await mapReady(page);
  state.testMap = { url: page.url(), api: await page.evaluate(() => window.IT_SKILLS_SERVER.api) };
  check((await h2(page)) === "9 Kenntnisse in 3 Bereichen" && (await page.locator("#title").innerText()) === "Testdaten", "the imported map: " + await h2(page));
  const fromMap = await exportFrom(page, () => page.click("#file-export"));
  const json = JSON.parse(fromMap.text);
  check(fromMap.name === "Testdaten.it-skills-map.json", "the file name is the title, as in stage a: " + fromMap.name);
  check(same(Object.keys(json), ["format", "schema", "title", "exportedAt", "collections"]) && same(Object.keys(json.collections), ["areas", "stations", "groups", "skills", "projects"]), "the fields and the collections in the order of the format");
  check(same(sorted(json.collections), sorted(STAGE_A_FILE.collections)), "the export of the map page holds the documents of the file");
  await pick(page, "#file-input", "kaputt.json", "{");
  await page.waitForTimeout(200);
  check((await page.locator("#file-message").innerText()) === "Die Datei ist kein gültiges JSON. Eine Map-Datei entsteht mit „Exportieren“.", "Map-Datei öffnen in the map: a bad file gives the error below the toolbar");
  await pick(page, "#file-input", fromMap.name, fromMap.text);
  await page.waitForURL(new RegExp(`/${handle}/testdaten-2$`));
  await mapReady(page);
  check((await h2(page)) === "9 Kenntnisse in 3 Bereichen", "Map-Datei öffnen in the map imports the file as one more map of the account");
  const copyId = await page.evaluate(() => window.IT_SKILLS_SERVER.api.split("/").pop());
  s.allow = [/status of 404/];
  check(await page.evaluate(async (id) => (await fetch("/api/maps/" + id, { method: "DELETE", headers: { "X-Requested-With": "it-skills" } })).status, copyId) === 204, "the copy is deleted again");
  await go(page, "/");
  await page.waitForFunction(() => document.querySelectorAll("#account-list li").length === 2, null, { timeout: 10000 });
  const item = page.locator("#account-list li", { hasText: "Testdaten" });
  check((await item.locator(".map-meta").innerText()).startsWith("Privat · geändert "), "the list names the visibility and the change: " + await item.locator(".map-meta").innerText());
  const fromList = await exportFrom(page, () => item.locator("button", { hasText: "Exportieren" }).click());
  check(fromList.name === "Testdaten.it-skills-map.json" && same(sorted(JSON.parse(fromList.text).collections), sorted(STAGE_A_FILE.collections)), "Exportieren on the start page gives the same file");
  await pick(page, "#account-file-input", "kaputt.json", "{ kein json");
  await page.waitForFunction(() => !document.getElementById("account-message").hidden, null, { timeout: 5000 });
  check((await page.locator("#account-message").innerText()).startsWith("Die Datei ist kein gültiges JSON."), "a bad file gives the German error of stage a");
}));

test("a map of this browser moves into the account", asOwner(async (s, check) => {
  const page = s.page;
  await go(page, "/");
  await page.click("#new-default");
  await page.waitForURL(/\/map\.html\?id=/);
  await mapReady(page);
  check((await h2(page)) === "12 Kenntnisse in 3 Bereichen" && await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("it-skills-map/")).length) === 1, "stage a works for a signed-in visitor too: a map in this browser");
  await go(page, "/");
  await page.waitForFunction(() => document.querySelectorAll("#account-list li").length === 2, null, { timeout: 10000 });
  await page.locator("#map-list button", { hasText: "Ins Konto übernehmen" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#account-list li").length === 3, null, { timeout: 10000 });
  check((await page.locator("#account-message").innerText()).startsWith("„Meine Skills“ liegt jetzt auch im Konto."), "the message: " + await page.locator("#account-message").innerText());
  check(await page.locator("#map-list li").count() === 1, "the map stays in the browser");
  const slugs = await page.locator("#account-list .map-title").evaluateAll((all) => all.map((a) => a.getAttribute("href").split("/").pop()));
  check(slugs.includes("meine-skills-2"), "the account has the copy: " + slugs.join(", "));
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("it-skills-map/")).forEach((k) => localStorage.removeItem(k)));
}));

test("a share link opens the map read-only in a second browser, and the reader follows the owner by polling", asOwner(async (s, check) => {
  const page = s.page;
  await go(page, state.testMap.url);
  await mapReady(page);
  await openShare(page);
  check(await page.locator('#share-dialog input[name=share-visibility][value=private]').isChecked(), "a new map is private");
  check(await page.inputValue("#share-page-url") === `${S.base}/${handle}/testdaten`, "the dialog shows the public address /<handle>/<slug>");
  if (S.domain) check(await page.inputValue("#share-subdomain-url") === `${subdomainOrigin(handle)}/testdaten`, "and the address on the subdomain");
  await page.click("#share-create");
  await page.waitForSelector("#share-link-url", { timeout: 10000 });
  state.shareUrl = await page.inputValue("#share-link-url");
  check(new RegExp("^" + S.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/s/[A-Za-z0-9_-]{20,}$").test(state.shareUrl), "a new link: " + state.shareUrl.replace(/\/s\/.*/, "/s/…"));
  check(await page.locator('#share-dialog input[name=share-visibility][value=link]').isChecked(), "a link makes the map shared by link");
  await page.locator("#share-link-url + button").click();
  await page.waitForTimeout(200);
  check(await page.evaluate(() => navigator.clipboard.readText()) === state.shareUrl, "Kopieren puts the link on the clipboard");
  check(/^Link vom \d{2}\.\d{2}\.\d{4}/.test(await page.locator("#share-link-created").innerText()) && await page.locator("#share-renew").isVisible() && await page.locator("#share-create").count() === 0,
    "the dialog shows the one link with its date, and the button for a new link");
  await page.click("#share-close");

  const r = await site(browser_);
  try {
    await go(r.page, state.shareUrl);
    await mapReady(r.page, { owner: false, heading: "9 Kenntnisse in 3 Bereichen" });
    const v = await r.page.evaluate(() => ({ h2: document.querySelector("#panel h2").textContent, cfg: !document.getElementById("cfg").hidden || !document.getElementById("cfg-show").hidden,
      exp: !!document.getElementById("file-export"), share: !!document.getElementById("share-open"), add: document.querySelectorAll("#panel .add, #panel [data-act^='new'], #panel [data-act^='edit']").length,
      note: (document.getElementById("reader-note") || {}).textContent, title: document.getElementById("title").textContent }));
    check(v.h2 === "9 Kenntnisse in 3 Bereichen" && v.title === "Testdaten", "the reader sees the map: " + v.h2);
    check(!v.cfg && !v.exp && !v.share && v.add === 0, "and no write controls: " + JSON.stringify(v));
    check(v.note === `Map von ${handle} · nur lesen`, "the header names the owner: " + v.note);
    const refused = await r.page.evaluate(async () => { try { await (await runtime.db()).collection("areas").doc("x").set({ name: "X" }); return "written"; } catch (error) { return error.code; } });
    check(refused === "permission_denied", "the runtime of a reader refuses a write: " + refused);

    // The owner renames an area; the reader sees it without a reload.
    await page.locator("#areas .chip", { hasText: "Daten" }).click(); await page.waitForTimeout(150);
    await clickPanel(page, "Bereich bearbeiten");
    await page.fill("#cf-name", "Daten & Analyse");
    await submitForm(page);
    await saved(page);
    const t0 = Date.now();
    const seen = await r.page.waitForFunction(() => [...document.querySelectorAll("#areas .chip")].some((c) => c.textContent === "Daten & Analyse"), null, { timeout: 15000 }).then(() => true, () => false);
    check(seen, `the reader sees the new name through polling, after ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    // The owner revokes the link with a new one: the next poll of the reader says so, and the link opens nothing any
    // more.
    r.allow = [/status of 404/];
    await openShare(page);
    check(await page.inputValue("#share-link-url") === state.shareUrl, "the dialog shows the same link again");
    await page.click("#share-renew");
    await page.click("#share-renew-yes");
    await page.waitForFunction((old) => { const x = document.getElementById("share-link-url"); return x && x.value !== old; }, state.shareUrl, { timeout: 10000 });
    check(true, "the owner revokes the link");
    await page.click("#share-close");
    check(await waitAlert(r.page, "nicht mehr freigegeben"), "the reader gets a message: " + await alertText(r.page));
    const again = await r.page.goto(state.shareUrl);
    check(again.status() === 404, "the revoked link gives 404: " + again.status());
    clean(check, r, " (reader)");
  } finally { await r.context.close(); }
}));

test("two tabs of the owner: a hidden tab does not poll, and its stale write is a conflict with a clear message", asOwner(async (s, check) => {
  const a = s.page, b = await s.context.newPage();
  await go(a, state.testMap.url); await mapReady(a);
  await go(b, state.testMap.url); await mapReady(b);
  await b.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  const polls = () => s.requests.filter((x) => x.includes("/docs?since=")).length;
  await a.close();
  const before = polls();
  await b.waitForTimeout(7000);
  check(polls() === before, `the hidden tab asked the server ${polls() - before} times in 7 s`);
  const c = await s.context.newPage();
  await go(c, state.testMap.url); await mapReady(c);
  const area = (await serverDocs(c, state.testMap.api)).find((d) => d.collection === "areas" && d.id === "ai").data;
  const write = (page, name) => page.evaluate(async ([x, n]) => { try { await (await runtime.db()).collection("areas").doc("ai").set({ ...x, name: n }); return "ok"; } catch (error) { return error.code; } }, [area, name]);
  check(await write(c, "KI aus Tab A") === "ok", "tab A writes the area");
  s.allow = [/status of 409/];
  check(await write(b, "KI aus Tab B") === "conflict", "the stale tab B gets a conflict");
  check((await alertText(b)).includes("Schreibkonflikt: Diese Map wurde inzwischen an anderer Stelle geändert"), "and a German message: " + await alertText(b));
  await b.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  const shows = await b.waitForFunction(() => [...document.querySelectorAll("#areas .chip")].some((x) => x.textContent === "KI aus Tab A"), null, { timeout: 10000 }).then(() => true, () => false);
  check(shows, "visible again, tab B shows the change of tab A");
  check((await serverDocs(c, state.testMap.api)).find((d) => d.id === "ai" && d.collection === "areas").data.name === "KI aus Tab A", "the server kept the change of tab A");
  await b.close();
  s.page = c;
}));

test("the messages of the runtime: no connection, a limit of the server, an ended session with the way back", asOwner(async (s, check) => {
  const page = s.page;
  await go(page, state.testMap.url); await mapReady(page);
  s.allow = [/status of 413/, /status of 401/, /ERR_INTERNET_DISCONNECTED/];
  await s.context.setOffline(true);
  check(await waitAlert(page, "Keine Verbindung zum Server."), "offline: " + await alertText(page));
  await s.context.setOffline(false);
  const back = await page.waitForFunction(() => !(document.getElementById("runtime-alert") || { textContent: "" }).textContent.includes("Keine Verbindung"), null, { timeout: 15000 }).then(() => true, () => false);
  check(back, "online again, the message goes away");
  const big = await page.evaluate(async () => { try { await (await runtime.db()).collection("notes").doc("big").set({ text: "x".repeat(300 * 1024) }); return "ok"; } catch (error) { return error.code; } });
  check(big === "quota_exceeded", "a document above the limit is refused: " + big);
  check((await alertText(page)).includes("Grenze des Servers: Ein Dokument darf höchstens 256 KB haben. Die letzte Änderung ist nicht gespeichert."), "with the limit in the message: " + await alertText(page));
  await s.context.clearCookies();
  await page.locator("#areas .chip", { hasText: "Entwicklung" }).click(); await page.waitForTimeout(150);
  await clickPanel(page, "Bereich bearbeiten");
  await page.fill("#cf-name", "Entwicklung neu");
  await submitForm(page);
  check(await waitAlert(page, "Deine Sitzung ist abgelaufen."), "an ended session: " + await alertText(page));
  check((await page.locator("#save-state").innerText()).startsWith("Nicht gespeichert"), "the save state says so too: " + await page.locator("#save-state").innerText());
  const login = page.locator("#runtime-alert a", { hasText: "Neu anmelden" });
  const href = await login.getAttribute("href");
  check(href === `${S.base}/account?next=${encodeURIComponent(`/${handle}/testdaten`)}`, "with a link to sign in again: " + href);
  await login.click();
  await page.waitForURL(/\/account\?next=/);
  await page.waitForFunction(() => !document.getElementById("signed-out").hidden, null, { timeout: 10000 });
  await page.fill("#login input[name=email]", account.email);
  await page.fill("#login input[name=password]", account.password);
  await page.click("#login button[type=submit]");
  await page.waitForURL(state.testMap.url, { timeout: 10000 });
  await mapReady(page);
  check(page.url() === state.testMap.url && await page.locator("#share-open").isVisible(), "after the login the owner is back on the map");
  check((await page.locator("#areas .chip").allInnerTexts()).includes("Entwicklung"), "the change during the ended session is not stored");
}));

// Screenshots for the review, light and dark, at 1400 × 900 and 390 × 844: the start page of the account, the map of
// the owner with "Teilen", and the map of a reader.
test("screenshots of the start page, the dialog Teilen and a reader, and no sideways scroll on a phone", asOwner(async (s, check) => {
  fs.mkdirSync(OUT, { recursive: true });
  const page = s.page;
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  for (const [w, h] of [[1400, 900], [390, 844]]) for (const scheme of ["light", "dark"]) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await go(page, "/");
    await page.waitForFunction(() => document.querySelectorAll("#account-list li").length > 0, null, { timeout: 10000 });
    await page.waitForTimeout(400);
    if (w < 500) check(await noSideScroll(), `${scheme}: the start page has no sideways scroll at ${w} px`);
    await page.screenshot({ path: path.join(OUT, `start-account-${scheme}-${w}x${h}.png`) });
    await go(page, state.testMap.url); await mapReady(page);
    await openShare(page);
    await page.waitForTimeout(300);
    if (w < 500) check(await page.evaluate(() => { const d = document.getElementById("share-dialog").getBoundingClientRect(); return d.left >= 0 && d.right <= window.innerWidth; }), `${scheme}: the dialog Teilen fits at ${w} px`);
    await page.screenshot({ path: path.join(OUT, `share-${scheme}-${w}x${h}.png`) });
    await page.click("#share-close");
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  const link = await page.evaluate(async (id) => (await (await fetch("/api/maps/" + id + "/shares", { method: "POST", headers: { "X-Requested-With": "it-skills" } })).json()).url, state.testMap.api.split("/").pop());
  const r = await site(browser_);
  try {
    for (const [w, h] of [[1400, 900], [390, 844]]) {
      await r.page.setViewportSize({ width: w, height: h });
      await go(r.page, link);
      await mapReady(r.page, { owner: false, heading: "9 Kenntnisse in 3 Bereichen" });
      if (w < 500) check(await r.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `the reader map has no sideways scroll at ${w} px`);
      await r.page.screenshot({ path: path.join(OUT, `reader-light-${w}x${h}.png`) });
    }
    clean(check, r, " (reader)");
  } finally { await r.context.close(); }
  check(fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).length >= 10, "ten screenshots in tests/server/out/");
}));

// Embedding. Two pages of other sites (hostSite) frame a map of the owner, like a CV page or the page of a team.
// A small server on 127.0.0.1 with a free port: one more site, with pages that the test writes.
function hostSite() {
  const pages = new Map();
  const server = http.createServer((request, response) => {
    const html = pages.get(new URL(request.url, "http://127.0.0.1").pathname);
    response.writeHead(html === undefined ? 404 : 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html === undefined ? "" : html);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const origin = "http://127.0.0.1:" + server.address().port;
    done({
      origin,
      // A page with the given body above a long block, so that the page can scroll.
      show(name, body) {
        pages.set("/" + name, `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Lebenslauf</title></head>`
          + `<body style="margin:0;font-family:sans-serif"><h1 style="margin:8px">Lebenslauf</h1>${body}<div style="height:1600px"></div></body></html>`);
        return origin + "/" + name;
      },
      close: () => new Promise((closed) => { server.closeAllConnections(); server.close(closed); }),
    });
  }));
}
let hosts = null;
const hostSites = async () => hosts || (hosts = await Promise.all([hostSite(), hostSite()]));
const frameTag = (src, id = "map-frame", style = "width:100%;aspect-ratio:16/10;border:0") => `<iframe id="${id}" src="${src.replace(/&/g, "&amp;")}" title="Skill-Map" style="${style}"></iframe>`;
// The frame of a page and whether it shows a map page: a frame that the browser blocks shows its error page instead.
async function frameOf(page, selector = "iframe") {
  const frame = await (await page.waitForSelector(selector)).contentFrame();
  await frame.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
  const shown = await frame.evaluate(() => !!document.getElementById("map")).catch(() => false);
  return { frame, shown };
}
const frameReady = (frame, heading = "9 Kenntnisse in 3 Bereichen") => frame.waitForFunction((h) => { const x = document.querySelector("#panel h2"); return !!x && x.textContent === h; }, heading, { timeout: 15000 }).then(() => true, () => false);
// A point of an element in the frame, in the coordinates of the page around it.
async function framePoint(page, frame, find) {
  const box = await (await page.$("iframe")).boundingBox();
  const p = await frame.evaluate(find);
  return { x: box.x + p.x, y: box.y + p.y };
}
const nodeCentre = (id) => `(() => { const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__.id === ${JSON.stringify(id)});
  const b = g.querySelector("circle.hit").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`;
const mapCentre = () => { const b = document.getElementById("map").getBoundingClientRect(); return { x: b.x + b.width * 0.3, y: b.y + b.height * 0.5 }; };
const zoomK = (frame) => frame.evaluate(() => d3.zoomTransform(document.getElementById("map")).k);
const FRAME_ERRORS = [/Refused to (frame|display)/, /frame-ancestors/, /status of 404/];
// The map of the embed tests, imported for this test run and deleted at its end.
const embedMap = { id: null, slug: null, url: null, code: null };
const embedApi = (page, body) => page.evaluate(async ([id, b]) => (await fetch("/api/maps/" + id, { method: "PATCH", headers: { "X-Requested-With": "it-skills", "Content-Type": "application/json" }, body: JSON.stringify(b) })).json(), [embedMap.id, body]);

test("embed: Teilen says why a private map cannot be embedded and gives the code of a public map with its options", asOwner(async (s, check) => {
  const page = s.page;
  await go(page, "/");
  const created = await page.evaluate(async (file) => (await (await fetch("/api/maps/import", { method: "POST", headers: { "X-Requested-With": "it-skills", "Content-Type": "application/json" }, body: JSON.stringify(file) })).json()),
    { ...STAGE_A_FILE, title: "Eingebettete Map" });
  Object.assign(embedMap, { id: created.id, slug: created.slug, url: created.pageUrl });
  check(created.embed && created.embed.allow === "all" && created.embed.url === null, "a new map lets every site embed it, but has no embed address while it is private: " + JSON.stringify(created.embed));
  await go(page, embedMap.url); await mapReady(page);
  await openShare(page);
  check((await page.locator("#embed-section h3").innerText()) === "Einbetten", "the dialog Teilen has the section Einbetten");
  check((await page.locator("#embed-private").innerText()).startsWith("Eine private Map lässt sich nicht einbetten, denn nur du darfst sie sehen."), "a private map says why it cannot be embedded");
  check(await page.locator("#embed-public").isVisible() && await page.locator("#embed-link").isVisible() && await page.locator("#embed-code").count() === 0, "and offers to share it, without a code");
  await page.click("#embed-public");
  await page.waitForSelector("#embed-code", { timeout: 10000 });
  check(await page.locator('#share-dialog input[name=share-visibility][value=public]').isChecked(), "Öffentlich machen makes the map public");
  const plain = `<iframe src="${S.base}/e/${handle}/${embedMap.slug}?lang=de" title="Skill-Map: Eingebettete Map" loading="lazy" style="width:100%;aspect-ratio:16/10;min-height:400px;border:0"></iframe>`;
  check(await page.inputValue("#embed-code") === plain, "the code is a ready iframe: " + await page.inputValue("#embed-code"));
  check((await page.locator("#embed-help").innerText()).startsWith("So geht es: Kopiere den Code in den HTML-Code deiner Website"), "with a German help text");
  await page.selectOption("#embed-theme", "dark");
  await page.uncheck("#embed-panel");
  const withOptions = await page.inputValue("#embed-code");
  check(withOptions.includes(`/e/${handle}/${embedMap.slug}?theme=dark&amp;panel=0&amp;lang=de"`) && (await page.getAttribute("#embed-preview", "href")).endsWith("?theme=dark&panel=0&lang=de"),
    "theme and panel go into the code and the preview: " + withOptions.replace(/^.*src="([^"]*)".*$/, "$1"));
  await page.selectOption("#embed-theme", "auto");
  await page.check("#embed-panel");
  check(await page.inputValue("#embed-code") === plain, "back to the defaults, the code has no options but the language");
  await page.click("#embed-copy");
  await page.waitForTimeout(200);
  check(await page.evaluate(() => navigator.clipboard.readText()) === plain, "Kopieren puts the code on the clipboard");
  check(await page.locator("#embed-allow input[value=all]").isChecked() && await page.locator("#embed-origins").count() === 0, "every website may embed the map");
  embedMap.code = plain;
  fs.mkdirSync(OUT, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator("#embed-section").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, `embed-share-${scheme}-1400x900.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.click("#share-close");
}));

test("embed: a page of another site frames the public map read-only, without cookies, and the frame follows the owner", asOwner(async (s, check) => {
  if (!embedMap.code) throw new Error("no embed code (the test before failed)");
  const [A] = await hostSites();
  const cv = A.show("cv", embedMap.code);
  const r = await site(browser_, [A.origin]);
  r.allow = FRAME_ERRORS;
  const responses = [];
  r.context.on("response", (response) => responses.push(response));
  try {
    await go(r.page, cv);
    const { frame, shown } = await frameOf(r.page);
    check(shown && await frameReady(frame), "the frame shows the map: " + frame.url());
    const v = await frame.evaluate(() => ({
      embed: document.documentElement.classList.contains("embed"), cfg: !document.getElementById("cfg").hidden || !document.getElementById("cfg-show").hidden,
      tools: ["share-open", "file-export", "file-open", "account-link", "reader-note"].filter((id) => document.getElementById(id)),
      edit: document.querySelectorAll("#panel .add, #panel [data-act^='new'], #panel [data-act^='edit'], #panel [data-act='export-map|']").length,
      links: [...document.querySelectorAll("a")].map((a) => ({ text: a.textContent, href: a.href, target: a.target, rel: a.rel })),
      hidden: ["subtitle", "projects-btn", "timebar", "save-state"].filter((id) => getComputedStyle(document.getElementById(id)).display !== "none"),
      shown: ["q", "zoom-in", "zoom-out", "zoom-fit", "panel"].filter((id) => getComputedStyle(document.getElementById(id)).display === "none"),
      chips: document.querySelectorAll("#areas .chip").length, title: document.getElementById("title").textContent, cookie: document.cookie }));
    check(v.embed && v.title === "Eingebettete Map", "the embed view of the map: " + v.title);
    check(!v.cfg && !v.tools.length && v.edit === 0, "no write controls, no force menu, no account controls: " + JSON.stringify(v.tools));
    check(v.links.length === 1 && v.links[0].text === "Auf it-skills.localhost öffnen" && v.links[0].href === embedMap.url && v.links[0].target === "_blank" && v.links[0].rel === "noopener",
      "the only link opens the full map in a new tab: " + JSON.stringify(v.links));
    check(!v.hidden.length && !v.shown.length && v.chips === 3, "it shows the search, zoom, the area filter and the panel, and hides the rest: " + JSON.stringify(v));
    const refused = await frame.evaluate(async () => { try { await (await runtime.db()).collection("areas").doc("x").set({ name: "X" }); return "written"; } catch (error) { return error.code; } });
    check(refused === "permission_denied", "its runtime refuses a write: " + refused);
    await frame.fill("#q", "python");
    await frame.waitForTimeout(150);
    check(await frame.locator("#map .node.match").count() === 1, "the search finds Python");
    await frame.fill("#q", "");
    await frame.waitForTimeout(150);
    const python = await framePoint(r.page, frame, nodeCentre("s:Python"));
    await r.page.mouse.click(python.x, python.y);
    await frame.waitForTimeout(150);
    check(await frame.locator("#panel h2").innerText() === "Python" && (await frame.locator("#panel").textContent()).includes("Eingesetzt bei"), "a click on a skill shows its details");
    await frame.locator("#areas .chip", { hasText: "Daten" }).click();
    await frame.waitForTimeout(150);
    check(await frame.locator("#panel h2").innerText() === "Daten", "a click on an area chip shows the area");
    check(v.cookie === "" && (await r.context.cookies()).length === 0, "the frame sets no cookie");
    const ours = responses.filter((x) => x.url().startsWith(S.base));
    const cookies = (await Promise.all(ours.map((x) => x.headerValue("set-cookie")))).filter(Boolean);
    check(ours.length > 3 && cookies.length === 0, `no answer of the site sets a cookie (${ours.length} answers)`);
    const doc = ours.find((x) => x.url().split("?")[0] === `${S.base}/e/${handle}/${embedMap.slug}`);
    const policy = doc ? (await doc.headerValue("content-security-policy")) || "" : "";
    check(/; frame-ancestors \*$/.test(policy) && policy.includes("script-src 'self';") && await doc.headerValue("x-frame-options") === null, "the embed view allows every site to frame it");

    // The mouse wheel scrolls the page around the frame; Ctrl and the wheel zoom the map at the normal step.
    await frame.click("#zoom-fit");
    await frame.waitForTimeout(150);
    const k0 = await zoomK(frame), centre = await framePoint(r.page, frame, mapCentre);
    await r.page.mouse.move(centre.x, centre.y);
    await r.page.mouse.wheel(0, 300);
    await r.page.waitForTimeout(300);
    const scrolled = await r.page.evaluate(() => scrollY), k1 = await zoomK(frame);
    check(scrolled > 0 && Math.abs(k1 - k0) < 1e-9, `the wheel scrolls the page (${scrolled} px) and leaves the zoom (${k0.toFixed(3)} → ${k1.toFixed(3)})`);
    check(await frame.locator("#embed-wheel.on").count() === 1 && (await frame.locator("#embed-wheel").innerText()) === "Strg + Mausrad zum Zoomen", "and the map says how to zoom");
    await r.page.evaluate(() => scrollTo(0, 0));
    await r.page.waitForTimeout(200);
    const again = await framePoint(r.page, frame, mapCentre);
    await r.page.mouse.move(again.x, again.y);
    await r.page.keyboard.down("Control");
    await r.page.mouse.wheel(0, -100);
    await r.page.keyboard.up("Control");
    await r.page.waitForTimeout(300);
    const k2 = await zoomK(frame), still = await r.page.evaluate(() => scrollY);
    check(k2 / k1 > 1.1 && k2 / k1 < 1.2 && still === 0, `Ctrl and the wheel zoom the map by the step of its own page: × ${(k2 / k1).toFixed(3)}, and the page stays`);
    await r.page.screenshot({ path: path.join(OUT, "embed-host-light-1400x900.png") });

    // The owner renames an area on his map page; the frame shows it without a reload.
    const page = s.page;
    await go(page, embedMap.url); await mapReady(page);
    const api = await page.evaluate(() => window.IT_SKILLS_SERVER.api);
    const area = (await serverDocs(page, api)).find((d) => d.collection === "areas" && d.id === "data").data;
    const written = await page.evaluate(async (x) => { try { await (await runtime.db()).collection("areas").doc("data").set({ ...x, name: "Daten live" }); return "ok"; } catch (error) { return error.code; } }, area);
    const t0 = Date.now();
    const seen = await frame.waitForFunction(() => [...document.querySelectorAll("#areas .chip")].some((c) => c.textContent === "Daten live"), null, { timeout: 15000 }).then(() => true, () => false);
    check(written === "ok" && seen, `the frame shows the change of the owner through polling, after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    clean(check, r, " (reader on another site)");
  } finally { await r.context.close(); }

  // The signed-in owner: the frame and the embed address send his session nowhere, and he gets the reader view.
  s.also.push(A.origin);
  s.allow = FRAME_ERRORS;
  const own = await s.context.newPage();
  try {
    const requests = [];
    own.on("request", (request) => { if (request.url().includes("/api/")) requests.push(request); });
    await go(own, cv);
    const { frame, shown } = await frameOf(own);
    check(shown && await frameReady(frame) && await frame.locator("#share-open").count() === 0 && await frame.locator("#cfg").isHidden(), "in the browser of the owner the frame shows the read-only view");
    await go(own, `/e/${handle}/${embedMap.slug}`);
    await own.waitForFunction(() => document.querySelector("#panel h2") && document.querySelector("#panel h2").textContent === "9 Kenntnisse in 3 Bereichen", null, { timeout: 15000 });
    const mode = await own.evaluate(() => [window.IT_SKILLS_SERVER.mode, !!document.getElementById("share-open"), !!document.getElementById("file-export")]);
    check(mode[0] === "embed" && !mode[1] && !mode[2], "the embed address opened by the owner is the reader view too: " + JSON.stringify(mode));
    const sent = await Promise.all(requests.map(async (x) => !!(await x.allHeaders()).cookie));
    check(requests.length >= 2 && sent.every((x) => !x), `no request of the embed view sends the session cookie (${requests.length} requests)`);
    const control = await own.evaluate(async () => (await (await fetch("/api/auth/session", { credentials: "same-origin" })).json()).signedIn);
    check(control === true, "while the owner is still signed in on the site");
  } finally { await own.close(); s.allow = []; }
}));

test("embed: theme and panel options, and the details over the map without the panel or in a narrow frame", withSite(async (s, check) => {
  if (!embedMap.code) throw new Error("no embed code (an earlier test failed)");
  const [A] = await hostSites();
  s.also.push(A.origin);
  s.allow = FRAME_ERRORS;
  const page = s.page, src = `${S.base}/e/${handle}/${embedMap.slug}`;
  await go(page, A.show("dark", frameTag(src + "?theme=dark&panel=0")));
  let { frame, shown } = await frameOf(page);
  check(shown && await frameReady(frame), "the frame with theme=dark and panel=0 shows the map");
  const look = (f) => f.evaluate(() => ({ theme: document.documentElement.dataset.theme || "auto", bg: getComputedStyle(document.body).backgroundColor,
    side: getComputedStyle(document.querySelector(".side")).display, over: document.documentElement.classList.contains("embed-over"), h2: document.querySelector("#panel h2").textContent }));
  let v = await look(frame);
  check(v.theme === "dark" && v.bg === "rgb(15, 21, 23)", "theme=dark: the dark colors " + v.bg);
  check(v.over && v.side === "none", "panel=0: the map fills the frame, without the panel");
  const go1 = await framePoint(page, frame, nodeCentre("s:Go"));
  await page.mouse.click(go1.x, go1.y);
  await frame.waitForTimeout(200);
  v = await look(frame);
  check(v.side !== "none" && v.h2 === "Go", "a click on a skill shows its details over the map: " + v.h2);
  await page.screenshot({ path: path.join(OUT, "embed-dark-panel0-1400x900.png") });
  await frame.click("#embed-close");
  await frame.waitForTimeout(200);
  v = await look(frame);
  check(v.side === "none", "the close button hides them again");

  await page.emulateMedia({ colorScheme: "dark" });
  await go(page, A.show("light", frameTag(src + "?theme=light")));
  ({ frame, shown } = await frameOf(page));
  v = shown && await frameReady(frame) ? await look(frame) : {};
  check(v.theme === "light" && v.bg === "rgb(243, 246, 245)" && !v.over && v.side !== "none", "theme=light keeps the light colors on a dark system, and the panel stands beside the map: " + JSON.stringify(v));
  await go(page, A.show("auto", frameTag(src + "?theme=nonsense&panel=yes")));
  ({ frame, shown } = await frameOf(page));
  v = shown && await frameReady(frame) ? await look(frame) : {};
  check(v.theme === "auto" && v.bg === "rgb(15, 21, 23)" && !v.over, "an unknown value means the default: the colors of the system and the panel");

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, A.show("phone", embedMap.code));
  ({ frame, shown } = await frameOf(page));
  check(shown && await frameReady(frame), "a narrow frame shows the map");
  v = await look(frame);
  check(v.over && v.side === "none", "a frame of 390 px puts the details over the map");
  const python = await framePoint(page, frame, nodeCentre("s:Python"));
  await page.mouse.click(python.x, python.y);
  await frame.waitForTimeout(200);
  v = await look(frame);
  const fits = await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(v.side !== "none" && v.h2 === "Python" && fits, "and opens them on a click, without sideways scroll");
  await page.screenshot({ path: path.join(OUT, "embed-light-390x844.png") });
}));

// English is the language of a first visit (i18n/README.md). A context without the choice of German, with the session of
// the owner, opens the account page, a map of the owner and the embed view of his public map. Each sets <html lang="en">
// and logs no missing text (clean fails on every console error). germanIn looks only at parts without map content.
// A page also follows the language of the account in its data block, so the account of the owner is English for this
// test, and gets its language back at the end.
test("English: the account page, a map on the server and the embed view open in English, without a missing text", asOwner(async (s, check) => {
  if (!embedMap.slug) throw new Error("no public map to embed (an earlier test failed)");
  const before = (await apiGet(s.page, "/api/account")).body || {};
  const english = await apiCall(s.page, "PATCH", "/api/account", { language: "en" });
  if (english.status !== 200) throw new Error("PATCH /api/account with en: " + english.status);
  const e = await site(browser_, [], { language: null });
  // The titles of maps and teams are content: a map made in German keeps its German title.
  const view = (selector, content = "") => e.page.evaluate(([sel, own]) => ({ lang: document.documentElement.lang, language: SkillMapI18n.language, title: document.title,
    text: [...document.querySelectorAll(sel)].map((el) => [...(own ? el.querySelectorAll(own) : [])].reduce((text, part) => text.split(part.innerText).join(""), el.innerText)).join("\n") }), [selector, content]);
  try {
    await e.context.addCookies(await s.context.cookies());
    await go(e.page, "/account");
    await kontoReady(e.page);
    await e.page.waitForFunction(() => document.querySelectorAll("#maps > li").length > 0, null, { timeout: 10000 });
    const account = await view("main", ".title");
    check(account.lang === "en" && account.language === "en" && account.title === textOf("account.pageTitle") && account.text.includes(textOf("account.heading")),
      "the account page: lang en and its English texts: " + account.lang + ", " + account.title);
    check(germanIn(account.text).length === 0, "the account page shows no German interface text: " + germanIn(account.text).join(" | "));

    await go(e.page, state.itMap.url);
    await e.page.waitForFunction((saved) => document.getElementById("save-state").textContent === saved && document.getElementById("cfg-groups").children.length > 0, englishOf("Gespeichert"), { timeout: 15000 });
    const map = await view("header .tools, #cfg, #timebar .time-head, #downloads");
    check(map.lang === "en" && map.text.includes(textOf("menu.title")), "a map of the owner on the server: lang en and the English force menu");
    check(germanIn(map.text).length === 0, "the map on the server shows no German interface text: " + germanIn(map.text).join(" | "));

    await go(e.page, `${S.base}/e/${handle}/${embedMap.slug}`);
    await e.page.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 });
    await e.page.waitForTimeout(300);
    const embed = await view("body");
    check(embed.lang === "en" && embed.language === "en", "the embed view of the public map: lang en");
  } finally {
    clean(check, e, " (English)");
    await e.context.close();
    if (before.language) await apiCall(s.page, "PATCH", "/api/account", { language: before.language });
  }
}));

// A static page of the server has no data block and asks the API nothing (finding D2 of the final review). The choice of
// the language there goes to the account on the next page of the app. A context without the language of the tests
// before every load keeps what the pages chose; it has the session of the owner.
test("the language of a static page: a choice on the imprint reaches the account on the next page of the app, and the imprint asks the API nothing", asOwner(async (s, check) => {
  const before = (await apiGet(s.page, "/api/account")).body || {};
  const e = await site(browser_, [], { language: null });
  const page = e.page;
  const mark = () => page.evaluate(() => localStorage.getItem("skill-map-language-account"));
  const language = () => page.evaluate(() => ({ language: SkillMapI18n.language, source: SkillMapI18n.source }));
  try {
    check(before.language === "de", "the account of the owner is German: " + before.language);
    await e.context.addCookies(await s.context.cookies());
    await go(page, "/");
    await page.waitForLoadState("load");
    check(same(await language(), { language: "de", source: "account" }) && await mark() === "signed-in", "the start page shows the German account and notes it");
    await go(page, "/imprint.html");
    await page.waitForLoadState("load");
    const asked = e.requests.length;
    await page.selectOption("[data-language-picker] select", "en");
    await page.locator(".language-note:not([hidden]) .language-reload").waitFor({ timeout: 5000 });
    const loaded = page.waitForEvent("load");
    await page.click(".language-note .language-reload");
    await loaded;
    const fromImprint = e.requests.slice(asked).filter((r) => r.includes("/api/"));
    check(same(await language(), { language: "en", source: "browser" }) && await mark() === "newer" && fromImprint.length === 0,
      "the imprint keeps English as a choice newer than the account, and asks the API nothing: " + (fromImprint.join(", ") || "no request to /api/"));
    check((await apiGet(page, "/api/account")).body.language === "de", "the account is still German");
    await go(page, "/account");
    await kontoReady(page);
    await page.waitForFunction(() => localStorage.getItem("skill-map-language-account") === "signed-in", null, { timeout: 10000 }).catch(() => {});
    check(same(await language(), { language: "en", source: "browser" }) && (await page.locator("h1").first().innerText()) === textOf("account.heading") && await mark() === "signed-in",
      "the account page shows the choice instead of the account and sends it: " + JSON.stringify(await language()));
    check((await apiGet(page, "/api/account")).body.language === "en", "the account is English now");
    await go(page, "/");
    await page.waitForLoadState("load");
    check(same(await language(), { language: "en", source: "account" }), "the next page follows the account again: " + JSON.stringify(await language()));
  } finally {
    clean(check, e, " (the context with the session of the owner)");
    await e.context.close();
    if (before.language) await apiCall(s.page, "PATCH", "/api/account", { language: before.language });
  }
}));

test("embed: other sites cannot frame the full map or the account page, and an origin list allows only its sites", asOwner(async (s, check) => {
  const [A, B] = await hostSites();
  const page = s.page;
  const src = `${S.base}/e/${handle}/${embedMap.slug}`;
  const r = await site(browser_, [A.origin, B.origin]);
  r.allow = FRAME_ERRORS;
  try {
    await go(r.page, A.show("three", frameTag(embedMap.url, "full") + frameTag(S.base + "/account", "konto") + frameTag(src, "map-frame")));
    const full = await frameOf(r.page, "#full"), konto = await frameOf(r.page, "#konto"), embed = await frameOf(r.page, "#map-frame");
    check(!full.shown, "the full map page cannot be framed by another site: " + full.frame.url());
    check(!konto.shown && !(await konto.frame.evaluate(() => !!document.getElementById("login")).catch(() => false)), "nor the account page");
    check(embed.shown && await frameReady(embed.frame), "the embed view can");

    // The owner allows only site A.
    await go(page, embedMap.url); await mapReady(page);
    await openShare(page);
    await page.locator("#embed-allow input[value=origins]").check();
    await page.waitForSelector("#embed-origins", { timeout: 10000 });
    check((await page.locator("#embed-origins-empty").innerText()).startsWith("Noch keine Website in der Liste"), "an empty list says that no other site may embed the map now");
    await page.fill("#embed-origins", "kein gültiger Eintrag");
    await page.click("#embed-save");
    check((await page.locator("#embed-origins-message").innerText()).startsWith("„kein“ ist keine Adresse einer Website."), "a wrong entry gets a message: " + await page.locator("#embed-origins-message").innerText());
    await page.fill("#embed-origins", `${A.origin}/lebenslauf\n${A.origin}`);
    await page.click("#embed-save");
    await page.waitForFunction(() => !document.getElementById("embed-origins-empty"), null, { timeout: 10000 }).catch(() => {});
    const stored = await page.evaluate(async (id) => (await (await fetch("/api/maps/" + id, { cache: "no-store" })).json()).embed, embedMap.id);
    check(stored.allow === "origins" && same(stored.origins, [A.origin]), "the list holds the origin of site A once, without the path: " + JSON.stringify(stored));
    check(await page.inputValue("#embed-origins") === A.origin, "and the dialog shows it");
    await page.click("#share-close");
    await go(r.page, A.show("one", frameTag(src)));
    const onA = await frameOf(r.page);
    check(onA.shown && await frameReady(onA.frame), "site A may frame the map");
    await go(r.page, B.show("one", frameTag(src)));
    const onB = await frameOf(r.page);
    check(!onB.shown, "site B may not: " + onB.frame.url());

    // Back to every site: B may frame it again, and the list stays for later.
    await openShare(page);
    await page.locator("#embed-allow input[value=all]").check();
    await page.waitForFunction(() => !document.getElementById("embed-origins"), null, { timeout: 10000 });
    await page.click("#share-close");
    await go(r.page, B.show("again", frameTag(src)));
    const back = await frameOf(r.page);
    check(back.shown && await frameReady(back.frame), "with every website allowed again, site B may frame the map");
    const kept = await page.evaluate(async (id) => (await (await fetch("/api/maps/" + id, { cache: "no-store" })).json()).embed, embedMap.id);
    check(kept.allow === "all" && same(kept.origins, [A.origin]), "and the list stays for the next switch");
    clean(check, r, " (reader on other sites)");
  } finally { await r.context.close(); }
}));

test("embed: a share link embeds a map shared by link, a revoked link stops it, and a private map has no embed view", asOwner(async (s, check) => {
  const [A] = await hostSites();
  const page = s.page;
  await go(page, embedMap.url); await mapReady(page);
  await openShare(page);
  await page.locator('#share-dialog input[name=share-visibility][value=link]').check();
  await page.waitForSelector("#embed-link", { timeout: 10000 });
  check((await page.locator("#embed-section").innerText()).includes("Die Map ist per Link geteilt, hat aber noch keinen Link. Der Code zum Einbetten nutzt ihren Link zum Lesen."), "a map shared by link without a link asks for its read link");
  await page.click("#embed-link");
  await page.waitForSelector("#embed-code", { timeout: 10000 });
  const code = await page.inputValue("#embed-code");
  const token = (code.match(/\/e\/s\/([A-Za-z0-9_-]+)\?lang=de"/) || [])[1];
  check(!!token && await page.inputValue("#share-link-url") === `${S.base}/s/${token}`, "Link erstellen gives the read link and its code");
  check((await page.locator("#embed-link-note").innerText()).includes("Widerrufst du den Link oben und erzeugst einen neuen, zeigt der Rahmen die Map nicht mehr."), "and says that the link is readable on the other site");
  await page.click("#share-close");
  const r = await site(browser_, [A.origin]);
  r.allow = FRAME_ERRORS;
  try {
    const cv = A.show("shared", code);
    await go(r.page, cv);
    const { frame, shown } = await frameOf(r.page);
    check(shown && await frameReady(frame), "the frame of the share link shows the map");
    check(await frame.evaluate(() => document.querySelector("a.embed-open").href) === `${S.base}/s/${token}`, "and links to the full map of the link");
    const publicEmbed = await r.context.newPage();
    const answer = await publicEmbed.goto(`${S.base}/e/${handle}/${embedMap.slug}`);
    check(answer.status() === 404 && (await publicEmbed.locator("body").innerText()).includes("Diese Map gibt es nicht"), "a map shared by link has no public embed address: " + answer.status());
    await publicEmbed.close();
    // A new link revokes the link of the frame. The second step of the dialog says so first.
    await openShare(page);
    check(await page.inputValue("#embed-code") === code, "the dialog gives the same code again");
    await page.click("#share-renew");
    check((await page.locator("#share-renew-ask").innerText()).includes("auch nicht in Rahmen auf anderen Websites"), "Widerrufen und neuen Link erzeugen first says that frames on other websites stop too");
    await page.click("#share-renew-yes");
    await page.waitForFunction((old) => { const x = document.getElementById("embed-code"); return x && x.value !== old; }, code, { timeout: 10000 });
    const renewed = (await page.inputValue("#embed-code")).match(/\/e\/s\/([A-Za-z0-9_-]+)\?lang=de"/);
    check(!!renewed && renewed[1] !== token && await page.inputValue("#share-link-url") === `${S.base}/s/${renewed[1]}`, "the embed code holds the new link");
    await page.click("#share-close");
    check(await waitAlert(frame, "nicht mehr freigegeben"), "after the revoke, the frame says so at its next poll");
    await go(r.page, cv);
    const again = await frameOf(r.page);
    check((await again.frame.locator("body").innerText()).includes("Diese Map gibt es nicht, oder sie ist nicht mehr freigegeben."), "after a reload, the frame shows that the map is not shared");

    // A private map: no embed view, by its address or by a link.
    const link = await page.evaluate(async (id) => (await (await fetch("/api/maps/" + id + "/shares", { method: "POST", headers: { "X-Requested-With": "it-skills" } })).json()).embedUrl, embedMap.id);
    await embedApi(page, { visibility: "public" });
    const before = await r.page.goto(link);
    check(before.status() === 200, "a link of a public map embeds it");
    await embedApi(page, { visibility: "private" });
    for (const url of [link, `${S.base}/e/${handle}/${embedMap.slug}`]) {
      const response = await r.page.goto(url);
      check(response.status() === 404, `a private map gives 404 at ${url.replace(/\/e\/s\/.*/, "/e/s/…")}`);
    }
    clean(check, r, " (reader on another site)");
  } finally { await r.context.close(); }
  await openShare(page);
  check(await page.locator("#embed-private").isVisible() && await page.locator("#embed-code").count() === 0, "the dialog of the private map shows no code again");
  // The private map keeps its paused link. The embed section shares it by link again instead of making a new link.
  check((await page.locator("#embed-link").innerText()) === "Per Link freigeben" && (await page.locator("#share-link-paused").innerText()).startsWith("Die Map ist privat, deshalb gilt der Link gerade nicht."),
    "a private map with a paused link offers Per Link freigeben, and the dialog says that the link waits");
  const paused = ((await apiGet(page, `/api/maps/${embedMap.id}/shares`)).body.shares || [])[0] || {};
  await page.click("#embed-link");
  await page.waitForSelector("#embed-code", { timeout: 10000 });
  check(!!paused.embedUrl && await page.locator('#share-dialog input[name=share-visibility][value=link]').isChecked() && (await page.inputValue("#embed-code")).includes(`src="${paused.embedUrl}?lang=de"`),
    "Per Link freigeben makes the same link work again, with its code");
  await page.click("#share-close");
  // From the start page, so that no open page of the map polls it after the delete.
  await go(page, "/");
  check(await page.evaluate(async (id) => (await fetch("/api/maps/" + id, { method: "DELETE", headers: { "X-Requested-With": "it-skills" } })).status, embedMap.id) === 204, "the map of the embed tests is deleted");
}));

test("the account page offers the templates of a personal map for a new team map too", asOwner(async (s, check) => {
  const page = s.page, teamHandle = handle + "-team";
  await go(page, "/account");
  await page.waitForFunction(() => !document.getElementById("signed-in").hidden, null, { timeout: 10000 });
  await page.fill("#new-team input[name=name]", "Testteam");
  await page.fill("#new-team input[name=handle]", teamHandle);
  await page.click("#new-team button[type=submit]");
  const item = page.locator("#team-list > li", { hasText: teamHandle });
  await item.waitFor({ timeout: 10000 });
  await item.locator(".actions button", { hasText: "Öffnen" }).click();
  const form = item.locator("form", { hasText: "Neue Map im Team" });
  await form.waitFor({ timeout: 10000 });
  const options = (select) => select.locator("option").evaluateAll((list) => list.map((o) => [o.value, o.textContent]));
  const personal = await options(page.locator("#new-map select[name=template]"));
  const offered = await form.locator("select[name=template]").count() ? await options(form.locator("select[name=template]")) : [];
  check(personal.length > 1 && same(offered, personal), "the form of a new team map offers " + JSON.stringify(offered) + ", the form of a personal map " + JSON.stringify(personal));
  for (const [template, title] of [["default", "Team-Standard"], ["empty", "Team-Leer"]]) {
    await form.locator("input[name=title]").fill(title);
    await form.locator("select[name=template]").selectOption(template, { timeout: 5000 });
    await form.locator("button[type=submit]").click();
    await item.locator(".maps a.title", { hasText: title }).waitFor({ timeout: 10000 });
  }
  const result = await page.evaluate(async (team) => {
    const get = async (path) => (await fetch(path, { cache: "no-store" })).json();
    const { maps } = await get(`/api/teams/${team}/maps`);
    const areas = async (title) => { const m = maps.find((x) => x.title === title); return m ? (await get(`/api/maps/${m.id}/docs`)).docs.filter((d) => d.collection === "areas").length : null; };
    return { standard: await areas("Team-Standard"), empty: await areas("Team-Leer"), template: Object.keys(window.SkillMapTemplates.map("default").collections.areas).length, teams: maps.every((m) => m.ownerType === "team") };
  }, teamHandle);
  check(result.standard === result.template && result.template === 3 && result.teams, `Standardvorlage gives the team map the ${result.template} areas of the default set: ${result.standard}`);
  check(result.empty === 0, "Leer gives an empty team map: " + result.empty + " areas");
  const status = await page.evaluate(async ([team, password]) => (await fetch(`/api/teams/${team}/delete`, { method: "POST",
    headers: { "X-Requested-With": "it-skills", "Content-Type": "application/json" }, body: JSON.stringify({ password }) })).status, [teamHandle, account.password]);
  check(status === 204, "the team goes again: " + status);
}));

test("the account page: a new map from each template, the import of a map file, and all maps as a ZIP file", asOwner(async (s, check) => {
  const page = s.page;
  await go(page, "/account");
  await kontoReady(page);
  // The path address leads (his answer of 2026-10-19 to finding A5). A subdomain is an option of the host, so it is the second address.
  const profile = await page.evaluate(() => { const a = document.getElementById("profile"), b = document.getElementById("profile-site");
    return { href: a.getAttribute("href"), text: a.textContent, site: b.hidden ? null : b.getAttribute("href"), siteText: b.hidden ? null : b.textContent }; });
  check(profile.href === `${S.base}/${handle}` && profile.text === `Deine öffentliche Seite: ${S.base}/${handle}`
    && same([profile.site, profile.siteText], S.domain ? [subdomainOrigin(handle), "Auch unter " + subdomainOrigin(handle)] : [null, null]),
    "the account page leads with the path address, and a subdomain is the second address: " + JSON.stringify(profile));
  const template = await page.evaluate(() => window.SkillMapTemplates.map("default").collections);
  for (const [title, choice, collections] of [["Konto-Leer", "empty", {}], ["Konto-Standard", "default", template]]) {
    await page.fill("#new-map input[name=title]", title);
    await page.selectOption("#new-map select[name=template]", choice);
    const said = await kontoSays(page, () => page.click("#new-map button[type=submit]"));
    check(said.text === `Map „${title}“ angelegt.` && !said.error, `Anlegen with the template ${choice}: ${said.text}`);
    check(await page.locator("#maps > li a.title", { hasText: title }).count() === 1, `the list of the maps shows ${title}`);
    const made = (await apiGet(page, "/api/maps")).body.maps.find((m) => m.title === title);
    kontoMaps[title] = made && made.id;
    const docs = made ? (await apiGet(page, `/api/maps/${made.id}/docs`)).body.docs : [];
    check(!!made && made.visibility === "private" && same(sorted(docsAsCollections(docs)), sorted(collections)),
      `the server holds the private map ${title} with the ${docs.length} documents of the template`);
  }

  await pick(page, "#import input[name=file]", "Konto-Import.it-skills-map.json", JSON.stringify({ ...STAGE_A_FILE, title: "Konto-Import" }));
  const imported = await kontoSays(page, () => page.click("#import button[type=submit]"));
  check(imported.text === "Map „Konto-Import“ importiert." && !imported.error, "Importieren: " + imported.text);
  const maps = (await apiGet(page, "/api/maps")).body.maps;
  const copy = maps.find((m) => m.title === "Konto-Import");
  kontoMaps["Konto-Import"] = copy && copy.id;
  const file = copy ? (await apiGet(page, `/api/maps/${copy.id}/export`)).body : {};
  check(!!copy && copy.visibility === "private" && same(sorted(file.collections), sorted(STAGE_A_FILE.collections)), "the server holds the documents of the file as a new private map");
  check(await page.locator("#maps > li a.title", { hasText: "Konto-Import" }).count() === 1, "and the list shows it");
  s.allow = [/status of 422/];
  await pick(page, "#import input[name=file]", "fremd.json", JSON.stringify({ format: "ein-anderes-format", schema: 1, title: "Fremd", collections: {} }));
  const refused = await kontoSays(page, () => page.click("#import button[type=submit]"));
  check(refused.error && refused.text === "Die Datei hat nicht das Format it-skills-map.", "a file of another format gives an error: " + refused.text);
  check((await apiGet(page, "/api/maps")).body.maps.length === maps.length, "and makes no map");

  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.click("#export-all")]);
  const zip = unzip(fs.readFileSync(await download.path()));
  check(new RegExp(`^it-skills-${handle}-\\d{4}-\\d{2}-\\d{2}\\.zip$`).test(download.suggestedFilename()), "the link gives a ZIP file named after the account: " + download.suggestedFilename());
  const info = JSON.parse(zip["account.json"] || "{}");
  check(info.handle === handle && info.email === account.email, "account.json names the account");
  check(same(Object.keys(zip).sort(), ["account.json", ...maps.map((m) => m.slug + ".json")].sort()) && same((info.maps || []).map((m) => m.file).sort(), maps.map((m) => m.slug + ".json").sort()),
    `one map file for each of the ${maps.length} maps of the account: ${Object.keys(zip).join(", ")}`);
  const differ = [];
  for (const m of maps) {
    const inZip = JSON.parse(zip[m.slug + ".json"] || "{}"), onServer = (await apiGet(page, `/api/maps/${m.id}/export`)).body;
    if (inZip.format !== "it-skills-map" || inZip.title !== m.title || !same(sorted(inZip.collections), sorted(onServer.collections))) differ.push(m.slug);
  }
  check(differ.length === 0, "each map file holds the title and the documents of its map on the server" + (differ.length ? ": not " + differ.join(", ") : ""));
  const entry = (info.maps || []).find((m) => m.slug === "konto-import") || {};
  check(entry.title === "Konto-Import" && entry.visibility === "private" && same(sorted(JSON.parse(zip["konto-import.json"] || "{}").collections), sorted(STAGE_A_FILE.collections)),
    "the imported map is in the ZIP file as the file that went in");
}));

// A map has one read link (his decision of 2026-10-19). The account page shows it at any time to copy again, and a new
// link, which revokes the old one, needs a second step in the page, never a dialog of the browser.
test("the account page: the read link of a map to copy again at any time, and a new link only after a second step", asOwner(async (s, check) => {
  const page = s.page, id = kontoMaps["Konto-Import"];
  if (!id) throw new Error("no map Konto-Import (an earlier test failed)");
  const dialogs = [];
  const onDialog = (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); };
  page.on("dialog", onDialog);
  const row = () => page.locator("#maps > li", { hasText: "Konto-Import" });
  const box = () => row().locator(".shares");
  const field = () => box().locator("input");
  const openBox = async () => { await row().locator(".actions button", { hasText: /^Link$/ }).click(); await box().locator("button").first().waitFor({ timeout: 10000 }); };
  try {
    await go(page, "/account"); await kontoReady(page);
    await openBox();
    check((await box().innerText()).startsWith("Noch kein Link.") && await field().count() === 0, "a map without a link offers to create one: " + (await box().innerText()).split("\n")[0]);
    await box().locator("button", { hasText: "Link erstellen" }).click();
    await field().waitFor({ timeout: 10000 });
    const url = await field().inputValue();
    const listed = (await apiGet(page, `/api/maps/${id}/shares`)).body;
    check(listed.shares.length === 1 && listed.shares[0].url === url && /\/s\/[A-Za-z0-9_-]{20,}$/.test(url), "Link erstellen shows the read link of the map: " + url.replace(/\/s\/.*/, "/s/…"));
    const meta = await row().locator(".meta").innerText();
    check(meta.startsWith("Per Link · ") && meta.endsWith(" · Link zum Lesen") && await row().locator('select[aria-label="Sichtbarkeit"]').inputValue() === "link",
      "the private map is now shared by link, and its line names the link: " + meta);
    check(/^Link vom \d{2}\.\d{2}\.\d{4}/.test(await box().locator(".muted").innerText()), "the box names the date of the link: " + await box().locator(".muted").innerText());
    await box().locator("button", { hasText: "Kopieren" }).click();
    await page.waitForTimeout(200);
    check(await page.evaluate(() => navigator.clipboard.readText()) === url, "Kopieren puts the link on the clipboard");

    await go(page, "/account"); await kontoReady(page);
    await openBox();
    check(await field().inputValue() === url, "after a reload, the box shows the same link again");
    const paused = await kontoSays(page, () => row().locator('select[aria-label="Sichtbarkeit"]').selectOption("private"));
    await box().locator("input").waitFor({ timeout: 10000 });
    check(paused.text === "Sichtbarkeit: Privat." && (await box().innerText()).includes("Die Map ist privat, deshalb gilt der Link gerade nicht.") && await field().inputValue() === url
      && (await row().locator(".meta").innerText()).endsWith(" · Link zum Lesen pausiert"), "private pauses the link, and the box still shows it");
    await kontoSays(page, () => row().locator('select[aria-label="Sichtbarkeit"]').selectOption("link"));
    await box().locator("input").waitFor({ timeout: 10000 });

    const renew = box().locator("button", { hasText: /^Widerrufen und neuen Link erzeugen$/ });
    const ask = box().locator(".ask");
    check(await ask.isHidden(), "the second step is hidden at first");
    await renew.click();
    check(await ask.isVisible() && await renew.isHidden() && (await ask.innerText()).includes("Der aktuelle Link gilt sofort nicht mehr, auch nicht in Rahmen auf anderen Websites."),
      "Widerrufen und neuen Link erzeugen asks first and names the frames on other websites: " + (await ask.innerText()).split("\n")[0]);
    await ask.locator("button", { hasText: "Abbrechen" }).click();
    check(await ask.isHidden() && await renew.isVisible() && (await apiGet(page, `/api/maps/${id}/shares`)).body.shares[0].url === url, "Abbrechen keeps the link");
    await renew.click();
    await ask.locator("button", { hasText: "Ja, widerrufen und neuen Link erzeugen" }).click();
    await page.waitForFunction((old) => [...document.querySelectorAll("#maps .shares input")].some((x) => x.value && x.value !== old), url, { timeout: 10000 });
    const fresh = await field().inputValue();
    check(fresh !== url && (await box().innerText()).startsWith("Neuer Link. Der alte Link gilt nicht mehr."), "the confirmation gives a new link and says that the old one no longer works");
    check(same((await apiGet(page, `/api/maps/${id}/shares`)).body.shares.map((x) => x.url), [fresh]), "the server keeps only the new link");
    const r = await site(browser_);
    try {
      r.allow = [/status of 404/];
      check((await r.page.goto(url)).status() === 404, "the old link gives 404");
      check((await r.page.goto(fresh)).status() === 200, "the new link opens the map");
      clean(check, r, " (reader)");
    } finally { await r.context.close(); }
    check(dialogs.length === 0, "no dialog of the browser: " + dialogs.join(" | "));
  } finally { page.off("dialog", onDialog); }
}));

test("the account page: a new team, and an invitation that the owner withdraws before anyone accepts it", asOwner(async (s, check) => {
  const page = s.page;
  // The second account registers, confirms and signs in through the API, in a browser of its own.
  const m = await site(browser_);
  state.member = m;
  await go(m.page, "/account");
  await kontoReady(m.page, "signed-out");
  const registered = await apiCall(m.page, "POST", "/api/auth/register", { email: member.email, handle: member.handle, password: memberPassword(), language: "de" });
  member.registered = registered.status === 202;
  const token = (((await mailTo(member.email, SUBJECT.confirm)).Text || "").match(/#confirm=([A-Za-z0-9_-]+)/) || [])[1];
  const confirmed = await apiCall(m.page, "POST", "/api/auth/confirm", { token, password: memberPassword() });
  const signedIn = await apiCall(m.page, "POST", "/api/auth/login", { email: member.email, password: memberPassword() });
  check(member.registered && confirmed.status === 200 && signedIn.status === 200, `a second account registers, confirms and signs in through the API: ${registered.status}, ${confirmed.status}, ${signedIn.status}`);

  await go(page, "/account");
  await kontoReady(page);
  await page.fill("#new-team input[name=name]", crew.name);
  await page.fill("#new-team input[name=handle]", crew.handle);
  const made = await kontoSays(page, () => page.click("#new-team button[type=submit]"));
  crew.created = (await apiGet(page, `/api/teams/${crew.handle}`)).status === 200;
  check(made.text === `Team „${crew.name}“ angelegt.` && !made.error && crew.created, "Team anlegen: " + made.text);
  const row = await openTeam(page, crew.handle);
  check((await row.locator(":scope > .meta").innerText()) === "Deine Rolle: Inhaber · 1 Mitglied · 0 Maps", "the list names the role, the members and the maps: " + await row.locator(":scope > .meta").innerText());
  check(await row.locator(".team p", { hasText: "Keine offenen Einladungen." }).count() === 1, "no open invitation yet");

  // An invitation to an address without an account, withdrawn again.
  const stranger = handle + "-x@example.org";
  const sent = await inviteFrom(page, row, stranger, "editor");
  check(sent.text === "Die Einladung ist verschickt, falls die Adresse stimmt." && !sent.error, "Einladung schicken: " + sent.text);
  const open = row.locator(".team li", { hasText: stranger });
  await open.waitFor({ timeout: 10000 });
  check((await open.innerText()).startsWith(`${stranger} · Bearbeiter · bis `), "Offene Einladungen lists it with its role: " + await open.innerText());
  const link = mailLink(await mailTo(stranger, SUBJECT.invitation(crew.name)), "invite");
  check(link.startsWith(S.base + "/account#invite="), "the mail links to the account page: " + link.replace(/=.*/, "=…"));
  const withdrawn = await kontoSays(page, () => open.locator("button", { hasText: "Zurückziehen" }).click());
  check(withdrawn.text === `Einladung an ${stranger} zurückgezogen.` && !withdrawn.error, "Zurückziehen: " + withdrawn.text);
  const none = await row.locator(".team p", { hasText: "Keine offenen Einladungen." }).waitFor({ timeout: 10000 }).then(() => true, () => false);
  const left = await apiGet(page, `/api/teams/${crew.handle}/invitations`);
  check(none && left.status === 200 && left.body.invitations.length === 0, "the page and the server have no open invitation any more");
  m.allow = [/status of 400/];
  await openLink(m.page, link);
  const refused = await m.page.waitForFunction(() => { const box = document.getElementById("message"); return !box.hidden && box.classList.contains("error"); }, null, { timeout: 10000 }).then(() => true, () => false);
  check(refused && (await m.page.locator("#message").innerText()) === "Die Einladung ist ungültig, abgelaufen, zurückgezogen oder schon angenommen." && await m.page.locator("#invitation").isHidden(),
    "the link of the withdrawn invitation offers nothing to accept: " + await m.page.locator("#message").innerText());
  clean(check, m, " (second account)");
  m.allow = [];
}));

test("the account page: the second account hides an invitation, opens it again from the mail and accepts it", asOwnerAndMember(async (s, m, check) => {
  const page = s.page;
  const row = await openTeam(page, crew.handle);
  const sent = await inviteFrom(page, row, member.email, "reader");
  check(sent.text === "Die Einladung ist verschickt, falls die Adresse stimmt.", "the owner invites the second account as Leser: " + sent.text);
  const link = mailLink(await mailTo(member.email, SUBJECT.invitation(crew.name)), "invite");
  await openLink(m.page, link);
  await kontoReady(m.page);
  const shown = await m.page.locator("#invitation").waitFor({ timeout: 10000 }).then(() => true, () => false);
  const text = await m.page.locator("#invitation-text").innerText();
  check(shown && text.startsWith(`${handle} lädt dich in das Team „${crew.name}“ (${crew.handle}) ein, mit der Rolle Leser. Die Einladung gilt bis `) && await m.page.locator("#accept-invitation").isVisible(),
    "the link shows who invites, the team and the role, with Einladung annehmen: " + text);
  check(!m.page.url().includes("#invite"), "and takes the token out of the address");
  await m.page.click("#dismiss-invitation");
  check(await m.page.locator("#invitation").isHidden() && await m.page.evaluate(() => localStorage.getItem("it-skills-invite")) === null, "Ausblenden hides the invitation and forgets it in this browser");
  await m.page.reload();
  await kontoReady(m.page);
  await m.page.waitForTimeout(300);
  check(await m.page.locator("#invitation").isHidden(), "after a reload it stays hidden");
  const still = await apiGet(page, `/api/teams/${crew.handle}/invitations`);
  check(still.body.invitations.length === 1 && still.body.invitations[0].email === member.email && still.body.invitations[0].role === "reader", "Ausblenden does not withdraw it: the owner still has it open");

  await openLink(m.page, link);
  await kontoReady(m.page);
  await m.page.locator("#accept-invitation").waitFor({ timeout: 10000 });
  const joined = await kontoSays(m.page, () => m.page.click("#accept-invitation"));
  check(joined.text === `Du bist jetzt im Team „${crew.name}“, Rolle Leser.` && !joined.error && await m.page.locator("#invitation").isHidden(), "the link of the mail opens it again, and Einladung annehmen joins the team: " + joined.text);
  const theirs = teamRow(m.page, crew.handle);
  await theirs.waitFor({ timeout: 10000 });
  check((await theirs.locator(":scope > .meta").innerText()) === "Deine Rolle: Leser · 2 Mitglieder · 0 Maps", "the team list of the second account shows the team: " + await theirs.locator(":scope > .meta").innerText());
  check(same(await membersOf(page, crew.handle), [[handle, "owner"], [member.handle, "reader"]]), "the server has the second account as Leser");
  check((await apiGet(page, `/api/teams/${crew.handle}/invitations`)).body.invitations.length === 0, "and the invitation is no longer open");
}));

test("the account page: the owner moves a map into the team, changes the role of the member and renames the team", asOwnerAndMember(async (s, m, check) => {
  const page = s.page, id = kontoMaps["Konto-Leer"];
  // A public map with a link: the move makes it private and ends the link.
  check((await apiCall(page, "PATCH", `/api/maps/${id}`, { visibility: "public" })).status === 200 && (await apiCall(page, "POST", `/api/maps/${id}/shares`)).status === 201, "Konto-Leer is public, with a link");
  check((await apiGet(page, `/${handle}/konto-leer`)).status === 200, "and its public address answers");
  // The start map of the owner: the move into the team ends it (his answer of 2026-10-19 to finding A5).
  const startShown = () => page.evaluate(async (p) => (await (await fetch(p, { cache: "no-store" })).text()).includes('"slug": "konto-leer"'), `/${handle}`);
  const started = await apiCall(page, "PATCH", `/api/maps/${id}`, { start: true });
  check(started.status === 200 && started.body.start === true && await startShown(), "Konto-Leer is the start map, and the address of the owner shows it");
  s.allow = [/status of 404/, /status of 409/];
  await go(page, "/account");
  await kontoReady(page);
  check((await page.locator("#maps > li", { hasText: "Konto-Leer" }).locator(":scope > .meta").innerText()).includes("Start-Map"), "the list of the maps marks the start map");
  const mover = page.locator("#maps > li", { hasText: "Konto-Leer" }).locator('select[aria-label="In ein Team verschieben"]');
  await mover.waitFor({ timeout: 10000 });
  check(same(await mover.locator("option").allInnerTexts(), ["In ein Team verschieben …", `${crew.name} (${crew.handle})`]), "a personal map offers the team of its owner");
  let asked = nextDialog(page, false);
  await mover.selectOption(crew.handle);
  const question = await asked;
  check(question === `Map „Konto-Leer“ in das Team „${crew.name}“ verschieben? Sie wird dabei privat: ihre öffentlichen Adressen gelten nicht mehr, ihr Link zum Lesen wird gelöscht, und keine andere Website bettet sie ein.`,
    "the move asks first and says that the map becomes private: " + question);
  await page.waitForFunction(() => { const x = [...document.querySelectorAll("#maps > li")].find((li) => li.textContent.includes("Konto-Leer")); return x && x.querySelector('select[aria-label="In ein Team verschieben"]').value === ""; }, null, { timeout: 10000 }).catch(() => {});
  const kept = (await apiGet(page, `/api/maps/${id}`)).body;
  check(kept.ownerType === "user" && kept.visibility === "public" && await mover.inputValue() === "", "Abbrechen keeps the map where it was: " + kept.ownerType + ", " + kept.visibility);
  asked = nextDialog(page, true);
  const moved = await kontoSays(page, () => mover.selectOption(crew.handle));
  check(await asked !== null && moved.text === `Map „Konto-Leer“ ist jetzt im Team „${crew.name}“.` && !moved.error, "OK moves it: " + moved.text);
  check(await page.locator("#maps > li", { hasText: "Konto-Leer" }).count() === 0, "it leaves the list of the own maps");
  const there = (await apiGet(page, `/api/teams/${crew.handle}/maps`)).body.maps.find((x) => x.id === id) || {};
  check(there.ownerType === "team" && there.visibility === "private" && there.shares === 0 && same(there.embed, { allow: "origins", origins: [], url: null }),
    "the server has it in the team, private, without links and without embedding: " + JSON.stringify({ type: there.ownerType, visibility: there.visibility, shares: there.shares, embed: there.embed }));
  check((await apiGet(page, `/${handle}/konto-leer`)).status === 404, "its old public address is gone");
  check(there.start === false && !(await startShown()), "the move ends the start map of the owner, and the team does not get it");
  let row = await openTeam(page, crew.handle);
  check(await row.locator(".team .maps > li a.title", { hasText: "Konto-Leer" }).count() === 1 && (await row.locator(":scope > .meta").innerText()).endsWith("· 1 Map"), "the team lists the map");

  const changed = await kontoSays(page, () => row.locator(`select[aria-label="Rolle von ${member.handle}"]`).selectOption("editor"));
  check(changed.text === `Rolle von ${member.handle}: Bearbeiter.` && !changed.error, "a new role for the member: " + changed.text);
  check(same(await membersOf(page, crew.handle), [[handle, "owner"], [member.handle, "editor"]]), "the server has the member as Bearbeiter");
  await go(m.page, "/account");
  await kontoReady(m.page);
  const theirs = await openTeam(m.page, crew.handle);
  check((await theirs.locator(":scope > .meta").innerText()).startsWith("Deine Rolle: Bearbeiter") && await theirs.locator(".team form", { hasText: "Neue Map im Team" }).count() === 1
    && await theirs.locator(".team form", { hasText: "Einladen" }).count() === 0 && await theirs.locator(`select[aria-label="Rolle von ${handle}"]`).count() === 0,
    "the member sees the new role: new maps in the team, but no invitations and no roles");

  const own = row.locator(`select[aria-label="Rolle von ${handle}"]`);
  const refused = await kontoSays(page, () => own.selectOption("reader"));
  check(refused.error && refused.text === "Ein Team braucht mindestens einen Inhaber. Gib die Rolle zuerst einem anderen Mitglied.", "the only owner cannot give up the role: " + refused.text);
  await page.waitForFunction((label) => { const x = document.querySelector(`#team-list select[aria-label="${label}"]`); return !!x && x.value === "owner"; }, "Rolle von " + handle, { timeout: 10000 }).catch(() => {});
  check(await own.inputValue() === "owner" && same(await membersOf(page, crew.handle), [[handle, "owner"], [member.handle, "editor"]]), "the page and the server keep the owner");

  const old = crew.handle, nord = handle + "-nord";
  const rename = row.locator(".team form", { hasText: "Team umbenennen" });
  await rename.locator("input[name=name]").fill("Testcrew Nord");
  await rename.locator("input[name=handle]").fill(nord);
  const renamed = await kontoSays(page, () => rename.locator("button[type=submit]").click());
  const byNew = await apiGet(page, `/api/teams/${nord}`);
  if (byNew.status === 200) Object.assign(crew, { name: byNew.body.name, handle: nord });
  check(renamed.text === "Team gespeichert." && !renamed.error, "Team umbenennen: " + renamed.text);
  row = teamRow(page, nord);
  const stays = await row.locator(".team h3", { hasText: "Mitglieder" }).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check(stays && (await row.locator(":scope > .title").innerText()) === `Testcrew Nord (${nord})`, "the list shows the new name and address, and the team stays open");
  check(byNew.status === 200 && byNew.body.name === "Testcrew Nord" && (await apiGet(page, `/api/teams/${old}`)).status === 404, "the server has the team under its new address only");
  const map = (await apiGet(page, `/api/teams/${nord}/maps`)).body.maps.find((x) => x.id === id) || {};
  check(map.pageUrl === `${S.base}/${nord}/konto-leer`, "its map moves to the new address: " + map.pageUrl);
  const offered = await page.locator("#maps > li", { hasText: "Konto-Standard" }).locator('select[aria-label="In ein Team verschieben"] option').allInnerTexts();
  check(same(offered, ["In ein Team verschieben …", `Testcrew Nord (${nord})`]), "the own maps offer the team under its new name and address: " + JSON.stringify(offered));
}));

test("the account page: the owner removes the member, and the member joins again and leaves the team", asOwnerAndMember(async (s, m, check) => {
  const page = s.page;
  const row = await openTeam(page, crew.handle);
  let asked = nextDialog(page, true);
  const removed = await kontoSays(page, () => memberRow(row, member.handle + " · ").locator("button", { hasText: "Entfernen" }).click());
  check(await asked === `${member.handle} aus dem Team entfernen?` && removed.text === `${member.handle} ist nicht mehr im Team.` && !removed.error, "Entfernen asks first and removes the member: " + removed.text);
  check(same(await membersOf(page, crew.handle), [[handle, "owner"]]), "the server has only the owner left");
  m.allow = [/status of 404/];
  await go(m.page, "/account");
  await kontoReady(m.page);
  check(await m.page.locator("#no-teams").isVisible() && (await apiGet(m.page, "/api/teams")).body.teams.length === 0 && (await apiGet(m.page, `/api/teams/${crew.handle}`)).status === 404,
    "the removed member is in no team any more");

  s.allow = [/status of 409/];
  asked = nextDialog(page, true);
  const stays = await kontoSays(page, () => memberRow(row, "(du)").locator("button", { hasText: "Team verlassen" }).click());
  check(await asked === `Team „${crew.name}“ wirklich verlassen?` && stays.error && stays.text === "Ein Team braucht mindestens einen Inhaber. Gib die Rolle zuerst einem anderen Mitglied.", "the only owner cannot leave the team: " + stays.text);
  check(same(await membersOf(page, crew.handle), [[handle, "owner"]]), "and stays its owner");

  const sent = await inviteFrom(page, await openTeam(page, crew.handle), member.email, "reader");
  check(sent.text === "Die Einladung ist verschickt, falls die Adresse stimmt.", "the owner invites the member again: " + sent.text);
  await openLink(m.page, mailLink(await mailTo(member.email, SUBJECT.invitation(crew.name)), "invite"));
  await kontoReady(m.page);
  await m.page.locator("#accept-invitation").waitFor({ timeout: 10000 });
  const joined = await kontoSays(m.page, () => m.page.click("#accept-invitation"));
  check(joined.text === `Du bist jetzt im Team „${crew.name}“, Rolle Leser.`, "the member joins again: " + joined.text);
  const theirs = await openTeam(m.page, crew.handle);
  asked = nextDialog(m.page, true);
  const left = await kontoSays(m.page, () => memberRow(theirs, "(du)").locator("button", { hasText: "Team verlassen" }).click());
  check(await asked === `Team „${crew.name}“ wirklich verlassen?` && left.text === `Du hast das Team „${crew.name}“ verlassen.` && !left.error, "Team verlassen asks first and leaves the team: " + left.text);
  check(await m.page.locator("#no-teams").isVisible() && await m.page.locator("#team-list > li").count() === 0, "the account page of the member has no team any more");
  check(same(await membersOf(page, crew.handle), [[handle, "owner"]]), "the server has only the owner again");
}));

test("the account page: the owner deletes the team with its maps", asOwner(async (s, check) => {
  const page = s.page, id = kontoMaps["Konto-Leer"];
  await go(page, "/account");
  await kontoReady(page);
  const remove = (await openTeam(page, crew.handle)).locator(".team form", { hasText: "Team löschen" });
  s.allow = [/status of 401/, /status of 404/];
  await remove.locator("input[name=password]").fill(account.password + " falsch");
  let asked = nextDialog(page, true);
  const wrong = await kontoSays(page, () => remove.locator("button[type=submit]").click());
  check(await asked === `Team „${crew.name}“ und alle seine Maps wirklich löschen?` && wrong.error && wrong.text === "Das Passwort ist falsch.", "Team löschen asks first, and a wrong password gives an error: " + wrong.text);
  check((await apiGet(page, `/api/teams/${crew.handle}`)).status === 200, "a wrong password deletes nothing");
  await remove.locator("input[name=password]").fill(account.password);
  asked = nextDialog(page, true);
  const gone = await kontoSays(page, () => remove.locator("button[type=submit]").click());
  check(await asked !== null && gone.text === `Das Team „${crew.name}“ ist gelöscht.` && !gone.error, "with the password the team goes: " + gone.text);
  const team = await apiGet(page, `/api/teams/${crew.handle}`), map = await apiGet(page, `/api/maps/${id}`);
  crew.deleted = team.status === 404;
  check(await page.locator("#team-list > li").count() === 0 && await page.locator("#no-teams").isVisible(), "the list has no team any more");
  check(crew.deleted && map.status === 404, `the server has neither the team nor its map: ${team.status}, ${map.status}`);
  check(await page.locator('#maps select[aria-label="In ein Team verschieben"]').count() === 0, "the own maps offer no team any more");
}));

test("the account page: a forgotten password is reset through the link in the mail", asOwnerAndMember(async (s, m, check) => {
  const page = m.page;
  await go(page, "/account");
  await kontoReady(page);
  const out = await kontoSays(page, () => page.click("#logout"));
  check(out.text === "Du bist abgemeldet." && await page.locator("#signed-out").isVisible(), "Abmelden: " + out.text);
  await page.click('[data-tab="forgot"]');
  await page.fill("#forgot input[name=email]", member.email);
  const asked = await kontoSays(page, () => page.click("#forgot button[type=submit]"));
  check(asked.text === "Wir haben dir eine E-Mail geschickt, falls die Angaben stimmen. Bitte folge dem Link darin." && !asked.error, "Passwort vergessen: " + asked.text);
  const link = mailLink(await mailTo(member.email, SUBJECT.reset), "reset");
  check(link.startsWith(S.base + "/account#reset="), "the mail links to the account page: " + link.replace(/=.*/, "=…"));
  await openLink(page, link);
  const form = await page.locator("#reset").waitFor({ timeout: 10000 }).then(() => true, () => false);
  const old = memberPassword(), fresh = "ein neues Passwort aus dem Link " + crypto.randomBytes(3).toString("hex");
  member.passwords.push(fresh);
  await page.fill("#reset-form input[name=password]", fresh);
  const set = await kontoSays(page, () => page.click("#reset-form button[type=submit]"));
  check(form && set.text === "Dein neues Passwort gilt. Bitte melde dich an." && !set.error && await page.locator("#reset").isHidden() && !page.url().includes("#reset"),
    "the link opens Neues Passwort, and Passwort setzen sets it: " + set.text);
  m.allow = [/status of 401/];
  await page.fill("#login input[name=email]", member.email);
  await page.fill("#login input[name=password]", old);
  const refused = await kontoSays(page, () => page.click("#login button[type=submit]"));
  check(refused.error && refused.text === "E-Mail-Adresse oder Passwort ist falsch." && await page.locator("#signed-out").isVisible(), "the old password no longer signs in: " + refused.text);
  await page.fill("#login input[name=email]", member.email);
  await page.fill("#login input[name=password]", fresh);
  const welcome = await kontoSays(page, () => page.click("#login button[type=submit]"));
  check(welcome.text === "Du bist angemeldet." && (await page.locator("#who").innerText()) === `Angemeldet als ${member.handle} (${member.email})`, "the new one does: " + welcome.text);
}));

test("the account page: a password change, and the account deletes itself with its maps", asOwnerAndMember(async (s, m, check) => {
  const page = m.page;
  m.allow = [/status of 401/, /status of 404/];
  const before = memberPassword(), changed = "ein geaendertes Passwort " + crypto.randomBytes(3).toString("hex");
  await page.fill("#password-form input[name=current]", before + " falsch");
  await page.fill("#password-form input[name=new]", changed);
  const wrong = await kontoSays(page, () => page.click("#password-form button[type=submit]"));
  check(wrong.error && wrong.text === "Das Passwort ist falsch.", "Passwort ändern with a wrong current password gives an error: " + wrong.text);
  member.passwords.push(changed);
  await page.fill("#password-form input[name=current]", before);
  await page.fill("#password-form input[name=new]", changed);
  const done = await kontoSays(page, () => page.click("#password-form button[type=submit]"));
  check(done.text === "Dein neues Passwort gilt." && !done.error, "Passwort ändern: " + done.text);
  check((await apiGet(page, "/api/auth/session")).body.signedIn === true, "this browser stays signed in, with a new session");

  // A public map of the account, which goes with it.
  await page.fill("#new-map input[name=title]", "Map des Mitglieds");
  await page.selectOption("#new-map select[name=template]", "empty");
  check((await kontoSays(page, () => page.click("#new-map button[type=submit]"))).text === "Map „Map des Mitglieds“ angelegt.", "the account makes a map");
  const shared = await kontoSays(page, () => page.locator("#maps > li", { hasText: "Map des Mitglieds" }).locator('select[aria-label="Sichtbarkeit"]').selectOption("public"));
  const address = `/${member.handle}/map-des-mitglieds`;
  check(shared.text === "Sichtbarkeit: Öffentlich." && (await apiGet(page, address)).status === 200, "and makes it public: " + shared.text);

  await page.fill("#delete-form input[name=password]", before);
  let asked = nextDialog(page, true);
  const refused = await kontoSays(page, () => page.click("#delete-form button[type=submit]"));
  check(await asked === "Konto und alle Maps wirklich löschen?" && refused.error && refused.text === "Das Passwort ist falsch.", "Konto löschen asks first, and the password before the change is wrong now: " + refused.text);
  await page.fill("#delete-form input[name=password]", changed);
  asked = nextDialog(page, false);
  await page.click("#delete-form button[type=submit]");
  check(await asked !== null, "Abbrechen in the question");
  await page.waitForTimeout(300);
  check((await apiGet(page, "/api/account")).status === 200 && await page.locator("#signed-in").isVisible(), "keeps the account");
  asked = nextDialog(page, true);
  const gone = await kontoSays(page, () => page.click("#delete-form button[type=submit]"));
  check(await asked !== null && gone.text === "Dein Konto und deine Maps sind gelöscht." && !gone.error && await page.locator("#signed-out").isVisible(), "OK with the new password deletes the account: " + gone.text);
  const session = (await apiGet(page, "/api/auth/session")).body, map = await apiGet(page, address);
  member.deleted = session.signedIn === false && map.status === 404;
  check(member.deleted, "the session and the public map are gone");
  await page.fill("#login input[name=email]", member.email);
  await page.fill("#login input[name=password]", changed);
  const login = await kontoSays(page, () => page.click("#login button[type=submit]"));
  check(login.error && login.text === "E-Mail-Adresse oder Passwort ist falsch.", "the account no longer signs in: " + login.text);
}));

test("a public map by path and by subdomain, and the owner logs out", asOwner(async (s, check) => {
  const page = s.page;
  await go(page, state.testMap.url); await mapReady(page);
  await openShare(page);
  await page.locator('#share-dialog input[name=share-visibility][value=public]').check();
  const said = await page.waitForFunction(() => document.getElementById("share-dialog").textContent.includes("Jeder mit der Adresse liest die Map."), null, { timeout: 10000 }).then(() => true, () => false);
  check(said && await page.locator('#share-dialog input[name=share-visibility][value=public]').isChecked(), "the dialog says that the map is public");
  await page.click("#share-close");
  const r = await site(browser_);
  try {
    await go(r.page, `/${handle}/testdaten`);
    await mapReady(r.page, { owner: false, heading: "9 Kenntnisse in 3 Bereichen" });
    check((await h2(r.page)) === "9 Kenntnisse in 3 Bereichen" && !(await r.page.locator("#share-open").count()) && await r.page.locator("#cfg").isHidden(), "by path: the map, read-only");
    if (S.domain) {
      await go(r.page, `${subdomainOrigin(handle)}/testdaten`);
      await mapReady(r.page, { owner: false, heading: "9 Kenntnisse in 3 Bereichen" });
      check((await h2(r.page)) === "9 Kenntnisse in 3 Bereichen" && !(await r.page.locator("#share-open").count()), "by subdomain: the map, read-only");
      check(await r.page.locator("a.tool-link", { hasText: "Start" }).getAttribute("href") === S.base + "/", "Start on the subdomain leads to the main site");
      await go(r.page, subdomainOrigin(handle) + "/");
      // The list page of the app has the name of the owner as its title (server/app/pages.py).
      check((await r.page.locator("main").innerText()).includes("Testdaten") && (await r.page.title()) === handle, "the subdomain lists the public maps");
    } else check(true, "BASE_DOMAIN is empty: no subdomain to test");
    // The address of the owner (his answer of 2026-10-19 to finding A5): the list of the public maps, until the owner picks
    // a start map below the public address in Teilen. Then it shows that map, and so does the root of the subdomain.
    await go(r.page, `/${handle}`);
    check((await r.page.locator("main").innerText()).includes("Testdaten") && (await r.page.title()) === handle, "the address of the owner lists the public maps");
    await openShare(page);
    await page.locator("#share-start").click();
    const shown = await page.waitForFunction((text) => (document.getElementById("share-start-note") || {}).textContent === text, `${S.base}/${handle} zeigt jetzt diese Map.`,
      { timeout: 10000 }).then(() => true, () => false);
    check(shown && await page.locator("#share-start").isChecked() && (await page.locator("#share-start-label").innerText()) === `Diese Map auch unter ${S.base}/${handle} zeigen`,
      "the owner picks the map as the start map below the public address");
    await page.click("#share-close");
    await go(r.page, `/${handle}`);
    await mapReady(r.page, { owner: false, heading: "9 Kenntnisse in 3 Bereichen" });
    check((await h2(r.page)) === "9 Kenntnisse in 3 Bereichen" && !(await r.page.locator("#share-open").count()), "the address of the owner shows the start map, read-only");
    if (S.domain) {
      await go(r.page, subdomainOrigin(handle) + "/");
      await mapReady(r.page, { owner: false, heading: "9 Kenntnisse in 3 Bereichen" });
      check((await h2(r.page)) === "9 Kenntnisse in 3 Bereichen", "the root of the subdomain shows the start map too");
    } else check(true, "BASE_DOMAIN is empty: no subdomain for the start map");
    clean(check, r, " (reader)");
  } finally { await r.context.close(); }
  await go(page, "/");
  await page.waitForSelector("#account-logout");
  await page.click("#account-logout");
  await page.waitForFunction(() => document.getElementById("account-title") && document.getElementById("account-title").textContent === "Maps auf dem Server speichern", null, { timeout: 10000 });
  check(true, "after Abmelden the start page offers the account again");
  s.allow = [/status of 404/];
  const hidden = await go(page, state.itMap.url);
  check(hidden.status() === 404 && (await page.locator("body").innerText()).includes("Nicht gefunden"), "the private map is gone for a visitor without a session");
  await go(page, state.testMap.url);
  await mapReady(page, { owner: false, heading: "9 Kenntnisse in 3 Bereichen" });
  check(await page.locator("#share-open").count() === 0 && await page.locator("#cfg").isHidden(), "the public map is read-only after the logout");
}));

test("stage a works on the same site without an account and never asks the API", withSite(async (s, check) => {
  const page = s.page;
  await go(page, "/");
  check(await page.locator("#account-login").isVisible() && await page.locator("#new-default").isVisible(), "both ways on the start page");
  await page.click("#new-default");
  await page.waitForURL(/\/map\.html\?id=/);
  await mapReady(page);
  check((await h2(page)) === "12 Kenntnisse in 3 Bereichen" && await page.locator("#file-export").isVisible(), "a map in this browser, with the owner controls");
  await clickPanel(page, "+ Bereich");
  await page.fill("#cf-name", "Lokaler Bereich");
  await submitForm(page);
  await saved(page);
  await page.reload();
  await mapReady(page);
  check((await page.locator("#areas .chip").allInnerTexts()).includes("Lokaler Bereich"), "after a reload the area is there");
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("it-skills-map/")).map((k) => JSON.parse(localStorage.getItem(k)).collections.areas));
  check(stored.length === 1 && Object.values(stored[0]).some((x) => x.name === "Lokaler Bereich"), "the map is in the localStorage of the browser");
  await page.locator("a.tool-link", { hasText: "Start" }).click();
  await page.waitForURL(/\/index\.html$/);
  check(await page.locator("#map-list li").count() === 1 && await page.locator("#map-list button", { hasText: "Ins Konto übernehmen" }).count() === 0, "the start page lists it, without Ins Konto übernehmen");
  const api = s.requests.filter((x) => /\/api\//.test(x));
  check(api.length === 0, "no request to the API: " + api.join(", "));
}));

// Before the owner goes: the second account and the team of the account tests, if a failure left them. The owner
// cannot delete his account while he is the only owner of a team with another member.
test("clean up: the second account and the team of the account tests are deleted", async ({ browser, check }) => {
  const s = await site(browser);
  s.allow = [/status of 4\d\d/];
  try {
    await go(s.page, "/account");
    if (member.registered && !member.deleted) {
      let status = 0;
      for (const password of [...member.passwords].reverse()) {
        if ((await apiCall(s.page, "POST", "/api/auth/login", { email: member.email, password })).status !== 200) continue;
        status = (await apiCall(s.page, "POST", "/api/account/delete", { password })).status;
        break;
      }
      member.deleted = status === 204;
      check(member.deleted, "the second account is deleted: " + status);
    } else check(true, member.registered ? "the second account deleted itself in its test" : "no second account was made");
    if (crew.created && !crew.deleted) {
      const login = await apiCall(s.page, "POST", "/api/auth/login", { email: account.email, password: account.password });
      const status = login.status === 200 ? (await apiCall(s.page, "POST", `/api/teams/${crew.handle}/delete`, { password: account.password })).status : login.status;
      await apiCall(s.page, "POST", "/api/auth/logout");
      crew.deleted = status === 204;
      check(crew.deleted, "the team of the account tests is deleted: " + status);
    } else check(true, crew.created ? "the team was deleted in its test" : "no team was made");
  } finally {
    await s.context.close();
    if (state.member) await state.member.context.close().catch(() => {});
  }
}, true);

test("clean up: the account deletes itself", async ({ check }) => {
  const s = state.owner;
  if (!s) { check(false, "no owner"); return; }
  const page = s.page;
  await go(page, "/account");
  // After a failure the owner may still be signed in, because the test that logs him out did not run.
  await page.waitForFunction(() => !document.getElementById("signed-out").hidden || !document.getElementById("signed-in").hidden, null, { timeout: 10000 });
  if (await page.locator("#signed-out").isVisible()) {
    await page.fill("#login input[name=email]", account.email);
    await page.fill("#login input[name=password]", account.password);
    await page.click("#login button[type=submit]");
  }
  await page.waitForFunction(() => !document.getElementById("signed-in").hidden, null, { timeout: 10000 });
  const status = await page.evaluate(async (password) => (await fetch("/api/account/delete", { method: "POST", headers: { "X-Requested-With": "it-skills", "Content-Type": "application/json" }, body: JSON.stringify({ password }) })).status, account.password);
  check(status === 204, "the account and its maps are deleted: " + status);
  s.allow = [/status of 404/];
  if (state.testMap) {
    const gone = await page.goto(state.testMap.url);
    check(gone.status() === 404, "its public map is gone");
  }
  clean(check, s);
}, true);

let browser_ = null;
(async () => {
  // The stack must answer before the browser tests start.
  const { chromium } = require("playwright");
  const probe = await chromium.launch();
  try {
    const page = await (await probe.newContext({ ignoreHTTPSErrors: true })).newPage();
    // The proxy starts before the app is ready (server/compose.yaml), so a 502 can last a few seconds after the start.
    let answer = null;
    for (const end = Date.now() + 60000; ;) {
      answer = await page.goto(S.base + "/api/health", { timeout: 10000 }).catch((error) => ({ status: () => 0, error }));
      if (answer.status() !== 502 || Date.now() > end) break;
      await page.waitForTimeout(1000);
    }
    if (answer.status() !== 200) { console.error(`The stack does not answer at ${S.base}/api/health. Start it first: docker compose -f server/compose.yaml up -d --build (see server/README.md).`); process.exit(1); }
    const mail = await fetch(S.mailpit + "/api/v1/info").then((x) => x.ok, () => false);
    if (!mail) { console.error(`mailpit does not answer at ${S.mailpit}. The stack needs COMPOSE_PROFILES=local.`); process.exit(1); }
  } finally { await probe.close(); }
  let ok = false;
  const wrapped = tests.map((t) => ({ ...t, fn: async (x) => { browser_ = x.browser; return t.fn(x); } }));
  // A test that passes the limit of the harness (E2E_TEST_LIMIT_S) fails with its name, and the tests after it, which
  // build on it, report that they did not run. The clean-up still runs.
  try { ok = await run(wrapped, { pool: 1, only: process.argv.slice(2), late: () => { failedBefore = true; } }); } finally {
    if (state.owner) await state.owner.context.close().catch(() => {});
    if (state.member) await state.member.context.close().catch(() => {});
    if (hosts) await Promise.all(hosts.map((x) => x.close()));
  }
  process.exitCode = ok ? 0 : 1;
})();

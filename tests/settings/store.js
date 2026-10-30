// Tests the configuration store of the force menu in the map page with the test runtime and its database: save, the
// list, load, overwrite, delete, refused writes, a page without db, the migration of old formats, newer formats, unknown
// keys, the state of the browser and the schema guard. It also proves that a viewer who does not own the page gets no
// menu. The pages are map pages of the site build, served from tests/settings/out/site (tests/e2e/site.js).
// Usage: node tests/settings/store.js [name ...]   (no name: all tests; E2E_VERBOSE=1 prints every check)
const fs = require("fs"), path = require("path");
const { run } = require("../e2e/harness");
const { TestSite, openPage, pageOf, withData, withLayout, LAYOUT } = require("../e2e/site");
const { schemaProblems, SCHEMA_FILE } = require("./schema-guard");
const here = __dirname, out = path.join(here, "out"), repo = path.join(here, "..", "..");
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
// The pages of this suite. Their configurations pick none for readers, so every page starts with the values of layout.js.
const site = new TestSite(path.join(out, "site-store"));
const build = (dataFile, projectsFile) => pageOf(dataFile, projectsFile, path.join(here, "fixture.configs.json"));
// The settings test data (two areas, five categories), and the end-to-end test data with three projects for readers.
const springsPage = build(path.join(here, "fixture.js"), path.join(here, "fixture.projects.json"));
const e2ePage = build(path.join(repo, "tests", "e2e", "fixture.js"), path.join(repo, "tests", "e2e", "fixture.projects.json"));
// A page whose default for "Standard-Skills" is off, to prove that a migration step does not take the default.
const STANDARD_ON = "let STANDARD_SKILLS = typeof STANDARD_SKILLS_OVERRIDE === \"boolean\" ? STANDARD_SKILLS_OVERRIDE : true;";
if (LAYOUT.split(STANDARD_ON).length !== 2) throw new Error("the default of STANDARD_SKILLS is not found once in the layout");
const defaultOff = (page) => withLayout(page, (layout) => layout.replace(STANDARD_ON, STANDARD_ON.replace(": true;", ": false;")));
const standardOffPage = defaultOff(springsPage);
// The settings test data has no standard skill. For the migration of "standardLinks", "B2 fünf" is a standard skill since
// station 2, so the switch changes the lines and the springs, and so the look of the map.
const NO_STANDARD = "const STANDARD = {};";
if (springsPage.data.split(NO_STANDARD).length !== 2) throw new Error("the empty STANDARD of the test data is not found once in its data");
const withStandardPage = withData(springsPage, (data) => data.replace(NO_STANDARD, 'const STANDARD = { "B2 fünf": { text: "Standard in den Testdaten", since: "P2" } };'));

const NOW = "2026-10-17T12:05:00.000Z", NOW_TEXT = "17.10.2026, 14:05";

// Every key that the page reads or writes in localStorage is recorded in window.__storage.
function recordStorage() {
  window.__storage = [];
  const getItem = Storage.prototype.getItem, setItem = Storage.prototype.setItem;
  Storage.prototype.getItem = function (key) { window.__storage.push("get " + key); return getItem.call(this, key); };
  Storage.prototype.setItem = function (key, value) { window.__storage.push("set " + key); return setItem.call(this, key, value); };
}

// Opens a page with the test runtime: its database starts with the documents of seed ({ "configs/id": body }), and every
// collection that the page opens is recorded in window.__paths. A write waits 60 ms; with window.__refuse set to a code,
// it rejects with that code. The viewer owns the page, so it has the force menu. runtime false: a saved copy without the
// runtime. db false: the database resolves null. owner false: a viewer who does not own the page; he gets no menu, so the
// page is ready when its panel shows. failSnapshot: the collections whose subscription fails.
async function open(browser, { page: variant = springsPage, runtime = true, db = true, owner = true, seed = {}, refuse = null, stored = null, failSnapshot = null } = {}) {
  await site.start();
  const mode = !runtime ? "noRuntime" : owner ? "owner" : db ? "viewer" : "signedOut";
  const config = { mode, db: owner ? db : undefined, seed, refuse, failSnapshot, emit: "collection", delays: { use: 60, write: 60, snapshot: 30, emit: 20 } };
  // The ageing counts from a fixed day, as in run.js.
  const init = ["window.EXPERIENCE_NOW_OVERRIDE = 2026.75;", ...(runtime ? [recordStorage] : [])];
  // A state that an older page stored in this browser.
  if (stored) init.push([(s) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("skill-springs", JSON.stringify(s)); sessionStorage.setItem("seeded", "1"); } }, stored]);
  const { context, page, errors } = await openPage(browser, site, variant, { runtime: config, init, ignore: /Failed to load resource/, goto: false,
    contextOptions: { viewport: { width: 1300, height: 860 }, reducedMotion: "reduce", colorScheme: "light", timezoneId: "Europe/Berlin", locale: "de-DE" } });
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(site.url(variant));
  if (!owner || !runtime) {
    await page.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    return { context, page, errors };
  }
  await page.waitForFunction(() => window.springMeasure && document.getElementById("store-state") && !/Verbinde|Lade die/.test(document.getElementById("store-state").textContent), null, { timeout: 15000 });
  await idle(page);
  return { context, page, errors };
}
const idle = (page) => page.waitForFunction(() => !document.getElementById("spring-load").disabled && !/Berechne/.test(document.getElementById("cfg-measures").textContent), null, { timeout: 60000 });
// Runs fn on a fresh page and checks that the page logged no error.
const withPage = (options, fn) => async ({ browser, check }) => {
  const { context, page, errors } = await open(browser, options);
  try { await fn(page, check); } finally { check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : "")); await context.close(); }
};

// Page helpers.
const openStore = (page) => page.evaluate(() => { document.getElementById("spring-store").open = true; });
const view = (page) => page.evaluate(() => {
  const e = (id) => document.getElementById(id), shown = (x) => !x.hidden && x.getClientRects().length > 0;
  return {
    state: shown(e("store-state")) ? e("store-state").textContent : "", form: shown(e("store-form")), list: shown(e("store-list")),
    reader: shown(e("store-reader")) ? e("store-reader").textContent : "",
    ask: shown(e("store-ask")) ? e("store-ask").querySelector("p").textContent : "",
    entries: [...e("store-list").querySelectorAll("li")].map((li) => ({ name: li.querySelector(".store-name").textContent, meta: li.querySelector(".store-meta").textContent,
      confirm: li.querySelector(".store-confirm") ? li.querySelector(".store-confirm").textContent : "", buttons: [...li.querySelectorAll("button")].map((b) => b.textContent + (b.disabled ? " (gesperrt)" : "")) })),
    message: e("store-message").textContent, messageError: e("store-message").classList.contains("error"),
    page: e("spring-message").textContent, pageError: e("spring-message").classList.contains("error"),
  };
});
const settle = (page, ms = 250) => page.waitForTimeout(ms).then(() => idle(page));
async function saveAs(page, name) { await page.fill("#store-name", name); await page.click("#store-save"); await settle(page); }
async function entryButton(page, name, text) { await page.locator("#store-list li", { has: page.locator(".store-name", { hasText: name }) }).locator("button", { hasText: text }).click(); await settle(page); }
async function loadLine(page, line) {
  await page.evaluate((text) => { document.getElementById("spring-values").value = text; document.getElementById("spring-load").click(); }, typeof line === "string" ? line : JSON.stringify(line));
  await settle(page, 80);
}
// The state of the page with sorted keys, so two states compare as text.
const canon = (page) => page.evaluate(() => { const sort = (x) => Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x; return JSON.stringify(sort(springCurrent())); });
// What the map shows: a checksum of all node positions, the drawn lines and their widest stroke.
const look = (page) => page.evaluate(() => { const lines = [...document.querySelectorAll("path.shared-line")];
  return d3.selectAll("#map g.node").data().reduce((t, n) => t + n.x * 1.3 + n.y * 0.7, 0).toFixed(6) + " | " + lines.length + " Linien | breiteste " + Math.max(0, ...lines.map((p) => +p.getAttribute("stroke-width"))); });
const defaultsWith = (page, change) => page.evaluate((code) => { const s = JSON.parse(JSON.stringify(SPRING_DEFAULTS)); (new Function("s", code))(s); return s; }, change);
const doc = (name, values, savedAt, schema = 4) => ({ name, schema, values, savedAt });
const KEYS4 = SCHEMA.versions["4"];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("store starts collapsed, empty collection, a name is needed", withPage({}, async (page, check) => {
  check(await page.evaluate(() => document.getElementById("spring-store").open === false), "the section Konfigurationen starts collapsed");
  check(await page.evaluate(() => document.querySelector("#spring-store summary").textContent) === "Konfigurationen", "its title is Konfigurationen");
  await openStore(page);
  const v = await view(page);
  check(v.state === "Noch keine Konfiguration gespeichert." && v.form && !v.list, "empty collection: the note, the form, no list");
  await page.click("#store-save"); await settle(page);
  const w = await view(page);
  check(w.message === "Bitte einen Namen eingeben." && w.messageError && await page.evaluate(() => window.__writes.length) === 0, "an empty name writes nothing and says so");
  check(JSON.stringify(await page.evaluate(() => window.__paths.slice().sort())) === '["configs","groups","projects","settings","skills"]', "the page of the owner opens projects, groups, skills, configs and settings once each");
  check(v.reader === "Noch keine Konfiguration für Leser gewählt. Leser sehen die Werte aus layout.js.", "no pick yet, and readers see the values of layout.js: " + v.reader);
}));

test("save writes one document with name, schema, values and date, and lists it", withPage({}, async (page, check) => {
  await openStore(page);
  await loadLine(page, { schema: 4, ticks: 500, lines: { skill: { drawnBridges: 37 } } });
  const before = await page.evaluate(() => JSON.stringify(springCurrent()));
  // A second click while the first write runs does nothing: one write at a time.
  await page.fill("#store-name", "  Ruhige   Wolken ");
  await page.evaluate(() => { document.getElementById("store-save").click(); document.getElementById("store-save").click(); });
  await settle(page, 300);
  const writes = await page.evaluate(() => window.__writes), docs = await page.evaluate(() => window.__docs());
  check(writes.length === 1 && writes[0].op === "set" && writes[0].full === "configs/ruhige-wolken", "one write to configs/ruhige-wolken: " + JSON.stringify(writes));
  const d = docs["configs/ruhige-wolken"];
  check(d && d.name === "Ruhige Wolken" && d.schema === 4 && d.savedAt === NOW && JSON.stringify(Object.keys(d).sort()) === '["name","savedAt","schema","values"]', "document: name with single spaces, schema 4, savedAt, nothing else");
  check(d && JSON.stringify(d.values) === before, "values: the full state of springCurrent");
  const v = await view(page);
  check(v.message === "Gespeichert: „Ruhige Wolken“." && !v.messageError, "message: " + v.message);
  check(JSON.stringify(v.entries) === JSON.stringify([{ name: "Ruhige Wolken", meta: NOW_TEXT + " · Schema 4", confirm: "", buttons: ["Laden", "Für Leser", "Löschen"] }]), "the list shows the entry: " + JSON.stringify(v.entries));
  check(v.state === "" && await page.inputValue("#store-name") === "", "the empty note is gone and the name field is empty");
  // Without "automatisch", a change in the menu waits; the message says that it is not saved.
  await page.evaluate(() => { document.getElementById("cfg-auto").click(); });
  await page.evaluate(() => { const r = document.getElementById("cfg-ticks"); r.value = "1"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); });
  await saveAs(page, "Wartet");
  check((await view(page)).message === "Gespeichert: „Wartet“. Änderungen im Menü, die auf „Neu berechnen“ warten, sind nicht dabei.", "a waiting change is named");
  check((await page.evaluate(() => window.__docs()))["configs/wartet"].values.ticks === 500, "the saved state is the computed one");
}));

test("the list shows the newest first, with name, date and schema", withPage({ seed: {
  "configs/aelter": doc("Älter", { ticks: 300 }, "2026-10-15T09:30:00.000Z", 2),
  "configs/neuer": doc("Neuer", { ticks: 300 }, "2026-10-17T07:00:00.000Z"),
  "configs/mitte": doc("Mitte <b>fett</b>", { ticks: 300 }, "2026-10-16T18:45:00.000Z"),
} }, async (page, check) => {
  await openStore(page);
  const v = await view(page);
  check(JSON.stringify(v.entries.map((e) => [e.name, e.meta])) === JSON.stringify([["Neuer", "17.10.2026, 09:00 · Schema 4"], ["Mitte <b>fett</b>", "16.10.2026, 20:45 · Schema 4"], ["Älter", "15.10.2026, 11:30 · Schema 2"]]),
    "newest first, names as text: " + JSON.stringify(v.entries.map((e) => [e.name, e.meta])));
  await saveAs(page, "Jetzt");
  check(JSON.stringify((await view(page)).entries.map((e) => e.name)) === JSON.stringify(["Jetzt", "Neuer", "Mitte <b>fett</b>", "Älter"]), "a new entry comes first");
  await page.fill("#store-name", "Per Enter"); await page.press("#store-name", "Enter"); await settle(page);
  check(!!(await page.evaluate(() => window.__docs()))["configs/per-enter"] && await page.locator("#store-form button[type=submit]").count() === 0, "Enter in the name field saves too, and the store has no submit button");
}));

test("load restores every value, all three line sets and the start points", withPage({}, async (page, check) => {
  await openStore(page);
  const S = await defaultsWith(page, `Object.assign(s, { fixed: true, seed: 2, ticks: 500, friction: 0.6, likeSkillCross: 2, standardSkills: false, showExperience: false, lineMode: "category" });
    Object.assign(s.lines.category, { drawnBridges: 3, bridgeWidthMax: 10, lineGradient: true, bridgeColorLight: "#ff0000" });
    Object.assign(s.lines.skill, { drawnBridges: 37, bridgeWidthMax: 0.5, crossAreaOnly: true });
    Object.assign(s.lines.mixed, { drawnBridges: 12, bridgeBend: -0.35 });
    s.at = { sd: [-300, 40], ai: [300, -40] };`);
  await loadLine(page, { schema: 4, ...S });
  const wanted = await canon(page), map = await look(page);
  await saveAs(page, "Alles anders");
  await page.click("#spring-reset"); await settle(page);
  check(await canon(page) !== wanted && await look(page) !== map, "Werte aus layout.js changes the state and the map");
  await entryButton(page, "Alles anders", "Laden");
  check(await canon(page) === wanted, "every value is back, also the line sets of all three modes and the start points");
  check(await page.evaluate(() => JSON.stringify(CLUSTERS.map((c) => c.at))) === "[[-300,40],[300,-40]]", "the start points of the areas are back");
  check(await look(page) === map, "the map is the same as after loading the line: " + map);
  check(await page.evaluate(() => { const v = JSON.parse(document.getElementById("spring-values").value); return v.schema === 4 && v.standardSkills === false && v.lines.skill.drawnBridges === 37 && v.lines.mixed.bridgeBend === -0.35 && document.getElementById("cfg-drawnBridges-n").value === "3"; }), "the menu and the values line show the loaded values");
  const v = await view(page);
  check(v.page === "Konfiguration „Alles anders“ geladen, Schema 4 wie diese Seite." && !v.pageError, "page message: " + v.page);
  check(v.message === "Geladen: „Alles anders“." && !v.messageError, "store message: " + v.message);
}));

test("overwrite asks in the page, then replaces", withPage({ seed: { "configs/test": doc("Test", { ticks: 300 }, "2026-10-16T08:00:00.000Z") } }, async (page, check) => {
  await openStore(page);
  await loadLine(page, { schema: 4, ticks: 500 });
  await saveAs(page, "Test");
  check((await view(page)).ask === "„Test“ gibt es schon, gespeichert 16.10.2026, 10:00. Überschreiben?" && await page.evaluate(() => window.__writes.length) === 0, "a taken name asks and writes nothing");
  await page.locator("#store-ask button", { hasText: "Abbrechen" }).click(); await settle(page);
  check((await view(page)).ask === "" && (await page.evaluate(() => window.__docs()))["configs/test"].values.ticks === 300, "Abbrechen keeps the document");
  await saveAs(page, "Test");
  await page.type("#store-name", "x"); await settle(page);
  check((await view(page)).ask === "", "a new name closes the question");
  // Another spelling of the same name has the same id, so it asks too.
  await page.fill("#store-name", ""); await saveAs(page, "test");
  check((await view(page)).ask.startsWith("„Test“ gibt es schon"), "the same id in another spelling asks too");
  await page.locator("#store-ask button", { hasText: "Überschreiben" }).click(); await settle(page, 300);
  const writes = await page.evaluate(() => window.__writes), docs = await page.evaluate(() => window.__docs());
  check(writes.length === 1 && writes[0].full === "configs/test" && Object.keys(docs).length === 1, "one write, still one document");
  check(docs["configs/test"].name === "test" && docs["configs/test"].values.ticks === 500 && docs["configs/test"].savedAt === NOW, "the document has the new name, values and date");
  const v = await view(page);
  check(v.message === "Überschrieben: „test“." && JSON.stringify(v.entries.map((e) => e.name)) === '["test"]', "message and list: " + v.message);
}));

// A name without a letter of a to z or a digit (finding D7 of the final review): the id is "config" now, and a map that
// has the old id "konfiguration" keeps it for such a name.
test("a name without Latin letters saves under the id config, and an old configuration with the id konfiguration keeps its saves", async ({ browser, check }) => {
  let { context, page, errors } = await open(browser, {});
  try {
    await openStore(page);
    await saveAs(page, "設定");
    const writes = await page.evaluate(() => window.__writes);
    check(writes.length === 1 && writes[0].full === "configs/config" && (await page.evaluate(() => window.__docs()))["configs/config"].name === "設定", "a new map: configs/config: " + JSON.stringify(writes.map((w) => w.full)));
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  } finally { await context.close(); }
  ({ context, page, errors } = await open(browser, { seed: { "configs/konfiguration": doc("設定", { ticks: 300 }, "2026-10-16T08:00:00.000Z") } }));
  try {
    await openStore(page);
    await loadLine(page, { schema: 4, ticks: 500 });
    await saveAs(page, "設定");
    check((await view(page)).ask === "„設定“ gibt es schon, gespeichert 16.10.2026, 10:00. Überschreiben?", "the old id asks before it overwrites: " + (await view(page)).ask);
    await page.locator("#store-ask button", { hasText: "Überschreiben" }).click(); await settle(page, 300);
    const writes = await page.evaluate(() => window.__writes), docs = await page.evaluate(() => window.__docs());
    check(writes.length === 1 && writes[0].full === "configs/konfiguration" && JSON.stringify(Object.keys(docs)) === '["configs/konfiguration"]' && docs["configs/konfiguration"].values.ticks === 500,
      "the save overwrites configs/konfiguration and makes no second document: " + JSON.stringify(Object.keys(docs)));
    await entryButton(page, "設定", "Laden");
    check((await view(page)).message === "Geladen: „設定“.", "the old id loads as before: " + (await view(page)).message);
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  } finally { await context.close(); }
});

test("delete asks in the entry, then removes",withPage({ seed: { "configs/a": doc("A", { ticks: 300 }, "2026-10-16T08:00:00.000Z"), "configs/b": doc("B", { ticks: 500 }, "2026-10-15T08:00:00.000Z") } }, async (page, check) => {
  await openStore(page);
  await entryButton(page, "A", "Löschen");
  let v = await view(page);
  check(v.entries[0].confirm === "„A“ löschen?" && JSON.stringify(v.entries[0].buttons) === '["Löschen","Abbrechen"]' && JSON.stringify(v.entries[1].buttons) === '["Laden","Für Leser","Löschen"]', "the entry asks, the other entry stays");
  check(await page.evaluate(() => window.__writes.length) === 0, "asking writes nothing");
  await entryButton(page, "A", "Abbrechen");
  check((await view(page)).entries[0].confirm === "" && Object.keys(await page.evaluate(() => window.__docs())).length === 2, "Abbrechen keeps both");
  await entryButton(page, "A", "Löschen");
  await entryButton(page, "A", "Löschen");
  v = await view(page);
  check(JSON.stringify(await page.evaluate(() => window.__writes)) === '[{"op":"delete","full":"configs/a"}]', "one delete of configs/a");
  check(JSON.stringify(v.entries.map((e) => e.name)) === '["B"]' && v.message === "Gelöscht: „A“.", "the list keeps B: " + v.message);
}));

// The pick for readers (the plan of 2026-10-18): "Für Leser" writes settings/reader. The picked entry says so and cannot
// be deleted, and overwriting it warns that readers see the new values at once. The owner's own state stays.
test("Für Leser writes the pick, and the picked entry cannot be deleted", withPage({ seed: {
  "configs/a": doc("A", { ticks: 300 }, "2026-10-16T08:00:00.000Z"), "configs/b": doc("B", { ticks: 500 }, "2026-10-15T08:00:00.000Z") } }, async (page, check) => {
  await openStore(page);
  const before = await canon(page);
  await entryButton(page, "B", "Für Leser");
  const writes = await page.evaluate(() => window.__writes), docs = await page.evaluate(() => window.__docs());
  check(writes.length === 1 && writes[0].op === "set" && writes[0].full === "settings/reader", "one write to settings/reader: " + JSON.stringify(writes));
  check(JSON.stringify(docs["settings/reader"]) === JSON.stringify({ config: "b", pickedAt: NOW }), "the pick names the id and the time: " + JSON.stringify(docs["settings/reader"]));
  let v = await view(page);
  check(v.message === "Für Leser gewählt: „B“. Die Map startet mit dieser Konfiguration, auch nach Export und Import." && !v.messageError, "message: " + v.message);
  check(v.entries[1].meta === "15.10.2026, 10:00 · Schema 4 · für Leser" && JSON.stringify(v.entries[1].buttons) === '["Laden","Löschen (gesperrt)"]', "the picked entry: its meta line, no Für Leser, Löschen locked: " + JSON.stringify(v.entries[1]));
  check(await page.locator('#store-list li[data-id="b"] button', { hasText: "Löschen" }).getAttribute("title") === "Erst eine andere Konfiguration für Leser wählen", "the locked Löschen says why");
  check(JSON.stringify(v.entries[0].buttons) === '["Laden","Für Leser","Löschen"]' && v.entries[0].meta === "16.10.2026, 10:00 · Schema 4", "the other entry keeps all buttons");
  check(v.reader === "Für Leser gewählt: „B“, am 17.10.2026, 14:05.", "the store names the pick: " + v.reader);
  check(await canon(page) === before && await page.evaluate(() => TICKS) === 300, "the owner's own state does not follow the pick");
  await saveAs(page, "B");
  check((await view(page)).ask === "„B“ gibt es schon, gespeichert 15.10.2026, 10:00. Überschreiben? Leser sehen die neuen Werte sofort.", "overwriting the picked entry warns: " + (await view(page)).ask);
  await page.locator("#store-ask button", { hasText: "Abbrechen" }).click(); await settle(page);
  await saveAs(page, "A");
  check((await view(page)).ask === "„A“ gibt es schon, gespeichert 16.10.2026, 10:00. Überschreiben?", "another entry asks without the warning");
  await page.locator("#store-ask button", { hasText: "Abbrechen" }).click(); await settle(page);
  await entryButton(page, "A", "Für Leser");
  v = await view(page);
  check((await page.evaluate(() => window.__docs()))["settings/reader"].config === "a" && JSON.stringify(v.entries.map((e) => e.buttons)) === '[["Laden","Löschen (gesperrt)"],["Laden","Für Leser","Löschen"]]',
    "a new pick frees the old entry: " + JSON.stringify(v.entries.map((e) => e.buttons)));
}));

test("the store says when the pick names a missing configuration or cannot be read", async ({ browser, check }) => {
  let { context, page, errors } = await open(browser, { seed: { "configs/a": doc("A", { ticks: 500 }, "2026-10-16T08:00:00.000Z"), "settings/reader": { config: "weg", pickedAt: "2026-10-16T09:00:00.000Z" } } });
  await openStore(page);
  let v = await view(page);
  check(v.reader === "Für Leser gewählt ist „weg“, aber diese Konfiguration gibt es nicht. Die Karte behält ihren Stand.", "a missing configuration: " + v.reader);
  check(await page.evaluate(() => TICKS) === 300 && JSON.stringify(v.entries[0].buttons) === '["Laden","Für Leser","Löschen"]', "the map keeps its state, and every entry can be picked");
  check(errors.length === 0, "no page errors");
  await context.close();
  // A refused subscription of settings: the pick cannot be read, and the map keeps its state.
  ({ context, page, errors } = await open(browser, { seed: { "configs/a": doc("A", { ticks: 500 }, "2026-10-16T08:00:00.000Z") }, failSnapshot: ["settings"] }));
  await openStore(page);
  v = await view(page);
  check(v.reader === "Die Wahl für Leser ist nicht lesbar (permission_denied). Die Karte behält ihren Stand." && await page.evaluate(() => TICKS) === 300, "a refused subscription: " + v.reader);
  check(errors.length === 0, "no page errors");
  await context.close();
  // A pick refused for the right: the store becomes read-only, as after a refused save.
  ({ context, page, errors } = await open(browser, { seed: { "configs/a": doc("A", { ticks: 500 }, "2026-10-16T08:00:00.000Z") }, refuse: "permission_denied" }));
  await openStore(page);
  await entryButton(page, "A", "Für Leser");
  v = await view(page);
  check(v.message === "Wahl für Leser abgelehnt: Diese Ansicht darf keine Konfigurationen schreiben. Laden geht weiter." && v.messageError && JSON.stringify(v.entries[0].buttons) === '["Laden"]', "permission_denied: " + v.message);
  check(!("settings/reader" in await page.evaluate(() => window.__docs())), "nothing written");
  check(errors.length === 0, "no page errors");
  await context.close();
});

test("a refused write shows an error and leaves the store readable", async ({ browser, check }) => {
  const seed = { "configs/b": doc("B", { ticks: 500 }, "2026-10-15T08:00:00.000Z") };
  let { context, page, errors } = await open(browser, { seed, refuse: "permission_denied" });
  await openStore(page);
  await saveAs(page, "X");
  let v = await view(page);
  check(v.message === "Speichern abgelehnt: Diese Ansicht darf keine Konfigurationen schreiben. Laden geht weiter." && v.messageError, "permission_denied: " + v.message);
  check(v.state === "Nur lesen: Diese Ansicht darf keine Konfigurationen speichern oder löschen." && !v.form && JSON.stringify(v.entries[0].buttons) === '["Laden"]', "read only: no form, no Für Leser, no Löschen");
  check(Object.keys(await page.evaluate(() => window.__docs())).join() === "configs/b", "nothing written");
  await entryButton(page, "B", "Laden");
  check(await page.evaluate(() => TICKS) === 500 && !(await view(page)).pageError, "Laden still works");
  check(errors.length === 0, "no page errors");
  await context.close();
  // Any other refusal fails this one save and names its reason; the store stays writable.
  ({ context, page, errors } = await open(browser, { seed, refuse: "invalid_argument" }));
  await openStore(page);
  await saveAs(page, "X");
  v = await view(page);
  check(v.message === "Speichern abgelehnt: refused by the test" && v.messageError && v.form && JSON.stringify(v.entries[0].buttons) === '["Laden","Für Leser","Löschen"]', "invalid_argument: the message, and the store stays writable: " + v.message);
  await page.evaluate(() => { window.__refuse = null; });
  await saveAs(page, "X");
  check((await view(page)).message === "Gespeichert: „X“." && !!(await page.evaluate(() => window.__docs()))["configs/x"], "the next save lands");
  check(errors.length === 0, "no page errors");
  await context.close();
  ({ context, page, errors } = await open(browser, { seed, refuse: "quota_exceeded" }));
  await openStore(page);
  await saveAs(page, "X");
  v = await view(page);
  check(v.message === "Speichern abgelehnt: Der Speicher ist voll. Lösche alte Konfigurationen und versuche es noch einmal." && v.messageError && v.form, "quota_exceeded: the form stays");
  // A short fault gets one more try, then the message names it.
  await page.evaluate(() => { window.__refuse = "unavailable"; window.__writes.length = 0; });
  await entryButton(page, "B", "Löschen"); await entryButton(page, "B", "Löschen"); await settle(page, 900);
  v = await view(page);
  check(v.message === "Löschen fehlgeschlagen (unavailable). Versuche es gleich noch einmal." && await page.evaluate(() => window.__writes.length) === 2, "unavailable: two tries, then the message");
  check(v.entries.length === 1, "B stays in the list");
  check(errors.length === 0, "no page errors");
  await context.close();
});

test("without db the store of the owner says so and the menu works as before", withPage({ db: false }, async (page, check) => {
  const NOTE = "Der Konfigurationsspeicher ist in dieser Ansicht nicht verfügbar. Alles andere funktioniert wie gewohnt, auch „Werte kopieren“ und „Werte laden“.";
  await openStore(page);
  const v = await view(page);
  check(v.state === NOTE && !v.form && !v.list, "the note, no form, no list");
  check(v.reader === "Leser sehen die Werte aus layout.js.", "the store says what readers see: " + v.reader);
  await loadLine(page, { schema: 4, ticks: 500 });
  const w = await view(page);
  check(w.page === "Geladen: 1 Wert aus der Zeile, alle übrigen aus layout.js." && !w.pageError && await page.evaluate(() => TICKS) === 500, "Werte laden works: " + w.page);
  const before = await look(page);
  await page.evaluate(() => document.getElementById("cfg-fixed").click()); await settle(page);
  check(await look(page) !== before, "a control lays the map out again");
  check(await page.evaluate(() => d3.selectAll("#map g.node").data().length) === 38, "the map has all 38 nodes");
}));

// A viewer who does not own the page and a saved copy without the runtime are readers: no menu, no start points, no
// measures, no store and no state of the browser.
const readerView = (page) => page.evaluate(() => ({
  menu: !document.getElementById("cfg").hidden || !document.getElementById("cfg-show").hidden, open: document.querySelector(".map").classList.contains("cfg-open"),
  seeds: !!document.querySelector(".seed-layer"), measures: typeof window.springMeasure, groups: document.getElementById("cfg-groups").children.length,
  storage: window.__storage ? window.__storage.filter((s) => s.endsWith("skill-springs")) : [], nodes: d3.selectAll("#map g.node").data().length,
}));
for (const [label, options] of [["a viewer who does not own the page", { owner: false, seed: { "configs/test": doc("Test", { ticks: 500 }, "2026-10-16T08:00:00.000Z") } }],
  ["a saved copy without runtime", { runtime: false }]]) {
  test(label + " gets no menu, no store and no browser state", withPage({ page: e2ePage, ...options }, async (page, check) => {
    const r = await readerView(page);
    check(!r.menu && !r.open && !r.seeds && r.measures === "undefined" && r.groups === 0, "no menu, no start points, no measures: " + JSON.stringify(r));
    check(r.storage.length === 0, "the page neither reads nor writes skill-springs: " + JSON.stringify(r.storage));
    check(r.nodes === 16 && await page.locator("#panel h2").first().innerText() === "9 Kenntnisse in 3 Bereichen", "the map and the overview of the snapshot");
    check(await page.locator("h1").innerText() === "Skill-Atlas · Alex Beispiel (Demo)" && await page.locator("#save-state").innerText() === "", "reader header, no save status");
    if (options.runtime === false) return;
    check(JSON.stringify(await page.evaluate(() => window.__paths.slice().sort())) === '["configs","groups","projects","settings","skills"]', "the page reads the pick for readers: configs and settings");
    check(await page.evaluate(() => window.__writes.length) === 0, "no writes");
  }));
}

test("a version 1 line and configuration migrate to the look of today", withPage({}, async (page, check) => {
  await openStore(page);
  const at = { sd: [-300, 0], ai: [300, 0] };
  // The same look in version 4: the flat line values in the mode of the line, the cross factors equal to the inside ones,
  // the switch Standard-Skills on and no gradient.
  const E = { schema: 4, lineMode: "mixed", likeSkill: 2, likeSkillCross: 2, likeGroup: 4, likeGroupCross: 4, ticks: 500, standardSkills: true,
    lines: { category: { lineGradient: false }, skill: { lineGradient: false }, mixed: { drawnBridges: 12, bridgeWidthMax: 5, lineGradient: false } }, at };
  await loadLine(page, E);
  const wanted = await canon(page), map = await look(page);
  await page.click("#spring-reset"); await settle(page);
  await loadLine(page, { lineMode: "mixed", drawnBridges: 12, bridgeWidthMax: 5, likeSkill: 2, likeGroup: 4, useLines: true, ticks: 500, at });
  check(await canon(page) === wanted && await look(page) === map, "the version 1 line gives the same state and map: " + map);
  const v = await view(page);
  check(v.page === "Geladen: 6 Werte aus der Zeile und 2 Startpunkte, alle übrigen aus layout.js. Die Zeile hat Schema 1 und wurde beim Laden auf Schema 4 migriert."
    + " Die Linienwerte außerhalb von „lines“ gelten für den Modus Skill-Kategorie. „Abstoßung Skills zwischen Bereichen“ und „Abstoßung Kategorien zwischen Bereichen“ haben den Wert im eigenen Bereich, wie vor der Trennung der Abstoßung."
    + " „Standard-Skills zählen mit“ und „Farbverlauf zwischen Bereichsfarben“ sind aus, wie vor diesen Einstellungen. „Standard-Skills zählen mit“ war aus, darum ist „Standard-Skills“ an."
    + " Nicht mehr im Menü und übersprungen: useLines." && !v.pageError, "message: " + v.page);
  // A full state of version 1 as a saved configuration.
  const full = await defaultsWith(page, `Object.assign(s, { lineMode: "category", ticks: 500 }); Object.assign(s.lines.category, { drawnBridges: 3, bridgeWidthMax: 10 });
    s.at = { sd: [-300, 0], ai: [300, 0] };`);
  const flat = { ...full, ...full.lines.category, useBend: 0.2 };
  delete flat.lines; delete flat.lineGradient; delete flat.standardSkills;
  await loadLine(page, { schema: 4, ...full, lines: { category: { ...full.lines.category, lineGradient: false } }, standardSkills: true });
  const wantedFull = await canon(page), mapFull = await look(page);
  await page.click("#spring-reset"); await settle(page);
  await page.evaluate(([flatValues]) => SKILL_MAP_RUNTIME.db().then((db) => db.collection("configs").doc("alt-eins").set({ name: "Alt eins", schema: 1, values: flatValues, savedAt: "2026-10-12T10:00:00.000Z" })), [flat]);
  await settle(page, 300);
  await entryButton(page, "Alt eins", "Laden");
  check(await canon(page) === wantedFull && await look(page) === mapFull, "the version 1 configuration gives the same state and map");
  check((await view(page)).page === "Konfiguration „Alt eins“ geladen. Sie hat Schema 1 und wurde beim Laden auf Schema 4 migriert. Die Linienwerte außerhalb von „lines“ gelten für den Modus Kategorie-Kategorie."
    + " „Standard-Skills zählen mit“ und „Farbverlauf zwischen Bereichsfarben“ sind aus, wie vor diesen Einstellungen. „Standard-Skills zählen mit“ war aus, darum ist „Standard-Skills“ an."
    + " Nicht mehr im Menü und übersprungen: useBend. Der gespeicherte Eintrag bleibt, wie er ist, bis du ihn neu speicherst."
    + " Nicht in der Konfiguration und aus layout.js: Linienwerte von Skill-Skill, Linienwerte von Skill-Kategorie.", "message: " + (await view(page)).page);
}));

test("a version 2 configuration and line migrate to the look of today", async ({ browser, check }) => {
  // A full state of version 4 with the switch Standard-Skills on and no gradient, the look of a version 2 state, and the
  // same state in version 2, without "standardSkills" and "lineGradient". The page has a standard skill, so the switch
  // changes the look.
  const first = await open(browser, {});
  const v4 = await defaultsWith(first.page, `Object.assign(s, { ticks: 500, lineMode: "skill", standardSkills: true }); s.lines.skill.drawnBridges = 37; s.lines.category.bridgeWidthMax = 10;
    s.at = { sd: [-300, 0], ai: [300, 0] }; Object.values(s.lines).forEach((set) => { set.lineGradient = false; });`);
  await first.context.close();
  const v2 = JSON.parse(JSON.stringify(v4)); delete v2.standardSkills; Object.values(v2.lines).forEach((set) => { delete set.lineGradient; });
  const seed = { "configs/vor-dem-farbverlauf": doc("Vor dem Farbverlauf", v2, "2026-10-16T20:00:00.000Z", 2) };
  for (const [label, variant] of [["default on", withStandardPage], ["default off", defaultOff(withStandardPage)]]) {
    const { context, page, errors } = await open(browser, { page: variant, seed });
    await openStore(page);
    await loadLine(page, { schema: 4, ...v4 });
    const wanted = await canon(page), map = await look(page);
    // Before the load the page has the switch off and the gradient on, so neither the current state nor the default decides.
    await loadLine(page, { schema: 4, ...v4, standardSkills: false, lines: Object.fromEntries(Object.entries(v4.lines).map(([m, set]) => [m, { ...set, lineGradient: true }])) });
    check(await look(page) !== map, label + ": the switch off and the gradient change the map");
    await entryButton(page, "Vor dem Farbverlauf", "Laden");
    check(await canon(page) === wanted && await look(page) === map, label + ": the version 2 configuration gives the same state and map, Standard-Skills on, no gradient");
    const v = await view(page);
    check(v.page === "Konfiguration „Vor dem Farbverlauf“ geladen. Sie hat Schema 2 und wurde beim Laden auf Schema 4 migriert. „Standard-Skills zählen mit“ und „Farbverlauf zwischen Bereichsfarben“ sind aus, wie vor diesen Einstellungen."
      + " „Standard-Skills zählen mit“ war aus, darum ist „Standard-Skills“ an. Der gespeicherte Eintrag bleibt, wie er ist, bis du ihn neu speicherst."
      && !v.pageError, label + ": message: " + v.page);
    check((await page.evaluate(() => window.__docs()))["configs/vor-dem-farbverlauf"].schema === 2, label + ": loading does not change the saved document");
    // The same values as a line without "schema": its shape says version 2.
    await page.click("#spring-reset"); await settle(page);
    await loadLine(page, v2);
    check(await canon(page) === wanted && (await view(page)).page.includes("Die Zeile hat Schema 2 und wurde beim Laden auf Schema 4 migriert."), label + ": the version 2 line without schema gives the same state");
    // A line of version 4 that does not name the setting takes the default of layout.js.
    await loadLine(page, { schema: 4, ticks: 300 });
    check(await page.evaluate(() => STANDARD_SKILLS) === (label === "default on"), label + ": a version 4 line without standardSkills takes the default");
    check(errors.length === 0, label + ": no page errors");
    await context.close();
  }
});

test("a version 3 configuration with standardLinks on or off migrates to the same look in version 4", async ({ browser, check }) => {
  // Full states of version 4 for both values of the switch, and the same states in version 3, where standardLinks is the
  // opposite of standardSkills. The page has a standard skill, so the two values give two looks.
  const first = await open(browser, { page: withStandardPage });
  const v4 = {};
  for (const skills of [true, false]) v4[skills] = await defaultsWith(first.page, `Object.assign(s, { ticks: 500, lineMode: "skill", standardSkills: ${skills} }); s.lines.skill.drawnBridges = 1000; s.at = { sd: [-300, 0], ai: [300, 0] };`);
  await first.context.close();
  const v3 = (skills) => { const v = JSON.parse(JSON.stringify(v4[skills])); delete v.standardSkills; v.standardLinks = !skills; return v; };
  // A version 3 configuration without standardLinks counts as off, so Standard-Skills is on.
  const bare = v3(true); delete bare.standardLinks;
  const seed = { "configs/links-an": doc("Links an", v3(false), "2026-10-17T08:00:00.000Z", 3), "configs/links-aus": doc("Links aus", v3(true), "2026-10-17T07:00:00.000Z", 3),
    "configs/ohne": doc("Ohne", bare, "2026-10-17T06:00:00.000Z", 3) };
  for (const [label, variant] of [["default on", withStandardPage], ["default off", defaultOff(withStandardPage)]]) {
    const { context, page, errors } = await open(browser, { page: variant, seed });
    await openStore(page);
    const want = {};
    for (const skills of [true, false]) { await loadLine(page, { schema: 4, ...v4[skills] }); want[skills] = { state: await canon(page), map: await look(page) }; }
    check(want[true].map !== want[false].map && want[true].map.includes("| 154 Linien |") && want[false].map.includes("| 169 Linien |"),
      label + ": Standard-Skills on and off give two looks: " + want[true].map + " / " + want[false].map);
    for (const [name, links, skills] of [["Links an", true, false], ["Links aus", false, true], ["Ohne", null, true]]) {
      // Before the load the page shows the other value, so neither the current state nor the default decides.
      await loadLine(page, { schema: 4, ...v4[!skills] });
      await entryButton(page, name, "Laden");
      check(await canon(page) === want[skills].state && await look(page) === want[skills].map, `${label}: „${name}“ gives the state and the map of Standard-Skills ${skills ? "on" : "off"}`);
      const v = await view(page);
      check(v.page === `Konfiguration „${name}“ geladen. Sie hat Schema 3 und wurde beim Laden auf Schema 4 migriert. „Standard-Skills zählen mit“ war ${links ? "an" : "aus"}, darum ist „Standard-Skills“ ${skills ? "an" : "aus"}.`
        + " Der gespeicherte Eintrag bleibt, wie er ist, bis du ihn neu speicherst." && !v.pageError, `${label}: „${name}“: message: ` + v.page);
      check(await page.evaluate(() => !("standardLinks" in springCurrent()) && !("standardLinks" in JSON.parse(document.getElementById("spring-values").value))), `${label}: „${name}“: no standardLinks in the state or the line`);
    }
    const docs = await page.evaluate(() => window.__docs());
    check(["links-an", "links-aus", "ohne"].every((id) => docs["configs/" + id].schema === 3 && !("standardSkills" in docs["configs/" + id].values)), label + ": loading does not change the saved documents");
    // The same values as lines without "schema": standardLinks gives the shape of version 3.
    for (const skills of [true, false]) {
      await loadLine(page, { schema: 4, ...v4[!skills] });
      await loadLine(page, v3(skills));
      check(await canon(page) === want[skills].state && (await view(page)).page.includes("Die Zeile hat Schema 3 und wurde beim Laden auf Schema 4 migriert."), `${label}: a version 3 line without schema and with standardLinks ${!skills ? "on" : "off"} gives the same state`);
    }
    check(errors.length === 0, label + ": no page errors");
    await context.close();
  }
});

test("a newer schema loads the keys it knows and names the rest", withPage({}, async (page, check) => {
  const T = await defaultsWith(page, `Object.assign(s, { ticks: 500, lineMode: "skill" }); s.lines.skill.drawnBridges = 37; s.at = { sd: [-300, 0], ai: [300, 0] };`);
  await loadLine(page, { schema: 4, ...T });
  const wanted = await canon(page);
  await page.click("#spring-reset"); await settle(page);
  const values = { ...T, friction: "hoch", lines: { ...T.lines, skill: { ...T.lines.skill, futureLine: true }, future: { drawnBridges: 3 } }, at: { ...T.at, neu: [0, 0] }, futureKnob: 3 };
  await page.evaluate((v) => SKILL_MAP_RUNTIME.db().then((db) => db.collection("configs").doc("von-morgen").set({ name: "Von morgen", schema: 5, values: v, savedAt: "2026-10-17T10:00:00.000Z" })), values);
  await settle(page, 300);
  await openStore(page);
  check((await view(page)).entries[0].meta === "17.10.2026, 12:00 · Schema 5 · neuer als diese Seite", "the list marks the newer schema");
  await entryButton(page, "Von morgen", "Laden");
  const v = await view(page);
  check(v.page === "Konfiguration „Von morgen“ geladen. Sie hat Schema 5, diese Seite kennt Schema 4. Geladen sind die Werte, die diese Seite kennt."
    + " Unbekannt und übersprungen: lines.skill.futureLine, lines.future, at.neu, futureKnob. Unpassend und übersprungen: friction. Der gespeicherte Eintrag bleibt, wie er ist, bis du ihn neu speicherst."
    + " Nicht in der Konfiguration und aus layout.js: friction." && !v.pageError, "message: " + v.page);
  check(await canon(page) === wanted, "every known value loads, and friction takes the value of layout.js");
}));

test("unknown keys in a line are named, a line of unknown keys loads nothing", withPage({}, async (page, check) => {
  await loadLine(page, '{"schema":4,"ticks":500,"tiks":300,"lines":{"skill":{"drawnBridges":37,"breite":2}}}');
  let v = await view(page);
  check(v.page === "Geladen: 1 Wert aus der Zeile und 1 Linienwert für 1 Modus, alle übrigen aus layout.js. Unbekannt und übersprungen: tiks, lines.skill.breite." && !v.pageError, "message: " + v.page);
  check(await page.evaluate(() => TICKS === 500 && springCurrent().lines.skill.drawnBridges === 37), "the known values load");
  await loadLine(page, '{"tiks":300}');
  v = await view(page);
  check(v.page === "Kein Wert der Zeile ist bekannt: tiks. Nichts geladen." && v.pageError && await page.evaluate(() => TICKS) === 500, "only unknown keys: an error, nothing loads");
  await loadLine(page, '{"schema":4,"ticks":"viele"}');
  check((await view(page)).page === "Falscher Typ bei: ticks. Nichts geladen.", "a wrong type of the current schema still loads nothing");
  await loadLine(page, '{"schema":"drei"}');
  check((await view(page)).page === "Falscher Typ bei: schema. Nichts geladen.", "a schema that is no number loads nothing");
}));

test("the values line and the stored state carry the schema; an old stored state migrates", async ({ browser, check }) => {
  let { context, page, errors } = await open(browser, {});
  const line = await page.evaluate(() => document.getElementById("spring-values").value), stored = await page.evaluate(() => JSON.parse(localStorage.getItem("skill-springs") || "null"));
  // A full state of version 3 with "Standard-Skills zählen mit" on, as a page of version 3 stored it.
  const v3stored = await defaultsWith(page, `Object.assign(s, { ticks: 500 }); delete s.standardSkills; s.standardLinks = true;`);
  check(line.startsWith('{"schema":4,') && JSON.parse(line).lines && !("schema" in JSON.parse(line).lines), "Werte kopieren starts with schema 4");
  check(JSON.parse(line).standardSkills === true && !("standardLinks" in JSON.parse(line)), "the line carries standardSkills, not standardLinks");
  await page.evaluate(() => document.getElementById("cfg-fixed").click()); await settle(page);
  check((await page.evaluate(() => JSON.parse(localStorage.getItem("skill-springs")))).schema === 4, "the stored state carries schema 4");
  await loadLine(page, await page.evaluate(() => document.getElementById("spring-values").value));
  const top = KEYS4.top.length, perMode = KEYS4.lines.length;
  check((await view(page)).page === `Geladen: ${top} Werte aus der Zeile, ${3 * perMode} Linienwerte für 3 Modi und 2 Startpunkte, alle übrigen aus layout.js.`, "the copied line loads without migration: " + (await view(page)).page);
  check(stored === null, "a fresh page stores nothing before the first change");
  check(errors.length === 0, "no page errors");
  await context.close();
  // The page starts from the configuration for readers, not from the state of the browser. "Letzter Stand im Browser"
  // loads that state through the same steps as a saved configuration.
  const fromBrowser = async (state) => {
    ({ context, page, errors } = await open(browser, { stored: state }));
    const start = await page.evaluate(() => JSON.stringify(springCurrent()) === JSON.stringify(SPRING_DEFAULTS) && !document.getElementById("spring-browser").disabled);
    await page.click("#spring-browser"); await settle(page);
    return start;
  };
  // A state that a page of version 1 stored: flat line values for Kategorie-Kategorie, from before the split of the repulsion.
  check(await fromBrowser({ pull: 0.05, lineMode: "category", drawnBridges: 3, likeGroup: 4, ticks: 500 }), "with an old stored state the page starts from layout.js, and the button is free");
  check(await page.evaluate(() => { const v = springCurrent(); return v.lineMode === "category" && v.lines.category.drawnBridges === 3 && v.likeGroupCross === 4 && v.ticks === 500 && v.standardSkills === true && !("standardLinks" in v) && !v.lines.category.lineGradient; }),
    "Letzter Stand im Browser loads the old stored state through the same steps");
  check(await page.evaluate(() => document.querySelectorAll("path.shared-line").length) === 3, "the map draws its 3 lines");
  const message = (await view(page)).page;
  check(message.startsWith("Letzter Stand im Browser geladen. Er hat Schema 1 und wurde beim Laden auf Schema 4 migriert.") && !message.includes("gespeicherte Eintrag"), "page message: " + message);
  check((await page.evaluate(() => JSON.parse(localStorage.getItem("skill-springs")))).schema === 4, "the loaded state is stored again, in schema 4");
  check(errors.length === 0, "no page errors");
  await context.close();
  // A state that a page of version 3 stored with "Standard-Skills zählen mit" on loads with the switch off.
  check(await fromBrowser({ schema: 3, ...v3stored }), "with a stored state of version 3 the page starts from layout.js");
  check(await page.evaluate(() => { const v = springCurrent(); return v.standardSkills === false && STANDARD_SKILLS === false && !("standardLinks" in v) && v.ticks === 500 && document.getElementById("cfg-standardSkills").checked === false; }),
    "a stored state of version 3 with standardLinks on loads with Standard-Skills off");
  check(errors.length === 0, "no page errors");
  await context.close();
});

test("Letzter Stand im Browser waits for a stored state", withPage({}, async (page, check) => {
  check(await page.evaluate(() => document.getElementById("spring-browser").disabled), "a fresh browser has no state, so the button is locked");
  await loadLine(page, { schema: 4, ticks: 500 });
  check(await page.evaluate(() => !document.getElementById("spring-browser").disabled), "after the first layout the state is stored, and the button is free");
  await page.click("#spring-reset"); await settle(page);
  check(await page.evaluate(() => TICKS) === 300, "Werte aus layout.js");
  await page.click("#spring-browser"); await settle(page);
  check(await page.evaluate(() => TICKS) === 300 && (await view(page)).page === "Letzter Stand im Browser geladen, Schema 4 wie diese Seite.", "the stored state is the last layout: " + (await view(page)).page);
}));

test("schema guard: SPEC, SPRING_SCHEMA, the steps and schema.json agree", withPage({}, async (page, check) => {
  check(schemaProblems(LAYOUT).length === 0, "the built layout agrees with schema.json: " + schemaProblems(LAYOUT).join(" "));
  const renamed = LAYOUT.replace('{"key":"ticks"', '{"key":"tickz"');
  check(JSON.stringify(schemaProblems(renamed)) === JSON.stringify(["SPEC changed: raise SPRING_SCHEMA and add a migration step. Version 4 in tests/settings/schema.json differs: new in SPEC (top): tickz; gone from SPEC (top): ticks."]),
    "a renamed setting fails: " + schemaProblems(renamed).join(" "));
  const lineAdded = LAYOUT.replace('{"key":"bridgeBend"', '{"key":"lineDash","name":"LINE_DASH","label":"Strich","bool":true,"look":"dash"},{"key":"bridgeBend"');
  check(schemaProblems(lineAdded)[0] === "SPEC changed: raise SPRING_SCHEMA and add a migration step. Version 4 in tests/settings/schema.json differs: new in SPEC (lines): lineDash.", "a new line setting fails");
  // The switch replaced standardLinks: a page with the old key and without the new one fails against version 4.
  const oldSwitch = LAYOUT.replace('{"key":"standardSkills"', '{"key":"standardLinks"');
  check(schemaProblems(oldSwitch)[0] === "SPEC changed: raise SPRING_SCHEMA and add a migration step. Version 4 in tests/settings/schema.json differs: new in SPEC (top): standardLinks; gone from SPEC (top): standardSkills.", "the old switch fails against version 4");
  const noTwo = JSON.parse(JSON.stringify(SCHEMA)); delete noTwo.versions["2"];
  check(JSON.stringify(schemaProblems(LAYOUT, noTwo)) === '["schema.json has no entry for version 2"]', "a missing version fails");
  check(await page.evaluate(() => SPRING_SCHEMA === 4 && SPRING_STEPS.length === SPRING_SCHEMA - 1), "SPRING_SCHEMA is 4 with 3 steps");
  check(Object.keys(SCHEMA.versions).join() === "1,2,3,4", "schema.json has the versions 1, 2, 3 and 4");
  // A full state of each old version, built from the keys of schema.json, becomes a full state of version 4.
  const result = await page.evaluate(([v1, v2, v3]) => {
    const value = (k) => { const s = SPRING_DEFAULTS; return k === "standardLinks" ? false : k in s ? s[k] : s.lines.skill[k]; };
    const linesOf = (v) => Object.fromEntries(SPRING_MODES.map((m) => [m, Object.fromEntries(v.lines.map((k) => [k, SPRING_DEFAULTS.lines[m][k]]))]));
    const full1 = { ...Object.fromEntries(v1.top.map((k) => [k, value(k)])), lineMode: "skill", at: SPRING_DEFAULTS.at };
    const full2 = { ...Object.fromEntries(v2.top.map((k) => [k, value(k)])), lines: linesOf(v2), at: SPRING_DEFAULTS.at };
    const full3 = { ...Object.fromEntries(v3.top.map((k) => [k, value(k)])), lines: linesOf(v3), at: SPRING_DEFAULTS.at };
    const keys = (r) => ({ top: Object.keys(r.values).filter((k) => k !== "lines" && k !== "at").sort(), lines: Object.fromEntries(Object.entries(r.values.lines).map(([m, set]) => [m, Object.keys(set).sort()])), from: r.from });
    return { one: keys(springMigrate(full1)), two: keys(springMigrate(full2)), three: keys(springMigrate(full3)), shape3: springShape(full3), shape4: springShape(springMigrate(full3).values) };
  }, [SCHEMA.versions["1"], SCHEMA.versions["2"], SCHEMA.versions["3"]]);
  const top4 = JSON.stringify([...KEYS4.top].sort()), lines4 = JSON.stringify([...KEYS4.lines].sort());
  check(result.one.from === 1 && JSON.stringify(result.one.top) === top4 && JSON.stringify(result.one.lines.skill) === lines4 && JSON.stringify(result.one.lines.category) === '["lineGradient"]',
    "a full version 1 state has every key of version 4 for its mode");
  check(result.two.from === 2 && JSON.stringify(result.two.top) === top4 && Object.values(result.two.lines).every((l) => JSON.stringify(l) === lines4), "a full version 2 state has every key of version 4 in every mode");
  check(result.three.from === 3 && JSON.stringify(result.three.top) === top4 && Object.values(result.three.lines).every((l) => JSON.stringify(l) === lines4), "a full version 3 state has every key of version 4 in every mode");
  check(result.shape3 === 3 && result.shape4 === 4, "without schema, a full version 3 state has the shape of version 3, and its migration the shape of version 4");
  // The step from 3 to 4 alone: standardSkills is the opposite of standardLinks, and a missing standardLinks counts as off.
  // A standardLinks that is no switch stays and is named as unknown; values that name standardSkills keep it.
  const step = await page.evaluate(() => [{ standardLinks: true }, { standardLinks: false }, {}, { standardLinks: "ja" }, { standardLinks: true, standardSkills: true }]
    .map((v) => { const r = SPRING_STEPS[2]({ ...v, lines: {} }); return [r.values.standardSkills === undefined ? "-" : r.values.standardSkills, "standardLinks" in r.values ? r.values.standardLinks : "-", r.standard]; }));
  check(JSON.stringify(step) === JSON.stringify([[false, "-", { links: true, skills: false }], [true, "-", { links: false, skills: true }], [true, "-", { links: false, skills: true }], ["-", "ja", null], [true, "-", null]]),
    "step 3 to 4: on gives off, off and missing give on, a wrong type stays, a given standardSkills stays: " + JSON.stringify(step));
}));

run(tests, { pool: 4, only: process.argv.slice(2) }).then(async (ok) => { await site.close(); process.exitCode = ok ? 0 : 1; });

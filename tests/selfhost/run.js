// Browser tests of the self-hosted site (stage a): the start page, the example map, new maps, the editing of areas,
// stations, categories, skills and projects, the map file, the storage of the browser and the screenshots.
// It serves dist/selfhost/ (node build_selfhost.js) on 127.0.0.1, and every test fails on a request to another host.
// Usage: node tests/selfhost/run.js [part of a test name ...]    E2E_VERBOSE=1 prints every check.
// A test that does not end within 6 minutes fails with its name (E2E_TEST_LIMIT_S of tests/e2e/harness.js changes it).
const fs = require("fs"), path = require("path");
const { run, runOne } = require("../e2e/harness");
const { chooseLanguage, englishOf, germanIn, textOf, pdfText } = require("../e2e/site");
const { serve } = require("./server");
const { fakeApi } = require("./fake-api");
const repo = path.join(__dirname, "..", "..");
const SITE = path.join(repo, "dist", "selfhost"), OUT = path.join(__dirname, "out");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Keys in a fixed order, so two documents compare by content.
const sorted = (x) => Array.isArray(x) ? x.map(sorted) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sorted(x[k])])) : x;
const KEY = "it-skills-map/";

if (!fs.existsSync(path.join(SITE, "index.html"))) { console.error("dist/selfhost is missing: run node build_selfhost.js first"); process.exit(1); }
// The data of the CV map, as the build reads it.
const DATA = new Function(fs.readFileSync(path.join(repo, "skills", "data.js"), "utf8") + "\nreturn { COLORS, CLUSTERS, GROUPS, SKILLS, PROJECTS, WHERE, STANDARD };")();
const FIXTURE = new Function(fs.readFileSync(path.join(repo, "tests", "e2e", "fixture.js"), "utf8") + "\nreturn { COLORS, CLUSTERS, GROUPS, SKILLS, PROJECTS, WHERE, STANDARD };")();

// The collections of a map from data in the shape of skills/data.js, for test maps with content.
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
const FIXTURE_PROJECTS = JSON.parse(fs.readFileSync(path.join(repo, "tests", "e2e", "fixture.projects.json"), "utf8"));
// The default set of a new map (selfhost/site/default-set.js) with the names of a language: its title, its collections,
// its categories as [id, area, name] and its skills as [name, category, rating, stations], in the order of the page.
const CATALOGS = require(path.join(repo, "i18n", "tools", "catalogs.js")).texts();
function defaultSetIn(language) {
  const text = (key) => CATALOGS[language][key] || CATALOGS.en[key];
  const set = new Function("t", "return (" + fs.readFileSync(path.join(repo, "selfhost", "site", "default-set.js"), "utf8") + "\n);")(text);
  const byOrder = (docs) => Object.entries(docs).sort(([, a], [, b]) => a.order - b.order);
  return { title: set.title, empty: set.empty, collections: set.collections, areas: byOrder(set.collections.areas).map(([, a]) => a.name),
    groups: byOrder(set.collections.groups).map(([id, g]) => [id, g.area, g.name]),
    skills: byOrder(set.collections.skills).map(([, x]) => [x.name, x.group, x.rating, x.places.join(" ")]) };
}
const entryOf = (title, collections) => ({ format: "it-skills-map", schema: 1, title, createdAt: "2026-10-18T08:00:00.000Z", updatedAt: "2026-10-18T08:00:00.000Z", collections });

let server = null;
const tests = [];
const test = (name, fn, known) => tests.push({ name, fn, known });

// A browser context on the site. maps: entries of localStorage at the first load ({ id: entry }). init: a script that
// runs before every page. Every request must stay on the server of the test.
// language: the language of the pages, German by default (tests/e2e/site.js); null keeps English of a first visit.
async function site(browser, { colorScheme = "light", viewport = { width: 1400, height: 900 }, maps = null, init = null, language = "de" } = {}) {
  const context = await browser.newContext({ colorScheme, viewport, reducedMotion: "reduce", acceptDownloads: true });
  if (language) await context.addInitScript(chooseLanguage, language);
  const external = [], errors = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(server.origin + "/")) return route.continue();
    external.push(url);
    return route.abort();
  });
  // The seed runs once per tab, and only in pages of the site (not in an empty frame).
  if (maps) await context.addInitScript(([entries, key, origin]) => {
    if (location.origin !== origin) return;
    try {
      if (sessionStorage.getItem("seeded")) return;
      Object.entries(entries).forEach(([id, entry]) => localStorage.setItem(key + id, JSON.stringify(entry)));
      sessionStorage.setItem("seeded", "1");
    } catch (error) { /* a frame without storage */ }
  }, [maps, KEY, server.origin]);
  if (init) await context.addInitScript(init);
  const watch = (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("request", (request) => { const url = request.url(); if (!url.startsWith(server.origin + "/") && !/^(blob|data):/.test(url)) external.push(url); });
  };
  context.on("page", watch);
  const page = await context.newPage();
  return { context, page, errors, external };
}
// Runs body on a page of the site and fails the test on a console error or a request to another host.
const withSite = (options, body) => async ({ browser, check }) => {
  const s = await site(browser, options);
  try { await body(s.page, check, s); } finally {
    check(s.errors.length === 0, "no console errors" + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
    check(s.external.length === 0, "no request leaves localhost" + (s.external.length ? ": " + [...new Set(s.external)].join(", ") : ""));
    await s.context.close();
  }
};
const go = (page, rel) => page.goto(server.url + rel);
// The map page has drawn its panel, and for the owner its database has answered.
async function mapReady(page, owner = true) {
  await page.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 });
  if (owner) await page.waitForFunction(() => document.getElementById("save-state").textContent === "Gespeichert" && document.getElementById("cfg-groups").children.length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(250);
}
const saved = (page) => page.waitForFunction(() => document.getElementById("save-state").textContent === "Gespeichert", null, { timeout: 10000 }).then(() => page.waitForTimeout(150));
const h2 = (page) => page.locator("#panel h2").first().innerText();
const panelText = (page) => page.locator("#panel").innerText();
const stored = (page) => page.evaluate((key) => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith(key)).map((k) => [k.slice(key.length), JSON.parse(localStorage.getItem(k))])), KEY);
const mapIdOf = (page) => new URL(page.url()).searchParams.get("id");
async function clickPanel(page, text, selector = "button") { await page.locator("#panel " + selector, { hasText: text }).first().click(); await page.waitForTimeout(120); }
async function submitForm(page) { await page.locator("#catalog-form button[type=submit]").click(); await page.waitForTimeout(250); }
// Clicks the node of a skill, category or area in the map.
async function clickNode(page, id) {
  const p = await page.evaluate((i) => {
    const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__.id === i);
    if (!g) return null;
    const box = g.querySelector("circle.hit").getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, id);
  if (!p) throw new Error("no node " + id);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
// Picks a file in the file input of the page, from text.
const pick = (page, selector, name, text) => page.setInputFiles(selector, { name, mimeType: "application/json", buffer: Buffer.from(text, "utf8") });
async function exportFrom(page, selector) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), page.click(selector)]);
  return { name: download.suggestedFilename(), text: fs.readFileSync(await download.path(), "utf8") };
}

// Start page and example map
test("start page: the text, the buttons, the storage warning and the example map read-only", withSite({}, async (page, check) => {
  await go(page, "");
  check((await page.locator("h1").innerText()) === "Skill-Map" && (await page.title()) === "Skill-Map · Kenntnisse als Netz", "title and heading");
  const text = await page.locator("main").innerText();
  check(text.includes("Der Server speichert nichts.") && text.includes("Deine Maps liegen nur in diesem Browser."), "it says that the server stores nothing");
  check(text.includes("Die exportierte Datei ist die einzige sichere Kopie.") && text.includes("Der Browser kann diesen Speicher verlieren"), "it says that the browser can lose its storage and the export is the only safe copy");
  for (const label of ["Neue Map mit Standardvorlage", "Leere Map", "Map-Datei öffnen"]) check(await page.locator("main button", { hasText: label }).count() === 1, "button " + label);
  check(await page.locator("#map-empty").isVisible() && await page.locator("#map-list li").count() === 0, "no map in this browser yet");
  check(!(await page.evaluate(() => document.body.innerText)).includes("Alex Beispiel"), "the start page itself names nobody");
  const fonts = await page.evaluate(() => document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "") + " " + f.weight)));
  check(fonts.includes("Archivo 400") && fonts.includes("Archivo 700") && fonts.includes("IBM Plex Mono 500"), "the fonts load from the site: " + fonts.join(", "));
  const links = await page.locator("footer a").evaluateAll((all) => all.map((a) => a.getAttribute("href")));
  check(same(links, ["imprint.html", "privacy.html", "ai.html", "license.txt", "vendor/licenses/d3-ISC.txt", "vendor/licenses/Archivo-OFL.txt", "vendor/licenses/IBM-Plex-Mono-OFL.txt", "vendor/licenses/Noto-Sans-OFL.txt", "vendor/licenses/zxcvbn-MIT.txt", "vendor/licenses/zxcvbn-ts-MIT.txt", "vendor/licenses/OpenSubtitles-OPUS-ODC-BY.txt"]), "footer: Impressum, Datenschutz and the licenses, as relative links");
  const frame = page.frame({ url: /example\.html$/ });
  check(!!frame, "the example map is embedded");
  await frame.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const v = await frame.evaluate(() => ({ h1: document.getElementById("title").textContent, cfg: !document.getElementById("cfg").hidden || !document.getElementById("cfg-show").hidden,
    groups: document.getElementById("cfg-groups").children.length, add: document.querySelectorAll("#panel .add, #panel [data-act^='new'], #panel [data-act^='edit']").length,
    exp: !!document.getElementById("file-export") && !document.getElementById("file-export").hidden, open: !!document.getElementById("file-open"), state: document.getElementById("save-state").textContent }));
  check(v.h1 === "Skill-Atlas · Alex Beispiel (Demo)" && !v.cfg && v.groups === 0 && v.add === 0 && !v.exp && v.state === "", "the example is his map as a reader: no force menu, no editor controls, no export: " + JSON.stringify(v));
  check(v.open, "the example offers Map-Datei öffnen");
  // The choice of the language is the one entry of the test itself.
  check(await page.evaluate(() => Object.keys(localStorage).filter((k) => k !== "skill-map-language").length) === 0, "the visit stores nothing in the browser");
}));

test("example map: the data, projects and configuration of the map file, for readers", withSite({}, async (page, check) => {
  // The map file is his data of skills/, written by node save_example.js after each export from the live editor.
  const { exampleMap } = require(path.join(repo, "save_example.js"));
  const file = JSON.parse(fs.readFileSync(path.join(repo, "selfhost", "site", "example.it-skills-map.json"), "utf8"));
  check(JSON.stringify(file.collections) === JSON.stringify(exampleMap().collections) && Object.keys(file.collections.skills).length === DATA.SKILLS.length,
    "selfhost/site/example.it-skills-map.json holds the data, projects and configurations of skills/ (node save_example.js writes it)");
  await go(page, "example.html");
  await mapReady(page, false);
  check((await h2(page)) === `${DATA.SKILLS.length} Kenntnisse in ${DATA.CLUSTERS.length} Bereichen`, "all skills in the six areas: " + await h2(page));
  const pick = file.collections.settings.reader.config;
  const pickState = await page.evaluate((c) => {
    const sort = (x) => Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
    return JSON.stringify(sort(springCurrent())) === JSON.stringify(sort(springConfigState(c)));
  }, { id: pick, ...file.collections.configs[pick] });
  check(pickState, `the map shows the configuration for readers of the map file, "${pick}"`);
  await page.locator("#projects-btn").click(); await page.waitForTimeout(150);
  check(await page.locator("#panel .plist li").count() > 0 && await page.locator("#panel button.add, #panel button.primary").count() === 0, "a reader sees the projects and no editing");
  check(await page.locator("a.tool-link", { hasText: "Start" }).getAttribute("href") === "index.html", "a link back to the start page");
}));

// The note below "Private Projekte" (B9 of the review) was a text of his CV in the page code. It is a field of the map
// file now, settings/texts.privateNote, and the example map shows it in the same place.
const NOTE = "In der Freizeit mit eigenen Abonnements von KI-Anbietern umgesetzt.";
const noteAfterPrivate = (page) => page.evaluate(() => {
  const head = [...document.querySelectorAll("#panel h3")].find((h) => h.textContent === "Private Projekte"), next = head && head.nextElementSibling;
  return { head: !!head, note: next && next.matches("p.muted") ? next.textContent : null };
});
test("the note below Private Projekte comes from the map file, not from the page code", withSite({ maps: {
  m1: entryOf("Mit Notiz", { ...collectionsOf(FIXTURE, FIXTURE_PROJECTS), settings: { texts: { privateNote: "Eigene Notiz zu den privaten Projekten." } } }), m2: entryOf("Ohne Notiz", collectionsOf(FIXTURE, FIXTURE_PROJECTS)) } }, async (page, check) => {
  check(!fs.readFileSync(path.join(SITE, "assets", "page.js"), "utf8").includes("Abonnements"), "the page code of the site holds no text of his CV");
  const file = JSON.parse(fs.readFileSync(path.join(repo, "selfhost", "site", "example.it-skills-map.json"), "utf8"));
  check(file.collections.settings && same(file.collections.settings.texts, { privateNote: NOTE }), "the example map file holds the note: " + JSON.stringify(file.collections.settings));
  await go(page, "example.html");
  await mapReady(page, false);
  check(same(await noteAfterPrivate(page), { head: true, note: NOTE }), "the example map shows it right below Private Projekte");
  await go(page, "map.html?id=m1");
  await mapReady(page);
  check(same(await noteAfterPrivate(page), { head: true, note: "Eigene Notiz zu den privaten Projekten." }), "a map of a visitor shows the note of its file");
  await go(page, "map.html?id=m2");
  await mapReady(page);
  check(same(await noteAfterPrivate(page), { head: true, note: null }), "a map without the field shows no note");
}));

// New maps
test("a new map from the default set: three areas with two categories and two skills each, the owner controls, no stations", withSite({}, async (page, check) => {
  await go(page, "");
  await page.click("#new-default");
  await page.waitForURL(/map\.html\?id=/);
  await mapReady(page);
  const de = defaultSetIn("de");
  check((await page.locator("#title").innerText()) === "Meine Skills" && (await page.title()) === "Meine Skills · Skill-Map" && de.title === "Meine Skills", "the title of the map");
  check((await h2(page)) === "12 Kenntnisse in 3 Bereichen", "twelve skills in three areas: " + await h2(page));
  check(same(await page.locator("#areas .chip").allInnerTexts(), ["Softwareentwicklung", "Daten", "Arbeitsweisen"]), "the area chips of the default set");
  const v = await page.evaluate(() => ({ cfg: !document.getElementById("cfg").hidden, exp: !document.getElementById("file-export").hidden, stations: Object.keys(PROJECTS).length,
    groups: GROUPS.map(([id, area, name]) => [id, area, name]), skills: SKILLS.map(([name, group, rating, places]) => [name, group, rating, places]) }));
  check(v.cfg && v.exp, "the owner gets the force menu and Exportieren");
  check(v.stations === 0 && same(v.groups, de.groups), "no stations, and the six categories in their areas: " + JSON.stringify(v.groups));
  check(same(v.skills, de.skills), "the twelve skills in their categories, rated 1, without stations: " + JSON.stringify(v.skills));
  check(await page.locator("#panel button", { hasText: "+ Bereich" }).count() === 1 && await page.locator("#panel button", { hasText: "+ Station" }).count() === 1, "+ Bereich and + Station");
  check(await page.locator("#timebar").isHidden(), "without stations the time range control is hidden");
  await page.locator("#areas .chip", { hasText: "Daten" }).click(); await page.waitForTimeout(150);
  check(await page.locator("#panel button", { hasText: "+ Kategorie" }).count() === 1 && await page.locator("#panel button", { hasText: "Bereich bearbeiten" }).count() === 1, "an area offers + Kategorie and Bereich bearbeiten");
  check(same(await page.locator("#panel h3").allTextContents(), ["Datenbanken", "Analyse"]), "its categories");
  check(!(await page.evaluate(() => document.body.innerText)).includes("Alex Beispiel"), "no text names the person of the example");
  const maps = await stored(page), entry = maps[mapIdOf(page)];
  check(Object.keys(maps).length === 1 && Object.keys(entry.collections).sort().join() === "areas,groups,skills", "one map in the browser, with areas, groups and skills");
  check(same(sorted(entry.collections), sorted(de.collections)), "the stored map is the default set of selfhost/site/default-set.js with the German names");
}));

test("an empty map works: the owner adds the first area and category", withSite({}, async (page, check) => {
  await go(page, "");
  await page.click("#new-empty");
  await page.waitForURL(/map\.html\?id=/);
  await mapReady(page);
  check((await page.locator("#title").innerText()) === "Neue Skill-Map" && (await h2(page)) === "0 Kenntnisse in 0 Bereichen", "an empty map");
  check((await panelText(page)).includes("Noch keine Bereiche.") && (await panelText(page)).includes("Noch keine Stationen."), "it says what comes first");
  check(await page.evaluate(() => { const t = d3.zoomTransform(document.getElementById("map")); return [t.k, t.x, t.y].every(Number.isFinite); }), "the map has a finite zoom");
  await clickPanel(page, "+ Bereich");
  await page.fill("#cf-name", "Erster Bereich");
  await submitForm(page);
  check((await h2(page)) === "Erster Bereich" && same(await page.locator("#areas .chip").allInnerTexts(), ["Erster Bereich"]), "the first area");
  await clickPanel(page, "+ Kategorie");
  await page.fill("#cf-name", "Erste Kategorie");
  await submitForm(page);
  check((await h2(page)) === "Erste Kategorie", "the first category");
  await saved(page);
  const entry = (await stored(page))[mapIdOf(page)];
  check(same(entry.collections.areas, { "erster-bereich": { name: "Erster Bereich", color: "#2c5fc4", at: [0, 0], order: 0 } }), "the area document: " + JSON.stringify(entry.collections.areas));
  check(same(entry.collections.groups, { "erster-bereich-erste-kategorie": { name: "Erste Kategorie", area: "erster-bereich", order: 0 } }), "the category document");
}));

// Editing and the map file
test("the owner creates an area, a station, a category, a skill and a project; reload, export, delete and import keep them", withSite({}, async (page, check, s) => {
  await go(page, "");
  await page.click("#new-default");
  await page.waitForURL(/map\.html\?id=/);
  await mapReady(page);
  const id = mapIdOf(page);
  await clickPanel(page, "+ Bereich");
  check((await page.inputValue("#cf-color")) === "#7a4ca6", "a new area suggests a color that no area has");
  await page.fill("#cf-name", "Testbereich");
  await page.fill("#cf-color", "#8a3f7a");
  await page.fill("#cf-x", "420"); await page.fill("#cf-y", "260");
  await submitForm(page);
  check((await h2(page)) === "Testbereich" && (await page.locator("#areas .chip").allInnerTexts()).at(-1) === "Testbereich", "the area is on the map and in the header");
  check(await page.evaluate(() => getComputedStyle(document.querySelector("#areas .chip.k-testbereich i")).backgroundColor) === "rgb(138, 63, 122)", "with its color");
  await clickPanel(page, "+ Kategorie");
  await page.fill("#cf-name", "Testkategorie");
  await submitForm(page);
  check((await h2(page)) === "Testkategorie", "the category");
  await page.click("#panel .back"); await page.waitForTimeout(100);
  await clickPanel(page, "+ Station");
  await page.fill("#cf-name", "Testfirma GmbH"); await page.fill("#cf-short", "Testfirma");
  await page.fill("#cf-when", "03.2019 – 12.2022");
  await page.fill("#cf-note", "Entwicklung von Testsystemen.");
  await submitForm(page);
  check((await h2(page)) === "Testfirma GmbH" && (await page.locator("#panel .crumb").innerText()) === "Arbeitgeber · 03.2019 – 12.2022", "the station with its kind and dates");
  check(await page.locator("#timebar").isVisible() && await page.locator("#time-places .time-place").count() === 1, "the time range control shows the station");
  // The skill in the new category, used at the new station.
  await page.locator("#areas .chip", { hasText: "Testbereich" }).click(); await page.waitForTimeout(150);
  await page.locator("#panel h3 .linkbtn", { hasText: "Testkategorie" }).click(); await page.waitForTimeout(150);
  await clickPanel(page, "+ Skill");
  await page.fill("#cf-name", "Testkenntnis");
  await page.selectOption("#cf-rating", "3");
  await page.locator('input[name="cf-place"][value="TESTFIRMA"]').check();
  await submitForm(page);
  check((await h2(page)) === "Testkategorie" && await page.locator("#panel .chips", { hasText: "Testkenntnis" }).count() === 1, "a new skill returns to its category");
  await page.locator("#panel .chips").getByText("Testkenntnis").first().click(); await page.waitForTimeout(150);
  check((await h2(page)) === "Testkenntnis" && (await page.locator("#panel .list .linkbtn").allInnerTexts()).join() === "Testfirma GmbH", "the skill and its station");
  // A project at the station with the skill.
  await page.click("#projects-btn"); await page.waitForTimeout(100);
  await clickPanel(page, "Neues Projekt");
  await page.fill("#pf-name", "Testprojekt");
  await page.selectOption("#pf-station", "TESTFIRMA");
  await page.locator("#project-form button[type=submit]").click(); await page.waitForTimeout(200);
  await clickPanel(page, "Skills zuweisen");
  await clickNode(page, "s:Testkenntnis");
  await page.click("#editbar-done"); await page.waitForTimeout(200);
  check((await page.locator("#panel h3").first().innerText()).toLowerCase() === "1 kenntnis", "the project has the skill");
  await saved(page);
  const before = (await stored(page))[id].collections;
  check(!!before.stations.TESTFIRMA && !!before.areas.testbereich && Object.values(before.skills).some((x) => x.name === "Testkenntnis") && Object.values(before.projects).some((p) => p.name === "Testprojekt"), "all five are in the storage of the browser");

  await page.reload();
  await mapReady(page);
  check((await page.locator("#areas .chip").allInnerTexts()).includes("Testbereich") && (await h2(page)) === "13 Kenntnisse in 4 Bereichen", "after a reload: the area and the skill");
  check((await page.locator("#panel .chips .chip").allInnerTexts()).includes("Testfirma GmbH"), "the station");
  await page.click("#projects-btn"); await page.waitForTimeout(150);
  check((await page.locator("#panel .plist button").allInnerTexts()).some((t) => t.includes("Testprojekt")), "the project");

  // Export
  const file = await exportFrom(page, "#file-export");
  check(file.name === "Meine Skills.it-skills-map.json", "the file name is the title: " + file.name);
  const json = JSON.parse(file.text);
  check(same(Object.keys(json), ["format", "schema", "title", "exportedAt", "collections"]) && json.format === "it-skills-map" && json.schema === 1 && json.title === "Meine Skills", "the fields of the format");
  check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(json.exportedAt), "exportedAt in UTC: " + json.exportedAt);
  check(same(Object.keys(json.collections), ["areas", "stations", "groups", "skills", "projects"]), "the collections in the order of the format: " + Object.keys(json.collections));
  check(same(sorted(json.collections), sorted(before)), "the file holds the documents of the map");
  check(same(json.collections.stations.TESTFIRMA, { name: "Testfirma GmbH", short: "Testfirma", kind: "Arbeitgeber", when: "03.2019 – 12.2022", months: 46, note: "Entwicklung von Testsystemen.", order: 0 }), "the station document: " + JSON.stringify(json.collections.stations.TESTFIRMA));

  // Delete on the start page
  await go(page, "");
  check(await page.locator("#map-list li").count() === 1 && (await page.locator("#map-list .map-meta").innerText()).startsWith("4 Bereiche · 7 Kategorien · 13 Kenntnisse · 1 Station · 1 Projekt"), "the list counts the content: " + await page.locator("#map-list .map-meta").innerText());
  await page.locator("#map-list button", { hasText: "Löschen" }).click(); await page.waitForTimeout(100);
  check((await page.locator("#map-list .confirm").innerText()).startsWith("„Meine Skills“ aus diesem Browser löschen? Ohne exportierte Datei ist die Map dann verloren."), "delete asks first");
  check(Object.keys(await stored(page)).length === 1, "asking deletes nothing");
  await page.locator("#map-list button", { hasText: "Endgültig löschen" }).click(); await page.waitForTimeout(150);
  check(await page.locator("#map-list li").count() === 0 && Object.keys(await stored(page)).length === 0 && await page.locator("#map-empty").isVisible(), "the map is gone from the browser");

  // Import of the file
  await pick(page, "#file-input", file.name, file.text);
  await page.waitForURL(/map\.html\?id=/);
  await mapReady(page);
  const maps = await stored(page), newId = mapIdOf(page);
  check(Object.keys(maps).length === 1 && newId !== id, "the import is a new map in the browser");
  check(same(sorted(maps[newId].collections), sorted(before)) && maps[newId].title === "Meine Skills", "the import restores the same content and title");
  check((await h2(page)) === "13 Kenntnisse in 4 Bereichen" && (await page.locator("#title").innerText()) === "Meine Skills", "and the same map");
  check(s.errors.length === 0, "no console errors on the way");
}));

test("a bad map file gives a clear German error, on the start page and in the editor", withSite({}, async (page, check) => {
  await go(page, "");
  const good = { format: "it-skills-map", schema: 1, title: "T", exportedAt: "2026-10-18T22:00:00Z", collections: { areas: {} } };
  const cases = [
    ["kein JSON", "{ nicht json", "Die Datei ist kein gültiges JSON."],
    ["ein Array", "[1, 2]", "Die Datei enthält kein JSON-Objekt."],
    ["anderes Format", JSON.stringify({ ...good, format: "andere-map" }), "Das ist keine Map-Datei: Das Feld „format“ ist „andere-map“, erwartet ist „it-skills-map“."],
    ["ohne Format", JSON.stringify({ ...good, format: undefined }), "Das ist keine Map-Datei: Das Feld „format“ ist nicht da"],
    ["neueres Schema", JSON.stringify({ ...good, schema: 2 }), "Die Datei hat Schema 2. Diese Seite kennt höchstens Schema 1."],
    ["Schema kein Integer", JSON.stringify({ ...good, schema: "1" }), "Das Feld „schema“ fehlt oder ist keine ganze Zahl ab 1."],
    ["ohne collections", JSON.stringify({ ...good, collections: [] }), "Das Feld „collections“ fehlt oder ist kein Objekt."],
    ["Name der Sammlung", JSON.stringify({ ...good, collections: { Areas: {} } }), "Der Name der Sammlung „Areas“ ist ungültig."],
    ["ID mit Schrägstrich", JSON.stringify({ ...good, collections: { skills: { "a/b": {} } } }), "Die Dokument-ID „a/b“ in „skills“ ist ungültig. Eine ID hat 1 bis 200 Zeichen und keinen „/“."],
    ["zu lange ID", JSON.stringify({ ...good, collections: { skills: { ["x".repeat(201)]: {} } } }), "in „skills“ ist ungültig. Eine ID hat 1 bis 200 Zeichen"],
    ["Bereich mit Leerzeichen", JSON.stringify({ ...good, collections: { areas: { "a b": { name: "A" } } } }), "Die Dokument-ID „a b“ in „areas“ ist ungültig. Erlaubt sind kleine Buchstaben"],
    ["Station PRIVAT", JSON.stringify({ ...good, collections: { stations: { PRIVAT: { name: "P" } } } }), "Die Dokument-ID „PRIVAT“ in „stations“ ist ungültig."],
    ["Dokument kein Objekt", JSON.stringify({ ...good, collections: { groups: { g1: "Text" } } }), "Das Dokument „g1“ in „groups“ ist kein Objekt."],
    ["ID ..", JSON.stringify({ ...good, collections: { skills: { "..": {} } } }), "Die Dokument-ID „..“ in „skills“ ist ungültig. Eine ID enthält kein Steuerzeichen und kein kaputtes Zeichen"],
    ["ID mit Steuerzeichen", JSON.stringify({ ...good, collections: { skills: { "a\u0001b": {} } } }), "in „skills“ ist ungültig. Eine ID enthält kein Steuerzeichen"],
    ["Titel mit Steuerzeichen", JSON.stringify({ ...good, title: "T\u0001" }), "Das Feld „title“ enthält ein Steuerzeichen oder ein kaputtes Zeichen."],
  ];
  for (const [name, text, want] of cases) {
    await pick(page, "#file-input", name + ".json", text);
    await page.waitForTimeout(150);
    const got = (await page.locator("#message").isVisible()) ? await page.locator("#message").innerText() : "";
    check(got.includes(want), `${name}: ${got}`);
  }
  check(Object.keys(await stored(page)).length === 0 && page.url().endsWith("/"), "no bad file became a map");
  await go(page, "example.html");
  await mapReady(page, false);
  await pick(page, "#file-input", "kaputt.json", "{");
  await page.waitForTimeout(150);
  check((await page.locator("#file-message").innerText()) === "Die Datei ist kein gültiges JSON. Eine Map-Datei entsteht mit „Exportieren“." && page.url().endsWith("example.html"), "the editor shows the error below its toolbar");
  await pick(page, "#file-input", "gut.json", JSON.stringify(good));
  await page.waitForURL(/map\.html\?id=/);
  await mapReady(page);
  check((await page.locator("#title").innerText()) === "T", "a good file from the example opens as a new map");
}));

// The rules of a map file are the rules of the server (finding B4 of the final review): server/tests/test_maps.py tests the
// same ids and titles there.
test("the site takes the ids and titles of a map file that the server takes, and refuses the others", withSite({}, async (page, check) => {
  await go(page, "");
  const result = await page.evaluate(() => {
    const R = window.SkillMapRuntime;
    const file = (fields) => R.store.parseFile(JSON.stringify({ format: "it-skills-map", schema: 1, collections: {}, ...fields }));
    const bad = [["areas", 'x"] .y'], ["areas", "Gross"], ["areas", "a".repeat(41)], ["stations", "PRIVAT"], ["stations", "Ai"], ["stations", "1A"],
      ["groups", "Gruppe"], ["groups", "-x"], ["skills", "__proto__"], ["skills", ".."], ["skills", "."], ["skills", "a\u0001b"], ["skills", "a\u007f"],
      ["projects", "x\u001f"], ["skills", "a\ud800"]];
    const good = [["areas", "sd"], ["areas", "a_b-1"], ["stations", "ACME"], ["stations", "A1"], ["groups", "sd-lang"], ["groups", "1x"],
      ["skills", "C# und .NET"], ["skills", "..a"], ["skills", "a".repeat(200)]];
    const title = (text) => { const parsed = file({ title: text }); return parsed.error ? null : parsed.map.title; };
    return {
      refused: bad.filter(([name, id]) => R.validId(name, id) || !file({ collections: { [name]: { [id]: {} } } }).error).map((x) => x.join("/")),
      taken: good.filter(([name, id]) => !R.validId(name, id) || file({ collections: { [name]: { [id]: {} } } }).error).map((x) => x.join("/")),
      titles: [title("Ä".repeat(130)) === "Ä".repeat(120), title("a" + "\u{1F600}".repeat(130)) === "a" + "\u{1F600}".repeat(119),
        title("  Meine \t\n Karte\u00a0 ") === "Meine Karte", title("x".repeat(119) + " yz") === "x".repeat(119), title(" \t ") === "Importierte Map",
        title("Karte\u0001") === null, title("Karte\u001c") === null, title("a\ud800") === null],
      schema: !R.store.parseFile('{"format": "it-skills-map", "schema": 1.0, "collections": {}}').error,
      // The content rules of server/app/store.py (_check_value): the doc is depth 0, so a value at depth 65 is too deep.
      content: (() => {
        const nest = (n) => n ? "[" + nest(n - 1) + "]" : "0";
        const doc = (value) => R.store.parseFile('{"format": "it-skills-map", "schema": 1, "collections": {"skills": {"a": {"x": ' + value + "}}}}").error || "";
        return { deep63: doc(nest(63)), deep64: doc(nest(64)), nul: doc('"a\\u0000b"'), half: doc('"a\ud800"'), keyHalf: doc('{"\ud800": 1}'), big: doc("1e999"), plain: doc('"Łódź 日本"') };
      })(),
    };
  });
  check(result.refused.length === 0, "the site refuses every id that the server refuses" + (result.refused.length ? ": " + result.refused.join(", ") : ""));
  check(result.taken.length === 0, "the site takes every id that the server takes" + (result.taken.length ? ": " + result.taken.join(", ") : ""));
  check(result.titles.every(Boolean), "a title keeps 120 characters, one space for each run of white space, and no control character: " + JSON.stringify(result.titles));
  check(result.schema, "schema 1.0 is schema 1, as on the server");
  const c = result.content, de = CATALOGS.de, fill = (key, values) => Object.entries(values).reduce((text, [k, v]) => text.replace("{" + k + "}", v), de[key]);
  const where = { id: "a", collection: "skills" };
  check(c.deep63 === "" && c.plain === "" && c.deep64 === fill("local.docTooDeep", { ...where, max: 64 }) && c.nul === fill("local.docNullCharacter", where)
    && c.half === fill("local.docHalfCharacter", where) && c.keyHalf === fill("local.docHalfCharacter", where) && c.big === fill("local.docNotFinite", where),
    "the site refuses the content of a document that the server refuses: too deep, a null character, half of a character pair, a number too large: " + JSON.stringify(c));
}));

// Deletes with dependents
const seededMap = () => entryOf("Testdaten", collectionsOf(FIXTURE, FIXTURE_PROJECTS));
test("deleting an area or a station that is in use asks first and names what depends on it", withSite({ maps: { m1: seededMap() } }, async (page, check) => {
  await go(page, "map.html?id=m1");
  await mapReady(page);
  check((await h2(page)) === "9 Kenntnisse in 3 Bereichen", "the test map");
  await page.locator("#areas .chip", { hasText: "Entwicklung" }).click(); await page.waitForTimeout(150);
  await clickPanel(page, "Löschen");
  const ask = await page.locator("#panel .confirm p").innerText();
  check(ask === "„Entwicklung“ löschen? Mit dem Bereich verschwinden auch 2 Kategorien und 5 Kenntnisse. Die Kenntnisse verschwinden auch aus 3 Projekten. Das lässt sich nicht rückgängig machen.", "the area: " + ask);
  check(Object.keys((await stored(page)).m1.collections.groups).length === 4, "asking deletes nothing");
  await clickPanel(page, "Abbrechen");
  check(await page.locator("#panel .confirm").count() === 0, "Abbrechen keeps the area");
  await clickPanel(page, "Löschen");
  await clickPanel(page, "Endgültig löschen");
  await saved(page);
  let c = (await stored(page)).m1.collections;
  check(!c.areas.sd && Object.keys(c.groups).sort().join() === "ai-tools,data-db" && Object.values(c.skills).length === 4, "the area, its categories and its skills are deleted");
  check(Object.values(c.projects).every((p) => p.skills.every((n) => !["C#", "Python", "Go", "React", "CSS"].includes(n))), "the projects lost those skills");
  check((await h2(page)) === "4 Kenntnisse in 2 Bereichen", "the map follows");
  await page.locator("#panel .chips .chip", { hasText: "Neufirma AG" }).click(); await page.waitForTimeout(150);
  await clickPanel(page, "Löschen");
  const askStation = await page.locator("#panel .confirm p").innerText();
  check(askStation === "„Neufirma AG“ löschen? 2 Kenntnisse verlieren diese Station. 2 Projekte dieser Station werden mit gelöscht. Das lässt sich nicht rückgängig machen.", "the station: " + askStation);
  await clickPanel(page, "Endgültig löschen");
  await saved(page);
  c = (await stored(page)).m1.collections;
  check(!c.stations.NEU && Object.values(c.skills).every((x) => !x.places.some((p) => p === "NEU" || p === "NEUi")), "the station is gone, and no skill names it");
  check(Object.values(c.projects).every((p) => p.station !== "NEU"), "its projects are deleted");
  check(!(await page.locator("#panel .chips").first().innerText()).includes("Neufirma"), "the overview follows");
}));

test("deleting a station turns a standard skill since that station into a normal skill", withSite({ maps: { m1: seededMap() } }, async (page, check) => {
  await go(page, "map.html?id=m1");
  await mapReady(page);
  await page.locator("#panel .chips .chip", { hasText: "Altfirma GmbH" }).click(); await page.waitForTimeout(150);
  await clickPanel(page, "Löschen");
  const ask = await page.locator("#panel .confirm p").innerText();
  check(ask === "„Altfirma GmbH“ löschen? 2 Kenntnisse verlieren diese Station. 1 Projekt dieser Station wird mit gelöscht. 1 Standard-Skill zählt ab dieser Station und wird eine normale Kenntnis. Das lässt sich nicht rückgängig machen.", "the question: " + ask);
  await clickPanel(page, "Endgültig löschen");
  await saved(page);
  const skills = Object.values((await stored(page)).m1.collections.skills), cs = skills.find((x) => x.name === "C#");
  check(!cs.standard && same(cs.places, ["NEU"]), "C# keeps NEU and is no standard skill: " + JSON.stringify(cs));
}));

// Counts of one (finding D5 of the final review): a map with one area, one category, one skill, one station and one project.
const oneOfEach = () => entryOf("Eins", {
  areas: { eins: { name: "Bereich Eins", color: "#3f6fb0", at: [0, 0], order: 0 } },
  stations: { EINS: { name: "Station Eins", short: "", kind: "Arbeitgeber", when: "01.2020 – 12.2021", months: 24, note: "", order: 0 } },
  groups: { "eins-kategorie": { name: "Kategorie Eins", area: "eins", order: 0 } },
  skills: { "kenntnis-eins": { name: "Kenntnis Eins", group: "eins-kategorie", rating: 2, places: ["EINS"], order: 0 } },
  projects: { "eins-projekt": { name: "Projekt Eins", station: "EINS", base: false, order: 1, when: "", skills: ["Kenntnis Eins"] } },
});
test("a count of one takes the singular in German and in English: the headline, the projects, the rating, the station, the search and the time range", async ({ browser, check }) => {
  const WORDS = {
    de: { heading: "1 Kenntnis in 1 Bereich", projects: "1 Projekt angelegt.", rating: "1 Kenntnis", station: "1 Kenntnis", search: "1 Treffer für „kenntnis eins“",
      headingInRange: "1 von 1 Kenntnis in 1 Bereich", projectsInRange: "1 Projekt angelegt, 1 im Zeitraum." },
    en: { heading: "1 skill in 1 area", projects: "1 project created.", rating: "1 skill", station: "1 skill", search: "1 hit for “kenntnis eins”",
      headingInRange: "1 of 1 skill in 1 area", projectsInRange: "1 project created, 1 in the time range." },
  };
  for (const [language, words] of Object.entries(WORDS)) {
    const s = await site(browser, { language: language === "en" ? null : language, maps: { m1: oneOfEach() } });
    const page = s.page, panelHas = (text) => page.waitForFunction((x) => document.getElementById("panel").textContent.includes(x), text, { timeout: 10000 }).then(() => true, () => false);
    try {
      await go(page, "map.html?id=m1");
      await mapReady(page, false);
      check((await h2(page)) === words.heading, language + ": the headline: " + await h2(page));
      check(await panelHas(words.projects), language + ": the projects of the owner: " + words.projects);
      await page.locator('#panel .legend button[data-go="rating|2"]').click(); await page.waitForTimeout(150);
      check((await page.locator("#panel .rating").textContent()).trim() === words.rating, language + ": the rating: " + await page.locator("#panel .rating").textContent());
      await page.click("#panel .back"); await page.waitForTimeout(150);
      await page.locator("#panel .chips .chip", { hasText: "Station Eins" }).click(); await page.waitForTimeout(150);
      check((await page.locator("#panel h3").first().textContent()) === words.station, language + ": the station: " + await page.locator("#panel h3").first().textContent());
      await page.fill("#q", "Kenntnis Eins"); await page.waitForTimeout(150);
      check((await h2(page)) === words.search, language + ": the search: " + await h2(page));
      await page.fill("#q", ""); await page.waitForTimeout(150);
      await page.focus("#time-from"); await page.keyboard.press("ArrowRight");
      await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
      check((await h2(page)) === words.headingInRange && await panelHas(words.projectsInRange), language + ": with a time range: " + await h2(page));
      check(s.errors.length === 0, language + ": no console errors" + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
    } finally { await s.context.close(); }
  }
});

test("the harness fails a test that does not end within its limit, and lets a test that ends or throws report as before", async ({ check }) => {
  check(await runOne(() => new Promise(() => {}), {}, 100) === "late", "a test that waits for ever is late after its limit");
  check(await runOne(async () => {}, {}, 2000) === "ended", "a test that ends is not late");
  check(await runOne(async () => { throw new Error("broken"); }, {}, 2000).catch((error) => "threw " + error.message) === "threw broken", "a test that throws still throws");
});

test("the check of the texts and the import refuse a translation without the plural forms of English, and plural forms that English lacks", async ({ check }) => {
  const tools = path.join(repo, "i18n", "tools"), catalogs = require(path.join(tools, "catalogs.js"));
  const { check: checkTexts } = require(path.join(tools, "check.js")), { merge } = require(path.join(tools, "import.js"));
  const base = path.join(OUT, "plural-check"), root = path.join(base, "i18n"), serverRoot = path.join(base, "server");
  fs.rmSync(base, { recursive: true, force: true });
  for (const code of ["en", "de"]) {
    fs.cpSync(path.join(repo, "i18n", code), path.join(root, code), { recursive: true });
    fs.cpSync(path.join(repo, "server", "app", "i18n", code), path.join(serverRoot, code), { recursive: true });
  }
  const RULE = "a text has plural forms in every language or in none";
  const plural = () => (checkTexts({ root, serverRoot }).rules.find((rule) => rule.name === RULE) || { problems: null }).problems;
  check(same(plural(), []), "the copy of the catalogs passes the rule: " + JSON.stringify(plural()));
  const edit = (file, key, text) => { const all = JSON.parse(fs.readFileSync(file, "utf8")); all[key].text = text; fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n"); };
  edit(path.join(root, "de", "page.json"), "overview.skills", "{count} Kenntnisse");
  edit(path.join(serverRoot, "de", "errors.json"), "error.not_found", { one: "Nicht gefunden.", other: "Nicht gefunden." });
  const found = plural() || [];
  check(found.length === 2 && found[0].startsWith("de: overview.skills has no plural, but English has the forms one, other") && found[1].startsWith("de: error.not_found has a plural, but English has none"),
    "the check fails on a German text without the plural of English, and on a German plural without one in English: " + JSON.stringify(found));
  const english = (key) => catalogs.read(root, serverRoot).catalogs.en.get(key).text;
  const result = merge({ language: "de", entries: {
    "overview.skills": { english: english("overview.skills"), text: "{count} Kenntnisse" },
    "error.not_found": { english: english("error.not_found"), text: { one: "Nicht gefunden.", other: "Nicht gefunden." } },
    "overview.areas": { english: english("overview.areas"), text: { one: "{count} Bereich", other: "{count} Bereichen" } },
  } }, { root, serverRoot });
  check(same(result.merged, ["overview.areas"]) && result.skipped.length === 2 && result.skipped[0].startsWith("overview.skills: the text has no plural")
    && result.skipped[1].startsWith("error.not_found: the text has a plural"), "the import skips both and names them, and merges the right one: " + JSON.stringify(result));
  fs.rmSync(base, { recursive: true, force: true });
});

// New ids (finding D7 of the final review): a name without a letter of a to z or a digit gets the English stem "item".
test("a name without Latin letters gets an English stem for its new id, an old id keeps working, and an indirect station takes the text of the catalogs", async ({ browser, check }) => {
  const old = seededMap();
  // Ids that a page made before from such names, with the old stem "projekt".
  old.collections.stations.PROJEKT = { name: "大阪 Alt", short: "", kind: "Arbeitgeber", when: "01.2015 – 12.2016", months: 24, note: "", order: 9 };
  old.collections.skills.projekt = { name: "寿司 Alt", group: "sd-lang", rating: 1, places: ["PROJEKT"], order: 99 };
  const s = await site(browser, { maps: { m1: old } });
  const page = s.page;
  try {
    await go(page, "map.html?id=m1");
    await mapReady(page);
    check(await page.evaluate(() => WHERE.NEUi) === "Neufirma AG (indirekt)", "the short name of an indirect use comes from the catalogs: " + await page.evaluate(() => WHERE.NEUi));
    await clickPanel(page, "+ Bereich");
    await page.fill("#cf-name", "日本"); await page.fill("#cf-x", "420"); await page.fill("#cf-y", "260");
    await submitForm(page);
    await clickPanel(page, "+ Kategorie");
    await page.fill("#cf-name", "東京");
    await submitForm(page);
    await page.click("#panel .back"); await page.waitForTimeout(100);
    await clickPanel(page, "+ Station");
    await page.fill("#cf-name", "大阪"); await page.fill("#cf-when", "03.2019 – 12.2022");
    await submitForm(page);
    await page.locator("#areas .chip", { hasText: "日本" }).click(); await page.waitForTimeout(150);
    await page.locator("#panel h3 .linkbtn", { hasText: "東京" }).click(); await page.waitForTimeout(150);
    await clickPanel(page, "+ Skill");
    await page.fill("#cf-name", "寿司");
    await page.locator('input[name="cf-place"][value="ITEM"]').check();
    await submitForm(page);
    await page.click("#projects-btn"); await page.waitForTimeout(100);
    await clickPanel(page, "Neues Projekt");
    await page.fill("#pf-name", "京都");
    await page.selectOption("#pf-station", "ITEM");
    await page.locator("#project-form button[type=submit]").click(); await page.waitForTimeout(200);
    await saved(page);
    const c = (await stored(page)).m1.collections;
    const ids = { area: Object.keys(c.areas).find((id) => c.areas[id].name === "日本"), group: Object.keys(c.groups).find((id) => c.groups[id].name === "東京"),
      station: Object.keys(c.stations).find((id) => c.stations[id].name === "大阪"), skill: Object.keys(c.skills).find((id) => c.skills[id].name === "寿司"),
      project: Object.keys(c.projects).find((id) => c.projects[id].name === "京都") };
    check(same(ids, { area: "item", group: "item-item", station: "ITEM", skill: "item", project: "item-item" }), "the new ids have the stem item: " + JSON.stringify(ids));
    check(same(c.skills.item.places, ["ITEM"]) && c.projects["item-item"].station === "ITEM", "the new skill and the new project name the new station");
    check(!!c.stations.PROJEKT && !!c.skills.projekt && same(c.skills.projekt.places, ["PROJEKT"]), "the old ids stay as they are");
    await go(page, "map.html?id=m1");
    await mapReady(page);
    check((await page.locator("#panel .chips .chip").allInnerTexts()).includes("大阪 Alt"), "the station with the old id shows on the map");
    await clickNode(page, "s:寿司 Alt");
    check((await h2(page)) === "寿司 Alt" && (await page.locator("#panel .list .linkbtn").allInnerTexts()).join() === "大阪 Alt", "the skill with the old id shows with its station");
    check(s.errors.length === 0, "no console errors" + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
  } finally { await s.context.close(); }
  const e = await site(browser, { language: null, maps: { m1: seededMap() } });
  try {
    await go(e.page, "map.html?id=m1");
    await mapReady(e.page, false);
    await e.page.waitForFunction(() => typeof WHERE.NEUi === "string", null, { timeout: 10000 });
    check(await e.page.evaluate(() => WHERE.NEUi) === "Neufirma AG (indirect)", "in English, the indirect use says indirect: " + await e.page.evaluate(() => WHERE.NEUi));
  } finally { await e.context.close(); }
});

// Editing of names and colors
test("the owner renames and recolors an area and a station, and renames the map", withSite({ maps: { m1: seededMap() } }, async (page, check) => {
  await go(page, "map.html?id=m1");
  await mapReady(page);
  await page.locator("#areas .chip", { hasText: "Daten" }).click(); await page.waitForTimeout(150);
  await clickPanel(page, "Bereich bearbeiten");
  await page.fill("#cf-name", "Daten & Analyse"); await page.fill("#cf-color", "#b4540a");
  await submitForm(page);
  check((await h2(page)) === "Daten & Analyse" && (await page.locator("#areas .chip.k-data").innerText()) === "Daten & Analyse", "the new name");
  check(await page.evaluate(() => getComputedStyle(document.querySelector("#areas .chip.k-data i")).backgroundColor) === "rgb(180, 84, 10)", "the new color");
  check(await page.evaluate(() => [...document.querySelectorAll("#map g.node.k-data text")].some((t) => t.textContent === "Daten & Analyse")), "the map names the area anew");
  await page.click("#panel .back"); await page.waitForTimeout(100);
  await page.locator("#panel .chips .chip", { hasText: "Hobbyprojekt" }).click(); await page.waitForTimeout(150);
  await clickPanel(page, "Station bearbeiten");
  await page.fill("#cf-name", "Bastelprojekt");
  await page.fill("#cf-when", "Frühling");
  await submitForm(page);
  check((await page.locator("#cf-error").innerText()) === "Der Zeitraum braucht ein Datum wie 03.2013, 2013 oder „seit 05.2026“.", "a period without a date is refused");
  await page.fill("#cf-when", "seit 2025");
  await submitForm(page);
  check((await h2(page)) === "Bastelprojekt", "the station has its new name");
  await page.click("#panel .back"); await page.waitForTimeout(100);
  await clickPanel(page, "Titel ändern");
  await page.fill("#cf-name", "Meine Testkarte");
  await submitForm(page);
  check((await page.locator("#title").innerText()) === "Meine Testkarte" && (await page.title()) === "Meine Testkarte · Skill-Map", "the map has its new title");
  await saved(page);
  const entry = (await stored(page)).m1;
  check(entry.title === "Meine Testkarte" && entry.collections.areas.data.name === "Daten & Analyse" && entry.collections.areas.data.color === "#b4540a" && entry.collections.stations.PRIV.name === "Bastelprojekt", "the storage holds the changes");
}));

// A running station in English (D3 of the final review): the form saved "since 05.2024" with an empty months field as one
// month, and "03/2013" lost its month. The forms of a station and a project read since, seit, today, present and heute in
// every language, and MM/YYYY next to MM.YYYY. They refuse any other word with the text of the language.
for (const language of ["de", "en"]) {
  test(`the station and the project form in ${language === "de" ? "German" : "English"}: since, seit, today, present, heute and MM/YYYY count their months, another word is refused`,
    withSite({ language, maps: { m1: seededMap() } }, async (page, check) => {
      await go(page, "map.html?id=m1");
      await page.waitForFunction(() => document.getElementById("save-state").dataset.state === "saved" && document.getElementById("cfg-groups").children.length > 0, null, { timeout: 15000 });
      await page.waitForTimeout(250);
      const refused = textOf("form.whenInvalid", language), now = await page.evaluate(() => NOW_MONTH), M = (y, m) => y * 12 + m - 1;
      await page.locator("#panel .chips .chip", { hasText: "Hobbyprojekt" }).click(); await page.waitForTimeout(150);
      // Saves the dates with an empty months field: the stored station, or the error of the form.
      async function station(when) {
        await page.locator('#panel [data-act="edit-station|PRIV"]').click(); await page.waitForTimeout(100);
        await page.fill("#cf-when", when); await page.fill("#cf-months", "");
        await submitForm(page);
        const error = await page.locator("#cf-error").isVisible() ? await page.locator("#cf-error").innerText() : "";
        if (error) await page.locator('#panel [data-act="cancel-catalog|"]').first().click();
        await page.waitForTimeout(100);
        return { error, ...(await stored(page)).m1.collections.stations.PRIV };
      }
      check((await page.locator('#panel [data-act="edit-station|PRIV"]').count()) === 1, "the station panel of Hobbyprojekt");
      await page.locator('#panel [data-act="edit-station|PRIV"]').click(); await page.waitForTimeout(100);
      const hint = await page.getAttribute("#cf-when", "placeholder");
      check(hint === textOf("form.whenExample", language) && (language === "en" ? hint.includes("since 05.2026") : hint.includes("seit 05.2026")), "the placeholder names " + (language === "en" ? "since" : "seit") + ": " + hint);
      await page.locator('#panel [data-act="cancel-catalog|"]').first().click(); await page.waitForTimeout(100);
      const running = [];
      for (const when of ["seit 05.2024", "since 05.2024", "05.2024 – today", "05.2024 – present", "05.2024 – heute", "Since 05.2024"]) running.push([when, await station(when)]);
      const wrong = running.filter(([when, s]) => s.error || s.when !== when || s.months !== now - M(2024, 5) + 1);
      check(wrong.length === 0, `seit, since, today, present and heute run to today: ${now - M(2024, 5) + 1} months each: ` + JSON.stringify(wrong));
      const slash = await station("03/2013 – 10/2019");
      check(!slash.error && slash.months === 80, "03/2013 – 10/2019 names two months: 80 months: " + JSON.stringify(slash));
      for (const when of ["Frühling 2024", "05.2024 – bis jetzt", "until 05.2024", "05.2024 – now"]) {
        const s = await station(when);
        check(s.error === refused && s.when === "03/2013 – 10/2019", `„${when}“ is refused with the text of the language, and the station keeps its dates: ` + JSON.stringify(s));
      }
      // The project form reads the same dates.
      await page.click("#projects-btn"); await page.waitForTimeout(100);
      await page.locator("#panel .plist button", { hasText: "Kundenportal" }).click(); await page.waitForTimeout(100);
      async function project(when) {
        await page.locator('#panel [data-act="form|"]').click(); await page.waitForTimeout(100);
        await page.fill("#pf-when", when);
        await page.locator("#project-form button[type=submit]").click(); await page.waitForTimeout(250);
        const error = await page.locator("#pf-error").isVisible() ? await page.locator("#pf-error").innerText() : "";
        if (error) await page.locator('#panel [data-act="cancel-form|"]').first().click();
        // A project saves a moment after the change.
        await page.waitForTimeout(500);
        await page.waitForFunction(() => document.getElementById("save-state").dataset.state === "saved", null, { timeout: 10000 });
        return { error, when: (await stored(page)).m1.collections.projects["neu-kundenportal"].when };
      }
      const since = await project("since 05.2024");
      check(!since.error && since.when === "since 05.2024" && await page.evaluate(() => projectMonths({ station: "NEU", when: "since 05.2024" }).to === NOW_MONTH), "a project takes since 05.2024, and it runs to today: " + JSON.stringify(since));
      const summer = await project("Sommer 2024");
      check(summer.error === refused && summer.when === "since 05.2024", "a project with another word is refused with the text of the language: " + JSON.stringify(summer));
    }));
}

// The runtime
test("the local database has the interface that the page uses, and one map is one localStorage entry", withSite({ maps: { m1: entryOf("Leer", {}) } }, async (page, check) => {
  await go(page, "map.html?id=m1");
  await mapReady(page);
  const r = await page.evaluate(async () => {
    const db = await runtime.db(), col = db.collection("skills"), ref = col.doc("probe");
    const snaps = [];
    const stop = col.onSnapshot((snap) => snaps.push(snap));
    await new Promise((done) => setTimeout(done, 50));
    await ref.set({ name: "Probe", group: "g", rating: 1, places: [], order: 0 });
    await new Promise((done) => setTimeout(done, 50));
    const last = snaps.at(-1), doc = last.docs[0];
    const shape = { path: col.path, refId: ref.id, refPath: ref.path, stop: typeof stop, keys: Object.keys(last).sort(), size: last.size, empty: last.empty,
      changes: last.docChanges().map((c) => c.type), doc: { id: doc.id, exists: doc.exists, data: doc.data() }, first: snaps[0].empty };
    let refused = "";
    try { await db.collection("Bad Name").doc("x").set({}); } catch (error) { refused = error.code; }
    let notObject = "";
    try { await ref.set("Text"); } catch (error) { notObject = error.code; }
    await ref.delete();
    await new Promise((done) => setTimeout(done, 50));
    shape.afterDelete = { size: snaps.at(-1).size, changes: snaps.at(-1).docChanges().map((c) => c.type) };
    stop();
    shape.refused = refused; shape.notObject = notObject;
    shape.entries = Object.keys(localStorage).filter((k) => k.startsWith("it-skills-map/"));
    shape.owner = await runtime.isOwner();
    return shape;
  });
  check(r.path === "skills" && r.refId === "probe" && r.refPath === "skills/probe" && r.stop === "function", "collection, doc and onSnapshot: " + JSON.stringify(r));
  check(same(r.keys, ["docChanges", "docs", "empty", "metadata", "size"]) && r.size === 1 && r.empty === false && r.first === true, "a snapshot has docs, size, empty, docChanges and metadata");
  check(r.doc.id === "probe" && r.doc.exists === true && r.doc.data.name === "Probe" && same(r.changes, ["added"]), "a document has id, exists and data(), and docChanges names the new one");
  check(r.afterDelete.size === 0 && same(r.afterDelete.changes, ["removed"]), "delete removes it");
  check(r.refused === "invalid_argument" && r.notObject === "invalid_argument", "a bad name or a document that is no object is refused with invalid_argument");
  check(same(r.entries, ["it-skills-map/m1"]) && r.owner === true, "one entry per map, and the browser that holds it is the owner");
}));

// Names of a map that are also names of the members of a plain object (B3 of the review): "constructor" as the area of
// a category emptied the map, and as a place it made every position NaN. Each name goes into five places, one map for
// each: an area id, the area of a category, a station code, a skill name and a project key. The map is stored as JSON
// text, so "__proto__" stays a key of its own, as JSON.parse reads it from the storage of a browser.
function rawEntry(collections) {
  const docs = (pairs) => "{" + pairs.map(([id, doc]) => JSON.stringify(id) + ":" + JSON.stringify(doc)).join(",") + "}";
  return '{"format":"it-skills-map","schema":1,"title":"Namen","createdAt":"2026-10-18T08:00:00.000Z","updatedAt":"2026-10-18T08:00:00.000Z","collections":{'
    + Object.entries(collections).map(([name, pairs]) => JSON.stringify(name) + ":" + docs(pairs)).join(",") + "}}";
}
// The map of one case, and what the page must show: the valid nodes, the area chips, the stations of the overview.
function nameCase(N, place) {
  const c = {
    areas: [["a", { name: "Area A", color: "#2c5fc4", at: [0, 0], order: 0 }]],
    stations: [["ST", { name: "Station", short: "", kind: "Arbeitgeber", when: "2020 – 2022", months: 24, note: "", order: 0 }]],
    groups: [["a-g1", { name: "G1", area: "a", order: 0 }], ["a-g2", { name: "G2", area: "a", order: 1 }]],
    skills: [["s1", { name: "S1", group: "a-g1", rating: 2, places: ["ST"], order: 0 }], ["s2", { name: "S2", group: "a-g2", rating: 2, places: ["ST"], order: 1 }]],
    projects: [["p1", { name: "P1", station: "ST", base: false, order: 1, when: "", skills: ["S1"] }]],
  };
  const want = { nodes: 5, areas: ["Area A"], stations: ["Station"] };
  if (place === "area id") {
    c.areas.push([N, { name: "Bereich " + N, color: "#0a8573", at: [300, 0], order: 1 }]);
    c.groups.push(["n-g", { name: "NG", area: N, order: 2 }]);
    c.skills.push(["s3", { name: "S3", group: "n-g", rating: 1, places: ["ST"], order: 2 }]);
    if (/^[a-z][a-z0-9_-]{0,39}$/.test(N)) Object.assign(want, { nodes: 8, areas: ["Area A", "Bereich " + N] });
  } else if (place === "area of a category") {
    c.groups.push(["a-bad", { name: "Fremd", area: N, order: 2 }]);
    c.skills.push(["s3", { name: "S3", group: "a-bad", rating: 1, places: ["ST"], order: 2 }]);
  } else if (place === "station code") {
    c.stations.push([N, { name: "Station " + N, short: "", kind: "Arbeitgeber", when: "2023", months: 12, note: "", order: 1 }]);
    c.skills.forEach(([, s]) => s.places.push(N));
    c.projects.push(["p2", { name: "P2", station: N, base: false, order: 1, when: "", skills: ["S2"] }]);
    if (/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(N)) want.stations = ["Station " + N, "Station"];
  } else if (place === "skill name") {
    c.skills.push(["s3", { name: N, group: "a-g1", rating: 3, places: ["ST"], order: 2, standard: { text: "Standard seit Station", since: "ST" } }]);
    c.projects[0][1].skills.push(N);
    want.nodes = 6;
  } else c.projects.push([N, { name: "Projekt " + N, station: "ST", base: false, order: 2, when: "", skills: ["S2"] }]);
  return { text: rawEntry(c), want };
}
const PLACES = ["area id", "area of a category", "station code", "skill name", "project key"];
for (const N of ["constructor", "toString", "__proto__"]) {
  test(`the name ${N} as an area id, the area of a category, a station code, a skill name and a project key: the map draws every valid node`, withSite({}, async (page, check) => {
    await go(page, "");
    for (const [i, place] of PLACES.entries()) {
      const { text, want } = nameCase(N, place), id = "n" + i;
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [KEY + id, text]);
      await go(page, "map.html?id=" + id);
      await mapReady(page);
      const r = await page.evaluate(() => ({ nodes: document.querySelectorAll("#map g.node").length, nan: [...document.querySelectorAll("#map g.node")].filter((g) => /NaN/.test(g.getAttribute("transform"))).length,
        areas: [...document.querySelectorAll("#areas .chip")].map((c) => c.textContent), stations: [...document.querySelectorAll("#panel .chips")][0] ? [...[...document.querySelectorAll("#panel .chips")][0].querySelectorAll(".chip")].map((c) => c.textContent) : [] }));
      check(r.nodes === want.nodes && r.nan === 0 && same(r.areas, want.areas) && same(r.stations, want.stations), `${place}: ${want.nodes} nodes without NaN, the areas and stations: ` + JSON.stringify(r));
      const odd = /undefined|function|\[object|\bObject\b/i;
      if (place === "station code") {
        await clickNode(page, "s:S1");
        const places = await page.locator("#panel h3:has-text('Eingesetzt bei') + ul.list .linkbtn").allInnerTexts();
        check(same(places, want.stations), `${place}: the stations of a skill: ` + JSON.stringify(places));
        await page.click("#projects-btn"); await page.waitForTimeout(150);
        const heads = await page.locator("#panel .station-head h3").allTextContents();
        check(heads.length === 2 && !heads.some((t) => odd.test(t)), `${place}: the project list names each station: ` + JSON.stringify(heads));
      } else if (place === "skill name") {
        await page.locator("#areas .chip", { hasText: "Area A" }).click(); await page.waitForTimeout(150);
        await page.locator("#panel .chip").filter({ hasText: new RegExp("^" + N + "$") }).click(); await page.waitForTimeout(150);
        check((await h2(page)) === N && (await page.locator("#panel .badge").innerText()) === "Standard seit Station", `${place}: its panel with its standard note`);
      } else if (place === "project key") {
        await page.click("#projects-btn"); await page.waitForTimeout(150);
        await page.locator("#panel .plist button", { hasText: "Projekt " + N }).click(); await page.waitForTimeout(150);
        check((await h2(page)) === "Projekt " + N, `${place}: the project opens`);
      }
      check(!odd.test(await panelText(page)), `${place}: the panel shows no member of an object`);
    }
  }));
}

test("a map file with a collection named constructor imports and keeps that collection", withSite({}, async (page, check) => {
  await go(page, "");
  const file = { format: "it-skills-map", schema: 1, title: "Mit Sammlung", exportedAt: "2026-10-18T22:00:00Z", collections: { areas: { a: { name: "Area A", color: "#2c5fc4", at: [0, 0], order: 0 } }, constructor: { x: { note: "bleibt" } } } };
  await pick(page, "#file-input", "sammlung.json", JSON.stringify(file));
  await page.waitForURL(/map\.html\?id=/, { timeout: 10000 }).catch(() => {});
  check(/map\.html\?id=/.test(page.url()), "the import opens the new map: " + page.url());
  const maps = await stored(page), entry = Object.values(maps)[0];
  check(!!entry && same(entry.collections.constructor, { x: { note: "bleibt" } }), "the map keeps the collection constructor: " + JSON.stringify(entry && entry.collections));
}));

// One key, "skill-springs", held the last state of the force menu for every map of the site (B6 of the review), so
// "Letzter Stand im Browser" loaded the state of another map.
const menuIdle = (page) => page.waitForFunction(() => !document.getElementById("spring-load").disabled && !/Berechne/.test(document.getElementById("cfg-measures").textContent), null, { timeout: 20000 }).then(() => page.waitForTimeout(100));
test("each map keeps its own last state of the force menu in this browser", withSite({ maps: { m1: seededMap(), m2: seededMap() } }, async (page, check) => {
  await go(page, "map.html?id=m1");
  await mapReady(page); await menuIdle(page);
  await page.evaluate(() => { document.getElementById("spring-values").value = JSON.stringify({ schema: 4, ticks: 500 }); document.getElementById("spring-load").click(); });
  await menuIdle(page);
  check(await page.evaluate(() => TICKS) === 500, "map 1 lays out with 500 steps");
  await go(page, "map.html?id=m2");
  await mapReady(page); await menuIdle(page);
  check(await page.locator("#spring-browser").isDisabled() && await page.evaluate(() => TICKS) === 300, "map 2 has no state of its own: Letzter Stand im Browser is off, and it keeps 300 steps");
  await go(page, "map.html?id=m1");
  await mapReady(page); await menuIdle(page);
  await page.click("#spring-browser"); await menuIdle(page);
  check(await page.evaluate(() => TICKS) === 500, "map 1 loads its own state again");
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("skill-springs")).sort());
  check(same(keys, ["skill-springs/m1"]), "the state has the key of its map: " + JSON.stringify(keys));
  // A map that the start page deletes takes its state along.
  await go(page, "");
  await page.locator("#map-list li", { has: page.locator(`a[href="map.html?id=m1"]`) }).locator("button", { hasText: "Löschen" }).click();
  await page.locator("#map-list button", { hasText: "Endgültig löschen" }).click(); await page.waitForTimeout(150);
  check(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("skill-springs")).length) === 0 && !Object.keys(await stored(page)).includes("m1"), "deleting map 1 deletes its state too");
}));

// The downloads of the map of a visitor (B5 of the review) carried the title of the build, "Skill-Map".
async function downloadFile(page, kind) {
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click(`#downloads button[data-file="${kind}"]`)]);
  const data = fs.readFileSync(await file.path());
  await page.waitForFunction(() => [...document.querySelectorAll("#downloads button")].every((b) => !b.disabled), null, { timeout: 30000 });
  return data;
}
// The text strings of a PDF of jsPDF and its title, as a reader finds them, also in the embedded font of the PDF
// (pdfText in tests/e2e/site.js).
const pdfOf = (buffer) => pdfText(buffer);
const svgFoot = (text) => [...text.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).at(-1);
// The PNG against the SVG of the page with the footer that it must have, drawn at the same size: their pixels.
const pngAgainst = (page, svg, png, foot) => page.evaluate(async ([svgText, pngData, footer]) => {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml"), texts = doc.querySelectorAll("text");
  texts[texts.length - 1].textContent = footer;
  const w = Number(doc.documentElement.getAttribute("width")) * 2, h = Number(doc.documentElement.getAttribute("height")) * 2;
  const pixels = async (src) => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(img, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
  const got = await pixels("data:image/png;base64," + pngData), want = await pixels("data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(doc)));
  let differ = 0;
  for (let i = 0; i < got.length; i += 4) if (got[i] !== want[i] || got[i + 1] !== want[i + 1] || got[i + 2] !== want[i + 2]) differ++;
  return { differ, total: got.length / 4 };
}, [svg, png.toString("base64"), foot]);
test("the SVG, the PNG and the PDF of a map of a visitor carry the title of that map", withSite({ maps: { m1: entryOf("Meine Karte", collectionsOf(FIXTURE, FIXTURE_PROJECTS)) } }, async (page, check) => {
  await go(page, "map.html?id=m1");
  await mapReady(page);
  const day = await page.evaluate(() => new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }));
  const svg = (await downloadFile(page, "svg")).toString("utf8");
  check(svgFoot(svg) === "Meine Karte · " + day, "the SVG: " + svgFoot(svg));
  const png = await downloadFile(page, "png"), r = await pngAgainst(page, svg, png, "Meine Karte · " + day);
  check(r.differ < 20, `the PNG draws the footer „Meine Karte · ${day}“: ${r.differ} of ${r.total} pixels apart`);
  const pdf = pdfOf(await downloadFile(page, "pdf"));
  check(pdf.strings.includes("Meine Karte · " + day) && pdf.title === "Meine Karte", "the PDF: its footer and its title " + pdf.title);
  // A new title reaches the next file.
  await clickPanel(page, "Titel ändern");
  await page.fill("#cf-name", "Andere Karte");
  await submitForm(page);
  check(svgFoot((await downloadFile(page, "svg")).toString("utf8")) === "Andere Karte · " + day, "after a rename the SVG carries the new title");
}));

// Names beyond Windows-1252 in the PDF (D4 of the final review): the standard fonts of PDF drew "Łódź → 日本 ✓" as
// wrong characters. The PDF embeds Noto Sans, which draws Latin with its accents, Greek and Cyrillic. Before a PDF with
// other characters, the page names them and downloads on request, with U+FFFD in their place.
const worldMap = (title, skills) => entryOf(title, {
  areas: { gr: { name: "Ελλάδα", color: "#2c5fc4", at: [0, 0], order: 0 }, pl: { name: "Polska", color: "#0a8573", at: [200, 0], order: 1 } },
  groups: { "gr-ru": { name: "Москва", area: "gr", order: 0 }, "pl-pl": { name: "Łódź", area: "pl", order: 1 } },
  skills: Object.fromEntries(skills.map(([name, group, rating], i) => ["s" + i, { name, group, rating, places: [], order: i }])) });
test("the PDF draws Łódź, Ελλάδα and Москва as text in its embedded font Noto Sans", withSite({ maps: { m1: worldMap("Karte Łódź", [["Łódź", "pl-pl", 3], ["Ελληνικά", "gr-ru", 1], ["Русский язык", "gr-ru", 2], ["Grüße – „€“", "pl-pl", 1]]) } }, async (page, check) => {
  await go(page, "map.html?id=m1");
  await mapReady(page);
  const day = await page.evaluate(() => new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }));
  const pdf = pdfOf(await downloadFile(page, "pdf"));
  const want = ["Ελλάδα", "Polska", "МОСКВА", "ŁÓDŹ", "Łódź", "Ελληνικά", "Русский язык", "Grüße – „€“", "Karte Łódź · " + day];
  check(want.every((name) => pdf.strings.includes(name)), "the PDF holds each name as text, the categories in capitals, and the title in the foot line: " + JSON.stringify(want.filter((name) => !pdf.strings.includes(name))));
  check(pdf.fonts.length > 0 && pdf.fonts.every((f) => f.name === "NotoSans" && f.embedded), "in the embedded font Noto Sans: " + JSON.stringify(pdf.fonts));
  check(!pdf.strings.some((s) => s.includes("�")), "without a replacement character");
  check((await page.locator("#download-state").innerText()).startsWith("Heruntergeladen: ") && await page.locator("#download-state.error").count() === 0, "and without a warning: " + await page.locator("#download-state").innerText());
}));
for (const language of ["de", "en"]) {
  test(`a name that the font of the PDF cannot draw: a warning names the characters first, in ${language === "de" ? "German" : "English"}, and the PDF follows on request`,
    withSite({ language, maps: { m1: worldMap("Karte", [["日本", "pl-pl", 3], ["Party 🎉 Time", "gr-ru", 1], ["Łódź", "pl-pl", 1]]) } }, async (page, check) => {
      await go(page, "map.html?id=m1");
      await page.waitForFunction(() => document.getElementById("save-state").dataset.state === "saved", null, { timeout: 15000 });
      await page.waitForTimeout(250);
      let downloads = 0;
      page.on("download", () => { downloads++; });
      await page.click('#downloads button[data-file="pdf"]');
      await page.waitForFunction(() => document.querySelector("#download-state button"), null, { timeout: 30000 });
      const state = await page.locator("#download-state").innerText(), characters = ["日 (U+65E5)", "本 (U+672C)", "🎉 (U+1F389)"];
      const [before, after] = textOf("download.pdfMissing", language).split("{characters}");
      check(state.startsWith(before) && state.includes(after) && characters.every((c) => state.includes(c)) && !state.includes("Ł") && state.includes(textOf("download.pdfAnyway", language))
        && await page.locator("#download-state.error").count() === 1, "the warning names each character with its code point, and no other: " + state);
      await page.waitForTimeout(300);
      check(downloads === 0, "no PDF without a click on the button");
      const [file] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.locator("#download-state button").click()]);
      const pdf = pdfOf(fs.readFileSync(await file.path()));
      check(["��", "Party � Time", "Łódź"].every((name) => pdf.strings.includes(name)), "the PDF shows U+FFFD in their place and keeps the rest of each name: " + JSON.stringify(pdf.strings.filter((s) => /�|Party|Łódź/.test(s))));
      await page.waitForFunction(() => !document.querySelector("#download-state button"), null, { timeout: 10000 });
      check(!(await page.locator("#download-state").innerText()).includes(characters[0]), "after the download the warning is gone");
    }));
}

// A configuration for readers with a billion steps (B2 of the review) froze the page on every open.
const hugeMap = () => entryOf("Riesig", { ...collectionsOf(FIXTURE, FIXTURE_PROJECTS), configs: { x: { name: "X", schema: 4, values: { ticks: 1e9, skillHold: 1e9 } } }, settings: { reader: { config: "x" } } });
test("a map with 1e9 steps in its configuration for readers opens in normal time", withSite({ maps: { m1: hugeMap() } }, async (page, check) => {
  const t0 = Date.now();
  await go(page, "map.html?id=m1");
  await mapReady(page);
  const answer = await Promise.race([page.evaluate(() => ({ ticks: TICKS, skillHold: SKILL_HOLD, nodes: document.querySelectorAll("#map g.node").length })),
    new Promise((resolve) => setTimeout(() => resolve(null), 15000))]);
  const seconds = (Date.now() - t0) / 1000;
  check(!!answer && answer.ticks === 1500 && answer.skillHold === 32 && answer.nodes === 16, "the configuration takes the ends of the controls, 1500 steps: " + JSON.stringify(answer));
  check(seconds < 15, `the page answers after ${seconds.toFixed(1)} s`);
}));

// A change that the visitor makes right before he leaves the page (B1 of the review): the page flushes its waiting
// writes on pagehide, and they must land before the page goes.
async function renameProject(page, from, to) {
  await page.click("#projects-btn"); await page.waitForTimeout(100);
  await page.locator("#panel .plist button", { hasText: from }).click(); await page.waitForTimeout(100);
  await clickPanel(page, "Bearbeiten");
  await page.fill("#pf-name", to);
  await page.locator("#project-form button[type=submit]").click();
}
const leave = async (page) => { await page.locator("header a.tool-link", { hasText: "Start" }).click(); await page.waitForURL((url) => url.pathname === "/" || url.pathname.endsWith("/index.html")); };
test("a change lands in the storage of the browser at once, also when the visitor leaves right after it", withSite({ maps: { m1: seededMap() } }, async (page, check) => {
  await go(page, "map.html?id=m1");
  await mapReady(page);
  // The page saves a project a moment after the change, so the leave sends it.
  await renameProject(page, "Kundenportal", "Umbenannt");
  await leave(page);
  check((await stored(page)).m1.collections.projects["neu-kundenportal"].name === "Umbenannt", "a renamed project is stored when the visitor leaves at once");
  // The page saves a category at once, and the storage must hold it before the next page.
  await go(page, "map.html?id=m1");
  await mapReady(page);
  await page.locator("#areas .chip", { hasText: "Daten" }).click(); await page.waitForTimeout(150);
  await clickPanel(page, "+ Kategorie");
  await page.fill("#cf-name", "Sofort");
  await page.locator("#catalog-form button[type=submit]").click();
  await leave(page);
  check(Object.values((await stored(page)).m1.collections.groups).some((g) => g.name === "Sofort"), "a new category is stored when the visitor leaves at once");
}));

// The runtime of the server against a stand-in of its API (tests/selfhost/fake-api.js), on the build of the site.
const docsOf = (collections) => Object.fromEntries(Object.entries(collections).flatMap(([name, docs]) => Object.entries(docs).map(([id, data]) => [name + "/" + id, data])));
// A context for the map page of the server. Each PUT and DELETE of the runtime is recorded in sessionStorage with its
// options, so the record survives a leave to the start page.
async function serverSite(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: "reduce", acceptDownloads: true });
  await context.addInitScript(chooseLanguage, "de");
  const errors = [], external = [];
  await context.addInitScript(() => {
    const original = window.fetch;
    window.fetch = function (input, options) {
      const o = options || {};
      if (o.method === "PUT" || o.method === "DELETE") {
        try {
          const list = JSON.parse(sessionStorage.getItem("writes") || "[]");
          list.push({ url: String(input), method: o.method, keepalive: o.keepalive === true, csrf: (o.headers || {})["X-Requested-With"] || "", bytes: typeof o.body === "string" ? new Blob([o.body]).size : 0 });
          sessionStorage.setItem("writes", JSON.stringify(list));
        } catch (error) { /* a page without storage */ }
      }
      return original.apply(this, arguments);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/status of 4\d\d/.test(message.text())) errors.push(message.text()); });
  page.on("request", (request) => { const url = request.url(); if (!url.startsWith(server.origin.replace(/:\d+$/, "")) && !/^(blob|data):/.test(url)) external.push(url); });
  return { context, page, errors, external };
}
const recordedWrites = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("writes") || "[]"));
async function until(test, ms = 5000) { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return test(); }

test("the runtime of the server sends a change with keepalive and the CSRF header, so a leave right after it keeps it", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: docsOf(collectionsOf(FIXTURE, FIXTURE_PROJECTS)) });
  const s = await serverSite(browser);
  try {
    await s.page.goto(api.pageUrl);
    await mapReady(s.page);
    check((await h2(s.page)) === "9 Kenntnisse in 3 Bereichen", "the map of the server");
    await renameProject(s.page, "Kundenportal", "Umbenannt");
    await leave(s.page);
    const landed = await until(() => (api.state.docs.get("projects/neu-kundenportal") || {}).name === "Umbenannt");
    check(landed, "the server has the renamed project after the leave");
    const put = (await recordedWrites(s.page)).filter((w) => w.url.includes("/docs/projects/neu-kundenportal"));
    check(put.length >= 1 && put.every((w) => w.keepalive && w.csrf === "it-skills"), "the runtime sent it with keepalive and X-Requested-With: " + JSON.stringify(put));
    check(api.state.writes.filter((w) => w.key === "projects/neu-kundenportal").every((w) => w.csrf === "it-skills"), "the server saw the CSRF header");
    // A body above 64 KB, the limit of the browser for keepalive, goes without it.
    await s.page.goto(api.pageUrl);
    await mapReady(s.page);
    const big = await s.page.evaluate(async () => { try { await (await runtime.db()).collection("extra").doc("gross").set({ text: "x".repeat(70 * 1024) }); return "written"; } catch (error) { return error.code; } });
    const small = await s.page.evaluate(async () => { try { await (await runtime.db()).collection("extra").doc("klein").set({ text: "x" }); return "written"; } catch (error) { return error.code; } });
    const sent = await recordedWrites(s.page), of = (id) => sent.filter((w) => w.url.includes("/docs/extra/" + id));
    check(big === "written" && api.state.docs.has("extra/gross") && of("gross").length === 1 && !of("gross")[0].keepalive && of("gross")[0].bytes > 64 * 1024,
      "a body of " + (of("gross")[0] || {}).bytes + " bytes goes without keepalive and lands: " + big);
    check(small === "written" && of("klein").length === 1 && of("klein")[0].keepalive, "a small body goes with keepalive");
    check(s.errors.length === 0, "no console errors" + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
    check(s.external.length === 0, "no request leaves localhost" + (s.external.length ? ": " + s.external.join(", ") : ""));
  } finally { await s.context.close(); await api.close(); }
});

// A second write of a document waits until the first one ends. A visitor who closed the tab in that moment lost it: the
// tab went before the wait ended. On pagehide the runtime sends every waiting write at once, with keepalive. A write
// without keepalive would not leave a closing tab, so the server sees only writes with keepalive here.
test("the runtime of the server sends a write that waits behind a slow write at once when the visitor closes the tab", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: docsOf(collectionsOf(FIXTURE, FIXTURE_PROJECTS)) });
  const s = await serverSite(browser);
  const key = "projects/neu-kundenportal", name = () => (api.state.docs.get(key) || {}).name, writes = () => api.state.writes.filter((w) => w.key === key);
  try {
    await s.page.goto(api.pageUrl);
    await mapReady(s.page);
    const project = api.state.docs.get(key);
    api.state.slow[key] = 2000;
    await s.page.evaluate(async (data) => {
      const doc = (await runtime.db()).collection("projects").doc("neu-kundenportal");
      doc.set({ ...data, name: "Erste Änderung" }).catch(() => null);
      doc.set({ ...data, name: "Zweite Änderung" }).catch(() => null);
    }, project);
    check(await until(() => writes().length === 1) && (await new Promise((r) => setTimeout(r, 300)), writes().length === 1), "the first write reaches the slow server, and the second one waits");
    check(s.errors.length === 0, "no console errors" + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
    check(s.external.length === 0, "no request leaves localhost" + (s.external.length ? ": " + s.external.join(", ") : ""));
    await s.page.close({ runBeforeUnload: true });
    const second = await until(() => writes().length === 2 && name() === "Zweite Änderung", 4000);
    await new Promise((r) => setTimeout(r, 2500));
    check(second && name() === "Zweite Änderung", `the closing tab sends the second write, and the server keeps it after the first write ends: ${writes().length} writes, the project is „${name()}“`);
  } finally { await s.context.close(); await api.close(); }
});

// The same through the project form (D1 of the final review): the page kept a second edit of a project for the moment
// when the first write ends, so the runtime never saw it when the tab closed before. Now the page hands it to the runtime
// when the tab hides or closes.
test("a project edit while the write of the edit before is still on its way lands when the visitor closes the tab", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: docsOf(collectionsOf(FIXTURE, FIXTURE_PROJECTS)) });
  const s = await serverSite(browser);
  const key = "projects/neu-kundenportal", name = () => (api.state.docs.get(key) || {}).name, writes = () => api.state.writes.filter((w) => w.key === key);
  try {
    await s.page.goto(api.pageUrl);
    await mapReady(s.page);
    api.state.slow[key] = 3000;
    await renameProject(s.page, "Kundenportal", "Erste Änderung");
    check(await until(() => writes().length === 1), "the first write reaches the slow server");
    await clickPanel(s.page, "Bearbeiten");
    await s.page.fill("#pf-name", "Zweite Änderung");
    await s.page.locator("#project-form button[type=submit]").click();
    await s.page.waitForTimeout(600);
    check(writes().length === 1, "the second edit waits for the first write");
    check(s.errors.length === 0, "no console errors" + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
    await s.page.close({ runBeforeUnload: true });
    await until(() => writes().length === 2 && name() === "Zweite Änderung", 4000);
    await new Promise((r) => setTimeout(r, 3500));
    const sent = writes().map((w) => JSON.parse(w.body).name + (w.base === null ? " without base" : " with base"));
    check(name() === "Zweite Änderung" && same(sent, ["Erste Änderung with base", "Zweite Änderung without base"]),
      `the closing tab sends the second edit, and the server keeps it after the first write ends: the project is „${name()}“, writes: ` + JSON.stringify(sent));
  } finally { await s.context.close(); await api.close(); }
});

// The runtime turned every 4xx but a few into invalid_argument, and the page then made the projects and the
// configurations read-only for the whole visit (B7 of the review). Only a refusal of the right (403) does that now.
test("the runtime of the server: a refused right makes the page read-only, any other refusal fails one write and shows its message", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: docsOf(collectionsOf(FIXTURE, FIXTURE_PROJECTS)) });
  const s = await serverSite(browser), page = s.page;
  const state = () => page.locator("#save-state").innerText();
  const notice = () => page.locator("#runtime-alert").innerText().catch(() => "");
  const settled = () => page.waitForFunction(() => !/Speichert/.test(document.getElementById("save-state").textContent), null, { timeout: 5000 }).then(() => page.waitForTimeout(200));
  const storeView = () => page.evaluate(() => ({ message: document.getElementById("store-message").textContent, form: !document.getElementById("store-form").hidden }));
  async function saveConfig(name) { await page.fill("#store-name", name); await page.click("#store-save"); await page.waitForTimeout(500); }
  try {
    await page.goto(api.pageUrl);
    await mapReady(page);
    // A 400 fails this one write. The page says why, and the next write lands.
    api.state.refuse["projects/neu-kundenportal"] = [400, "invalid_document", "Das Dokument ist ungültig."];
    await renameProject(page, "Kundenportal", "Abgelehnt");
    await page.waitForTimeout(500); await settled();
    check((await state()) === "Nicht gespeichert (invalid_argument)" && (await notice()).includes("Das Dokument ist ungültig."), "a 400: the write fails, and the page shows its message: " + await state() + " | " + await notice());
    check(await page.locator("#panel button", { hasText: "Bearbeiten" }).count() === 1, "the project stays editable");
    delete api.state.refuse["projects/neu-kundenportal"];
    await clickPanel(page, "Bearbeiten");
    await page.fill("#pf-name", "Angenommen");
    await page.locator("#project-form button[type=submit]").click();
    await page.waitForTimeout(500); await settled();
    check((await state()) === "Gespeichert" && api.state.docs.get("projects/neu-kundenportal").name === "Angenommen", "the next write lands: " + await state());
    // The same for a configuration of the force menu.
    await page.evaluate(() => { document.getElementById("spring-store").open = true; });
    api.state.refuse["configs/probe"] = [400, "invalid_document", "Das Dokument ist ungültig."];
    await saveConfig("Probe");
    let v = await storeView();
    check(v.message === "Speichern abgelehnt: Das Dokument ist ungültig." && v.form, "a 400 of a configuration: its message, and the store stays writable: " + JSON.stringify(v));
    delete api.state.refuse["configs/probe"];
    await saveConfig("Probe");
    check((await storeView()).message === "Gespeichert: „Probe“." && api.state.docs.has("configs/probe"), "the next save lands");
    // A 403 refuses the right: the configurations and the projects are read-only for this visit.
    api.state.refuse["configs/probe"] = [403, "forbidden", "Dafür fehlt dir die Rolle im Team."];
    await saveConfig("Probe");
    await page.locator("#store-ask button", { hasText: "Überschreiben" }).click(); await page.waitForTimeout(500);
    v = await storeView();
    check(v.message === "Speichern abgelehnt: Diese Ansicht darf keine Konfigurationen schreiben. Laden geht weiter." && !v.form, "a 403 of a configuration: the store is read-only: " + JSON.stringify(v));
    api.state.refuse["projects/neu-kundenportal"] = [403, "forbidden", "Dafür fehlt dir die Rolle im Team."];
    await clickPanel(page, "Bearbeiten");
    await page.fill("#pf-name", "Verboten");
    await page.locator("#project-form button[type=submit]").click();
    await page.waitForTimeout(500); await settled();
    check((await state()) === "Nur Lesen" && (await panelText(page)).includes("Die Projekte sind für diesen Besuch nur lesbar.") && await page.locator("#panel button", { hasText: "Bearbeiten" }).count() === 0,
      "a 403 of a project: the projects are read-only: " + await state());
    // The text of the server for this code, which the page shows from the catalogs (error.forbidden).
    check((await notice()).includes("Dafür fehlt dir die Rolle im Team."), "and the page shows the message of the server");
    check(s.errors.length === 0, "no console errors" + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
  } finally { await s.context.close(); await api.close(); }
});

// The storage of the browser
test("a full storage gives a clear German message", withSite({ maps: { m1: seededMap() }, init: () => {
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (window.__full && String(key).startsWith("it-skills-map/")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    return set.call(this, key, value);
  };
} }, async (page, check, s) => {
  await go(page, "map.html?id=m1");
  await mapReady(page);
  await page.evaluate(() => { window.__full = true; });
  await page.locator("#areas .chip", { hasText: "Daten" }).click(); await page.waitForTimeout(150);
  await clickPanel(page, "+ Kategorie");
  await page.fill("#cf-name", "Zu viel");
  await submitForm(page);
  await page.waitForTimeout(400);
  check((await page.locator("#runtime-alert").innerText()).startsWith("Der Speicher dieses Browsers ist voll. Die letzte Änderung ist nicht gespeichert. Exportiere die Map als Datei"), "the message: " + await page.locator("#runtime-alert").innerText().catch(() => ""));
  check((await page.locator("#save-state").innerText()) === "Nicht gespeichert (quota_exceeded)", "the save state says so too");
  await go(page, "");
  await page.evaluate(() => { window.__full = true; });
  await page.click("#new-empty"); await page.waitForTimeout(150);
  check((await page.locator("#message").innerText()).startsWith("Der Speicher dieses Browsers ist voll."), "a new map in a full storage says so");
}));

test("a blocked storage: the start page says so, and the example map still works", withSite({ init: () => {
  Object.defineProperty(window, "localStorage", { get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
} }, async (page, check) => {
  await go(page, "");
  // Without storage the page cannot read the choice of German, so it shows English, the language of a first visit.
  check((await page.locator("#message").innerText()).startsWith(textOf("local.blocked")), "the start page: " + await page.locator("#message").innerText());
  await go(page, "map.html?id=m1");
  await page.waitForFunction(() => document.querySelector("#panel h2"));
  await page.waitForTimeout(300);
  check((await page.locator("#runtime-alert").innerText()).startsWith(textOf("local.blocked")), "a map page says so too");
  await go(page, "example.html");
  await mapReady(page, false);
  check((await h2(page)).endsWith("skills in 6 areas"), "the example map works without storage");
}));

// English is the language of a first visit (i18n/README.md). Each kind of page of the site opens in English and sets
// <html lang="en">. withSite fails on every console error, so also on a missing text or a missing value of a text.
// germanIn looks only at parts of a map page without map content, because the content of these maps is German.
test("English: the start page, the example map and a map of the browser open in English, without a missing text", withSite({ language: null, maps: { m1: seededMap() } }, async (page, check) => {
  const view = (selector) => page.evaluate((sel) => ({ lang: document.documentElement.lang, language: SkillMapI18n.language, title: document.title,
    text: [...document.querySelectorAll(sel)].map((el) => el.innerText).join("\n") }), selector);
  await go(page, "");
  await page.waitForFunction(() => document.getElementById("map-list"));
  const start = await view("body");
  check(start.lang === "en" && start.language === "en" && start.title === textOf("start.pageTitle"), "the start page: lang en and its English title: " + start.lang + ", " + start.title);
  check(start.text.includes(textOf("start.newDefault")) && germanIn(start.text).length === 0, "the start page shows English texts and no German one: " + germanIn(start.text).join(" | "));
  const frame = page.frame({ url: /example\.html$/ });
  await frame.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 });
  check(await frame.evaluate(() => document.documentElement.lang) === "en", "the example map on the start page: lang en");

  await go(page, "example.html");
  await mapReady(page, false);
  await page.locator("#areas .chip").first().click(); await page.waitForTimeout(150);
  await page.click("#projects-btn"); await page.waitForTimeout(150);
  const example = await view("header .tools, .hint, #timebar .time-head, #downloads");
  check(example.lang === "en" && await page.locator("#projects-btn").innerText() === textOf("head.projects") && await page.locator("#time-title").textContent() === textOf("time.title"),
    "the example map: lang en and the English static texts");
  check(germanIn(example.text).length === 0, "the example map shows no German interface text: " + germanIn(example.text).join(" | "));

  await go(page, "map.html?id=m1");
  await page.waitForFunction((saved) => document.getElementById("save-state").textContent === saved && document.getElementById("cfg-groups").children.length > 0, englishOf("Gespeichert"), { timeout: 15000 });
  await page.evaluate(() => document.querySelectorAll("#cfg details").forEach((d) => { d.open = true; }));
  await page.waitForTimeout(200);
  const owner = await view("header .tools, #cfg, #timebar .time-head, #downloads");
  check(owner.lang === "en" && owner.text.includes(textOf("menu.title")), "a map of the browser as its owner: lang en and the English force menu");
  check(germanIn(owner.text).length === 0, "the owner map and its force menu show no German interface text: " + germanIn(owner.text).join(" | "));
}));

test("a map that this browser does not have: a message, read-only and empty", withSite({}, async (page, check) => {
  await go(page, "map.html?id=fehlt");
  await page.waitForFunction(() => document.querySelector("#panel h2"));
  await page.waitForTimeout(300);
  check((await page.locator("#runtime-alert").innerText()).startsWith("Diese Map gibt es in diesem Browser nicht."), "the message");
  check((await page.locator("#title").innerText()) === "Skill-Map" && await page.locator("#cfg").isHidden() && await page.locator("#file-export").isHidden(), "no owner controls");
}));

test("the map page of the server on a plain web space: a message, read-only, and no request to the API", withSite({}, async (page, check, s) => {
  const asked = [];
  page.on("request", (request) => { if (/\/api\//.test(request.url())) asked.push(request.url()); });
  await go(page, "server-map.html");
  await page.waitForFunction(() => document.querySelector("#panel h2"));
  await page.waitForTimeout(300);
  check((await page.locator("#runtime-alert").innerText()).startsWith("Diese Seite zeigt eine Map vom Server und braucht ihre Adresse."), "the message: " + await page.locator("#runtime-alert").innerText().catch(() => ""));
  check(await page.locator("#cfg").isHidden() && await page.locator("#file-export").count() === 0 && await page.locator("#share-open").count() === 0, "no owner controls");
  check(asked.length === 0, "no request to the API: " + asked.join(", "));
  await go(page, "");
  check(await page.locator("#account-card").count() === 0 && (await page.locator("#intro-label").innerText()).toLowerCase() === "so funktioniert es", "the start page shows no account card without the server");
}));

// Layout and theme
test("phone width and dark theme: start page and owner map fit and take the dark tokens", withSite({ maps: { m1: seededMap() }, viewport: { width: 390, height: 844 }, colorScheme: "dark" }, async (page, check) => {
  await go(page, "");
  await page.waitForTimeout(300);
  check(await noSideScroll(page), "the start page has no sideways scroll at 390 px");
  check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === "rgb(15, 21, 23)", "the start page takes the dark background of the map page");
  await go(page, "map.html?id=m1");
  await mapReady(page);
  check(await noSideScroll(page), "the owner map has no sideways scroll at 390 px");
  check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === "rgb(15, 21, 23)", "the map is dark");
  check(await page.evaluate(() => getComputedStyle(document.querySelector("#areas .chip.k-sd i")).backgroundColor) === "rgb(124, 156, 218)", "an area color is lighter in the dark theme: " + await page.evaluate(() => getComputedStyle(document.querySelector("#areas .chip.k-sd i")).backgroundColor));
}));

// The entry for AI agents on the start page, window.SkillMap (selfhost/site/agent.js), and the files that describe it.
const AI_EXAMPLE_FILE = path.join(repo, "selfhost", "site", "ai", "example.it-skills-map.json");
test("window.SkillMap on the start page: validate stores nothing, importMap stores a map and answers with its address, and a wrong file gets a reason", withSite({}, async (page, check) => {
  await go(page, "");
  const example = JSON.parse(fs.readFileSync(AI_EXAMPLE_FILE, "utf8"));
  const api = await page.evaluate(() => ({ format: SkillMap.format, schema: SkillMap.schema, docs: SkillMap.docs, frozen: Object.isFrozen(SkillMap) }));
  check(api.format === "it-skills-map" && api.schema === 1 && api.frozen, "the format and the schema: " + JSON.stringify([api.format, api.schema]));
  check(api.docs.llms === server.url + "llms.txt" && api.docs.format === server.url + "ai/format.txt" && api.docs.example === server.url + "ai/example.it-skills-map.json", "the addresses of the documents: " + JSON.stringify(api.docs));

  const dry = await page.evaluate((map) => SkillMap.validate(JSON.stringify(map)), example);
  check(dry.ok && dry.title === "Example Skill-Atlas" && dry.warnings.length === 0 && dry.counts.skills === 10 && dry.counts.projects === 3 && dry.counts.stations === 3, "validate: the example is valid, with no warning: " + JSON.stringify(dry));
  check(await page.evaluate(() => SkillMapRuntime.store.list().length) === 0, "validate stores nothing");

  const done = await page.evaluate((map) => SkillMap.importMap(map), example);
  check(done.ok && /^m[a-z0-9]+$/.test(done.id) && done.url === server.url + "map.html?id=" + done.id && done.warnings.length === 0 && same(done.counts, dry.counts), "importMap with an object: ok, the id, the address of the map and no warning: " + JSON.stringify(done));
  check(await page.evaluate(() => location.pathname.endsWith("/") || location.pathname.endsWith("index.html")), "the page stays on the start page by default");
  const listed = await page.evaluate(() => SkillMapRuntime.store.list().map((m) => [m.title, m.counts.skills]));
  check(same(listed, [["Example Skill-Atlas", 10]]), "the map is in the list of this browser: " + JSON.stringify(listed));

  await page.goto(done.url); await mapReady(page);
  check((await h2(page)) === "10 Kenntnisse in 3 Bereichen", "the stored map opens: " + await h2(page));

  await go(page, "");
  const text = await page.evaluate((map) => SkillMap.importMap(JSON.stringify(map)), example);
  check(text.ok && text.id !== done.id, "importMap with the text of the file makes a second map");

  const refused = await page.evaluate(() => [SkillMap.importMap("not json"), SkillMap.importMap(JSON.stringify({ format: "other", schema: 1, collections: {} })), SkillMap.importMap(undefined), SkillMap.importMap({ format: "it-skills-map", schema: 1, collections: { areas: { "Bad Id": {} } } })]);
  check(refused.every((r) => r.ok === false && typeof r.error === "string" && r.error.length > 10), "a wrong input is refused with a reason: " + JSON.stringify(refused.map((r) => r.error)));
  check(await page.evaluate(() => SkillMapRuntime.store.list().length) === 2, "a refused input stores nothing");

  const broken = structuredClone(example);
  broken.collections.groups["dev-lang"].area = "nowhere";
  broken.collections.skills.python.rating = 5;
  broken.collections.skills.git.places = ["FOX", "GONE"];
  broken.collections.skills.python2 = { name: "Python", group: "dev-lang", rating: 1, places: [], order: 99 };
  broken.collections.projects["fox-booking-api"].skills.push("Missing skill");
  broken.collections.projects["owl-data-platform"].station = "NOPE";
  const warned = await page.evaluate((map) => SkillMap.validate(map), broken);
  const w = warned.warnings.join("\n");
  check(warned.ok && warned.warnings.length === 6, "a file with wrong links is valid, and validate gives six warnings: " + warned.warnings.length + "\n" + w);
  check(["groups/dev-lang", "skills/python", "skills/git", "skills/python2", "projects/fox-booking-api", "projects/owl-data-platform"].every((x) => w.includes(x)), "each warning names its document");

  const open = await page.evaluate((map) => { SkillMap.importMap(map, { open: true }); return true; }, example);
  await page.waitForURL(/map\.html\?id=/);
  check(open && (await h2(page)).startsWith("10 Kenntnisse"), "importMap with open: true opens the map");
}));

test("llms.txt and the format text: served as text, every link resolves, and the example is the one of the importer", withSite({}, async (page, check) => {
  await go(page, "");
  const files = await page.evaluate(async () => Object.fromEntries(await Promise.all(["llms.txt", "ai/format.txt", "ai/example.it-skills-map.json", "ai.html", "license.txt"].map(async (name) => {
    const r = await fetch(name); return [name, { status: r.status, type: r.headers.get("content-type"), text: await r.text() }];
  }))));
  check(files["llms.txt"].status === 200 && files["llms.txt"].type.startsWith("text/plain") && files["llms.txt"].text.startsWith("# Skill-Map"), "llms.txt is plain text and starts with the name");
  const links = [...files["llms.txt"].text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  check(links.length >= 5 && links.every((l) => !l.includes("@SITE@") && !/^https?:/.test(l)), "its links are relative without SKILLMAP_SITE_URL: " + links.join(", "));
  const resolved = await page.evaluate(async (all) => Promise.all(all.map(async (l) => (await fetch(l)).status)), links);
  check(resolved.every((s) => s === 200), "every link of llms.txt resolves: " + resolved.join(","));
  const fmt = files["ai/format.txt"];
  check(fmt.status === 200 && fmt.type.startsWith("text/plain") && ["window.SkillMap.importMap", "window.SkillMap.validate", "it-skills-map", "Arbeitgeber", "PRIVAT", "ai/example.it-skills-map.json"].every((x) => fmt.text.includes(x)), "the format text names the entry, the format, the kinds and the example");
  check(files["ai/example.it-skills-map.json"].type.startsWith("application/json") && files["ai/example.it-skills-map.json"].text === fs.readFileSync(AI_EXAMPLE_FILE, "utf8").replace(/\r/g, ""), "the example file is the file of the repository");
  check(files["ai.html"].status === 200, "the page for people is there");
  check(files["license.txt"].status === 200 && files["license.txt"].type.startsWith("text/plain") && files["license.txt"].text.startsWith("Required Notice: Copyright (c) 2026 Justus Timmerer") && files["license.txt"].text.includes("PolyForm Noncommercial License 1.0.0"), "license.txt holds the notice and the PolyForm Noncommercial License");
}));

test("the page for people: heading, steps and the prompt with the address of llms.txt, in English and in German", withSite({ language: null }, async (page, check) => {
  for (const language of ["en", "de"]) {
    await go(page, "");
    await page.evaluate((c) => localStorage.setItem("skill-map-language", c), language);
    await go(page, "ai.html");
    const v = await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.title, h1: document.querySelector("main h1").textContent, steps: document.querySelectorAll("main ol li").length,
      prompt: document.getElementById("prompt").textContent, link: document.querySelector('main a[href="ai/format.txt"]').textContent }));
    check(v.lang === language && v.title === CATALOGS[language]["ai.pageTitle"] && v.h1 === CATALOGS[language]["ai.heading"] && v.steps === 4 && v.link === CATALOGS[language]["ai.formatLink"], `${language}: language, title, heading, four steps and the link: ${JSON.stringify([v.lang, v.title, v.h1, v.steps])}`);
    check(v.prompt === CATALOGS[language]["ai.prompt"].replace("{url}", server.url + "llms.txt"), `${language}: the prompt names the address of llms.txt: ${v.prompt}`);
  }
}));

test("SKILLMAP_LEGAL fills the placeholders of the legal pages, and the draft note goes away only when none is left", async ({ check }) => {
  const { build } = require(path.join(repo, "build_selfhost.js"));
  const dir = path.join(OUT, "legal-site"), file = path.join(OUT, "legal.json");
  const legal = { name: "Erika <Muster>", address: "Beispielweg 1\n12345 Beispielstadt", email: "erika@example.org", host: "Beispiel-Hosting AG", retention: "14 Tagen", retentionEn: "14 days", authority: "Beispiel-Aufsicht" };
  const decoded = (html) => html.replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n));
  const text = (name) => fs.readFileSync(path.join(dir, name), "utf8");
  try {
    for (const [label, values] of [["all", legal], ["partial", { name: legal.name }]]) {
      fs.writeFileSync(file, JSON.stringify(values));
      process.env.SKILLMAP_LEGAL = file;
      fs.rmSync(dir, { recursive: true, force: true });
      build(dir);
      const pages = [text("imprint.html"), text("privacy.html")];
      check(pages.every((p) => p.includes("Erika &lt;Muster&gt;")), label + ": the name is filled in and escaped");
      if (label === "all") {
        check(pages.every((p) => !p.includes('class="placeholder"') && !p.includes('class="draft"')), "all: no placeholder and no draft note is left");
        check(decoded(pages[0]).includes("Beispielweg 1<br>12345 Beispielstadt") && decoded(pages[1]).includes("erika@example.org") && pages[1].includes("Beispiel-Hosting AG") && pages[1].includes("14 Tagen") && pages[1].includes("14 days") && pages[1].includes("Beispiel-Aufsicht"), "all: the address, the e-mail address, the host, the retention in both languages and the authority");
        check(pages.every((p) => !p.includes("Beispielweg") && !p.includes("Beispielstadt") && !p.includes("erika") && !p.includes("@")), "all: the address and the e-mail address are not in the raw HTML");
      } else check(pages.every((p) => p.includes('class="placeholder"') && p.includes('class="draft"')), "partial: the other placeholders and the draft note stay");
    }
  } finally { delete process.env.SKILLMAP_LEGAL; }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the legal drafts carry the draft mark and the placeholders", withSite({}, async (page, check) => {
  for (const name of ["imprint.html", "privacy.html"]) {
    await go(page, name);
    const text = await page.locator("main").innerText();
    check(text.startsWith("Entwurf – vor Veröffentlichung prüfen"), name + ": marked as a draft at the top");
    check(["[NAME]", "[ANSCHRIFT]", "[E-MAIL]"].every((p) => text.includes(p)), name + ": the placeholders");
  }
  const text = await page.locator("main").innerText();
  check(text.includes("Diese Website setzt keine Cookies.") && text.includes("nur im lokalen Speicher deines Browsers") && text.includes("Die Website lädt nichts von anderen Servern."), "the privacy draft states the three facts");
  check(await page.evaluate(() => document.cookie) === "", "and the site sets no cookie");
}));

// The language of the pages (i18n/i18n.js) and its dropdown (selfhost/site/language.js), on the build of the site and
// on the stand-in of the API. A context of these tests stores no language before every load, as the other tests do: it
// keeps what the page chose, so that a check sees whether the choice stays.
async function langSite(browser, origin, { language = null, maps = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: "reduce" });
  // The first page of the context finds language and maps in the storage; later pages find what the site kept.
  await context.addInitScript(([code, entries, key, home]) => {
    if (location.origin !== home) return;
    try {
      if (sessionStorage.getItem("seeded")) return;
      if (code) localStorage.setItem("skill-map-language", code);
      Object.entries(entries || {}).forEach(([id, entry]) => localStorage.setItem(key + id, JSON.stringify(entry)));
      sessionStorage.setItem("seeded", "1");
    } catch (error) { /* a frame without storage */ }
  }, [language, maps, KEY, origin]);
  const errors = [], external = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin + "/")) return route.continue();
    external.push(url);
    return route.abort();
  });
  const watch = (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    // A refused request logs its status; the checks read the answer itself.
    page.on("console", (message) => { if (message.type() === "error" && !/status of [45]\d\d/.test(message.text())) errors.push(message.text()); });
  };
  context.on("page", watch);
  const page = await context.newPage();
  return { context, page, errors, external };
}
function cleanSite(s, check, label = "") {
  check(s.errors.length === 0, label + "no console errors" + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
  check(s.external.length === 0, label + "no request leaves localhost" + (s.external.length ? ": " + [...new Set(s.external)].join(", ") : ""));
}
// The language of the page, where it came from, what this browser keeps, and the dropdowns of the page.
const languageOf = (page) => page.evaluate(() => ({ language: SkillMapI18n.language, source: SkillMapI18n.source, lang: document.documentElement.lang,
  stored: (() => { try { return localStorage.getItem("skill-map-language"); } catch (error) { return "blocked"; } })(),
  pickers: [...document.querySelectorAll("[data-language-picker]")].map((holder) => {
    const select = holder.querySelector("select");
    return { shown: !holder.hidden && holder.checkVisibility(), value: select ? select.value : null, label: select ? select.getAttribute("aria-label") : null,
      options: [...holder.querySelectorAll("option")].map((o) => o.value + ":" + o.textContent) };
  }) }));
// Picks a language in the dropdown of the page, clicks the button of the note to reload, and waits for the page to load
// again. The page keeps the choice at once, but it does not load again by itself (finding D8 of the final review).
async function pickLanguage(page, code) {
  await page.selectOption("[data-language-picker] select", code);
  const reload = page.locator(".language-note:not([hidden]) .language-reload").first();
  await reload.waitFor({ timeout: 5000 });
  await Promise.all([page.waitForEvent("load"), reload.click()]);
}
// A page has drawn what a check reads: a map page its panel, the account page its view, any other page its body.
async function settled(page) {
  await page.waitForFunction(() => {
    if (document.getElementById("map")) return !!document.querySelector("#panel h2");
    if (document.getElementById("signed-out")) return !document.getElementById("signed-out").hidden || !document.getElementById("signed-in").hidden;
    return document.readyState === "complete";
  }, null, { timeout: 15000 });
  await page.waitForTimeout(250);
}
const LANGUAGES = ["en:English", "de:Deutsch"];
const SERVER_DOCS = () => docsOf(collectionsOf(FIXTURE, FIXTURE_PROJECTS));

test("the language of a page: the parameter lang of the embed view, then the account, then the choice of this browser, then English", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), visibility: "public", account: { language: "en" } });
  const s = await langSite(browser, api.origin);
  const page = s.page;
  try {
    await page.goto(api.url + "imprint.html"); await settled(page);
    let v = await languageOf(page);
    check(v.language === "en" && v.source === "default" && v.lang === "en" && v.stored === null, "without a choice and without an account: English: " + JSON.stringify(v));
    await page.evaluate(() => localStorage.setItem("skill-map-language", "de"));
    await page.reload(); await settled(page);
    v = await languageOf(page);
    check(v.language === "de" && v.source === "browser" && v.lang === "de", "the choice of this browser comes before English: " + JSON.stringify(v));
    await page.goto(api.pageUrl); await settled(page);
    v = await languageOf(page);
    check(v.language === "en" && v.source === "account" && v.lang === "en" && v.stored === "en", "the language of the account comes before the choice of this browser and becomes that choice: " + JSON.stringify(v));
    await page.goto(api.url + "example.html"); await settled(page);
    v = await languageOf(page);
    check(v.language === "en" && v.source === "browser", "so a static page follows the account: " + JSON.stringify(v));
    await page.goto(api.embedUrl + "?lang=de"); await settled(page);
    v = await languageOf(page);
    check(v.language === "de" && v.source === "address" && v.stored === "en", "the embed view takes its parameter lang first and keeps it as no choice: " + JSON.stringify(v));
    await page.goto(api.embedUrl + "?lang=xx"); await settled(page);
    v = await languageOf(page);
    check(v.language === "en" && v.source === "browser", "a language that the build lacks counts as no parameter: " + JSON.stringify(v));
    for (const rel of ["example.html?lang=de", "anna/servertest?lang=de"]) {
      await page.goto(api.url + rel); await settled(page);
      v = await languageOf(page);
      check(v.language === "en", "only the embed view reads the parameter lang, not " + rel + ": " + JSON.stringify(v));
    }
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("the dropdown in the header of every page lists the languages in their own names, switches the language and keeps it", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), visibility: "public", account: { signedIn: false } });
  const s = await langSite(browser, api.origin, { maps: { m1: seededMap() } });
  const page = s.page;
  const PAGES = [["the start page", ""], ["the example map", "example.html"], ["a map of this browser", "map.html?id=m1"], ["a map of the server", "anna/servertest"],
    ["the account page", "account"], ["the imprint", "imprint.html"], ["the privacy page", "privacy.html"]];
  try {
    for (const [label, rel] of PAGES) {
      await page.goto(api.url + rel); await settled(page);
      const v = await languageOf(page);
      check(v.pickers.length === 1 && v.pickers[0].shown && same(v.pickers[0].options, LANGUAGES) && v.pickers[0].value === "en" && v.pickers[0].label === textOf("language.label"),
        label + ": one dropdown in the header with English and Deutsch, on English: " + JSON.stringify(v.pickers));
      if (rel === "") {
        const frame = page.frame({ url: /example\.html$/ });
        await frame.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 });
        check(await frame.evaluate(() => [...document.querySelectorAll("[data-language-picker]")].every((h) => !h.checkVisibility())), "the example map in the frame of the start page has no dropdown of its own");
      }
    }
    await page.goto(api.embedUrl); await settled(page);
    check((await languageOf(page)).pickers.every((p) => !p.shown), "the embed view has no dropdown");
    await page.goto(api.url); await settled(page);
    await pickLanguage(page, "de"); await settled(page);
    let v = await languageOf(page);
    check(v.language === "de" && v.stored === "de" && v.pickers[0].value === "de" && (await page.locator("#new-default").innerText()) === "Neue Map mit Standardvorlage",
      "a choice on the start page loads it again in German and keeps the choice: " + JSON.stringify(v));
    for (const rel of ["imprint.html", "map.html?id=m1", "account"]) {
      await page.goto(api.url + rel); await settled(page);
      v = await languageOf(page);
      check(v.language === "de" && v.lang === "de", "the next page keeps German: " + rel);
    }
    await pickLanguage(page, "en"); await settled(page);
    v = await languageOf(page);
    check(v.language === "en" && v.stored === "en" && (await page.locator("h1").first().innerText()) === "Account", "a choice on the account page switches back to English: " + JSON.stringify(v));
    check(!api.state.calls.some((c) => c.method === "PATCH"), "without an account the dropdown sends nothing to the server");
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("the dropdown of a signed-in user sets the language of the account first, and a refused change keeps the language and says why", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), account: { language: "en" } });
  const s = await langSite(browser, api.origin);
  const page = s.page;
  try {
    await page.goto(api.pageUrl); await settled(page);
    await pickLanguage(page, "de"); await settled(page);
    const patch = api.state.calls.filter((c) => c.method === "PATCH" && c.path === "/api/account");
    check(patch.length === 1 && same(JSON.parse(patch[0].body), { language: "de" }) && patch[0].csrf === "it-skills", "PATCH /api/account with the language and the CSRF header: " + JSON.stringify(patch));
    let v = await languageOf(page);
    check(api.state.account.language === "de" && v.language === "de" && v.source === "account" && v.stored === "de", "the account and the page are German now: " + JSON.stringify(v));
    await page.goto(api.url); await settled(page);
    check((await languageOf(page)).language === "de" && (await page.locator("#account-card .label").innerText()).toLowerCase() === "mit konto speichern", "the start page follows the account");
    const refusal = { error: "invalid_request", message: "The request is not valid.", params: {} };
    api.state.refuse.account = [400, refusal.error, refusal.message];
    await page.selectOption("[data-language-picker] select", "en");
    await page.waitForFunction(() => !document.querySelector(".language-message").hidden, null, { timeout: 5000 });
    const expected = await page.evaluate((body) => SkillMapI18n.errorText(body, ""), refusal);
    v = await languageOf(page);
    check((await page.locator(".language-message").innerText()) === expected && !!expected && v.language === "de" && v.pickers[0].value === "de" && v.stored === "de" && api.state.account.language === "de",
      "a refused change: the page keeps German, the dropdown goes back, and the text of the error shows next to it: " + expected);
    api.state.refuse.account = [503, null];
    await page.selectOption("[data-language-picker] select", "en");
    await page.waitForFunction((last) => document.querySelector(".language-message").textContent !== last, expected, { timeout: 5000 });
    check((await page.locator(".language-message").innerText()) === CATALOGS.de["language.refused"].replace("{status}", "503"), "an answer without a text names its status: " + await page.locator(".language-message").innerText());
    delete api.state.refuse.account;
    await pickLanguage(page, "en"); await settled(page);
    check((await languageOf(page)).language === "en" && api.state.account.language === "en", "once the server takes it, the page switches");
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("the account page sends the language of the page with a registration and takes the language of the account after a login", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { account: { signedIn: false, language: "de" } });
  const s = await langSite(browser, api.origin);
  const page = s.page;
  try {
    await page.goto(api.url + "account"); await settled(page);
    check((await languageOf(page)).language === "en" && await page.locator("#signed-out").isVisible(), "signed out, a first visit shows the account page in English");
    await page.click("[data-tab=register]");
    await page.fill("#register input[name=email]", "bert@example.org");
    await page.fill("#register input[name=handle]", "bert");
    await page.fill("#register input[name=password]", "ein langes Passwort 123");
    await page.click("#register button[type=submit]");
    await page.waitForFunction(() => !document.getElementById("message").hidden, null, { timeout: 5000 });
    const register = api.state.calls.find((c) => c.path === "/api/auth/register");
    check(!!register && JSON.parse(register.body).language === "en" && JSON.parse(register.body).handle === "bert", "the registration sends the language of the page: " + (register && register.body.replace(/"password":"[^"]*"/, '"password":"…"')));
    await page.click("[data-tab=login]");
    await page.fill("#login input[name=email]", "anna@example.org");
    await page.fill("#login input[name=password]", "ein langes Passwort 123");
    const loaded = page.waitForEvent("load");
    await page.click("#login button[type=submit]");
    await loaded; await settled(page);
    const v = await languageOf(page);
    check(v.language === "de" && v.stored === "de" && v.pickers[0].value === "de" && await page.locator("#signed-in").isVisible() && (await page.locator("h1").first().innerText()) === "Konto",
      "a login into a German account loads the page again in German and keeps it: " + JSON.stringify(v));
    await page.click("#logout");
    await page.waitForFunction(() => !document.getElementById("signed-out").hidden, null, { timeout: 5000 });
    await pickLanguage(page, "en"); await settled(page);
    check((await languageOf(page)).language === "en" && !api.state.calls.some((c) => c.method === "PATCH"), "signed out again, the dropdown changes only this browser");
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("a choice in the dropdown keeps a half-filled form: the page keeps the choice at once and says in the chosen language to reload", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), account: { language: "de" } });
  const s = await langSite(browser, api.origin, { language: "de", maps: { m1: seededMap() } });
  const page = s.page;
  const note = () => page.evaluate(() => { const n = document.querySelector(".language-note"); return { shown: !!n && !n.hidden && n.checkVisibility(), lang: n ? n.lang : null, text: n ? n.textContent.replace(/\s+/g, " ").trim() : "" }; });
  const sameLoad = () => page.evaluate(() => window.__sameLoad === true);
  const patches = () => api.state.calls.filter((c) => c.method === "PATCH" && c.path === "/api/account");
  try {
    // A map of this browser: the station form of the owner, half filled.
    await page.goto(api.url + "map.html?id=m1"); await mapReady(page);
    await clickPanel(page, "+ Station");
    await page.fill("#cf-name", "Halb ausgefüllt");
    await page.evaluate(() => { window.__sameLoad = true; });
    await page.selectOption("[data-language-picker] select", "en");
    await page.locator(".language-note:not([hidden])").waitFor({ timeout: 5000 });
    let v = await languageOf(page);
    check(await sameLoad() && await page.inputValue("#cf-name") === "Halb ausgefüllt" && v.language === "de", "the page does not load again: the form keeps its text, and the page keeps German until a reload");
    check(v.stored === "en" && v.pickers[0].value === "en", "the choice is kept at once: " + JSON.stringify(v));
    const n = await note();
    check(n.shown && n.lang === "en" && n.text === textOf("language.reloadNote") + " " + textOf("language.reload"), "a note in the chosen language says to reload, with a button: " + JSON.stringify(n));
    await page.selectOption("[data-language-picker] select", "de");
    await page.waitForFunction(() => document.querySelector(".language-note").hidden, null, { timeout: 5000 });
    v = await languageOf(page);
    check(v.stored === "de" && !(await note()).shown && await sameLoad() && await page.inputValue("#cf-name") === "Halb ausgefüllt", "a choice of the language of the page takes the choice back, and the note goes");
    await pickLanguage(page, "en"); await settled(page);
    check((await languageOf(page)).language === "en" && !(await sameLoad()), "the button of the note loads the page in the chosen language");
    // Signed in, on the map page of the server: the dropdown sends the choice to the account first, and does not load the page either.
    await page.goto(api.pageUrl); await settled(page);
    check((await languageOf(page)).language === "de", "the map page of the server shows the German account");
    await page.evaluate(() => { window.__sameLoad = true; });
    await page.selectOption("[data-language-picker] select", "en");
    await page.locator(".language-note:not([hidden])").waitFor({ timeout: 5000 });
    v = await languageOf(page);
    check(await sameLoad() && v.language === "de" && v.stored === "en" && patches().length === 1 && api.state.account.language === "en",
      "signed in: the account takes the choice, the page keeps its state and says to reload: " + JSON.stringify(v));
    await Promise.all([page.waitForEvent("load"), page.click(".language-note .language-reload")]); await settled(page);
    v = await languageOf(page);
    check(v.language === "en" && v.source === "account" && patches().length === 1, "the button reloads the page in the language of the account: " + JSON.stringify(v));
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("a choice on a page without the session reaches the signed-in account on the next page with the session, and a choice without an account does not", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), account: { language: "de" } });
  const s = await langSite(browser, api.origin, { language: "de" });
  const page = s.page;
  const mark = () => page.evaluate(() => localStorage.getItem("skill-map-language-account"));
  const patches = () => api.state.calls.filter((c) => c.method === "PATCH" && c.path === "/api/account");
  try {
    await page.goto(api.url); await settled(page);
    let v = await languageOf(page);
    check(v.language === "de" && v.source === "account" && await mark() === "signed-in", "a page with the session of a signed-in account notes the account: " + JSON.stringify(v));
    const calls = api.state.calls.length;
    await page.goto(api.url + "imprint.html"); await settled(page);
    await pickLanguage(page, "en"); await settled(page);
    v = await languageOf(page);
    check(v.language === "en" && v.stored === "en" && await mark() === "newer" && api.state.calls.length === calls && api.state.account.language === "de",
      "the imprint keeps English as a choice newer than the account, and asks the API nothing: " + JSON.stringify(v));
    await page.goto(api.url + "account"); await settled(page);
    await page.waitForFunction(() => localStorage.getItem("skill-map-language-account") === "signed-in", null, { timeout: 5000 });
    v = await languageOf(page);
    check(v.language === "en" && v.source === "browser" && patches().length === 1 && same(JSON.parse(patches()[0].body), { language: "en" }) && api.state.account.language === "en"
      && (await page.locator("h1").first().innerText()) === "Account", "the next page with the session shows the choice instead of the account and sends it to the account: " + JSON.stringify(v));
    await page.goto(api.pageUrl); await settled(page);
    v = await languageOf(page);
    check(v.language === "en" && v.source === "account" && patches().length === 1, "then the account has it, and the pages follow the account again: " + JSON.stringify(v));
    // Signed out: a choice on a static page stays in this browser, and the account that signs in later keeps its language.
    api.state.account.signedIn = false;
    await page.goto(api.url); await settled(page);
    check(await mark() === null, "a page with the session of nobody forgets the account");
    await page.goto(api.url + "privacy.html"); await settled(page);
    await pickLanguage(page, "de"); await settled(page);
    check(await mark() === null && (await languageOf(page)).language === "de", "a choice without an account is only the choice of this browser");
    api.state.account.signedIn = true;
    await page.goto(api.url); await settled(page);
    v = await languageOf(page);
    check(v.language === "en" && v.source === "account" && patches().length === 1, "the account that signs in keeps its language: " + JSON.stringify(v));
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("the account page puts the dropdown of the visibility and of the move back when the server refuses the change", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), account: { language: "de" } });
  const s = await langSite(browser, api.origin, { language: "de" });
  const page = s.page;
  const refusal = { status: 503, contentType: "application/json", body: JSON.stringify({ error: "invalid_request", message: "The request is not valid.", params: {} }) };
  const team = { handle: "crew", name: "Crew", role: "owner", canEdit: true, canManage: true, members: 1, maps: 0 };
  // The message of the account page after an action: its text and whether it is an error.
  const says = async (action) => {
    await page.evaluate(() => { const box = document.getElementById("message"); box.textContent = ""; box.hidden = true; box.classList.remove("error"); });
    await action();
    await page.waitForFunction(() => { const box = document.getElementById("message"); return !box.hidden && box.textContent; }, null, { timeout: 10000 }).catch(() => {});
    return page.evaluate(() => { const box = document.getElementById("message"); return { text: box.textContent, error: box.classList.contains("error") }; });
  };
  const view = { ...team, profileUrl: api.origin + "/crew", siteUrl: null, members: [{ handle: "mate", role: "editor" }] };
  let teamsRefused = false;
  try {
    await page.route("**/api/teams", (route) => route.request().method() !== "GET" ? route.fallback()
      : teamsRefused ? route.fulfill(refusal) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ teams: [team] }) }));
    await page.route("**/api/teams/crew", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(view) }));
    await page.route("**/api/teams/crew/maps", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ maps: [] }) }));
    await page.route("**/api/teams/crew/invitations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ invitations: [] }) }));
    await page.route("**/api/teams/crew/members/mate", (route) => route.fulfill(refusal));
    await page.route("**/api/maps/m1", (route) => route.request().method() === "PATCH" ? route.fulfill(refusal) : route.fallback());
    await page.route("**/api/maps/m1/move", (route) => route.fulfill(refusal));
    await page.goto(api.url + "account"); await settled(page);
    const item = page.locator("#maps > li", { hasText: "Servertest" });
    const visibility = item.locator(`select[aria-label="${CATALOGS.de["account.map.visibilityLabel"]}"]`), mover = item.locator(`select[aria-label="${CATALOGS.de["account.map.moveLabel"]}"]`);
    await mover.waitFor({ timeout: 10000 });
    const error = CATALOGS.de["error.invalid_request"];
    let said = await says(() => visibility.selectOption("public"));
    check(said.error && said.text === error && await visibility.inputValue() === "private" && api.state.visibility === "private" && api.state.patches.length === 0,
      "a refused visibility: the error shows, and the dropdown shows the saved visibility again: " + await visibility.inputValue() + ", " + said.text);
    page.once("dialog", (dialog) => dialog.accept());
    said = await says(() => mover.selectOption("crew"));
    check(said.error && said.text === error && await mover.inputValue() === "" && await item.count() === 1,
      "a refused move: the error shows, the dropdown shows its first choice again, and the map stays in the list: " + JSON.stringify(await mover.inputValue()) + ", " + said.text);
    // The role of a member: the change and the reload of the list both fail, so only the dropdown itself can go back.
    await page.locator("#team-list > li", { hasText: "Crew" }).getByRole("button", { name: CATALOGS.de["account.team.open"] }).click();
    const roles = page.locator(`select[aria-label="${CATALOGS.de["account.member.roleLabel"].replace("{handle}", "mate")}"]`);
    await roles.waitFor({ timeout: 10000 });
    teamsRefused = true;
    said = await says(() => roles.selectOption("owner"));
    check(said.error && said.text === error && await roles.inputValue() === "editor",
      "a refused role, and its reload fails too: the error shows, and the dropdown shows the saved role again: " + await roles.inputValue() + ", " + said.text);
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("the strength meter below a new password counts to 12 characters, then shows the verdict of the server with its warning and tips", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { account: { signedIn: false, language: "de" } });
  const s = await langSite(browser, api.origin, { language: "de" });
  const page = s.page;
  const de = CATALOGS.de;
  const checks = () => api.state.calls.filter((c) => c.path === "/api/auth/password-check");
  // The meter of a form: whether it shows, its score, the filled parts of the bar, the label, the warning and the tips.
  const meter = (form) => page.evaluate((selector) => {
    const box = document.querySelector(selector + " + .strength, " + selector + " ~ .strength");
    return box && { shown: !box.hidden, score: box.dataset.score, ok: box.classList.contains("ok"), on: box.querySelectorAll(".strength-bar .on").length,
      label: box.querySelector(".strength-label").textContent, warning: box.querySelector(".strength-warning").textContent,
      tips: [...box.querySelectorAll(".strength-tips li")].map((li) => li.textContent) };
  }, form);
  const labelIs = (hint, text) => page.waitForFunction(([h, t]) => {
    const box = document.querySelector(h + " + .strength");
    return box && !box.hidden && box.querySelector(".strength-label").textContent === t;
  }, [hint, text], { timeout: 5000 });
  try {
    await page.goto(api.url + "account"); await settled(page);
    await page.click("[data-tab=register]");
    await page.fill("#register input[name=email]", "bert@example.org");
    await page.fill("#register input[name=handle]", "bert");
    check(!(await meter("#password-hint")).shown, "without a password, the meter is hidden");
    await page.fill("#register input[name=password]", "kurz");
    await labelIs("#password-hint", de["account.strength.short"].other.replace("{count}", "8"));
    let m = await meter("#password-hint");
    check(m.score === "0" && m.on === 1 && !m.ok && !m.warning && m.tips.length === 0 && checks().length === 0,
      "below 12 characters, the meter counts the missing characters and asks the server nothing: " + JSON.stringify(m));
    api.state.strength = { ok: false, problem: "guessable", score: 1, warning: "keyboard", tips: ["moreWords", "capitals"], min: 12, max: 1024 };
    await page.fill("#register input[name=password]", "Qwertzuiop12");
    await labelIs("#password-hint", de["account.strength.score1"]);
    m = await meter("#password-hint");
    const asked = JSON.parse(checks()[checks().length - 1].body);
    check(m.on === 2 && !m.ok && m.warning === de["account.strength.warn.keyboard"] && same(m.tips, [de["account.strength.tip.moreWords"], de["account.strength.tip.capitals"]]),
      "a weak password: two parts of the bar, the label, the warning and the tips of the server: " + JSON.stringify(m));
    check(same(asked, { password: "Qwertzuiop12", email: "bert@example.org", handle: "bert" }) && checks().every((c) => c.method === "POST" && c.csrf === "it-skills"),
      "the registration asks with the e-mail address and the handle of the form, as a write of the page: " + JSON.stringify(asked));
    api.state.strength = { ok: true, problem: null, score: 4, warning: null, tips: [], min: 12, max: 1024 };
    await page.fill("#register input[name=password]", "Kaffeetasse Laterne Wolke");
    await labelIs("#password-hint", de["account.strength.score4"]);
    m = await meter("#password-hint");
    check(m.on === 5 && m.ok && !m.warning && m.tips.length === 0, "a strong password: the whole bar, the label Stark, no warning and no tip: " + JSON.stringify(m));
    await page.click("#register button[type=submit]");
    await page.waitForFunction(() => !document.getElementById("message").hidden, null, { timeout: 5000 });
    check(!(await meter("#password-hint")).shown, "the registration empties the form, and the meter hides with it");
    api.state.account.signedIn = true;
    await page.goto(api.url + "account"); await settled(page);
    const before = checks().length;
    api.state.strength = { ok: false, problem: "guessable", score: 3, warning: "dates", tips: ["moreWords"], min: 12, max: 1024 };
    await page.fill("#password-form input[name=new]", "Sommer2026!!");
    await labelIs("#new-password-hint", de["account.strength.score3"]);
    m = await meter("#new-password-hint");
    check(checks().length === before + 1 && same(JSON.parse(checks()[before].body), { password: "Sommer2026!!" }) && m.warning === de["account.strength.warn.dates"] && m.on === 4,
      "the change of the password asks without personal words, so the server takes those of the signed-in user: " + JSON.stringify(m));
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("the embed view follows its parameter lang without a dropdown, and the code of the share dialog names the language of the page", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), visibility: "public", account: { language: "de" } });
  const s = await langSite(browser, api.origin);
  const page = s.page;
  try {
    for (const [code, other] of [["en", "de"], ["de", "en"]]) {
      await page.goto(api.url + "imprint.html");
      await page.evaluate((c) => localStorage.setItem("skill-map-language", c), other);
      await page.goto(api.embedUrl + "?lang=" + code); await settled(page);
      const v = await languageOf(page), open = await page.locator("#embed-open").innerText();
      check(v.language === code && v.lang === code && open === CATALOGS[code]["embed.openOn"].replace("{site}", "127.0.0.1") && v.pickers.every((p) => !p.shown),
        `?lang=${code}: the embed view in ${code}, without a dropdown: ${open}`);
    }
    await page.goto(api.pageUrl); await settled(page);
    await page.click("#share-open");
    await page.waitForSelector("#embed-code", { timeout: 10000 });
    const plain = await page.inputValue("#embed-code");
    check(plain.includes(`src="${api.url}e/anna/servertest?lang=de"`) && (await page.getAttribute("#embed-preview", "href")).endsWith("/e/anna/servertest?lang=de"), "the code and the preview name the language of the page: " + plain);
    await page.selectOption("#embed-theme", "dark");
    await page.uncheck("#embed-panel");
    check((await page.inputValue("#embed-code")).includes("/e/anna/servertest?theme=dark&amp;panel=0&amp;lang=de\""), "after the options: " + await page.inputValue("#embed-code"));
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

// A map has one read link (his decision of 2026-10-19). The dialog shows it every time, and a new link, which revokes it,
// needs a second step in the dialog, never a dialog of the browser. The fake API keeps one link, as the server does.
test("the share dialog of the server shows the one read link to copy again, asks in the dialog before a new link, and the embed code takes the new link", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), account: { language: "de" } });
  const s = await langSite(browser, api.origin);
  const page = s.page, dialogs = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  const link = (n) => api.url + "s/fake-read-link-token-" + n;
  try {
    await page.goto(api.pageUrl); await settled(page);
    await page.click("#share-open");
    await page.waitForSelector("#share-create", { timeout: 10000 });
    check((await page.locator("#share-dialog").innerText()).includes("Noch kein Link.") && await page.locator("#share-link-url").count() === 0 && await page.locator("#share-renew").count() === 0,
      "a private map without a link offers Link erstellen");
    check(await page.locator("#embed-private").isVisible() && (await page.locator("#embed-link").innerText()) === "Link erstellen", "the embed section of a private map offers the same link");
    await page.click("#share-create");
    await page.waitForSelector("#share-link-url", { timeout: 10000 });
    check(api.state.shares === 1 && await page.inputValue("#share-link-url") === link(1) && /^Link vom 19\.10\.2026/.test(await page.locator("#share-link-created").innerText()),
      "Link erstellen shows the link with its date: " + await page.locator("#share-link-created").innerText());
    check((await page.inputValue("#embed-code")).includes(`src="${api.url}e/s/fake-read-link-token-1?lang=de"`) && (await page.locator("#embed-link-note").innerText()).includes("Widerrufst du den Link oben und erzeugst einen neuen"),
      "the map is shared by link now, and its embed code uses the read link");
    await page.click("#share-close");
    await page.click("#share-open");
    await page.waitForSelector("#share-link-url", { timeout: 10000 });
    check(await page.inputValue("#share-link-url") === link(1) && await page.locator("#share-renewed").count() === 0, "opened again, the dialog shows the same link");
    check(await page.locator("#share-renew-ask").isHidden(), "the second step is hidden at first");
    await page.click("#share-renew");
    const ask = page.locator("#share-renew-ask");
    check(await ask.isVisible() && await page.locator("#share-renew").isHidden() && (await ask.innerText()).startsWith("Der aktuelle Link gilt sofort nicht mehr, auch nicht in Rahmen auf anderen Websites.")
      && await page.evaluate(() => document.activeElement && document.activeElement.id) === "share-renew-cancel", "Widerrufen und neuen Link erzeugen shows the warning in the dialog, and Abbrechen has the focus");
    await page.click("#share-renew-cancel");
    check(await ask.isHidden() && await page.locator("#share-renew").isVisible() && api.state.shares === 1 && await page.inputValue("#share-link-url") === link(1), "Abbrechen sends nothing and keeps the link");
    await page.click("#share-renew");
    await page.click("#share-renew-yes");
    await page.waitForFunction((old) => { const x = document.getElementById("share-link-url"); return x && x.value !== old; }, link(1), { timeout: 10000 });
    check(api.state.shares === 2 && await page.inputValue("#share-link-url") === link(2) && (await page.locator("#share-renewed").innerText()) === "Neuer Link. Der alte Link gilt nicht mehr.",
      "Ja, widerrufen und neuen Link erzeugen sends one request and shows the new link with a note");
    check((await page.inputValue("#embed-code")).includes("/e/s/fake-read-link-token-2?lang=de"), "the embed code takes the new link");
    // POST .../shares gives the link that the map has, and only {"replace": true} revokes it (server/API.md).
    check(same(api.state.sharePosts.map((text) => text ? JSON.parse(text) : null), [null, { replace: true }]), "Link erstellen sends no replace, and only Ja, widerrufen und neuen Link erzeugen sends replace: true");
    check(dialogs.length === 0, "no dialog of the browser" + (dialogs.length ? ": " + dialogs.join(" | ") : ""));
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

// The start map (his answer of 2026-10-19 to finding A5): the address of the owner, <BASE_URL>/<handle>, shows it while it
// is public, and else the list of the public maps. The fake API has no subdomains, so the dialog shows the path address only.
test("the share dialog offers the start map below the public address, says what the address shows, and sends start to the server", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), account: { language: "de" } });
  const s = await langSite(browser, api.origin);
  const page = s.page, owner = api.origin + "/anna", de = CATALOGS.de;
  const view = () => page.evaluate(() => {
    const order = [...document.querySelectorAll("#share-dialog > *")].map((el) => el.id || el.querySelector("input[id]")?.id || el.tagName.toLowerCase());
    return { order, box: document.getElementById("share-start")?.checked, label: document.getElementById("share-start-label")?.innerText,
      note: document.getElementById("share-start-note")?.innerText, subdomain: !!document.getElementById("share-subdomain-url") };
  });
  try {
    await page.goto(api.pageUrl); await settled(page);
    await page.click("#share-open");
    await page.waitForSelector("#share-start", { timeout: 10000 });
    let v = await view();
    check(v.label === de["share.startLabel"].replace("{address}", owner) && v.box === false && v.note === de["share.startHelp"],
      "a checkbox names the address of the owner, off at first: " + v.label + " / " + v.note);
    check(v.order.indexOf("share-page-url") < v.order.indexOf("share-start-label") && v.order.indexOf("share-start-label") < v.order.indexOf("share-start-note")
      && !v.subdomain && (await page.inputValue("#share-page-url")) === api.pageUrl, "it sits below the path address, and a host without subdomains shows no second address: " + v.order.join(", "));
    await page.click("#share-start");
    await page.waitForFunction((text) => document.getElementById("share-start-note")?.innerText === text, de["share.startNotPublic"].replace("{address}", owner), { timeout: 10000 });
    v = await view();
    check(same(api.state.patches, [{ start: true }]) && api.state.start === true && v.box === true, "a click sends start true, and the box stays on");
    check(v.note === de["share.startNotPublic"].replace("{address}", owner), "a private start map says that the address shows the list until it is public: " + v.note);
    await page.click("#share-dialog input[name=share-visibility][value=public]");
    await page.waitForFunction((text) => document.getElementById("share-start-note")?.innerText === text, de["share.startShown"].replace("{address}", owner), { timeout: 10000 });
    check(api.state.visibility === "public" && (await view()).note === de["share.startShown"].replace("{address}", owner), "a public start map says that the address shows it now");
    await page.click("#share-start");
    await page.waitForFunction((text) => document.getElementById("share-start-note")?.innerText === text, de["share.startHelp"], { timeout: 10000 });
    check(same(api.state.patches.at(-1), { start: false }) && api.state.start === false && (await view()).box === false, "a second click sends start false");
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

// A handle shares the top-level paths with the site and the app (<BASE_URL>/<handle>), so the build refuses a top-level
// name that is free as a handle, and it keeps the reserved names of the proxy equal to RESERVED of the server.
test("the build refuses a top-level name of the site or the app that is free as a handle, and the proxy reserves the same names as the server", async ({ check }) => {
  const { topLevelProblems, handleRules, caddyNames } = require(path.join(repo, "build_selfhost.js"));
  const walk = (dir, prefix = "") => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name), prefix + e.name + "/") : [prefix + e.name]);
  const files = walk(SITE), rules = handleRules(), caddy = caddyNames();
  const now = topLevelProblems(files);
  check(["api", "account", "index", "assets", "vendor", "example", "map", "server-map", "imprint", "privacy"].every((name) => now.names.includes(name)),
    "the check reads the names of the app and of the build: " + now.names.join(", "));
  check(now.free.length === 0 && now.differ.length === 0, "the site and the app of this build have no free name, and the two lists agree: " + JSON.stringify(now));
  check(same(topLevelProblems([...files, "newpage.html", "tools/x.js"]).free, ["newpage", "tools"]), "a new page or folder of the site that is free as a handle fails the check");
  const without = (name) => ({ ...rules, reserved: new Set([...rules.reserved].filter((x) => x !== name)) });
  check(same(topLevelProblems(files, { rules: without("vendor") }).free, ["vendor"]) && same(topLevelProblems(files, { rules: without("api") }).free, ["api"]),
    "a folder of the site or a path of the app that RESERVED lacks fails the check");
  check(same(topLevelProblems(files, { caddy: new Set([...caddy].filter((x) => x !== "www")) }).differ, ["www"]), "a name that reserved.caddy lacks fails the check");
  check(!rules.isHandle("ab") && !rules.isHandle("a--b") && rules.isHandle("anna"), "the form of a handle comes from HANDLE_RE of the server");
});

// The stack of the server serves dist/selfhost while a new build runs (an update). The build used to empty the folder
// first, and for about 3 s every page and file gave 404. With the cache rule of an address with a version, a browser
// kept such a 404 for a year. The build now moves each finished file into place, the pages last (writeSite).
test("a new build replaces the files of the site in place: no file is missing or partial meanwhile, and the pages come last", async ({ check }) => {
  const { spawn } = require("child_process");
  const { build } = require(path.join(repo, "build_selfhost.js"));
  const dir = path.join(OUT, "rebuild-site");
  const walk = (d, prefix = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), prefix + e.name + "/") : [prefix + e.name]);
  fs.rmSync(dir, { recursive: true, force: true });
  build(dir);
  const before = new Map(walk(dir).map((rel) => [rel, fs.readFileSync(path.join(dir, rel))]));
  fs.writeFileSync(path.join(dir, "stale.txt"), "a file of an older build");
  fs.mkdirSync(path.join(dir, "old-folder"));
  fs.writeFileSync(path.join(dir, "old-folder", "old.js"), "// an older build");
  // The second build runs in its own process, and this one reads the files meanwhile, as the proxy does.
  const watched = ["index.html", "map.html", "server-map.html", "assets/page.js", "vendor/fonts/fonts.css", "vendor/d3-7.9.0.min.js"];
  const child = spawn(process.execPath, [path.join(repo, "build_selfhost.js"), dir], { stdio: "ignore" });
  let exited = null;
  const done = new Promise((resolve) => child.on("exit", (code) => { exited = code; resolve(code); }));
  let reads = 0;
  const problems = new Set();
  while (exited === null) {
    for (const rel of watched) {
      reads++;
      let content = null;
      try { content = fs.readFileSync(path.join(dir, rel)); } catch (error) { problems.add(`${rel}: ${error.code}`); continue; }
      if (!content.equals(before.get(rel))) problems.add(`${rel}: ${content.length} of ${before.get(rel).length} bytes`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  check((await done) === 0, "the second build ends with exit code 0");
  check(reads > 6 * 20 && problems.size === 0, `${reads} reads of ${watched.length} files during the second build: each file was there and complete` + (problems.size ? ": " + [...problems].slice(0, 8).join(", ") : ""));
  check(same(walk(dir).sort(), [...before.keys()].sort()), "after the build the folder holds the files of the build only: the stale file and the old folder are gone");
  check(!fs.readdirSync(OUT).some((name) => name.startsWith(".rebuild-site.build-")), "no staging folder stays next to the folder");
  // The order of the moves: a build in this process, with a record of each rename into the folder.
  const renames = [], rename = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push(path.relative(dir, to).split(path.sep).join("/")); return rename(from, to); };
  try { build(dir); } finally { fs.renameSync = rename; }
  const pages = renames.filter((rel) => rel.endsWith(".html")), firstPage = renames.findIndex((rel) => rel.endsWith(".html"));
  check(renames.length === before.size && pages.length >= 6 && renames.slice(firstPage).every((rel) => rel.endsWith(".html")),
    `${renames.length} files moved into place, the ${pages.length} pages after every other file: ${renames.slice(firstPage - 1, firstPage + 2).join(", ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the imprint and the privacy page show the German text in German, and in English its translation with the note that the German text binds", withSite({ language: null }, async (page, check) => {
  const LEGAL = { "imprint.html": ["legal.imprintTitle", "Impressum", "Legal notice", "site.privacyLink"], "privacy.html": ["legal.privacyTitle", "Datenschutz", "Privacy notice", "site.imprintLink"] };
  const view = () => page.evaluate(() => ({ lang: document.documentElement.lang, title: document.title,
    shown: [...document.querySelectorAll("[data-versions] > [lang]")].filter((a) => a.checkVisibility()).map((a) => a.lang),
    heading: (([...document.querySelectorAll("[data-versions] > [lang]")].find((a) => a.checkVisibility()) || document).querySelector("h1") || {}).textContent,
    text: document.querySelector("main").innerText, links: [...document.querySelectorAll("main > p a")].map((a) => a.textContent) }));
  for (const language of ["en", "de"]) {
    await go(page, "");
    await page.evaluate((c) => localStorage.setItem("skill-map-language", c), language);
    for (const [name, [titleKey, german, english, linkKey]] of Object.entries(LEGAL)) {
      await go(page, name);
      const v = await view();
      const binding = v.text.includes("Only the German text is binding.");
      check(v.lang === language && v.title === CATALOGS[language][titleKey] && same(v.links, [CATALOGS[language]["legal.home"], CATALOGS[language][linkKey]]),
        `${name} in ${language}: lang, the title and the links from the catalogs: ${JSON.stringify([v.lang, v.title, v.links])}`);
      if (language === "de") check(same(v.shown, ["de"]) && v.heading === german && v.text.startsWith("Entwurf – vor Veröffentlichung prüfen") && !binding, `${name} in German: only the German text, which is the binding one`);
      else check(same(v.shown, ["en"]) && v.heading === english && v.text.startsWith("Draft – check before publication") && binding && ["[NAME]", "[ADDRESS]", "[E-MAIL]"].every((x) => v.text.includes(x)),
        `${name} in English: only the English text, with the placeholders and the note that the German text binds`);
    }
  }
}));

test("the default set opens in English and in German with three areas, six categories and twelve skills, and an empty map takes its title from the catalogs", withSite({ language: null }, async (page, check) => {
  for (const language of ["en", "de"]) {
    await go(page, "");
    await page.evaluate((c) => localStorage.setItem("skill-map-language", c), language);
    await go(page, "");
    const set = defaultSetIn(language);
    await page.click("#new-default");
    await page.waitForURL(/map\.html\?id=/);
    await page.waitForFunction(() => document.querySelector("#panel h2") && document.getElementById("cfg-groups").children.length > 0, null, { timeout: 15000 });
    const v = await page.evaluate(() => ({ title: document.getElementById("title").textContent, lang: document.documentElement.lang, areas: CLUSTERS.map((c) => c.name),
      groups: GROUPS.map(([id, area, name]) => [id, area, name]), skills: SKILLS.map(([name, group, rating, places]) => [name, group, rating, places]), chips: [...document.querySelectorAll("#areas .chip")].map((c) => c.textContent) }));
    check(v.lang === language && v.title === set.title && v.areas.length === 3 && v.groups.length === 6 && v.skills.length === 12, `${language}: “${v.title}” with ${v.areas.length} areas, ${v.groups.length} categories and ${v.skills.length} skills`);
    check(same(v.areas, set.areas) && same(v.chips, set.areas) && same(v.groups, set.groups) && same(v.skills, set.skills), `${language}: every name in ${language}: ${v.areas.join(", ")}`);
    await go(page, "");
    await page.click("#new-empty");
    await page.waitForURL(/map\.html\?id=/);
    await page.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 });
    check((await page.locator("#title").innerText()) === set.empty && await page.evaluate(() => CLUSTERS.length) === 0, `${language}: the empty map “${set.empty}”`);
  }
  check(defaultSetIn("en").title === "My skills" && defaultSetIn("de").title === "Meine Skills" && defaultSetIn("en").areas.join() === "Software development,Data,Ways of working", "the English and the German names of the catalogs");
}));

test("the account card of the start page and the two forms of the account page start a new map from the default set in the language of the page", async ({ browser, check }) => {
  const api = await fakeApi(SITE, { docs: SERVER_DOCS(), account: { language: "en" } });
  const s = await langSite(browser, api.origin);
  const page = s.page;
  const collections = (language) => sorted(defaultSetIn(language).collections);
  try {
    await page.goto(api.url); await settled(page);
    await page.waitForSelector("#account-new-default", { timeout: 10000 });
    check((await page.locator("#account-new-default").innerText()) === textOf("accountCard.newDefault"), "the account card offers the default set");
    const opened = page.waitForURL(/\/anna\/servertest$/);
    await page.click("#account-new-default");
    await opened;
    const card = api.state.imports.at(-1);
    check(!!card && card.body.title === "My skills" && same(sorted(card.body.collections), collections("en")) && card.team === null, "the card imports the default set with the English names: " + (card && card.body.title));
    await page.goto(api.url + "account"); await settled(page);
    const options = await page.locator("#new-map select[name=template] option").evaluateAll((all) => all.map((o) => o.value + ":" + o.textContent));
    check(same(options, ["default:" + textOf("account.template.default"), "empty:" + textOf("account.template.empty")]), "the form of a personal map offers the default set and empty: " + JSON.stringify(options));
    await page.fill("#new-map input[name=title]", "Konto-Standard");
    await page.selectOption("#new-map select[name=template]", "default");
    await page.click("#new-map button[type=submit]");
    await page.waitForFunction(() => !document.getElementById("message").hidden, null, { timeout: 5000 });
    const form = api.state.imports.at(-1);
    check(form !== card && form.body.title === "Konto-Standard" && same(sorted(form.body.collections), collections("en")), "the form imports the default set with the title of the form");
    await pickLanguage(page, "de"); await settled(page);
    await page.fill("#new-map input[name=title]", "Konto-Deutsch");
    await page.click("#new-map button[type=submit]");
    await page.waitForFunction(() => /Konto-Deutsch/.test(document.getElementById("message").textContent), null, { timeout: 5000 });
    check(same(sorted(api.state.imports.at(-1).body.collections), collections("de")), "after a switch to German, the default set has the German names");
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

// The pseudo language (PSEUDO of build_selfhost.js): a test build of the site with one more language, whose texts are the
// English texts between two marks. The run opens each kind of page in it and fails on every visible text, and on every
// title, aria-label, placeholder and alt, that holds a word outside the marks. Map data, numbers, punctuation and the
// names that no language translates (the product name, the file formats of the downloads, the library and the fonts of
// the licenses, the languages in their own names) do not count, and nor does the legal text, which is no text of the
// catalogs. A missing key logs an error, and each page fails on it.
const { build: buildSite, PSEUDO } = require(path.join(repo, "build_selfhost.js"));
const PSEUDO_SITE = path.join(OUT, "pseudo-site");
let pseudoBuilt = null;
const pseudoSite = () => pseudoBuilt || (pseudoBuilt = (buildSite(PSEUDO_SITE, { pseudo: true }), PSEUDO_SITE));
const NAMES = ["Skill-Map", "SVG", "PNG", "PDF", "D3", "Archivo", "IBM Plex Mono", "Noto Sans", "zxcvbn", "zxcvbn-ts", "OpenSubtitles (OPUS)"];
// Every text of a value: the strings of an object, its keys too.
const stringsOf = (value) => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf)
  : value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...stringsOf(v)]) : [];
// Runs in the page: each text without the marks, as "<where>: <text>". A text that a page splits around an element, as
// "Signed in as <strong>anna</strong>", has its opening mark in one text and its closing mark in another. The map writes
// the names of categories in capitals, so the data counts in any case.
function unmarked([open, close, data, names]) {
  const marked = new RegExp(open + "[^" + open + close + "]*" + close, "g"), opened = new RegExp(open + "[^" + close + "]*$"), closed = new RegExp("^[^" + open + "]*" + close);
  const words = [...new Set([...data, ...names].filter((x) => typeof x === "string" && x.trim().length > 1).flatMap((x) => [x.toLowerCase(), x.toUpperCase().toLowerCase()]))]
    .sort((a, b) => b.length - a.length);
  const rest = (text) => {
    let s = String(text), before;
    do { before = s; s = s.replace(marked, " "); } while (s !== before);
    s = s.replace(opened, " ").replace(closed, " ").toLowerCase();
    for (const word of words) s = s.split(word).join(" ");
    return s.replace(/[\s\p{N}\p{P}\p{S}]/gu, "");
  };
  const skip = (el) => !!el.closest("script, style, noscript, template, [data-versions] > [lang], [data-language-picker] option");
  const visible = (el) => el.tagName === "OPTION" ? !!el.closest("select") && el.closest("select").checkVisibility() : el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const found = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || skip(el) || !node.data.trim() || !visible(el)) continue;
    if (rest(node.data)) found.push((el.id ? "#" + el.id : el.tagName.toLowerCase()) + ": " + node.data.trim());
  }
  for (const el of document.querySelectorAll("[title], [aria-label], [placeholder], [alt]")) {
    if (skip(el)) continue;
    for (const name of ["title", "aria-label", "placeholder", "alt"]) {
      const value = el.getAttribute(name);
      if (value && rest(value)) found.push((el.id ? "#" + el.id : el.tagName.toLowerCase()) + "[" + name + "]: " + value);
    }
  }
  if (rest(document.title)) found.push("<title>: " + document.title);
  return [...new Set(found)];
}
// Checks the page as it is now; label names the page and its state.
async function allMarked(page, check, label, data) {
  const found = await page.evaluate(unmarked, [PSEUDO.open, PSEUDO.close, data, NAMES]);
  check(found.length === 0, label + ": every text comes from the catalogs" + (found.length ? ": " + found.slice(0, 15).join(" | ") + (found.length > 15 ? " …" : "") : ""));
}
// The map data of a map page: the strings of its constants and of its database, as the page holds them now. A reader
// sees the name of a base stack without its suffix " (ohne Linien)" (shownName in skills/page.js), which is data too.
const mapData = (page) => page.evaluate(() => {
  const all = [typeof MAP_TITLE === "string" ? MAP_TITLE : "", ...CLUSTERS.map((c) => c.name), ...GROUPS.map((g) => g[2]), ...SKILLS.map((x) => x[0]), ...Object.values(WHERE),
    ...Object.values(PROJECTS).flatMap((p) => [p.name, p.when, p.kind, p.note]), ...Object.values(STANDARD).map((x) => x.text), ...(typeof MAP_TEXTS === "object" ? Object.values(MAP_TEXTS) : []),
    ...(Array.isArray(STATIC_PROJECTS) ? STATIC_PROJECTS.flatMap((p) => [p.name, String(p.name).replace(/ \(ohne Linien\)$/, ""), p.when]) : [])];
  return all.filter((x) => typeof x === "string");
});
async function pseudoContext(browser, origin, maps = null) {
  const s = await langSite(browser, origin, { language: PSEUDO.code, maps });
  s.missing = () => s.errors.filter((e) => /^missing (text|value)/.test(e));
  return s;
}

test("pseudo language: the example map, a map of this browser and a map of the server show only texts of the catalogs", async ({ browser, check }) => {
  const api = await fakeApi(pseudoSite(), { docs: SERVER_DOCS(), visibility: "public", account: { language: null }, link: true });
  const seed = seededMap(), fixture = [...stringsOf(seed), ...stringsOf(collectionsOf(FIXTURE, FIXTURE_PROJECTS)), "Servertest", "anna"];
  const s = await pseudoContext(browser, api.origin, { m1: seed });
  const page = s.page;
  try {
    const example = JSON.parse(fs.readFileSync(path.join(repo, "selfhost", "site", "example.it-skills-map.json"), "utf8"));
    const exampleData = [...stringsOf(example.collections), example.title];
    await page.goto(api.url + "example.html"); await settled(page);
    check((await languageOf(page)).language === PSEUDO.code, "the pages open in the pseudo language");
    await allMarked(page, check, "the example map", [...exampleData, ...await mapData(page)]);
    await page.click("#projects-btn"); await page.waitForTimeout(200);
    await allMarked(page, check, "the example map with its projects", [...exampleData, ...await mapData(page)]);
    await page.locator("#areas .chip").first().click(); await page.waitForTimeout(200);
    await clickNode(page, "s:" + (await page.evaluate(() => SKILLS[0][0])));
    await allMarked(page, check, "the example map with a skill", [...exampleData, ...await mapData(page)]);
    check(s.missing().length === 0, "the example map: no missing text" + (s.missing().length ? ": " + s.missing().join(" | ") : ""));

    await page.goto(api.url + "map.html?id=m1"); await settled(page);
    await page.waitForFunction(() => document.getElementById("cfg-groups").children.length > 0, null, { timeout: 15000 });
    await page.evaluate(() => document.querySelectorAll("#cfg details").forEach((d) => { d.open = true; }));
    await page.waitForTimeout(300);
    await allMarked(page, check, "a map of this browser with the force menu open", [...fixture, ...await mapData(page)]);
    await clickPanel(page, "+ Station");
    await allMarked(page, check, "a map of this browser with the form of a new station", [...fixture, ...await mapData(page)]);
    await page.click("#projects-btn"); await page.waitForTimeout(200);
    await allMarked(page, check, "a map of this browser with its projects", [...fixture, ...await mapData(page)]);
    check(s.missing().length === 0, "a map of this browser: no missing text" + (s.missing().length ? ": " + s.missing().join(" | ") : ""));

    await page.goto(api.pageUrl); await settled(page);
    await allMarked(page, check, "a map of the server", [...fixture, ...await mapData(page)]);
    await page.click("#share-open");
    await page.waitForSelector("#embed-code", { timeout: 10000 });
    await allMarked(page, check, "a map of the server with the share dialog", [...fixture, ...await mapData(page), api.url + "anna/servertest", api.url + "e/anna/servertest", api.url + "s/fake-read-link-token-0"]);
    await page.click("#share-renew");
    await allMarked(page, check, "a map of the server with the second step before a new link", [...fixture, ...await mapData(page), api.url + "anna/servertest", api.url + "e/anna/servertest", api.url + "s/fake-read-link-token-0"]);
    check(s.missing().length === 0, "a map of the server: no missing text" + (s.missing().length ? ": " + s.missing().join(" | ") : ""));
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("pseudo language: the start page, the account page and the embed view show only texts of the catalogs", async ({ browser, check }) => {
  const api = await fakeApi(pseudoSite(), { docs: SERVER_DOCS(), visibility: "public", account: { language: null, signedIn: false }, link: true });
  const seed = seededMap(), fixture = [...stringsOf(seed), ...stringsOf(collectionsOf(FIXTURE, FIXTURE_PROJECTS)), "Servertest", "anna", "anna@example.org"];
  const s = await pseudoContext(browser, api.origin, { m1: seed });
  const page = s.page;
  try {
    await page.goto(api.url + "index.html"); await settled(page);
    await allMarked(page, check, "the start page, signed out", fixture);
    await page.locator("#map-list button", { hasText: PSEUDO.open }).last().click(); await page.waitForTimeout(150);
    await allMarked(page, check, "the start page with the question before a delete", fixture);
    await page.goto(api.url + "account"); await settled(page);
    await allMarked(page, check, "the account page, signed out", fixture);
    api.state.account.signedIn = true;
    await page.goto(api.url); await settled(page);
    await page.waitForSelector("#account-list li", { timeout: 10000 });
    await allMarked(page, check, "the start page, signed in", [...fixture, api.url + "anna/servertest"]);
    await page.goto(api.url + "account"); await settled(page);
    await page.waitForSelector("#maps li", { timeout: 10000 });
    await allMarked(page, check, "the account page, signed in", [...fixture, api.url + "anna", api.url + "anna/servertest"]);
    await page.locator("#maps li .actions button", { hasText: "Link" }).click();
    await page.waitForSelector("#maps .shares input", { timeout: 10000 });
    await page.locator("#maps .shares button").nth(1).click();
    await allMarked(page, check, "the account page with the read link and the second step before a new link", [...fixture, api.url + "anna", api.url + "anna/servertest", api.url + "s/fake-read-link-token-0"]);
    await page.goto(api.embedUrl); await settled(page);
    check((await languageOf(page)).language === PSEUDO.code, "the embed view takes the pseudo language of this browser without a parameter");
    await allMarked(page, check, "the embed view", [...fixture, ...await mapData(page), "127.0.0.1"]);
    check(s.missing().length === 0, "the start page, the account page and the embed view: no missing text" + (s.missing().length ? ": " + s.missing().join(" | ") : ""));
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("pseudo language: the imprint and the privacy page show only texts of the catalogs around the legal text", async ({ browser, check }) => {
  const api = await fakeApi(pseudoSite(), { account: { signedIn: false } });
  const s = await pseudoContext(browser, api.origin);
  try {
    for (const name of ["imprint.html", "privacy.html"]) {
      await s.page.goto(api.url + name); await settled(s.page);
      const shown = await s.page.evaluate(() => [...document.querySelectorAll("[data-versions] > [lang]")].filter((a) => a.checkVisibility()).map((a) => a.lang));
      check(same(shown, ["en"]), name + ": a language without its own legal text shows the English one");
      await allMarked(s.page, check, name, []);
    }
    check(s.missing().length === 0, "the legal pages: no missing text" + (s.missing().length ? ": " + s.missing().join(" | ") : ""));
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
});

test("pseudo language: the check finds a text outside the catalogs, and the build of the site never has the pseudo language", async ({ browser, check }) => {
  const api = await fakeApi(pseudoSite(), { account: { signedIn: false } });
  const s = await pseudoContext(browser, api.origin);
  try {
    await s.page.goto(api.url + "imprint.html"); await settled(s.page);
    await s.page.evaluate(() => { const p = document.createElement("p"); p.textContent = "Ein Text ohne Katalog"; document.querySelector("main").append(p); document.querySelector("main a").title = "Zur Startseite"; });
    const found = await s.page.evaluate(unmarked, [PSEUDO.open, PSEUDO.close, [], NAMES]);
    check(found.some((x) => x.endsWith(": Ein Text ohne Katalog")) && found.some((x) => x.endsWith("[title]: Zur Startseite")) && found.length === 2, "the run names a text and a title without the marks: " + found.join(" | "));
    cleanSite(s, check);
  } finally { await s.context.close(); await api.close(); }
  const site = fs.readFileSync(path.join(SITE, "assets", "i18n.js"), "utf8");
  const languages = Object.keys(new Function("window", site.slice(0, site.indexOf("\n", site.indexOf("window.SKILL_MAP_TEXTS"))) + "\nreturn window.SKILL_MAP_TEXTS;")({}));
  check(!site.includes(PSEUDO.open) && !site.includes(PSEUDO.close) && same(languages, ["en", "de"]), "dist/selfhost/assets/i18n.js has the languages of i18n/ and no pseudo language: " + languages.join(", "));
  check(fs.readFileSync(path.join(pseudoSite(), "assets", "i18n.js"), "utf8").includes('"' + PSEUDO.code + '":'), "and the test build has it");
});

// Screenshots for the report: the start page and an owner map, light and dark, at 1400 × 900 and 390 × 844.
test("screenshots of the start page and an owner map", async ({ browser, check }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const maps = { demo: entryOf("IT-Skills (Testdaten)", collectionsOf(DATA, JSON.parse(fs.readFileSync(path.join(repo, "skills", "projects.json"), "utf8")))) };
  for (const [w, h] of [[1400, 900], [390, 844]]) for (const scheme of ["light", "dark"]) {
    const s = await site(browser, { colorScheme: scheme, viewport: { width: w, height: h }, maps });
    await go(s.page, "");
    await s.page.frame({ url: /example\.html$/ }).waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 15000 }).catch(() => {});
    await s.page.waitForTimeout(600);
    await s.page.screenshot({ path: path.join(OUT, `start-${scheme}-${w}x${h}.png`) });
    await go(s.page, "map.html?id=demo");
    await mapReady(s.page);
    await s.page.screenshot({ path: path.join(OUT, `owner-map-${scheme}-${w}x${h}.png`) });
    check(s.errors.length === 0 && s.external.length === 0, `${scheme} ${w} × ${h}: no errors, no request leaves localhost` + (s.errors.length ? ": " + s.errors.join(" | ") : ""));
    await s.context.close();
  }
  check(fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).length >= 8, "eight screenshots in tests/selfhost/out/");
});

(async () => {
  server = await serve(SITE);
  let ok = false;
  try { ok = await run(tests, { pool: 4, only: process.argv.slice(2) }); } finally { await server.close(); }
  process.exitCode = ok ? 0 : 1;
})();

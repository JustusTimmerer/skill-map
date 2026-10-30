// End-to-end tests of the map page as signed-out reader, signed-in viewer and owner, on the test data in
// fixture.js with exact expectations, plus a smoke pass on the real data. Each page is a map page of the build of the
// site with the test runtime, opened over HTTP from tests/e2e/out/site (harness.js).
// Usage: node tests/e2e/map.js [part of a test name ...]    E2E_VERBOSE=1 prints every check.
const fs = require("fs"), path = require("path");
const { buildPage, open, h, run, projectDocs, repo, withInit, withData } = require("./harness");
const fixturePage = buildPage(path.join(__dirname, "fixture.js"), path.join(__dirname, "fixture.projects.json"));
// The same test data with two configurations; the build picks "Weit" for readers (fixture.configs.json).
const CONFIGS = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.configs.json"), "utf8"));
const configsPage = buildPage(path.join(__dirname, "fixture.js"), path.join(__dirname, "fixture.projects.json"), path.join(__dirname, "fixture.configs.json"));
// The real page, with the configurations of the last export when there are some.
const realConfigs = path.join(repo, "skills", "configs.json");
const realPage = buildPage(path.join(repo, "skills", "data.js"), path.join(repo, "skills", "projects.json"), fs.existsSync(realConfigs) ? realConfigs : null);
const seed = projectDocs(JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.projects.json"), "utf8")));
const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const LIGHT = "rgb(243, 246, 245)", DARK = "rgb(15, 21, 23)";

const tests = [];
const test = (name, fn, known) => tests.push({ name, fn, known });
// Opens the fixture page, runs body, and fails the test on any console error.
const withPage = (options, body) => async ({ browser, check }) => {
  const { context, page, errors } = await open(browser, options.page || fixturePage, options);
  try { await body(page, check, context); } finally {
    check(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await context.close();
  }
};

// Start and overview
test("overview lists counts, ratings, areas and stations", withPage({}, async (page, check) => {
  check((await page.locator("h1").innerText()) === "Skill-Atlas · Alex Beispiel (Demo)", "reader header");
  check((await page.locator("#save-state").innerText()) === "", "no save status for a reader");
  check((await h.h2(page)) === "9 Kenntnisse in 3 Bereichen", "headline counts 9 skills in 3 areas");
  check((await h.panel(page)).includes("3 Projekte."), "3 projects with skills, the empty one is hidden");
  const legend = await page.locator("#panel .legend button").allInnerTexts();
  check(same(legend.map((t) => t.replace(/\s+/g, " ").trim()), ["sehr gute Kenntnisse 2", "gute Kenntnisse 2", "Grundkenntnisse 3", "mit KI eingesetzt, ohne eigene Routine 1", "eingesetzt, noch nicht bewertet 1"]), "rating filter in order with counts: " + legend.join(" / ").replace(/\s+/g, " "));
  const areas = await page.locator("#panel .areas-list button").allInnerTexts();
  check(same(areas.map((t) => t.replace(/\s+/g, " ").trim()), ["Entwicklung 5", "Künstliche Intelligenz 2", "Daten 2"]), "area list with skill counts");
  const chips = await page.locator("#panel .chips").allInnerTexts();
  check(same(chips.map((t) => t.split("\n").filter(Boolean)), [["Neufirma AG", "Altfirma GmbH"], ["Hobbyprojekt"]]), "stations newest first, private projects apart");
  check(same(await page.locator("#areas .chip").allInnerTexts(), ["Entwicklung", "Künstliche Intelligenz", "Daten"]), "one area chip per area in the header");
}));

const overviewLine = (page) => page.locator("#panel h2 + p.muted").innerText();
test("the overview explains the lines of the default mode, without duration", withPage({}, async (page, check) => {
  const text = await overviewLine(page);
  check(text === "Die Linien verbinden Kenntnisse, die ich an denselben Stationen eingesetzt habe, je öfter, desto kräftiger. Ein Klick auf eine Kenntnis zeigt ihre Linien und wo ich sie eingesetzt habe.", "skill mode text: " + text);
}));
for (const [mode, start] of [["category", "Die Linien verbinden Kategorien, deren Kenntnisse"], ["mixed", "Die Linien verbinden Kenntnisse mit Kategorien, deren Kenntnisse"]]) {
  test(`the overview explains the lines of mode ${mode}`, withPage({ page: withInit(fixturePage, `window.LINE_MODE_OVERRIDE = '${mode}';`) }, async (page, check) => {
    const text = await overviewLine(page);
    check(text.startsWith(start) && text.includes("je öfter, desto kräftiger.") && text.endsWith("zeigt ihre Linien und wo ich sie eingesetzt habe."), `${mode} text: ` + text);
  }));
}
test("without lines the overview does not mention them", withPage({ page: withInit(fixturePage, "window.SHOW_LINES_OVERRIDE = false;") }, async (page, check) => {
  check((await overviewLine(page)) === "Ein Klick auf eine Kenntnis zeigt, wo ich sie eingesetzt habe.", "text without lines");
  check(await page.locator("#map path.shared-line").count() === 0, "no line drawn");
}));

test("map draws every node once with its symbol", withPage({}, async (page, check) => {
  const nodes = await page.evaluate(() => [...document.querySelectorAll("#map g.node")].map((g) => ({ id: g.__data__.id, text: g.querySelector("text").textContent,
    star: !!g.querySelector("path.s-fill"), ring: !!g.querySelector("circle.s-ring"), dash: (g.querySelector("circle.s-ring") || { getAttribute: () => null }).getAttribute("stroke-dasharray") })));
  check(nodes.length === 16 && new Set(nodes.map((n) => n.id)).size === 16, "16 nodes: 3 areas, 4 categories, 9 skills");
  const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
  check(by["c:ai"].text === "Künstliche Intelligenz" && by["g:sd-lang"].text === "SPRACHEN" && by["s:Claude Code"].text === "Claude Code", "labels: area name, category in capitals, skill name");
  check(by["s:C#"].star && !by["s:C#"].ring, "rating 3 draws a star");
  check(by["s:Python"].star && by["s:Python"].ring, "rating 2 draws a star in a ring");
  check(!by["s:Go"].star && !by["s:Go"].ring, "rating 1 draws a filled dot");
  check(by["s:Claude Code"].ring && !!by["s:Claude Code"].dash, "KI rating draws a dashed ring");
  check(by["s:CSS"].ring && !by["s:CSS"].dash, "rating 0 draws a plain ring");
  check(await page.locator("#map path.shared-line").count() > 0, "lines of shared use between categories are drawn");
}));

test("the loading message covers the map until the first layout", withPage({}, async (page, check) => {
  const html = await page.evaluate(() => fetch(location.href).then((r) => r.text()));
  const tag = (html.match(/<p class="map-loading"[^>]*>[^<]*<\/p>/) || [""])[0];
  check(!!tag && !/\shidden\b/.test(tag) && tag.includes("Loading the map, please wait …"), "the page source shows the message before any script runs");
  const shown = await page.evaluate(() => { const p = document.getElementById("map-loading"); return { hidden: p.hidden, display: getComputedStyle(p).display, text: p.textContent }; });
  check(shown.hidden && shown.display === "none", "after the first layout the message is hidden");
  check(shown.text === "Die Karte lädt, bitte warten …", "the message is translated: " + shown.text);
  check(await page.locator("#map g.node").count() === 16, "the map is drawn");
}));

test("without d3 the page explains that the map did not load", withPage({ mode: "noD3" }, async (page, check) => {
  check((await h.h2(page)) === "Die Karte konnte nicht laden", "error headline");
  check((await h.panel(page)).includes("Bitte die Seite neu laden."), "error tells what to do");
  check(await page.evaluate(() => document.getElementById("map-loading").hidden), "the loading message is hidden");
}));

// Zoom and labels
test("zoom buttons scale by 1.6 and Alles fits again", withPage({}, async (page, check) => {
  const fit = await h.k(page);
  await h.click(page, "#zoom-in");
  check(near(await h.k(page), fit * 1.6), "+ zooms in by 1.6");
  await h.click(page, "#zoom-out");
  check(near(await h.k(page), fit), "− zooms back out by 1.6");
  await h.click(page, "#zoom-in"); await h.click(page, "#zoom-in");
  await h.click(page, "#zoom-fit");
  check(near(await h.k(page), fit), "Alles returns to the fitted scale");
}));

test("zoom stops at 0.3 and 14", withPage({}, async (page, check) => {
  for (let i = 0; i < 14; i++) await page.click("#zoom-in");
  await page.waitForTimeout(100);
  check(near(await h.k(page), 14), "largest scale is 14");
  for (let i = 0; i < 20; i++) await page.click("#zoom-out");
  await page.waitForTimeout(100);
  check(near(await h.k(page), 0.3), "smallest scale is 0.3");
}));

test("skill names appear once they are large enough to read", withPage({}, async (page, check) => {
  await h.wheelTo(page, 2);
  check(!(await h.labelShown(page, "s:Go")) && !(await h.labelShown(page, "s:C#")), "at scale 2 small skill names are hidden");
  check(await h.labelShown(page, "g:sd-lang") && await h.labelShown(page, "c:sd"), "category and area names always show");
  await h.wheelTo(page, 2.8);
  check(await h.labelShown(page, "s:C#") && !(await h.labelShown(page, "s:Go")), "at scale 2.8 rating 3 shows (6.5 / 2.7 px) and rating 1 not yet (7.5 / 2.4 px)");
  await h.wheelTo(page, 3.3);
  check(await h.labelShown(page, "s:Go"), "at scale 3.3 rating 1 shows too");
  check(near(await h.fontSize(page, "c:sd"), 9) && near(await h.fontSize(page, "g:sd-lang"), 4), "zoomed in, area and category names keep their base size 9 and 4");
  await h.wheelTo(page, 0.5);
  check(near(await h.fontSize(page, "c:sd"), 30) && near(await h.fontSize(page, "g:sd-lang"), 5), "zoomed out, area names grow to 15 px on screen, category names stop at 5");
}));

test("dragging the map pans it without zooming", withPage({}, async (page, check) => {
  const before = await h.transform(page), p = await h.emptyPoint(page);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x + 60, p.y + 30, { steps: 5 }); await page.mouse.move(p.x + 120, p.y + 60, { steps: 5 });
  await page.mouse.up(); await page.waitForTimeout(80);
  const after = await h.transform(page);
  check(near(after.x - before.x, 120, 0.02) && near(after.y - before.y, 60, 0.02) && near(after.k, before.k), `moves by the drag (${Math.round(after.x - before.x)}, ${Math.round(after.y - before.y)}), same scale`);
}));

test("the map refits on resize until the reader zooms", withPage({}, async (page, check) => {
  const k1 = await h.k(page);
  await page.setViewportSize({ width: 1000, height: 700 }); await page.waitForTimeout(200);
  const k2 = await h.k(page);
  check(k2 < k1, `a smaller window fits the map smaller (${k1.toFixed(2)} → ${k2.toFixed(2)})`);
  await h.click(page, "#zoom-in");
  const k3 = await h.k(page);
  await page.setViewportSize({ width: 1300, height: 860 }); await page.waitForTimeout(200);
  check(near(await h.k(page), k3), "after a zoom by the reader, a resize keeps the scale");
}));

// Search
test("search highlights matches and lists them", withPage({}, async (page, check) => {
  await h.search(page, "sql");
  check((await h.h2(page)) === "2 Treffer für „sql“", "headline counts the hits");
  check(same(await h.chips(page), ["SQL Server", "SQLite"]), "hits sorted by rating");
  check(same(await h.classed(page, "match"), ["s:SQL Server", "s:SQLite"]), "both nodes marked as match");
  check(same(await h.onIds(page), ["c:data", "g:data-db", "s:SQL Server", "s:SQLite"]), "focus on the hits, their category and area");
  check(near(await h.opacity(page, "s:Python"), 0.14), "other skills fade to 14 %");
  check((await h.panel(page)).includes("Enter zoomt zum ersten Treffer."), "hint for Enter");
}));

test("search ignores case and spaces and reports no hit", withPage({}, async (page, check) => {
  await h.search(page, "  REACT ");
  check((await h.h2(page)) === "1 Treffer für „react“" && same(await h.chips(page), ["React"]), "finds React in any case");
  await h.search(page, "xyz");
  check((await h.h2(page)) === "0 Treffer für „xyz“" && (await h.panel(page)).includes("Keine Kenntnis auf der Karte enthält diesen Text."), "no hit says so");
  check((await h.classed(page, "match")).length === 0, "no node marked");
}));

test("Enter in the search opens the first hit and zooms to it", withPage({}, async (page, check) => {
  const fit = await h.k(page);
  await h.search(page, "py");
  await page.press("#q", "Enter"); await page.waitForTimeout(100);
  check((await h.h2(page)) === "Python", "skill panel of the first hit");
  check(same(await h.classed(page, "selected"), ["s:Python"]), "the hit is selected");
  check((await h.k(page)) > fit * 2, "the map zooms in to the hit");
}));

test("clearing the search returns to the overview", withPage({}, async (page, check) => {
  await h.search(page, "go");
  await h.search(page, "");
  check((await h.h2(page)) === "9 Kenntnisse in 3 Bereichen", "overview again");
  check(!(await h.focused(page)) && (await h.classed(page, "match")).length === 0, "no focus, no match");
}));

// Skill panel
test("skill panel shows category, rating, stations and projects", withPage({}, async (page, check) => {
  await h.clickNode(page, "s:Python");
  const text = await h.panel(page);
  check((await h.h2(page)) === "Python", "headline is the skill");
  check((await page.locator("#panel .crumb").innerText()) === "Entwicklung › Sprachen", "crumb names area and category");
  await page.locator("#panel .crumb .linkbtn", { hasText: "Sprachen" }).click();
  check((await h.h2(page)) === "Sprachen" && (await page.locator("#panel .crumb").innerText()) === "Entwicklung › Sprachen", "the category in the crumb opens the category, with the full path");
  await page.locator("#panel .crumb .linkbtn", { hasText: "Entwicklung" }).click();
  check((await h.h2(page)) === "Entwicklung", "the area in the crumb of the category opens the area");
  await h.clickNode(page, "s:Python");
  await page.locator("#panel .crumb .linkbtn", { hasText: "Entwicklung" }).click();
  check((await h.h2(page)) === "Entwicklung", "the area in the crumb of a skill opens the area");
  await h.clickNode(page, "s:Python");
  check((await page.locator("#panel .rating").innerText()).trim() === "gute Kenntnisse", "rating in words");
  const places = await page.locator("#panel ul.list").first().locator("li").allInnerTexts();
  check(same(places.map((t) => t.replace(/\s+/g, " ").trim()), ["Hobbyprojekt seit 2025", "Neufirma AG 2019 – 2024"]), "stations newest first with time range");
  check((await h.h3s(page)).includes("In Projekten") && text.includes("Chatbot") && text.includes("Private Projekte · 1"), "project from the snapshot with station and number");
  check(same(await h.onIds(page), ["c:sd", "g:sd-lang", "s:Python"]) && same(await h.classed(page, "selected"), ["s:Python"]), "focus on the skill and its parents");
  check(near(await h.opacity(page, "s:SQLite"), 0.14) && near(await h.opacity(page, "s:Python"), 1), "others fade, the skill stays");
}));

test("standard skill shows its note and its projects in order", withPage({}, async (page, check) => {
  await h.clickNode(page, "s:C#");
  check((await page.locator("#panel .badge").innerText()) === "Standard seit Altfirma in allen Stationen", "badge with the standard note");
  const projects = await page.locator("#panel ul.list li").allInnerTexts();
  check(same(projects.map((t) => t.replace(/\s+/g, " ").trim()), ["Grundstack Neu Neufirma AG · 0", "Kundenportal Neufirma AG · 4"]), "projects by number, readers see no (ohne Linien)");
  check((await page.locator("#panel .rating").innerText()).trim() === "sehr gute Kenntnisse", "rating 3 in words");
}));

test("skill panel marks indirect stations, KI use and missing stations", withPage({}, async (page, check) => {
  await h.clickNode(page, "s:Prompting");
  const places = await page.locator("#panel ul.list").first().locator("li button").allInnerTexts();
  check(same(places, ["Hobbyprojekt", "Neufirma AG (indirekt)"]), "an indirect station is marked");
  await h.clickNode(page, "s:Claude Code");
  check((await page.locator("#panel .rating").innerText()).trim() === "mit KI eingesetzt, ohne eigene Routine", "KI rating in words");
  await h.clickNode(page, "s:CSS");
  const text = await h.panel(page);
  check(text.includes("Bewertung aus dem Lebenslauf, ohne Zuordnung zu einer Station.") && text.includes("eingesetzt, noch nicht bewertet"), "a skill without stations says so");
  check(text.includes("Noch in keinem Projekt."), "and is in no project");
}));

test("links in the skill panel open the station and the project", withPage({}, async (page, check) => {
  await h.clickNode(page, "s:Python");
  await page.locator("#panel button", { hasText: "Neufirma AG" }).click(); await page.waitForTimeout(80);
  check((await h.h2(page)) === "Neufirma AG" && (await page.locator("#panel .crumb").innerText()) === "Arbeitgeber · 2019 – 2024", "station panel with kind and time range");
  check((await h.panel(page)).includes("Zweite Station der Testdaten.") && (await h.h3s(page)).includes("5 Kenntnisse"), "station note and 5 skills");
  check(same(await h.chips(page), ["C#", "SQL Server", "Python", "React", "Prompting"]), "skills of the station by rating, the indirect one included");
  await page.locator("#panel .chip", { hasText: "Python" }).click(); await page.waitForTimeout(80);
  await page.locator("#panel button", { hasText: "Chatbot" }).click(); await page.waitForTimeout(80);
  check((await h.h2(page)) === "Chatbot" && (await page.locator("#panel .crumb").innerText()) === "Private Projekte · Nr. 1 · 2025", "project view with station, number and time range");
  check((await h.pressed(page, "#projects-btn")) === "true", "the Projekte button shows the project view");
  check(same(await h.h3s(page), ["3 Kenntnisse", "Entwicklung", "Künstliche Intelligenz", "Nicht auf der Karte"]) && same(await h.chips(page), ["Python", "Claude Code", "Fortran"]), "skills by area, a skill not on the map listed apart");
}));

test("a click on the empty map clears the selection", withPage({}, async (page, check) => {
  await h.clickNode(page, "s:Go");
  const p = await h.emptyPoint(page);
  await page.mouse.click(p.x, p.y); await page.waitForTimeout(80);
  check((await h.h2(page)) === "9 Kenntnisse in 3 Bereichen" && !(await h.focused(page)), "overview, no focus");
}));

test("Übersicht clears the search and fits the map", withPage({}, async (page, check) => {
  const fit = await h.k(page);
  await h.search(page, "py"); await page.press("#q", "Enter"); await page.waitForTimeout(100);
  await h.click(page, "#panel .back");
  check((await h.h2(page)) === "9 Kenntnisse in 3 Bereichen" && (await page.inputValue("#q")) === "", "overview, empty search");
  check(near(await h.k(page), fit), "fitted scale again");
}));

test("hovering a skill focuses it until the pointer leaves", withPage({}, async (page, check) => {
  const p = await h.nodePoint(page, "s:SQLite");
  await page.mouse.move(p.x, p.y); await page.waitForTimeout(60);
  check(await h.focused(page) && same(await h.onIds(page), ["c:data", "g:data-db", "s:SQLite"]), "hover focuses the skill and its parents");
  const e = await h.emptyPoint(page);
  await page.mouse.move(e.x, e.y); await page.waitForTimeout(60);
  check(!(await h.focused(page)), "leaving clears the focus");
  check((await h.h2(page)) === "9 Kenntnisse in 3 Bereichen", "hover does not change the panel");
}));

// Lines of shared use, filtered by a click on a skill, a category or an area. Each scenario pins the line settings
// it needs, so a new default in layout.js does not change it.
const skillModePage = withInit(fixturePage, "window.LINE_MODE_OVERRIDE = 'skill'; window.LINE_COUNT_OVERRIDE = 3; window.LINE_CROSS_AREA_OVERRIDE = true;");
const categoryModePage = withInit(fixturePage, "window.LINE_MODE_OVERRIDE = 'category'; window.LINE_COUNT_OVERRIDE = 8; window.LINE_CROSS_AREA_OVERRIDE = true; window.LINE_WIDTH_MAX_OVERRIDE = 2.6;");
const linesOnMap = (page) => page.evaluate(() => [...document.querySelectorAll("#map path.shared-line")].map((p) => {
  const l = p.__data__;
  return { key: l.source.id + "|" + l.target.id, ends: [l.source, l.target].map((e) => ({ id: e.id, group: e.group, cluster: e.cluster })), strength: l.strength,
    width: Number(p.getAttribute("stroke-width")), opacity: Number(p.getAttribute("stroke-opacity")), shown: Number(getComputedStyle(p).strokeOpacity) };
}));
const positions = (page) => page.evaluate(() => d3.selectAll("#map g.node").data().map((n) => [n.id, n.x, n.y]));
const keys = (lines) => lines.map((l) => l.key);

// His values of 2026-10-17: up to 1000 lines of the skill mode, inside an area too, thin and faint.
// In the fixture, 13 pairs of skills in different categories share a station, so all of them show. Python and React
// share NEU inside Entwicklung, and only Python and Prompting share 2 stations. Width and opacity run from 0.1 to 0.5
// and from 0.1 to 0.35.
test("by default the map draws up to 1000 skill lines, thin and faint", withPage({}, async (page, check) => {
  const all = await linesOnMap(page);
  const total = await page.evaluate(() => { const L = computeLayout(); return lineTotal(L.nodes, L.links); });
  check(await page.evaluate(() => LINE_MODE === "skill" && LINE_COUNT === 1000 && LINE_CROSS_AREA === false), "defaults: skill mode, 1000 lines, pairs inside an area too");
  check(all.length === 13 && total === 13, "all 13 skill lines: " + all.length + " drawn, " + total + " in all");
  check(all.every((l) => l.ends.every((e) => e.id.startsWith("s:"))), "every line runs from skill to skill");
  check(same(all.filter((l) => l.ends[0].cluster === l.ends[1].cluster).map((l) => l.ends.map((e) => e.id).sort()), [["s:Python", "s:React"]]), "the one line inside an area: Python and React");
  const strongest = all.filter((l) => l.strength === 2);
  check(strongest.length === 1 && same(strongest[0].ends.map((e) => e.id).sort(), ["s:Prompting", "s:Python"]), "the strongest line: Python and Prompting");
  check(near(strongest[0].width, 0.5) && near(strongest[0].opacity, 0.35), "the strongest line: width 0.5, opacity 0.35");
  check(all.filter((l) => l !== strongest[0]).every((l) => near(l.width, 0.3) && near(l.opacity, 0.225)), "the lines with 1 station: half of the strength, width 0.3, opacity 0.225");
  const stroke = await page.evaluate(() => getComputedStyle(document.querySelector("#map path.shared-line")).stroke);
  check(stroke === "rgb(89, 103, 99)", "light theme: line color #596763, " + stroke);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  const dark = await page.evaluate(() => getComputedStyle(document.querySelector("#map path.shared-line")).stroke);
  check(dark === "rgb(133, 133, 133)", "dark theme: line color #858585, " + dark);
}));

// His wish of 2026-10-17: each line mode has its own defaults (LINE_DEFAULTS in layout.js). Kategorie-Kategorie draws the
// 8 strongest pairs between areas, thicker: width 0.4 to 2.6, opacity 0.16 to 0.46, #93a3a0 in the dark theme. The fixture
// has 5 such pairs. Skill-Kategorie takes the values of Skill-Skill. An override of one constant wins over the table.
const modeOnly = (mode, extra = "") => withInit(fixturePage, `window.LINE_MODE_OVERRIDE = '${mode}';${extra}`);
test("in category mode the map takes the category line defaults", withPage({ page: modeOnly("category") }, async (page, check) => {
  check(await page.evaluate(() => LINE_COUNT === 8 && LINE_CROSS_AREA === true && LINE_WIDTH_EXP === 0.5 && LINE_BEND === 0.15), "category defaults: 8 lines between areas, exponent 0.5, bend 0.15");
  const all = await linesOnMap(page);
  check(all.length === 5 && all.every((l) => l.ends.every((e) => e.id.startsWith("g:")) && l.ends[0].cluster !== l.ends[1].cluster), "all 5 category pairs between areas: " + all.length);
  check(near(Math.max(...all.map((l) => l.width)), 2.6) && near(Math.max(...all.map((l) => l.opacity)), 0.46), "the strongest line: width 2.6, opacity 0.46");
  check(all.every((l) => l.width > 0.4 && l.opacity > 0.16), "every line thicker than 0.4 and more opaque than 0.16");
  const stroke = await page.evaluate(() => getComputedStyle(document.querySelector("#map path.shared-line")).stroke);
  check(stroke === "rgb(89, 103, 99)", "light theme: line color #596763, " + stroke);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  const dark = await page.evaluate(() => getComputedStyle(document.querySelector("#map path.shared-line")).stroke);
  check(dark === "rgb(147, 163, 160)", "dark theme: line color #93a3a0, " + dark);
}));

test("in Skill-Kategorie mode the map takes the Skill-Skill line defaults", withPage({ page: modeOnly("mixed") }, async (page, check) => {
  check(await page.evaluate(() => LINE_COUNT === 1000 && LINE_CROSS_AREA === false && LINE_WIDTH_EXP === 1 && LINE_BEND === 0.1), "Skill-Skill values: 1000 lines, inside an area too, exponent 1, bend 0.1");
  const all = await linesOnMap(page), total = await page.evaluate(() => { const L = computeLayout(); return lineTotal(L.nodes, L.links); });
  check(all.length === 18 && total === 18 && all.filter((l) => l.ends[0].cluster === l.ends[1].cluster).length === 2, "all 18 lines: the 16 between areas and 2 inside an area, " + all.length + " drawn");
  check(near(Math.max(...all.map((l) => l.width)), 0.5) && near(Math.max(...all.map((l) => l.opacity)), 0.35), "the strongest line: width 0.5, opacity 0.35");
}));

test("an override wins over the line defaults of the mode", withPage({ page: modeOnly("category", " window.LINE_COUNT_OVERRIDE = 2; window.LINE_WIDTH_MAX_OVERRIDE = 1;") }, async (page, check) => {
  const all = await linesOnMap(page);
  check(all.length === 2, "the count override: 2 lines");
  check(near(Math.max(...all.map((l) => l.width)), 1) && near(Math.max(...all.map((l) => l.opacity)), 0.46), "the width override: 1; the opacity keeps the category default 0.46");
}));

// Standard skills count for no line while the switch "Standard-Skills" is on (STANDARD_SKILLS, the default). C# is the
// standard skill of the fixture. With the switch off, it is a normal skill and counts with its own stations like every
// other skill: ALT and NEU with SQL Server, NEU with React, and NEU with Prompting through its indirect station. So it gets
// 3 skill lines, and in Skill-Kategorie 3 lines to Datenbanken, Web and Werkzeuge. The other lines stay; only the lines
// to Sprachen grow stronger.
const standardOffPage = (extra = "") => withInit(fixturePage, `window.STANDARD_SKILLS_OVERRIDE = false;${extra}`);
const ofCSharp = (lines) => lines.filter((l) => l.ends.some((e) => e.id === "s:C#")).map((l) => [l.ends.find((e) => e.id !== "s:C#").id, l.strength]).sort();
test("by default no line touches the standard skill C#", withPage({}, async (page, check) => {
  check(await page.evaluate(() => STANDARD_SKILLS === true && !!computeLayout().nodes.find((n) => n.id === "s:C#").standard), "default: STANDARD_SKILLS on, C# is a standard skill");
  const all = await linesOnMap(page);
  check(all.length === 13 && ofCSharp(all).length === 0, "13 skill lines, none at C#: " + all.length);
}));

test("with STANDARD_SKILLS off, C# gets lines like every other skill", withPage({ page: standardOffPage() }, async (page, check) => {
  const all = await linesOnMap(page), total = await page.evaluate(() => { const L = computeLayout(); return lineTotal(L.nodes, L.links); });
  check(all.length === 16 && total === 16, "16 skill lines, the 13 of the default and 3 at C#: " + all.length + " drawn, " + total + " in all");
  check(same(ofCSharp(all), [["s:Prompting", 1], ["s:React", 1], ["s:SQL Server", 2]]), "C#: SQL Server with 2 stations, React and Prompting with 1: " + JSON.stringify(ofCSharp(all)));
  const strongest = all.find((l) => l.ends.some((e) => e.id === "s:C#") && l.strength === 2);
  check(near(strongest.width, 0.5) && near(strongest.opacity, 0.35), "C# and SQL Server share the top strength 2: width 0.5, opacity 0.35");
}));

test("with STANDARD_SKILLS off, C# starts Skill-Kategorie lines", withPage({ page: standardOffPage(" window.LINE_MODE_OVERRIDE = 'mixed';") }, async (page, check) => {
  const all = await mixedLines(page);
  check(all.length === 21, "21 lines, the 18 of the default and 3 from C#: " + all.length);
  const own = all.filter((l) => l.from === "s:C#").map((l) => [l.to, l.strength]).sort();
  check(same(own, [["g:ai-tools", 1], ["g:data-db", 2], ["g:sd-web", 1]]), "C# to Datenbanken (2), Web and Werkzeuge (1 each): " + JSON.stringify(own));
  check(all.filter((l) => l.from === "s:C#").every((l) => l.stroke === AREA_RGB.sd), "the lines of C# take the color of its area");
  const toLang = all.filter((l) => l.to === "g:sd-lang").map((l) => [l.from, l.strength]).sort();
  check(same(toLang, [["s:Claude Code", 2], ["s:Prompting", 4], ["s:React", 2], ["s:SQL Server", 3], ["s:SQLite", 2]]), "the lines to Sprachen count C# too: " + JSON.stringify(toLang));
}));

test("a click filters the category lines to the skill, category or area", withPage({ page: categoryModePage }, async (page, check) => {
  const all = await linesOnMap(page), before = await positions(page);
  check(all.length === 5, "5 category lines before a click");
  await h.clickNode(page, "s:Go");
  let lines = await linesOnMap(page);
  check(lines.length === 2 && lines.every((l) => l.ends.some((e) => e.group === "sd-lang")), "Go: the 2 lines of its category Sprachen");
  check(lines.every((l) => near(l.shown, l.opacity)), "the filtered lines are not dimmed");
  check(near(Math.max(...lines.map((l) => l.width)), 2.6), "the strongest filtered line has the full width");
  await h.clickNode(page, "g:ai-tools");
  lines = await linesOnMap(page);
  check(lines.length === 3 && lines.every((l) => l.ends.some((e) => e.group === "ai-tools")), "Werkzeuge: its 3 lines");
  await h.click(page, "#zoom-fit");
  await page.waitForTimeout(600);
  await h.clickNode(page, "c:data");
  lines = await linesOnMap(page);
  check(lines.length === 3 && lines.every((l) => l.ends.some((e) => e.cluster === "data")), "Daten: the 3 lines with an end in the area");
  check(same(await positions(page), before), "no node moves");
  const p = await h.emptyPoint(page);
  await page.mouse.click(p.x, p.y); await page.waitForTimeout(80);
  check(same(keys(await linesOnMap(page)), keys(all)), "a click on the empty map brings back all lines");
  await h.clickNode(page, "s:SQLite");
  await h.click(page, "#panel .back");
  check(same(keys(await linesOnMap(page)), keys(all)), "Übersicht brings back all lines");
}));

test("in skill mode a click filters the skill lines, strongest first", withPage({ page: skillModePage }, async (page, check) => {
  const all = await linesOnMap(page);
  check(all.length === 3, "3 skill lines before a click, as set");
  await h.clickNode(page, "s:Python");
  let lines = await linesOnMap(page);
  check(lines.length === 3 && lines.every((l) => l.ends.some((e) => e.id === "s:Python")), "Python: 3 of its 4 lines");
  check(lines[0].strength === 2 && lines[0].ends.some((e) => e.id === "s:Prompting"), "first Python and Prompting, they share 2 stations");
  check(lines.every((l, i) => i === 0 || l.strength <= lines[i - 1].strength), "ordered by strength");
  await h.clickNode(page, "g:data-db");
  lines = await linesOnMap(page);
  check(lines.length === 3 && lines.every((l) => l.ends.some((e) => e.group === "data-db")), "Datenbanken: 3 lines with an end in it");
  await h.click(page, "#areas .chip.k-ai");
  lines = await linesOnMap(page);
  check(lines.length === 3 && lines.every((l) => l.ends.some((e) => e.cluster === "ai")) && lines[0].strength === 2, "area chip: 3 lines with an end in the area, strongest first");
  await h.click(page, "#areas .chip.k-ai");
  check(same(keys(await linesOnMap(page)), keys(all)), "a second click on the chip brings back the lines of the whole map");
}));

// Skill-Kategorie: 16 lines run from a skill to a category of another area. C# is a standard skill and CSS has no
// station, so neither starts a line. All 16 are drawn, so each selection has an exact set.
const mixedModePage = withInit(fixturePage, "window.LINE_MODE_OVERRIDE = 'mixed'; window.LINE_COUNT_OVERRIDE = 100; window.LINE_CROSS_AREA_OVERRIDE = true;");
const AREA_RGB = { sd: "rgb(44, 95, 196)", ai: "rgb(10, 133, 115)", data: "rgb(169, 106, 6)" };
const mixedLines = (page) => page.evaluate(() => [...document.querySelectorAll("#map path.shared-line")].map((p) => {
  const l = p.__data__;
  return { key: l.source.id + ">" + l.target.id, from: l.source.id, fromType: l.source.type, to: l.target.id, toType: l.target.type, toGroup: l.target.group,
    fromGroup: l.source.group, fromArea: l.source.cluster, toArea: l.target.cluster, strength: l.strength, stroke: getComputedStyle(p).stroke };
}));
const sorted = (list) => [...list].sort();

test("in Skill-Kategorie mode a click filters the lines from skills to categories", withPage({ page: mixedModePage }, async (page, check) => {
  const all = await mixedLines(page), before = await positions(page);
  check(all.length === 16 && all.every((l) => l.fromType === "skill" && l.toType === "group" && l.fromArea !== l.toArea), "16 lines, each from a skill to a category of another area");
  check(all.every((l) => l.stroke === AREA_RGB[l.fromArea]), "each line in the area color of its skill");
  check(all[0].strength === 3 && sorted(all.filter((l) => l.strength === 3).map((l) => l.key)).join() === "s:Prompting>g:sd-lang,s:Python>g:ai-tools", "strongest first: Python to Werkzeuge and Prompting to Sprachen, 3 each");
  await h.clickNode(page, "s:Python");
  let lines = await mixedLines(page);
  check(same(sorted(lines.map((l) => l.key)), ["s:Python>g:ai-tools", "s:Python>g:data-db"]), "Python: only the 2 lines it starts, not the lines that end at Sprachen");
  await h.click(page, "#zoom-fit");
  await page.waitForTimeout(600);
  await h.clickNode(page, "g:ai-tools");
  lines = await mixedLines(page);
  check(lines.length === 10 && lines.filter((l) => l.to === "g:ai-tools").length === 5 && lines.filter((l) => l.fromGroup === "ai-tools").length === 5,
    "Werkzeuge: the 5 lines that end at it and the 5 lines its skills start");
  await h.click(page, "#areas .chip.k-data");
  lines = await mixedLines(page);
  check(lines.length === 10 && lines.filter((l) => l.toArea === "data").length === 5 && lines.filter((l) => l.fromArea === "data").length === 5,
    "Daten: the 5 lines that end in the area and the 5 lines its skills start");
  check(lines.every((l) => l.stroke === AREA_RGB[l.fromArea]), "filtered lines keep the area color of their skill");
  check(same(await positions(page), before), "no node moves");
  await h.click(page, "#areas .chip.k-data");
  check(same(sorted((await mixedLines(page)).map((l) => l.key)), sorted(all.map((l) => l.key))), "a second click on the chip brings back all 16 lines");
}));

test("in Skill-Kategorie mode the lines take the dark area colors", withPage({ page: mixedModePage, colorScheme: "dark" }, async (page, check) => {
  const DARK_RGB = { sd: "rgb(132, 168, 242)", ai: "rgb(69, 200, 177)", data: "rgb(226, 164, 67)" };
  const all = await mixedLines(page);
  check(all.length === 16 && all.every((l) => l.stroke === DARK_RGB[l.fromArea]), "each line in the dark area color of its skill");
}));

// Farbverlauf (his wish of 2026-10-17, off by default): with LINE_GRADIENT, each Skill-Skill or Kategorie-Kategorie line
// gets its own gradient in map units from the area color of its first end to the area color of its second end.
const AREA_DARK_RGB = { sd: "rgb(132, 168, 242)", ai: "rgb(69, 200, 177)", data: "rgb(226, 164, 67)" };
const gradientLines = (page) => page.evaluate(() => [...document.querySelectorAll("#map path.shared-line")].map((p) => {
  const l = p.__data__, m = getComputedStyle(p).stroke.match(/^url\("?#([^")]+)"?\)$/), g = m && document.getElementById(m[1]);
  const at = (a, v) => !!g && Math.abs(Number(g.getAttribute(a)) - v) < 1e-6;
  return { key: l.source.id + "|" + l.target.id, id: g ? g.id : null, ends: [l.source.cluster, l.target.cluster], units: g ? g.getAttribute("gradientUnits") : null,
    stops: g ? [...g.querySelectorAll("stop")].map((s) => getComputedStyle(s).stopColor) : [], onChord: at("x1", l.source.x) && at("y1", l.source.y) && at("x2", l.target.x) && at("y2", l.target.y),
    strength: l.strength, width: Number(p.getAttribute("stroke-width")), opacity: Number(p.getAttribute("stroke-opacity")) };
}));
const gradientIds = (page) => page.evaluate(() => [...document.querySelectorAll("#map linearGradient")].map((g) => g.id).sort());
// Every line has a gradient on its chord with the colors of its two ends, and the map holds exactly these gradients.
const gradientsMatch = async (page, check, colors, text) => {
  const lines = await gradientLines(page), ids = await gradientIds(page);
  check(lines.length > 0 && ids.length === lines.length && same(ids, sorted(lines.map((l) => l.id))) && new Set(ids).size === ids.length, `${text}: ${lines.length} lines, ${ids.length} gradients with unique ids, one per line`);
  check(lines.every((l) => l.units === "userSpaceOnUse" && l.onChord), `${text}: each gradient runs in map units from the first end to the second end`);
  check(lines.every((l) => same(l.stops, l.ends.map((e) => colors[e]))), `${text}: the stops are the area colors of the two ends`);
  return lines;
};
const gradientPage = (mode, extra = "") => modeOnly(mode, " window.LINE_GRADIENT_OVERRIDE = true;" + extra);

test("with the gradient option each skill line runs between the area colors of its ends", withPage({ page: gradientPage("skill") }, async (page, check) => {
  const all = await gradientsMatch(page, check, AREA_RGB, "skill mode, light");
  check(all.length === 13, "all 13 skill lines have a gradient: " + all.length);
  const inside = all.filter((l) => l.ends[0] === l.ends[1]);
  check(all.filter((l) => l.ends[0] !== l.ends[1]).every((l) => l.stops[0] !== l.stops[1]), "the 12 lines between areas have two different colors");
  check(inside.length === 1 && same(inside[0].stops, [AREA_RGB.sd, AREA_RGB.sd]), "the line inside Entwicklung, Python and React, has the blue of its area only");
  const strongest = all.filter((l) => l.strength === 2);
  check(strongest.length === 1 && near(strongest[0].width, 0.5) && near(strongest[0].opacity, 0.35) && all.filter((l) => l.strength === 1).every((l) => near(l.width, 0.3) && near(l.opacity, 0.225)),
    "width and opacity stay as without the gradient: 0.5 and 0.35 for the strongest, 0.3 and 0.225 for the others");
  await h.clickNode(page, "s:Python");
  const python = await gradientsMatch(page, check, AREA_RGB, "click on Python");
  check(python.length === 5 && python.every((l) => l.key.split("|").includes("s:Python")), "Python: its 5 lines and only their 5 gradients");
  const p = await h.emptyPoint(page);
  await page.mouse.click(p.x, p.y); await page.waitForTimeout(80);
  check(same(sorted((await gradientsMatch(page, check, AREA_RGB, "after the click on the empty map")).map((l) => l.key)), sorted(all.map((l) => l.key))), "a click on the empty map brings back all 13 lines with their gradients");
  await h.click(page, "#zoom-in"); await h.click(page, "#zoom-in");
  await gradientsMatch(page, check, AREA_RGB, "zoomed in");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await gradientsMatch(page, check, AREA_DARK_RGB, "data-theme dark, without a new drawing");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await gradientsMatch(page, check, AREA_RGB, "data-theme light again");
}));

test("with the gradient option the category lines take the dark area colors", withPage({ page: gradientPage("category"), colorScheme: "dark" }, async (page, check) => {
  const all = await gradientsMatch(page, check, AREA_DARK_RGB, "category mode, system dark");
  check(all.length === 5 && all.every((l) => l.ends[0] !== l.ends[1] && l.stops[0] !== l.stops[1]), "the 5 category lines between areas, each in two colors");
  check(near(Math.max(...all.map((l) => l.width)), 2.6) && near(Math.max(...all.map((l) => l.opacity)), 0.46), "width and opacity of the category defaults: the strongest line 2.6 and 0.46");
  await h.clickNode(page, "c:data");
  const data = await gradientsMatch(page, check, AREA_DARK_RGB, "click on Daten");
  check(data.length === 3 && data.every((l) => l.ends.includes("data")), "Daten: the 3 lines with an end in the area and only their gradients");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await gradientsMatch(page, check, AREA_RGB, "data-theme light over a dark system");
}));

test("the gradient option has no effect in Skill-Kategorie mode", withPage({ page: withInit(mixedModePage, "window.LINE_GRADIENT_OVERRIDE = true;") }, async (page, check) => {
  const all = await mixedLines(page);
  check(all.length === 16 && all.every((l) => l.stroke === AREA_RGB[l.fromArea]), "16 lines, each in the area color of its skill");
  check((await gradientIds(page)).length === 0 && await page.locator("#map defs").count() === 0, "no gradient on the map");
}));

test("by default the lines have no gradient", withPage({}, async (page, check) => {
  check(await page.evaluate(() => LINE_GRADIENT === false), "LINE_GRADIENT is off by default");
  const lines = await page.evaluate(() => [...document.querySelectorAll("#map path.shared-line")].map((p) => ({ style: p.getAttribute("style"), stroke: getComputedStyle(p).stroke })));
  check(lines.length === 13 && lines.every((l) => l.style === null && l.stroke === "rgb(89, 103, 99)"), "13 lines in the grey line color, without a style attribute");
  check(await page.locator("#map defs, #map linearGradient").count() === 0, "no defs and no gradient on the map");
}));

test("hovering a skill does not filter the lines", withPage({ page: skillModePage }, async (page, check) => {
  const all = keys(await linesOnMap(page));
  const p = await h.nodePoint(page, "s:SQLite");
  await page.mouse.move(p.x, p.y); await page.waitForTimeout(60);
  check(await h.focused(page), "hover focuses the skill");
  check(same(keys(await linesOnMap(page)), all), "the lines stay those of the whole map");
}));

// Categories, areas, ratings, stations
test("category node opens its skills and zooms to them", withPage({}, async (page, check) => {
  const fit = await h.k(page);
  await h.clickNode(page, "g:sd-lang");
  check((await h.h2(page)) === "Sprachen" && (await page.locator("#panel .crumb").innerText()) === "Entwicklung › Sprachen", "category panel with its area and the full path");
  check(same(await h.chips(page), ["C#", "Python", "Go"]), "skills by rating");
  check(same(await h.onIds(page), ["c:sd", "g:sd-lang", "s:C#", "s:Go", "s:Python"]), "focus on the category");
  check((await h.k(page)) > fit, "zooms in");
}));

test("area chip selects the area and a second click clears it", withPage({}, async (page, check) => {
  const fit = await h.k(page);
  await h.click(page, "#areas .chip.k-data");
  check((await h.pressed(page, "#areas .chip.k-data")) === "true" && (await h.pressed(page, "#areas .chip.k-sd")) === "false", "only the Daten chip is pressed");
  check((await h.h2(page)) === "Daten" && (await h.h3s(page)).join() === "Datenbanken", "area panel lists its category");
  check(same(await h.chips(page), ["SQL Server", "SQLite"]) && same(await h.onIds(page), ["c:data", "g:data-db", "s:SQL Server", "s:SQLite"]), "skills and focus of the area");
  await h.click(page, "#areas .chip.k-data");
  check((await h.pressed(page, "#areas .chip.k-data")) === "false" && (await h.h2(page)) === "9 Kenntnisse in 3 Bereichen", "second click returns to the overview");
  check(near(await h.k(page), fit), "and fits the map");
}));

test("area list, area node and category link lead to the same panels", withPage({}, async (page, check) => {
  await page.locator("#panel .areas-list button", { hasText: "Künstliche Intelligenz" }).click(); await page.waitForTimeout(80);
  check((await h.h2(page)) === "Künstliche Intelligenz" && (await h.pressed(page, "#areas .chip.k-ai")) === "true", "area list selects the area and presses its chip");
  await h.click(page, "#panel .back");
  await h.clickNode(page, "c:sd");
  check((await h.h2(page)) === "Entwicklung" && same(await h.h3s(page), ["Sprachen", "Web"]), "area node opens the area");
  await page.locator("#panel h3 button", { hasText: "Web" }).click(); await page.waitForTimeout(80);
  check((await h.h2(page)) === "Web" && same(await h.chips(page), ["React", "CSS"]), "category link opens the category");
}));

test("rating filter lists its skills by area", withPage({}, async (page, check) => {
  await page.locator("#panel .legend button", { hasText: "Grundkenntnisse" }).click(); await page.waitForTimeout(80);
  check((await h.h2(page)) === "Grundkenntnisse" && (await page.locator("#panel .rating").innerText()).trim() === "3 Kenntnisse", "headline and count");
  check(same(await h.h3s(page), ["Entwicklung", "Künstliche Intelligenz", "Daten"]) && same(await h.chips(page), ["Go", "Prompting", "SQLite"]), "one section per area");
  check(same(await h.onIds(page), ["c:ai", "c:data", "c:sd", "g:ai-tools", "g:data-db", "g:sd-lang", "s:Go", "s:Prompting", "s:SQLite"]), "focus on the three skills and their parents");
}));

test("station chips list the skills used there", withPage({}, async (page, check) => {
  await page.locator("#panel .chip", { hasText: "Altfirma GmbH" }).click(); await page.waitForTimeout(80);
  check(same(await h.h3s(page), ["2 Kenntnisse"]) && same(await h.chips(page), ["C#", "SQL Server"]), "Altfirma: 2 skills");
  await h.click(page, "#panel .back");
  await page.locator("#panel .chip", { hasText: "Hobbyprojekt" }).click(); await page.waitForTimeout(80);
  check((await page.locator("#panel .crumb").innerText()) === "Privates Projekt · seit 2025", "private project crumb");
  check(same(await h.chips(page), ["C#", "Python", "Go", "Prompting", "SQLite", "Claude Code"]), "Hobbyprojekt: 6 skills, the standard skill C# counts from its first station");
}));

// Projects as reader
test("Projekte lists the projects with skills for a reader", withPage({}, async (page, check) => {
  await h.click(page, "#projects-btn");
  check((await h.pressed(page, "#projects-btn")) === "true" && (await h.h2(page)) === "Projekte", "project list");
  const heads = await page.evaluate(() => [...document.querySelectorAll("#panel .station-head")].map((d) => [...d.children].map((c) => c.textContent.trim())));
  check(same(heads, [["Private Projekte"], ["Neufirma AG", "2019 – 2024"]]), "stations in order, private first without a time range");
  const rows = await page.locator("#panel .plist button").allInnerTexts();
  check(same(rows.map((t) => t.replace(/\s+/g, " ").trim()), ["1 Chatbot 2025 3", "0 Grundstack Neu 2", "4 Kundenportal 2"]), "number, name, time range and skill count; empty project hidden");
  check(await page.locator("#panel .flag, #panel button.add, #panel button.primary").count() === 0, "no editing controls");
  await h.click(page, "#projects-btn");
  check((await h.pressed(page, "#projects-btn")) === "false" && (await h.h2(page)) === "9 Kenntnisse in 3 Bereichen", "second click returns to the overview");
  await h.click(page, "#panel button.primary");
  check((await h.h2(page)) === "Projekte", "Projekte öffnen in the overview opens the list too");
}));

test("project view focuses its skills and locates one on the map", withPage({}, async (page, check) => {
  await h.click(page, "#projects-btn");
  await page.locator("#panel .plist button", { hasText: "Kundenportal" }).click(); await page.waitForTimeout(80);
  check((await page.locator("#panel .crumb").innerText()) === "Neufirma AG · Nr. 4" && (await h.h3s(page)).join("|") === "2 Kenntnisse|Entwicklung", "crumb and sections");
  check(same(await h.onIds(page), ["c:sd", "g:sd-lang", "g:sd-web", "s:C#", "s:React"]), "focus on the project skills");
  const before = await h.transform(page);
  await page.locator("#panel .tag button", { hasText: "React" }).click(); await page.waitForTimeout(80);
  const after = await h.transform(page);
  check(after.k > before.k, "a skill in the list zooms to it on the map");
  await page.locator("#panel .back").click(); await page.waitForTimeout(80);
  check((await h.h2(page)) === "Projekte", "← Projekte returns to the list");
  await page.locator("#panel .plist button", { hasText: "Grundstack Neu" }).click(); await page.waitForTimeout(80);
  check((await page.locator("#panel .badge").innerText()) === "Grundstack: an der ganzen Station eingesetzt", "a reader sees the Grundstack badge in reader words");
}));

// Theme, layout, keyboard
test("theme follows the system and the data-theme choice", async ({ browser, check }) => {
  const bg = (page) => page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.getElementById("map")).backgroundColor]);
  for (const [scheme, theme, want] of [["light", null, LIGHT], ["dark", null, DARK], ["dark", "light", LIGHT], ["light", "dark", DARK]]) {
    const { context, page } = await open(browser, fixturePage, { colorScheme: scheme });
    if (theme) await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const [body, map] = await bg(page);
    check(body === want && map === want, `system ${scheme}${theme ? ", data-theme " + theme : ""}: page and map ${want}`);
    if (scheme === "dark" && !theme) {
      const ink = await page.evaluate(() => getComputedStyle(document.querySelector("#map g.t-skill text, #map .t-skill")).fill);
      check(ink === "rgb(227, 235, 233)", "dark: skill names in the light ink color");
    }
    await context.close();
  }
});

test("on a phone the panel sits below the map without sideways scroll", withPage({ viewport: { width: 400, height: 800 } }, async (page, check) => {
  const layout = await page.evaluate(() => {
    const map = document.querySelector(".map").getBoundingClientRect(), aside = document.getElementById("panel").getBoundingClientRect();
    return { below: aside.top >= map.bottom - 1, width: document.documentElement.scrollWidth, hint: getComputedStyle(document.querySelector(".hint")).display };
  });
  check(layout.below, "panel below the map");
  check(layout.width <= 400, `no sideways scroll (${layout.width} px)`);
  check(layout.hint === "none", "the zoom hint is hidden");
  await h.clickNode(page, "s:Python");
  check((await h.h2(page)) === "Python" && (await page.evaluate(() => document.documentElement.scrollWidth)) <= 400, "a skill panel fits too");
}));

test("keyboard reaches the controls and activates them", withPage({}, async (page, check) => {
  const active = () => page.evaluate(() => { const a = document.activeElement; return { id: a.id, text: a.textContent.trim(), outline: getComputedStyle(a).outlineStyle }; });
  await page.keyboard.press("Tab");
  check((await active()).id === "q", "first Tab: search field");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Tab");
  check(await page.evaluate(() => document.activeElement.matches("[data-language-picker] select")), "sixth Tab: the dropdown of the languages, the last of the tools");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
  const chip = await active();
  check(chip.text === "Daten" && chip.outline === "solid", "ninth Tab: the Daten chip with a visible focus ring");
  await page.keyboard.press("Enter"); await page.waitForTimeout(80);
  check((await h.h2(page)) === "Daten", "Enter on the chip selects the area");
  await page.keyboard.press("Tab");
  check((await active()).text === "← Übersicht", "next Tab: the back button in the panel");
  await page.keyboard.press("Space"); await page.waitForTimeout(80);
  check((await h.h2(page)) === "9 Kenntnisse in 3 Bereichen", "Space on it returns to the overview");
}));

// A "|" in a skill name (B4 of the review) broke its chip: the page split the value of data-go at every "|".
const pipePage = withData(fixturePage, (d) => d.replace('["Go", "sd-lang", 1, "PRIV"]', '["C|D", "sd-lang", 1, "PRIV"]'));
test("a skill name with | opens from its chip, and its tag in a project locates and removes it", async ({ browser, check }) => {
  const reader = await open(browser, pipePage);
  await h.click(reader.page, "#areas .chip.k-sd");
  await reader.page.locator("#panel .chip", { hasText: "C|D" }).click(); await reader.page.waitForTimeout(80);
  check((await h.h2(reader.page)) === "C|D", "the chip of C|D opens its panel: " + await h.h2(reader.page));
  check(reader.errors.length === 0, "reader: no console errors" + (reader.errors.length ? ": " + reader.errors.join(" | ") : ""));
  await reader.context.close();
  const owner = await open(browser, pipePage, { mode: "owner", seed: { ...seed, "projects/privat-pipe": { name: "Pipe", station: "PRIVAT", base: false, order: 2, when: "", skills: ["C|D", "Python"] } } });
  await h.click(owner.page, "#projects-btn");
  await owner.page.locator("#panel .plist button", { hasText: "Pipe" }).click(); await owner.page.waitForTimeout(80);
  const k = await h.k(owner.page);
  await owner.page.locator('#panel [data-act="locate|C|D"]').click(); await owner.page.waitForTimeout(150);
  check((await h.k(owner.page)) > k, "the tag of C|D zooms to it");
  await owner.page.locator('#panel [data-act="remove|C|D"]').click(); await owner.page.waitForTimeout(700);
  check(same(await owner.page.evaluate(() => JSON.parse(localStorage.getItem("stub-db"))["projects/privat-pipe"].skills), ["Python"]), "its × removes C|D from the project");
  check(owner.errors.length === 0, "owner: no console errors" + (owner.errors.length ? ": " + owner.errors.join(" | ") : ""));
  await owner.context.close();
});

// Roles
test("signed-in viewer, saved copy and owner see their own controls", async ({ browser, check }) => {
  const viewer = await open(browser, fixturePage, { mode: "viewer", seed });
  check((await viewer.page.locator("h1").innerText()) === "Skill-Atlas · Alex Beispiel (Demo)" && (await viewer.page.locator("#save-state").innerText()) === "", "viewer: reader header, no save status");
  check((await h.panel(viewer.page)).includes("3 Projekte."), "viewer: 3 of 4 projects from the database");
  await h.click(viewer.page, "#projects-btn");
  check(await viewer.page.locator("#panel .flag, #panel button.add, #panel button.primary").count() === 0 && await viewer.page.evaluate(() => window.__writes.length) === 0, "viewer: no editing, no writes");
  check(viewer.errors.length === 0, "viewer: no console errors");
  await viewer.context.close();

  const copy = await open(browser, fixturePage, { mode: "noRuntime" });
  check((await h.panel(copy.page)).includes("3 Projekte.") && (await copy.page.locator("#save-state").innerText()) === "", "saved copy without runtime: snapshot of 3 projects, reader view");
  await copy.context.close();

  const owner = await open(browser, fixturePage, { mode: "owner", seed });
  check((await owner.page.locator("h1").innerText()) === "Skill-Atlas · Alex Beispiel (Demo)", "owner: the heading of the map");
  check((await owner.page.locator("#subtitle").innerText()).startsWith("Zum Lesen hineinzoomen."), "owner: the subtitle of the map page stays");
  check((await owner.page.locator("#save-state").innerText()) === "Gespeichert", "owner: save status");
  check((await h.panel(owner.page)).includes("4 Projekte angelegt."), "owner: all 4 projects counted");
  await h.click(owner.page, "#projects-btn");
  const rows = (await owner.page.locator("#panel .plist button").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  check(rows.includes("1 Ohne Kenntnisse 0") && rows.includes("0 Grundstack Neu (ohne Linien) ohne Linien 2"), "owner: the empty project and the Grundstack flag");
  check(await owner.page.locator("#panel button.add").count() === 3 && await owner.page.locator("#panel button.primary", { hasText: "Neues Projekt" }).count() === 1, "owner: + Projekt per station and Neues Projekt");
  check(owner.errors.length === 0, "owner: no console errors");
  await owner.context.close();
});

// One editor page (the plan of 2026-10-18): the force menu only for the owner, and the configuration that readers see.
// The build picks "Weit": 2 category lines, other start points, 500 steps. "Eng" draws Skill-Kategorie lines from start
// points close together, with 200 steps.
const configDocs = Object.fromEntries(CONFIGS.configs.map(({ id, ...c }) => ["configs/" + id, c]));
const pickDoc = (config) => ({ "settings/reader": { config, pickedAt: "2026-10-18T09:00:00.000Z" } });
const configOf = (id) => CONFIGS.configs.find((c) => c.id === id);
const STORED_STATE = JSON.stringify({ schema: 4, pull: 0.05, lineMode: "skill", ticks: 1000, lines: { skill: { drawnBridges: 3 } } });
// Every node position of the map, and of a new layout with the values of a configuration on a page without configurations.
const nodeSpots = (page) => page.evaluate(() => Object.fromEntries(d3.selectAll("#map g.node").data().map((n) => [n.id, [n.x, n.y]])));
async function layoutOf(browser, config, variant = fixturePage) {
  const { context, page } = await open(browser, variant);
  const result = config ? await page.evaluate((c) => { springApply(springConfigState(c)); return Object.fromEntries(computeLayout().nodes.map((n) => [n.id, [n.x, n.y]])); }, config) : await nodeSpots(page);
  await context.close();
  return result;
}
const samePositions = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((id) => b[id] && Math.abs(a[id][0] - b[id][0]) < 1e-9 && Math.abs(a[id][1] - b[id][1]) < 1e-9);
// Marks the drawn nodes, so a test sees whether the map was drawn again.
const markNodes = (page) => page.evaluate(() => { document.querySelectorAll("#map g.node").forEach((g) => { g.__kept = true; }); });
const nodesKept = (page) => page.evaluate(() => [...document.querySelectorAll("#map g.node")].every((g) => g.__kept));
// The state of the page with sorted keys, against the full state of a configuration.
const stateIs = (page, config) => page.evaluate((c) => {
  const sort = (x) => Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
  return JSON.stringify(sort(springCurrent())) === JSON.stringify(sort(springConfigState(c)));
}, config);
// Records each key that the page reads or writes in localStorage.
const recordStorage = () => {
  window.__storage = [];
  for (const name of ["getItem", "setItem", "removeItem"]) {
    const original = Storage.prototype[name];
    Storage.prototype[name] = function (key, ...rest) { window.__storage.push(key); return original.call(this, key, ...rest); };
  }
};
const readerView = (page) => page.evaluate(() => {
  const storage = window.__storage.filter((k) => k === "skill-springs");
  const shown = (id) => { const e = document.getElementById(id); return !e.hidden && e.getClientRects().length > 0; };
  const box = document.querySelector(".map").getBoundingClientRect(), map = document.getElementById("map").getBoundingClientRect();
  return { menu: shown("cfg"), show: shown("cfg-show"), open: document.querySelector(".map").classList.contains("cfg-open"), groups: document.getElementById("cfg-groups").children.length,
    seeds: !!document.querySelector(".seed-layer"), measures: typeof window.springMeasure, measured: document.getElementById("cfg-measures").children.length,
    storage, kept: Object.keys(localStorage).includes("skill-springs"), fullWidth: Math.abs(map.left - box.left) < 0.5 && Math.abs(map.width - box.width) < 0.5 };
});
for (const [label, mode] of [["signed-out reader", "signedOut"], ["signed-in viewer", "viewer"], ["saved copy without runtime", "noRuntime"]]) {
  test(`${label}: no force menu, no start points, no measures, no browser state, map at full width`,
    withPage({ page: configsPage, mode, seed: { ...seed, ...configDocs, ...pickDoc("weit") }, init: recordStorage }, async (page, check) => {
      await page.waitForTimeout(200);
      const r = await readerView(page);
      check(!r.menu && !r.show && !r.open && r.groups === 0, "no force menu and no button for it: " + JSON.stringify(r));
      check(!r.seeds && r.measures === "undefined" && r.measured === 0, "no start points and no measures");
      check(r.storage.length === 0 && !r.kept, "the page neither reads nor writes skill-springs, and localStorage has no such key: " + JSON.stringify(r.storage));
      check(r.fullWidth, "the map has the full width");
      check(await page.evaluate(() => LINE_MODE === "category" && TICKS === 500) && (await page.locator("h1").innerText()) === "Skill-Atlas · Alex Beispiel (Demo)", "the reader view with the configuration Weit");
    }));
}

// A state that the owner stored in the same browser does not change what a reader sees.
test("a signed-out reader sees the configuration that the build picked", async ({ browser, check }) => {
  const want = await layoutOf(browser, configOf("weit")), plain = await layoutOf(browser, null);
  for (const mode of ["signedOut", "noRuntime"]) {
    const { context, page, errors } = await open(browser, configsPage, { mode, storage: { "skill-springs": STORED_STATE } });
    const got = await nodeSpots(page);
    check(samePositions(got, want), mode + ": every node sits where a layout with the values of Weit puts it");
    check(!samePositions(got, plain), mode + ": and not where the values of layout.js put it");
    check(await page.evaluate(() => LINE_MODE === "category" && TICKS === 500 && STANDARD_SKILLS === false && LINE_WIDTH_MAX === 4) && await page.locator("#map path.shared-line").count() === 2, mode + ": 2 category lines and the other values of Weit");
    check((await overviewLine(page)).startsWith("Die Linien verbinden Kategorien"), mode + ": the overview explains the category lines");
    check(errors.length === 0, mode + ": no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await context.close();
  }
});

test("a signed-in viewer follows a new pick at once and keeps his filters", async ({ browser, check }) => {
  const want = { weit: await layoutOf(browser, configOf("weit"), timePage()), eng: await layoutOf(browser, configOf("eng"), timePage()) };
  const { context, page, errors } = await open(browser, timePage("", configsPage), { mode: "viewer", seed: { ...seed, ...configDocs, ...pickDoc("weit") } });
  const pick = (config) => page.evaluate((c) => SKILL_MAP_RUNTIME.db().then((db) => db.collection("settings").doc("reader").set({ config: c, pickedAt: "2026-10-18T10:00:00.000Z" })), config);
  const settled = () => page.waitForTimeout(400);
  check(samePositions(await nodeSpots(page), want.weit) && await page.evaluate(() => LINE_MODE) === "category", "the pick in the database is the pick of the build: the map of Weit");
  await markNodes(page); await settled();
  check(await nodesKept(page), "the map was drawn once, the same pick draws nothing again");
  // A time range and a station, as a reader sets them.
  await setRange(page, M(2019, 1), M(2024, 12));
  await page.locator("#panel .chips .chip", { hasText: "Neufirma AG" }).click(); await page.waitForTimeout(80);
  const before = { on: await h.onIds(page), label: await timeLabel(page), names: await inRangeNames(page), h2: await h.h2(page) };
  await pick("eng"); await settled();
  check(await page.evaluate(() => LINE_MODE === "mixed" && TICKS === 200) && samePositions(await nodeSpots(page), want.eng), "the new pick Eng: its line mode, its steps and its layout");
  const after = { on: await h.onIds(page), label: await timeLabel(page), names: await inRangeNames(page), h2: await h.h2(page) };
  check(same(after, before) && before.h2 === "Neufirma AG" && before.label === "2019 – 2024", "the station, its focus and the time range stay: " + JSON.stringify(after));
  check(await page.locator("#map path.shared-line.mixed").count() === await page.locator("#map path.shared-line").count(), "the lines are Skill-Kategorie lines");
  await markNodes(page);
  await pick("fehlt"); await settled();
  check(await nodesKept(page) && await page.evaluate(() => LINE_MODE) === "mixed", "a pick of a missing configuration keeps the map");
  await pick("eng"); await settled();
  check(await nodesKept(page), "the pick of the configuration that the map shows draws nothing again");
  // The owner saves Eng again with other values: the viewer follows.
  await page.evaluate((c) => SKILL_MAP_RUNTIME.db().then((db) => db.collection("configs").doc("eng").set({ ...c, values: { ...c.values, lineMode: "skill" } })), (({ id, ...c }) => c)(configOf("eng")));
  await settled();
  check(await page.evaluate(() => LINE_MODE) === "skill" && !(await nodesKept(page)), "new values of the picked configuration reach the viewer at once");
  check(await page.evaluate(() => window.__writes.length) === 4, "the viewer wrote nothing, only the test did");
  check(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await context.close();
});

test("a pick of a missing configuration keeps the map of the build", withPage({ page: configsPage, mode: "viewer", seed: { ...seed, ...configDocs, ...pickDoc("fehlt") } }, async (page, check) => {
  check(await stateIs(page, configOf("weit")) && await page.evaluate(() => LINE_MODE === "category" && TICKS === 500), "the state of Weit, the pick of the build, stays");
}));

test("a picked configuration with values that do not fit keeps the values of layout.js for them", withPage({ page: configsPage, mode: "viewer",
  seed: { ...seed, ...configDocs, "configs/kaputt": { name: "Kaputt", schema: 4, values: { ticks: "viele", lineMode: "bunt", friction: null, at: { sd: "x", ai: [250, 20] } }, savedAt: "2026-10-18T09:00:00.000Z" }, ...pickDoc("kaputt") } },
  async (page, check) => {
    const r = await page.evaluate(() => ({ ticks: TICKS, friction: FRICTION, mode: LINE_MODE, sd: CLUSTERS.find((c) => c.id === "sd").at, ai: CLUSTERS.find((c) => c.id === "ai").at,
      finite: d3.selectAll("#map g.node").data().every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), nodes: d3.selectAll("#map g.node").size() }));
    check(r.ticks === 300 && r.friction === 0.3 && r.mode === "skill" && same(r.sd, [-300, 0]) && same(r.ai, [250, 20]), "the values that fit apply, the others come from layout.js: " + JSON.stringify(r));
    check(r.finite && r.nodes === 16, "the map is drawn with all 16 nodes");
  }));

// A line color of the configuration for readers that is no color (C1 of the final review): the path of the readers
// checked it only as a text, so any text went into --shared-light and --shared-dark of every reader's map. Both paths
// share springFits now, and a color that does not fit keeps the color of layout.js.
const BAD_COLORS = { lineMode: "category", crossAreaOnly: false, lines: { category: { bridgeColorLight: "url(https://example.org/x.svg#a)", bridgeColorDark: "red; background: url(https://example.org/y)" },
  skill: { bridgeColorLight: "#12345", bridgeColorDark: "#1234567" } } };
const colorConfig = { name: "Farbe", schema: 4, values: BAD_COLORS, savedAt: "2026-10-20T08:00:00.000Z" };
const colorPage = Object.freeze({ ...fixturePage, configs: { reader: "farbe", configs: [{ id: "farbe", ...colorConfig }] } });
test("a line color of the configuration for readers that is no color keeps the color of layout.js", async ({ browser, check }) => {
  for (const [mode, variant, docs] of [["signedOut", colorPage, null], ["viewer", fixturePage, { ...seed, "configs/farbe": colorConfig, ...pickDoc("farbe") }]]) {
    const { context, page, errors } = await open(browser, variant, { mode, seed: docs });
    const r = await page.evaluate(() => {
      const map = document.getElementById("map"), d = SPRING_DEFAULTS.lines, state = springConfigState({ schema: 4, values: { lines: { skill: { bridgeColorLight: "#ABCDEF" } } } });
      return { mode: LINE_MODE, light: LINE_COLOR_LIGHT, dark: LINE_COLOR_DARK, css: [map.style.getPropertyValue("--shared-light"), map.style.getPropertyValue("--shared-dark")],
        want: [d.category.bridgeColorLight, d.category.bridgeColorDark], lines: document.querySelectorAll("#map path.shared-line").length,
        stroke: (document.querySelector("#map path.shared-line") ? getComputedStyle(document.querySelector("#map path.shared-line")).stroke : ""),
        skill: [springConfigState({ schema: 4, values: { lines: { skill: { bridgeColorLight: "#12345", bridgeColorDark: "#1234567" } } } }).lines.skill.bridgeColorLight === d.skill.bridgeColorLight,
          state.lines.skill.bridgeColorLight === "#ABCDEF"] };
    });
    check(r.mode === "category" && r.light === r.want[0] && r.dark === r.want[1] && same(r.css, r.want), mode + ": the line colors of layout.js, in the constants and in the CSS variables: " + JSON.stringify(r));
    check(r.lines > 0 && !/url|red/.test(r.stroke), mode + ": the lines draw in that color: " + r.stroke);
    check(same(r.skill, [true, true]), mode + ": a color of five or seven digits keeps the color of layout.js, and #ABCDEF fits");
    await page.waitForTimeout(300);
    const requests = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((url) => !url.startsWith(location.origin)));
    check(requests.length === 0, mode + ": no request leaves the site: " + requests.join(", "));
    check(errors.length === 0, mode + ": no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await context.close();
  }
});

// Values far outside the controls of the menu (B2 of the review): a billion steps froze the page of every reader. Each
// value takes the nearer end of the range of its control, on every path that reads a configuration.
const HUGE = { ticks: 1e9, skillHold: 1e9, hold: 1e9, range: 1e9, lines: { skill: { bridgeWidthMax: 1e9 } } };
const hugeConfig = { name: "Riesig", schema: 4, values: HUGE, savedAt: "2026-10-19T08:00:00.000Z" };
const hugePage = Object.freeze({ ...fixturePage, configs: { reader: "riesig", configs: [{ id: "riesig", ...hugeConfig }] } });
// A promise, or "no answer" after ms milliseconds, so a frozen page fails the test instead of stopping it.
const within = (ms, promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("no answer after " + ms / 1000 + " s"), ms))]);
const ends = (page) => within(15000, page.evaluate(() => ({ ticks: TICKS, skillHold: SKILL_HOLD, hold: AREA_HOLD, range: CHARGE_RANGE, width: LINE_WIDTH_MAX,
  nodes: d3.selectAll("#map g.node").size(), finite: d3.selectAll("#map g.node").data().every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)) })));
const atEnds = (r) => r.ticks === 1500 && r.skillHold === 32 && r.hold === 51.2 && r.range === 320 && r.width === 10 && r.nodes === 16 && r.finite;
test("a configuration for readers with huge values opens in normal time, each value at the end of its control", async ({ browser, check }) => {
  for (const [mode, variant, docs] of [["signedOut", hugePage, null], ["viewer", fixturePage, { ...seed, "configs/riesig": hugeConfig, ...pickDoc("riesig") }]]) {
    const t0 = Date.now();
    const opened = await within(20000, open(browser, variant, { mode, seed: docs }));
    if (typeof opened === "string") { check(false, mode + ": the page does not open: " + opened); continue; }
    const r = await ends(opened.page), seconds = (Date.now() - t0) / 1000;
    check(atEnds(r), mode + ": 1500 steps and the other ends of the ranges: " + JSON.stringify(r));
    check(seconds < 10, `${mode}: the page answers after ${seconds.toFixed(1)} s`);
    check(opened.errors.length === 0, mode + ": no console errors" + (opened.errors.length ? ": " + opened.errors.join(" | ") : ""));
    await opened.context.close();
  }
});
test("huge values in a line or the state of the browser take the ends of the controls too", async ({ browser, check }) => {
  const { context, page, errors } = await open(browser, fixturePage, { mode: "owner", seed, storage: { "skill-springs": JSON.stringify({ schema: 4, pull: 0.05, ...HUGE }) } });
  const idle = () => within(20000, page.waitForFunction(() => !document.getElementById("spring-load").disabled && !/Berechne/.test(document.getElementById("cfg-measures").textContent), null, { timeout: 20000 }).then(() => page.waitForTimeout(100)));
  try {
    await idle();
    // The stored state first: every new layout of the menu stores its own state in its place.
    await page.click("#spring-browser"); await idle();
    check(atEnds(await ends(page)), "Letzter Stand im Browser: each value at the end of its control");
    await page.click("#spring-reset"); await idle();
    await page.evaluate((line) => { document.getElementById("spring-values").value = line; document.getElementById("spring-load").click(); }, JSON.stringify({ schema: 4, ...HUGE }));
    await idle();
    check(atEnds(await ends(page)), "Werte laden: each value at the end of its control");
    const said = await within(5000, page.locator("#spring-message").innerText());
    check(said === "Geladen: 4 Werte aus der Zeile und 1 Linienwert für 1 Modus, alle übrigen aus layout.js. Auf das Ende des Reglers gesetzt: ticks, skillHold, hold, range, lines.skill.bridgeWidthMax.", "and the message names them: " + said);
    check(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  } finally { await context.close(); }
});

test("the owner gets the force menu, starts from the pick for readers and keeps his own state", async ({ browser, check }) => {
  const want = await layoutOf(browser, configOf("eng"));
  const { context, page, errors } = await open(browser, configsPage, { mode: "owner", seed: { ...seed, ...configDocs, ...pickDoc("eng") }, storage: { "skill-springs": STORED_STATE } });
  const idle = () => page.waitForFunction(() => !document.getElementById("spring-load").disabled && !/Berechne/.test(document.getElementById("cfg-measures").textContent), null, { timeout: 20000 }).then(() => page.waitForTimeout(100));
  await idle();
  const r = await page.evaluate(() => ({ menu: !document.getElementById("cfg").hidden, show: !document.getElementById("cfg-show").hidden, open: document.querySelector(".map").classList.contains("cfg-open"),
    groups: document.querySelectorAll("#cfg-groups details").length, seeds: document.querySelectorAll(".seed-layer .seed-handle").length, measures: document.querySelectorAll("#cfg-measures dt").length }));
  check(r.menu && !r.show && r.open && r.groups === 10 && r.seeds === 3 && r.measures >= 6, "the menu with its 10 groups, the start points of the 3 areas and the measures: " + JSON.stringify(r));
  check((await page.locator("h1").innerText()) === "Skill-Atlas · Alex Beispiel (Demo)", "the heading of the map stays");
  check(await stateIs(page, configOf("eng")) && samePositions(await nodeSpots(page), want), "the owner starts from the pick in the database, Eng, not from the build or the browser");
  check(await page.evaluate(() => document.getElementById("cfg-lineMode").value === "mixed" && localStorage.getItem("skill-springs")) === STORED_STATE, "the menu shows Eng, and the state of the browser is untouched");
  await page.evaluate(() => { document.getElementById("spring-store").open = true; });
  await page.locator('#store-list li[data-id="weit"] button', { hasText: "Für Leser" }).click(); await page.waitForTimeout(400);
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("stub-db"))["settings/reader"].config) === "weit", "Für Leser writes settings/reader");
  check(await stateIs(page, configOf("eng")) && samePositions(await nodeSpots(page), want), "the owner's own state does not follow the new pick");
  const entries = await page.evaluate(() => [...document.querySelectorAll("#store-list li")].map((li) => ({ id: li.dataset.id, meta: li.querySelector(".store-meta").textContent,
    buttons: [...li.querySelectorAll("button")].map((b) => b.textContent + (b.disabled ? " (gesperrt)" : "") + (b.title ? " [" + b.title + "]" : "")) })));
  check(same(entries.map((e) => [e.id, e.meta.replace(/^18\.10\.2026, \d\d:\d\d/, ""), e.buttons]), [["weit", " · Schema 4 · für Leser", ["Laden", "Löschen (gesperrt) [Erst eine andere Konfiguration für Leser wählen]"]],
    ["eng", " · Schema 4", ["Laden", "Für Leser", "Löschen"]]]), "the picked entry says so and cannot be deleted: " + JSON.stringify(entries));
  await page.click("#spring-browser"); await idle();
  check(await page.evaluate(() => LINE_MODE === "skill" && TICKS === 1000 && LINE_COUNT === 3), "Letzter Stand im Browser loads the stored state");
  check((await page.locator("#spring-message").innerText()).startsWith("Letzter Stand im Browser geladen, Schema 4 wie diese Seite."), "and says so");
  check(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await context.close();
});

test("the owner's edit banner stays clear of the force menu, and a phone width closes the menu", withPage({ mode: "owner", seed }, async (page, check) => {
  await h.click(page, "#projects-btn");
  await page.locator("#panel .plist button", { hasText: "Kundenportal" }).click(); await page.waitForTimeout(80);
  await page.locator("#panel button", { hasText: "Skills zuweisen" }).click(); await page.waitForTimeout(80);
  const boxes = () => page.evaluate(() => { const box = (id) => { const e = document.getElementById(id); return e.hidden ? null : e.getBoundingClientRect().toJSON(); };
    return { menu: box("cfg"), show: box("cfg-show"), bar: box("editbar") }; });
  let b = await boxes();
  check(!!b.menu && !!b.bar && b.bar.left >= b.menu.right, `the banner starts right of the open menu (${Math.round(b.bar.left)} ≥ ${Math.round(b.menu.right)})`);
  await h.click(page, "#cfg-hide");
  b = await boxes();
  check(!b.menu && !!b.show && b.bar.top >= b.show.bottom, `with the menu closed the banner sits below its button (${Math.round(b.bar.top)} ≥ ${Math.round(b.show.bottom)})`);
  await h.click(page, "#cfg-show");
  await page.setViewportSize({ width: 400, height: 800 }); await page.waitForTimeout(150);
  b = await boxes();
  check(!b.menu && !!b.show && await page.locator("#editbar-done").isVisible(), "at phone width the menu closes, and Fertig can be reached");
  await h.click(page, "#editbar-done");
  check(!(await page.locator("#editbar").isVisible()), "Fertig ends the editing");
}));

// Editing flows that the editor suites do not cover
const editKundenportal = async (page) => {
  await h.click(page, "#projects-btn");
  await page.locator("#panel .plist button", { hasText: "Kundenportal" }).click(); await page.waitForTimeout(80);
  await page.locator("#panel button", { hasText: "Skills zuweisen" }).click(); await page.waitForTimeout(80);
};
test("editing: search marks hits, Enter zooms, Escape ends", withPage({ mode: "owner", seed }, async (page, check) => {
  await editKundenportal(page);
  check(await page.locator("#editbar").isVisible() && (await page.locator("#editbar-count").innerText()) === "Neufirma AG · 2 Kenntnisse", "edit bar with station and count");
  await h.wheelTo(page, 1.5);
  await h.search(page, "sq");
  check(same(await h.classed(page, "match"), ["s:SQL Server", "s:SQLite"]), "hits marked");
  check(await h.labelShown(page, "s:SQLite") && await h.labelShown(page, "s:React") && !(await h.labelShown(page, "s:Go")), "names of hits and assigned skills show at a small scale, others not");
  check((await h.h2(page)) === "Kundenportal", "the panel stays on the project");
  const k = await h.k(page);
  await page.press("#q", "Enter"); await page.waitForTimeout(100);
  check((await h.k(page)) > k && (await h.h2(page)) === "Kundenportal", "Enter zooms to the first hit, the panel stays");
  await page.keyboard.press("Escape"); await page.waitForTimeout(80);
  check(!(await page.locator("#editbar").isVisible()) && (await page.inputValue("#q")) === "", "Escape ends editing and clears the search");
  check((await page.locator("#panel button", { hasText: "Skills zuweisen" }).count()) === 1, "back in the project view");
}));

test("editing: area chip and category node only zoom", withPage({ mode: "owner", seed }, async (page, check) => {
  await editKundenportal(page);
  const k = await h.k(page);
  await h.click(page, "#areas .chip.k-data");
  check((await h.k(page)) > k && (await h.pressed(page, "#areas .chip.k-data")) === "false", "chip zooms to the area without selecting it");
  await h.click(page, "#zoom-fit");
  await h.clickNode(page, "g:sd-lang");
  check((await h.h2(page)) === "Kundenportal" && same(await h.chips(page), ["C#", "React"]), "category click changes no assignment");
  await h.click(page, "#projects-btn");
  check(!(await page.locator("#editbar").isVisible()) && (await h.h2(page)) === "Projekte", "Projekte ends editing and opens the list");
}));

test("project form numbers per station and refuses a bad number", withPage({ mode: "owner", seed }, async (page, check) => {
  await h.click(page, "#projects-btn");
  await page.locator("#panel button", { hasText: "Neues Projekt" }).click(); await page.waitForTimeout(80);
  check((await page.inputValue("#pf-station")) === "PRIVAT" && (await page.inputValue("#pf-order")) === "2", "private projects first, next number 2");
  await page.selectOption("#pf-station", "NEU");
  check((await page.inputValue("#pf-order")) === "5", "Neufirma: next number after 4");
  await page.fill("#pf-order", "7");
  await page.selectOption("#pf-station", "ALT");
  check((await page.inputValue("#pf-order")) === "7", "a typed number stays when the station changes");
  await page.fill("#pf-name", "Testprojekt");
  for (const bad of ["-1", "1.5"]) {
    await page.fill("#pf-order", bad);
    await page.locator("#project-form button[type=submit]").click(); await page.waitForTimeout(60);
    check((await page.locator("#pf-error").innerText()) === "Die Nummer muss eine ganze Zahl ab 0 sein.", `number ${bad} is refused`);
  }
  await page.fill("#pf-order", "");
  await page.locator("#project-form button[type=submit]").click(); await page.waitForTimeout(600);
  check((await page.locator("#panel .crumb").innerText()) === "Altfirma GmbH · Nr. 2", "an empty number takes the next number of the station");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("stub-db"))["projects/alt-testprojekt"]);
  check(!!stored && stored.order === 2 && stored.station === "ALT", "stored with station and number");
}));

// Time range filter (his wish of 2026-10-17). "Now" is pinned to July 2026, so the range runs from 01.2015 (the start of
// ALT) to 07.2026. In the fixture, ALT runs 2015 – 2019, NEU 2019 – 2024 (both hold 2019) and PRIV since 2025. The
// project Chatbot runs in 2025, the NEU projects take the months of NEU. C# is the standard skill since ALT, Prompting has
// NEU as an indirect station and CSS has no station.
const M = (y, m) => y * 12 + m - 1;
const T_FIRST = M(2015, 1), T_LAST = M(2026, 7);
const timePage = (extra = "", base = fixturePage) => withInit(base, `window.EXPERIENCE_NOW_OVERRIDE = 2026.5;${extra}`);
const handleAt = (page, id) => page.evaluate((i) => Number(document.getElementById(i).getAttribute("aria-valuenow")), id);
const pressTimes = async (page, selector, key, times) => { await page.focus(selector); for (let i = 0; i < times; i++) await page.keyboard.press(key); };
// Sets the range with the keyboard, as a reader can: both handles to the ends, then the end back and the start forward.
async function setRange(page, from, to) {
  await page.focus("#time-to"); await page.keyboard.press("End");
  await page.focus("#time-from"); await page.keyboard.press("Home");
  const back = (await handleAt(page, "time-to")) - to, forward = from - (await handleAt(page, "time-from"));
  await pressTimes(page, "#time-to", "PageDown", Math.floor(back / 12)); await pressTimes(page, "#time-to", "ArrowLeft", back % 12);
  await pressTimes(page, "#time-from", "PageUp", Math.floor(forward / 12)); await pressTimes(page, "#time-from", "ArrowRight", forward % 12);
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(40);
}
const timeLabel = (page) => page.locator("#time-label").innerText();
// The names of the skills in the range (not faded), and the ids of the categories and areas that fade.
const inRangeNames = (page) => page.evaluate(() => [...document.querySelectorAll("#map g.node.t-skill:not(.out-of-time)")].map((g) => g.__data__.label).sort());
const fadedParents = (page) => page.evaluate(() => [...document.querySelectorAll("#map g.node.out-of-time:not(.t-skill)")].map((g) => g.__data__.id).sort());
const NEU_SKILLS = ["C#", "Python", "React", "Prompting", "SQL Server"].sort(), PRIV_SKILLS = ["C#", "Python", "Go", "Claude Code", "Prompting", "SQLite"].sort();

test("time range: the layout helpers read every date format and agree with placeEnd", async ({ browser, check }) => {
  for (const [variant, name] of [[timePage(), "fixture"], [timePage("", realPage), "real data"]]) {
    const { context, page, errors } = await open(browser, variant);
    const r = await page.evaluate(() => {
      const months = (w) => JSON.stringify(placeMonths(w));
      const agree = Object.entries(PROJECTS).map(([k, p]) => { const m = placeMonths(p.when);
        return /seit/.test(p.when) ? m.to === NOW_MONTH && placeEnd(p.when) === EXPERIENCE_NOW : Math.abs((m.to + 1) / 12 - placeEnd(p.when)) < 1e-9; });
      return { now: NOW_MONTH, agree: agree.every(Boolean), count: agree.length,
        formats: ["2005 – 2010", "08.2010 – 01.2013", "seit 05.2026", "05.2026", "seit 2025", "2025", ""].map(months) };
    });
    check(r.now === M(2026, 7), `${name}: NOW_MONTH is July 2026`);
    check(r.agree, `${name}: placeMonths agrees with placeEnd for all ${r.count} stations`);
    if (name === "fixture") {
      const want = [[M(2005, 1), M(2010, 12)], [M(2010, 8), M(2013, 1)], [M(2026, 5), M(2026, 7)], [M(2026, 5), M(2026, 5)], [M(2025, 1), M(2026, 7)], [M(2025, 1), M(2025, 12)]]
        .map(([from, to]) => JSON.stringify({ from, to })).concat("null");
      check(same(r.formats, want), "years, month.year, seit, one month, seit a year, one year and no date: " + r.formats.join(" "));
      const h = await page.evaluate(() => {
        const M = (y, m) => y * 12 + m - 1;
        const L = computeLayout(), skill = (label) => L.nodes.find((n) => n.label === label), ids = (set) => [...set].sort();
        const neu = activeUseLinks(L.links, new Set(["NEU"]));
        return {
          projects: [projectMonths({ station: "NEU", when: "" }), projectMonths({ station: "PRIVAT", when: "2025" }), projectMonths({ station: "PRIVAT", when: "" })].map((m) => JSON.stringify(m)),
          active: [[M(2019, 6), M(2019, 6)], [M(2024, 12), M(2024, 12)], [M(2025, 1), M(2025, 1)], [M(2014, 1), M(2014, 12)]].map(([a, b]) => ids(activePlaces(a, b)).join()),
          neu: neu.map((l) => l.source.label + "|" + l.target.label + ":" + l.w).sort(), same: activeUseLinks(L.links, null) === L.links,
          since: [standardSince(skill("C#")), standardSince(skill("Python"))], at: [standardAt(skill("C#"), "PRIV"), standardAt(skill("Python"), "NEU")],
          inTime: ["C#", "React", "Go", "CSS"].map((n) => inTime(skill(n), new Set(["PRIV"]), new Set(["React"]))),
        };
      });
      check(same(h.projects, [JSON.stringify({ from: M(2019, 1), to: M(2024, 12) }), JSON.stringify({ from: M(2025, 1), to: M(2025, 12) }), "null"]), "projectMonths: the station's months, its own months, none at PRIVAT without a date");
      check(same(h.active, ["ALT,NEU", "NEU", "PRIV", ""]), "activePlaces: 06.2019 both firms, 12.2024 NEU, 01.2025 PRIV, 2014 none: " + h.active.join(" / "));
      check(same(h.neu, ["Prompting|SQL Server:1", "Python|Prompting:1", "Python|React:1", "Python|SQL Server:1", "React|Prompting:1", "React|SQL Server:1"]) && h.same,
        "activeUseLinks: with NEU active, 6 links of 1 connection each; without a set the links stay: " + h.neu.join(" "));
      check(same(h.since, ["ALT", null]) && same(h.at, [true, false]), "standardSince: ALT for C#, null for Python; standardAt counts PRIV for C#, nothing for Python");
      check(same(h.inTime, [true, true, true, false]), "inTime with PRIV active: C# as standard skill, React by its project, Go by its station, CSS not");
      const rings = await page.evaluate(([e1, e2, e3, e4]) => [null, e1, e2, e3, e4].map((end) => experienceOf(["ALT"], end)).concat([experienceOf(["PRIV"], e1), experienceOf(["ALT"])]), [M(2020, 12), M(2023, 12), M(2014, 12), M(2026, 7)]);
      const [base, end2020, end2023, before, atNow, privEarly, plain] = rings;
      check(base.xpAgeing === 0.5 && base.xpLastYear === 2019 && base.xpAsOf === null, "ALT today: 6.5 years since 2019, ageing 50 %");
      check(end2020.xpAgeing === 0 && end2020.xpLastYear === 2019 && end2020.xpAsOf === M(2020, 12), "ALT, filter end 12.2020: ageing 0 %, last use 2019");
      check(end2023.xpAgeing === 0.25 && end2023.xpAsOf === M(2023, 12), "ALT, filter end 12.2023: ageing 25 %");
      check([base, end2020, end2023, before, atNow].every((x) => x.xpYears === 4) && privEarly.xpYears === 0.5, "the years of experience stay 4 for ALT under every end, 0.5 for PRIV");
      check(same(before, base) && same(atNow, base) && same(plain, base), "an end before ALT starts, an end in the month of now, and no end keep the ring of today");
      check(privEarly.xpAgeing === 0 && privEarly.xpAsOf === null, "PRIV, filter end 12.2020: no place by then, the ring of today");
    }
    check(errors.length === 0, `${name}: no console errors`);
    await context.close();
  }
});

// A running station in English (D3 of the final review): "since 05.2024" counted one month, as did "05.2024 – today",
// and "03/2013" lost its month. The words of a running place count in every language now, and the forms refuse any other
// word (whenValid). The functions as they were before (old below) give each old form of the maps the same months as today.
test("time range: since, seit, today, present and heute run to today in every language, MM/YYYY names a month, and the old forms keep their months", async ({ browser, check }) => {
  for (const [variant, name] of [[timePage(), "fixture"], [timePage("", realPage), "real data"]]) {
    const { context, page, errors } = await open(browser, variant);
    const r = await page.evaluate(() => {
      const oldDates = (when) => (String(when).match(/(\d{2}\.)?\d{4}/g) || []).map((t) => t.includes(".") ? { month: Number(t.slice(0, 2)), year: Number(t.slice(3)) } : { month: null, year: Number(t) });
      const oldMonths = (when) => { const d = oldDates(when); if (!d.length) return null; const f = d[0], l = d[d.length - 1];
        return { from: f.year * 12 + (f.month || 1) - 1, to: /seit/.test(when) ? NOW_MONTH : l.year * 12 + (l.month || 12) - 1 }; };
      const oldEnd = (when) => { const l = oldDates(when).pop(); return /seit/.test(when) || !l ? EXPERIENCE_NOW : l.year + (l.month || 12) / 12; };
      const months = (w) => JSON.stringify(placeMonths(w));
      const running = ["seit 05.2024", "since 05.2024", "Since 05.2024", "05.2024 – today", "05.2024 – present", "05.2024 – heute", "05.2024 - Today", "since 05.2024 – today"];
      const texts = [...Object.values(PROJECTS).map((p) => p.when), ...(typeof STATIC_PROJECTS === "undefined" ? [] : STATIC_PROJECTS.map((p) => p.when))];
      return {
        running: running.map(months), ends: running.every((w) => placeEnd(w) === EXPERIENCE_NOW),
        slash: ["03/2013 – 10/2019", "3/2013 – 10/2019", "03/2013", "03/2013 – today"].map(months),
        valid: [...running, "03.2013 – 10.2019", "03/2013 – 10/2019", "2005 – 2010", "2005-2010", "05.2026", "2025", "seit 2025", " 05.2026 "].map((w) => [w, whenValid(w)]).filter(([, ok]) => !ok),
        invalid: ["Frühling", "05.2024 – bis jetzt", "until 05.2024", "05.2024 – now", "ab 05.2024", "13.2020", "00.2020", "05.2024 –", "seit 03.2013 – 10.2019", "05.2024 heute", "2024 2025", "since"].map((w) => [w, whenValid(w)]).filter(([, ok]) => ok),
        old: texts.filter((w) => months(w) !== JSON.stringify(oldMonths(w)) || placeEnd(w) !== oldEnd(w)), count: texts.length,
        stored: texts.filter((w) => w && !whenValid(w)),
      };
    });
    if (name === "fixture") {
      check(r.running.every((m) => m === JSON.stringify({ from: M(2024, 5), to: M(2026, 7) })) && r.ends, "since, seit, today, present and heute, in any case: 05.2024 to July 2026, and placeEnd is now: " + r.running.join(" "));
      check(same(r.slash, [{ from: M(2013, 3), to: M(2019, 10) }, { from: M(2013, 3), to: M(2019, 10) }, { from: M(2013, 3), to: M(2013, 3) }, { from: M(2013, 3), to: M(2026, 7) }].map((m) => JSON.stringify(m))), "MM/YYYY and M/YYYY name a month: " + r.slash.join(" "));
      check(r.valid.length === 0, "whenValid takes every form of the forms: " + JSON.stringify(r.valid));
      check(r.invalid.length === 0, "whenValid refuses another word, a month outside 1 to 12, a dash without an end and seit before two dates: " + JSON.stringify(r.invalid));
    }
    check(r.old.length === 0 && r.count > 0, `${name}: each of the ${r.count} dates of the stations and projects gives the months and the end of before: ` + JSON.stringify(r.old));
    check(r.stored.length === 0, `${name}: the forms take every date of the map: ` + JSON.stringify(r.stored));
    check(errors.length === 0, `${name}: no console errors`);
    await context.close();
  }
});

test("time range: the control starts at all years and spans the stations", withPage({ page: timePage() }, async (page, check) => {
  check((await timeLabel(page)) === "alle Jahre", "label: alle Jahre");
  check(await page.evaluate(() => getComputedStyle(document.getElementById("time-reset")).visibility) === "hidden", "the reset button is hidden at all years");
  const aria = await page.evaluate(() => ["time-from", "time-to"].map((id) => { const e = document.getElementById(id); return [e.getAttribute("role"), e.tabIndex, ...["valuemin", "valuemax", "valuenow", "valuetext"].map((a) => e.getAttribute("aria-" + a))]; }));
  check(same(aria, [["slider", 0, String(T_FIRST), String(T_LAST), String(T_FIRST), "Januar 2015"], ["slider", 0, String(T_FIRST), String(T_LAST), String(T_LAST), "Juli 2026"]]), "two sliders from Januar 2015 to Juli 2026: " + JSON.stringify(aria));
  const bars = await page.evaluate(() => [...document.querySelectorAll("#time-places .time-place")].map((b) => [b.dataset.place, b.title, b.style.top]));
  check(same(bars, [["ALT", "Altfirma GmbH · 2015 – 2019", "0px"], ["NEU", "Neufirma AG · 2019 – 2024", "6px"], ["PRIV", "Hobbyprojekt · seit 2025", "0px"]]), "one bar per station, NEU in a second lane because it shares 2019: " + JSON.stringify(bars));
  const years = await page.locator("#time-years span").allInnerTexts();
  check(years.length >= 4 && years.every((y) => Number(y) >= 2015 && Number(y) <= 2026), "year labels under the track: " + years.join(" "));
  check((await page.locator("#map g.node.out-of-time, #map path.tree.out-of-time").count()) === 0 && (await page.locator("#map path.shared-line").count()) === 13, "nothing fades, all 13 lines");
}));

test("time range: exact skills in the range by station, project and month boundary", withPage({ page: timePage() }, async (page, check) => {
  const before = await positions(page);
  const cases = [
    [M(2016, 1), M(2017, 12), "2016 – 2017", ["C#", "SQL Server"].sort(), ["c:ai", "g:ai-tools", "g:sd-web"], "inside ALT"],
    [M(2021, 1), M(2022, 12), "2021 – 2022", NEU_SKILLS, [], "inside NEU"],
    [M(2018, 12), M(2018, 12), "12.2018", ["C#", "SQL Server"].sort(), ["c:ai", "g:ai-tools", "g:sd-web"], "12.2018: ALT only"],
    [M(2019, 6), M(2019, 6), "06.2019", NEU_SKILLS, [], "06.2019: ALT and NEU"],
    [M(2024, 12), M(2024, 12), "12.2024", NEU_SKILLS, [], "12.2024: the last month of NEU"],
    [M(2025, 1), M(2025, 1), "01.2025", PRIV_SKILLS, ["g:sd-web"], "01.2025: the first month of PRIV and Chatbot"],
    [M(2026, 1), T_LAST, "01.2026 – 07.2026", PRIV_SKILLS, ["g:sd-web"], "2026: only seit 2025"],
  ];
  for (const [from, to, label, want, parents, text] of cases) {
    await setRange(page, from, to);
    const got = await inRangeNames(page), faded = await fadedParents(page);
    check((await timeLabel(page)) === label && same(got, want), `${text}: label ${label}, skills ${got.join(", ")}`);
    check(same(faded, parents.sort()), `${text}: faded categories and areas ${faded.join(", ") || "none"}`);
    check(!got.includes("CSS"), `${text}: CSS has no station and stays out`);
  }
  check(near(await h.opacity(page, "s:React"), 0.14) && near(await h.opacity(page, "s:Go"), 1), "a skill out of the range fades to 14 %, one in it stays");
  check(same(await positions(page), before), "no node moves");
  await h.click(page, "#time-reset");
  check((await timeLabel(page)) === "alle Jahre" && (await page.locator("#map g.node.out-of-time").count()) === 0 && near(await h.opacity(page, "s:CSS"), 1), "Alle Jahre: no skill fades, CSS too");
}));

test("time range: a project brings its skills into the range", withPage({ page: timePage(), mode: "viewer",
  seed: projectDocs(JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.projects.json"), "utf8")).map((p) => p.id === "alt-ohne-kenntnisse" ? { ...p, skills: ["Go"] } : p)) }, async (page, check) => {
  await setRange(page, M(2016, 1), M(2017, 12));
  check(same(await inRangeNames(page), ["C#", "Go", "SQL Server"].sort()), "inside ALT, Go counts through the ALT project that holds it");
}));

// A standard skill counts for every station from its since on (usedIn). Here C# is at NEU only and standard since NEU.
const standardTimePage = timePage("", withData(fixturePage, (d) => d.replace('["C#", "sd-lang", 3, "ALT NEU"]', '["C#", "sd-lang", 3, "NEU"]').replace('since: "ALT"', 'since: "NEU"')));
test("time range: a standard skill counts from its since on", withPage({ page: standardTimePage }, async (page, check) => {
  for (const [from, to, inside, text] of [[M(2016, 1), M(2017, 12), false, "inside ALT, before since"], [M(2021, 1), M(2021, 12), true, "inside NEU, its station"], [M(2026, 1), T_LAST, true, "PRIV only, after since"]]) {
    await setRange(page, from, to);
    check((await inRangeNames(page)).includes("C#") === inside, `${text}: C# ${inside ? "in" : "out of"} the range`);
  }
}));

// The switch "Standard-Skills" for the panel, the station views and the time range filter. On (the default), C# shows its
// note and counts for every station from ALT on: ALT and NEU are its own stations, PRIV comes after them. Off, it is a
// normal skill: the panel lists its stations ALT and NEU, and it counts only there. Its standard field stays in the data.
const placesOf = (page) => page.locator("#panel h3:has-text('Eingesetzt bei') + ul.list li").allInnerTexts().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim()));
async function stationChips(page, name) {
  await page.locator("#panel .chip", { hasText: name }).click(); await page.waitForTimeout(80);
  const chips = await h.chips(page), heads = await h.h3s(page);
  await h.click(page, "#panel .back");
  return { heads, chips };
}
for (const [on, variant] of [[true, timePage()], [false, timePage(" window.STANDARD_SKILLS_OVERRIDE = false;")]]) {
  test(`standard skills ${on ? "on" : "off"}: the panel, the station views and the time range of C#`, withPage({ page: variant }, async (page, check) => {
    const state = await page.evaluate(() => { const L = computeLayout(), c = L.nodes.find((n) => n.id === "s:C#");
      return { switch: STANDARD_SKILLS, data: STANDARD["C#"].since, note: c.standard, since: standardSince(c), priv: standardAt(c, "PRIV"),
        inPriv: inTime(c, new Set(["PRIV"]), new Set()), inNeu: inTime(c, new Set(["NEU"]), new Set()) }; });
    check(same(state, { switch: on, data: "ALT", note: "Standard seit Altfirma in allen Stationen", since: on ? "ALT" : null, priv: on, inPriv: on, inNeu: true }),
      `STANDARD_SKILLS ${on}: the standard field stays; standardSince ${on ? "ALT" : "null"}, PRIV counts ${on ? "" : "not "}for C#, NEU always: ` + JSON.stringify(state));
    await h.clickNode(page, "s:C#");
    const badges = await page.locator("#panel .badge").allInnerTexts(), places = await placesOf(page);
    check(on ? same(badges, ["Standard seit Altfirma in allen Stationen"]) && same(places, []) : same(badges, []) && same(places, ["Neufirma AG 2019 – 2024", "Altfirma GmbH 2015 – 2019"]),
      on ? "the panel shows the note in place of the stations" : "the panel lists the stations of C#, newest first, and no note: " + places.join(" / "));
    await h.click(page, "#panel .back");
    const alt = await stationChips(page, "Altfirma GmbH"), neu = await stationChips(page, "Neufirma AG"), priv = await stationChips(page, "Hobbyprojekt");
    check(same(alt, { heads: ["2 Kenntnisse"], chips: ["C#", "SQL Server"] }) && same(neu, { heads: ["5 Kenntnisse"], chips: ["C#", "SQL Server", "Python", "React", "Prompting"] }),
      "Altfirma and Neufirma, the own stations of C#, count it: " + JSON.stringify([alt, neu]));
    check(same(priv, on ? { heads: ["6 Kenntnisse"], chips: ["C#", "Python", "Go", "Prompting", "SQLite", "Claude Code"] } : { heads: ["5 Kenntnisse"], chips: ["Python", "Go", "Prompting", "SQLite", "Claude Code"] }),
      `Hobbyprojekt ${on ? "counts C# as a standard skill since Altfirma" : "does not count C#"}: ` + JSON.stringify(priv));
    for (const [from, to, label, want, text] of [[M(2016, 1), M(2017, 12), "2016 – 2017", ["C#", "SQL Server"].sort(), "inside ALT"], [M(2021, 1), M(2022, 12), "2021 – 2022", NEU_SKILLS, "inside NEU"],
      [M(2026, 1), T_LAST, "01.2026 – 07.2026", on ? PRIV_SKILLS : PRIV_SKILLS.filter((n) => n !== "C#"), "only PRIV"]]) {
      await setRange(page, from, to);
      const got = await inRangeNames(page);
      check((await timeLabel(page)) === label && same(got, want), `time range ${text}: C# ${want.includes("C#") ? "in" : "out of"} the range: ` + got.join(", "));
    }
    await h.clickNode(page, "s:C#");
    check(near(await h.opacity(page, "s:C#"), 1), "a clicked C# stays visible");
    await h.click(page, "#time-reset");
    check((await page.locator("#map g.node.out-of-time").count()) === 0, "Alle Jahre: nothing fades");
  }));
}

test("time range: label in years or months, keyboard steps and the reset", withPage({ page: timePage() }, async (page, check) => {
  await page.focus("#time-from");
  await page.keyboard.press("ArrowRight");
  check((await handleAt(page, "time-from")) === T_FIRST + 1 && (await timeLabel(page)) === "02.2015 – 07.2026", "ArrowRight: one month, label in months");
  await page.keyboard.press("PageUp");
  check((await handleAt(page, "time-from")) === M(2016, 2), "Page Up: one year");
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowDown");
  check((await handleAt(page, "time-from")) === M(2015, 12), "ArrowLeft and ArrowDown: one month back each");
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("PageDown");
  check((await handleAt(page, "time-from")) === M(2015, 1) && (await timeLabel(page)) === "alle Jahre", "ArrowUp then Page Down: back at the start, all years again");
  await page.focus("#time-to");
  await page.keyboard.press("PageDown"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
  check((await timeLabel(page)) === "2015 – 2024", "the end at 12.2024: from January to December, label in years");
  await page.keyboard.press("Home");
  check((await handleAt(page, "time-to")) === T_FIRST && (await timeLabel(page)) === "01.2015", "Home on the end handle: down to the start handle, one month");
  for (let i = 0; i < 11; i++) await page.keyboard.press("ArrowRight");
  check((await timeLabel(page)) === "2015", "January to December of one year: 2015");
  await page.focus("#time-from"); await page.keyboard.press("End");
  check((await handleAt(page, "time-from")) === M(2015, 12) && (await timeLabel(page)) === "12.2015", "End on the start handle: up to the end handle");
  await page.keyboard.press("ArrowRight");
  check((await handleAt(page, "time-from")) === M(2015, 12), "the start handle does not pass the end handle");
  const reset = await page.evaluate(() => getComputedStyle(document.getElementById("time-reset")).visibility);
  check(reset === "visible", "the reset button shows while a range is set");
  await page.focus("#time-reset"); await page.keyboard.press("Enter"); await page.waitForTimeout(40);
  check((await timeLabel(page)) === "alle Jahre" && (await handleAt(page, "time-from")) === T_FIRST && (await handleAt(page, "time-to")) === T_LAST, "Enter on Alle Jahre: the full range again");
  check(await page.evaluate(() => document.activeElement.id) === "time-from", "the focus moves to the start handle");
}));

test("time range: mouse drag, track click, touch and station bars", withPage({ page: timePage(), hasTouch: true }, async (page, check) => {
  const box = await page.locator("#time-track").boundingBox(), y = box.y + box.height / 2;
  const xAt = (m) => box.x + (m - T_FIRST) / (T_LAST - T_FIRST + 1) * box.width;
  await page.mouse.move(xAt(T_FIRST), y); await page.mouse.down();
  await page.mouse.move(xAt(M(2017, 1)), y, { steps: 4 }); await page.mouse.move(xAt(M(2019, 1)), y, { steps: 4 }); await page.mouse.up();
  check((await handleAt(page, "time-from")) === M(2019, 1) && (await timeLabel(page)) === "01.2019 – 07.2026", "a drag of the start handle to 2019: " + await timeLabel(page));
  await page.mouse.click(xAt(M(2024, 1)), y);
  check((await timeLabel(page)) === "2019 – 2023", "a click on the track near the end moves the end handle: " + await timeLabel(page));
  await page.touchscreen.tap(xAt(M(2017, 1)), y); await page.waitForTimeout(40);
  check((await timeLabel(page)) === "2017 – 2023", "a tap left of the start handle moves it: " + await timeLabel(page));
  await page.locator('#time-places .time-place[data-place="NEU"]').click();
  check((await timeLabel(page)) === "2019 – 2024", "a click on the NEU bar sets the range to NEU");
  check(same(await page.evaluate(() => [...document.querySelectorAll("#time-places .time-place.on")].map((b) => b.dataset.place)), ["ALT", "NEU"]), "the bars of the active stations stand out: ALT shares 2019");
}));

test("time range: lines count only the active stations, in all three modes", async ({ browser, check }) => {
  // Skill-Skill, 2020 – 2024: only NEU is active. Its 6 pairs share one station each, so all have the top strength.
  let { context, page, errors } = await open(browser, timePage());
  const before = await positions(page);
  await setRange(page, M(2020, 1), M(2024, 12));
  const skill = await linesOnMap(page);
  check(same(skill.map((l) => l.key).sort(), ["s:Prompting|s:SQL Server", "s:Python|s:Prompting", "s:Python|s:React", "s:Python|s:SQL Server", "s:React|s:Prompting", "s:React|s:SQL Server"]), "skill mode: the 6 pairs of NEU: " + skill.map((l) => l.key).join(", "));
  check(skill.every((l) => l.strength === 1 && near(l.width, 0.5) && near(l.opacity, 0.35)), "each with 1 connection, Python and Prompting too: width 0.5, opacity 0.35");
  check(same(await positions(page), before), "no node moves");
  await h.clickNode(page, "s:Python");
  const python = await linesOnMap(page);
  check(same(python.map((l) => l.key).sort(), ["s:Python|s:Prompting", "s:Python|s:React", "s:Python|s:SQL Server"]), "a click on Python: its 3 lines through NEU");
  check(errors.length === 0, "skill mode: no console errors");
  await context.close();
  // Kategorie-Kategorie, 06.2025 – 07.2026: only PRIV is active.
  ({ context, page, errors } = await open(browser, timePage(" window.LINE_MODE_OVERRIDE = 'category';")));
  await setRange(page, M(2025, 6), T_LAST);
  const category = (await linesOnMap(page)).map((l) => [l.key, l.strength, Math.round(l.width * 1000) / 1000, Math.round(l.opacity * 1000) / 1000]);
  check(same(category, [["g:ai-tools|g:sd-lang", 4, 2.6, 0.46], ["g:ai-tools|g:data-db", 2, 1.956, 0.372], ["g:data-db|g:sd-lang", 2, 1.956, 0.372]]), "category mode: Werkzeuge–Sprachen 4, Werkzeuge–Datenbanken 2, Datenbanken–Sprachen 2: " + JSON.stringify(category));
  check(errors.length === 0, "category mode: no console errors");
  await context.close();
  // Skill-Kategorie, the same range: 10 lines, 5 of strength 2 and 5 of strength 1.
  ({ context, page, errors } = await open(browser, timePage(" window.LINE_MODE_OVERRIDE = 'mixed';")));
  await setRange(page, M(2025, 6), T_LAST);
  const mixed = (await mixedLines(page)).map((l) => l.key + ":" + l.strength).sort();
  check(same(mixed, ["s:Claude Code>g:data-db:1", "s:Claude Code>g:sd-lang:2", "s:Go>g:ai-tools:2", "s:Go>g:data-db:1", "s:Prompting>g:data-db:1", "s:Prompting>g:sd-lang:2",
    "s:Python>g:ai-tools:2", "s:Python>g:data-db:1", "s:SQLite>g:ai-tools:2", "s:SQLite>g:sd-lang:2"].sort()), "Skill-Kategorie mode: the 10 lines of PRIV: " + mixed.join(" "));
  check(errors.length === 0, "mixed mode: no console errors");
  await context.close();
});

test("time range: the panel counts follow the range and the rest fades", withPage({ page: timePage() }, async (page, check) => {
  await setRange(page, M(2021, 1), M(2022, 12));
  check((await h.h2(page)) === "5 von 9 Kenntnissen in 3 Bereichen", "headline: 5 of 9 skills");
  check((await h.panel(page)).includes("2 von 3 Projekten im Zeitraum."), "projects: the 2 of NEU of 3");
  const legend = await page.evaluate(() => [...document.querySelectorAll("#panel .legend button")].map((b) => [b.innerText.replace(/\s+/g, " ").trim(), b.classList.contains("off-time")]));
  check(same(legend, [["sehr gute Kenntnisse 2", false], ["gute Kenntnisse 2", false], ["Grundkenntnisse 1", false], ["mit KI eingesetzt, ohne eigene Routine 0", true], ["eingesetzt, noch nicht bewertet 0", true]]), "rating counts in the range, empty ones fade: " + JSON.stringify(legend));
  const areas = await page.evaluate(() => [...document.querySelectorAll("#panel .areas-list button")].map((b) => b.innerText.replace(/\s+/g, " ").trim()));
  check(same(areas, ["Entwicklung 3", "Künstliche Intelligenz 1", "Daten 1"]), "area counts in the range: " + areas.join(", "));
  const stations = await page.evaluate(() => [...document.querySelectorAll("#panel .chips .chip")].map((c) => [c.innerText.trim(), c.classList.contains("off-time")]));
  check(same(stations, [["Neufirma AG", false], ["Altfirma GmbH", true], ["Hobbyprojekt", true]]), "station chips outside the range fade");
  await h.clickNode(page, "s:Python");
  const rows = await page.evaluate(() => [...document.querySelectorAll("#panel ul.list li")].map((li) => [li.querySelector("button").innerText.trim(), li.classList.contains("off-time")]));
  check(same(rows, [["Hobbyprojekt", true], ["Neufirma AG", false], ["Chatbot", true]]), "skill panel: Hobbyprojekt and Chatbot fade, Neufirma not: " + JSON.stringify(rows));
  await h.click(page, "#projects-btn");
  const list = await page.evaluate(() => [...document.querySelectorAll("#panel .station-head, #panel .plist li")].map((e) => [e.innerText.replace(/\s+/g, " ").trim(), e.classList.contains("off-time")]));
  check(same(list.map(([, off]) => off), [true, true, false, false, false]), "project list: Private Projekte and Chatbot fade, Neufirma and its projects not: " + JSON.stringify(list));
  await h.click(page, "#projects-btn");
  await page.locator("#panel .legend button", { hasText: "Grundkenntnisse" }).click(); await page.waitForTimeout(80);
  check((await page.locator("#panel .rating").innerText()).trim() === "1 von 3 Kenntnissen im Zeitraum", "rating view: 1 of 3 in the range");
  check(same(await page.evaluate(() => [...document.querySelectorAll("#panel .chip.off-time")].map((c) => c.innerText.trim())), ["Go", "SQLite"]), "rating view: Go and SQLite fade");
  await setRange(page, T_FIRST, T_LAST);
  check((await page.locator("#panel .rating").innerText()).trim() === "3 Kenntnisse" && (await page.locator("#panel .off-time").count()) === 0, "all years: the rating view without a range again");
}));

test("time range: together with the search, a click and a project", withPage({ page: timePage() }, async (page, check) => {
  await setRange(page, M(2016, 1), M(2017, 12));
  await h.search(page, "sql");
  check(same(await h.classed(page, "match"), ["s:SQL Server", "s:SQLite"]) && near(await h.opacity(page, "s:SQL Server"), 1) && near(await h.opacity(page, "s:SQLite"), 0.14), "search in ALT: SQL Server shows, SQLite matches but fades");
  check((await h.panel(page)).includes("1 davon im Zeitraum.") && same(await page.evaluate(() => [...document.querySelectorAll("#panel .chip.off-time")].map((c) => c.innerText.trim())), ["SQLite"]), "the hit list says 1 in the range and fades SQLite");
  await h.search(page, "");
  await h.clickNode(page, "s:Go");
  check((await h.h2(page)) === "Go" && near(await h.opacity(page, "s:Go"), 1) && near(await h.opacity(page, "g:sd-lang"), 1), "a click on Go, out of the range: Go and its category stay visible");
  check(near(await h.opacity(page, "c:ai"), 0.14) && (await linesOnMap(page)).length === 0, "the other area fades, and Go has no line in ALT");
  await h.click(page, "#panel .back");
  await h.click(page, "#projects-btn");
  await page.locator("#panel .plist button", { hasText: "Chatbot" }).click(); await page.waitForTimeout(80);
  check(same(await h.onIds(page), ["c:ai", "c:sd", "g:ai-tools", "g:sd-lang", "s:Claude Code", "s:Python"]) && near(await h.opacity(page, "s:Python"), 0.14) && near(await h.opacity(page, "s:Claude Code"), 0.14), "project Chatbot in ALT: its skills in focus but faded, the project runs in 2025");
}));

test("time range: while a project gets skills, no skill fades", withPage({ page: timePage(), mode: "owner", seed }, async (page, check) => {
  await setRange(page, M(2016, 1), M(2017, 12));
  check(near(await h.opacity(page, "s:React"), 0.14), "before editing, React fades in ALT");
  await editKundenportal(page);
  check(near(await h.opacity(page, "s:React"), 1) && near(await h.opacity(page, "s:Go"), 0.4), "editing: the assigned React shows, the unassigned Go at the editing 40 %");
  check((await h.h2(page)) === "Kundenportal", "the panel shows the project");
}));

// The ageing counts to the end of the range when it ends before now (his rule of 2026-10-17). Go is at ALT only here:
// 4 years, last used 2019, so today (07.2026) 50 % of its ring are grey.
const goAltPage = timePage("", withData(fixturePage, (d) => d.replace('["Go", "sd-lang", 1, "PRIV"]', '["Go", "sd-lang", 1, "ALT"]')));
const ringOf = (page, id) => page.evaluate((i) => { const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__.id === i);
  return { fresh: Number(g.querySelector(".xp-fresh").dataset.share), aged: Number(g.querySelector(".xp-aged").dataset.share), title: g.querySelector("title").textContent }; }, id);
const allRings = (page) => page.evaluate(() => [...document.querySelectorAll("#map g.node.t-skill")].map((g) => g.querySelector("g.xp") ? g.querySelector("g.xp").outerHTML + g.querySelector("title").textContent : ""));
test("time range: the ageing of the ring counts to the end of the range", withPage({ page: goAltPage }, async (page, check) => {
  const base = await allRings(page), before = await positions(page);
  const today = await ringOf(page, "s:Go");
  check(near(today.fresh, 0.2) && near(today.aged, 0.2) && today.title === "Go · 4 Jahre Erfahrung, zuletzt genutzt 2019", "today: 4 of 10 years, half of them grey: " + JSON.stringify(today));
  await setRange(page, T_FIRST, M(2020, 12));
  const end2020 = await ringOf(page, "s:Go");
  check(near(end2020.fresh, 0.4) && near(end2020.aged, 0) && end2020.title === "Go · 4 Jahre Erfahrung, zuletzt genutzt 2019 (Stand 12.2020)", "end 12.2020: 0 % grey, the tooltip names the end: " + JSON.stringify(end2020));
  await setRange(page, T_FIRST, M(2023, 12));
  const end2023 = await ringOf(page, "s:Go");
  check(near(end2023.fresh, 0.3) && near(end2023.aged, 0.1) && end2023.title.endsWith("(Stand 12.2023)"), "end 12.2023: 25 % grey: " + JSON.stringify(end2023));
  check(same(await page.evaluate(() => d3.selectAll("#map g.node.t-skill").data().map((n) => n.xpYears)), await page.evaluate(() => computeLayout().nodes.filter((n) => n.type === "skill").map((n) => n.xpYears))), "the years of experience stay as without the range");
  check(same(await positions(page), before), "no node moves");
  await setRange(page, M(2018, 1), T_LAST);
  check(same(await allRings(page), base), "a range that only moves the start: the rings of today");
  await setRange(page, T_FIRST, T_LAST);
  check(same(await allRings(page), base), "all years: the rings of today");
}));

test("time range: on a phone the control fits without sideways scroll", withPage({ page: timePage(), viewport: { width: 400, height: 800 } }, async (page, check) => {
  await page.locator('#time-places .time-place[data-place="NEU"]').click(); await page.waitForTimeout(60);
  const layout = await page.evaluate(() => {
    const bar = document.getElementById("timebar").getBoundingClientRect(), map = document.querySelector(".map").getBoundingClientRect(), track = document.getElementById("time-track").getBoundingClientRect();
    return { width: document.documentElement.scrollWidth, below: bar.top >= map.bottom - 1, inside: bar.bottom <= innerHeight + 1 && bar.left >= 0 && bar.right <= 400, track: track.width };
  });
  check(layout.width <= 400, `no sideways scroll (${layout.width} px)`);
  check(layout.below && layout.inside, "the time bar sits below the map, inside the screen");
  check(layout.track > 300 && (await timeLabel(page)) === "2019 – 2024", `the track is ${Math.round(layout.track)} px wide and the NEU bar sets the range`);
}));

test("time range: the control in the dark theme", withPage({ page: timePage(), colorScheme: "dark" }, async (page, check) => {
  await setRange(page, M(2019, 1), M(2024, 12));
  const c = await page.evaluate(() => { const s = (id, p) => getComputedStyle(document.getElementById(id))[p];
    return [s("timebar", "backgroundColor"), s("time-from", "borderTopColor"), s("time-from", "backgroundColor"), s("time-fill", "backgroundColor"), s("time-label", "color")]; });
  check(same(c, ["rgb(21, 29, 32)", "rgb(227, 235, 233)", "rgb(21, 29, 32)", "rgb(227, 235, 233)", "rgb(227, 235, 233)"]), "dark surface, light ink for handles, fill and label: " + c.join(" / "));
  const bars = await page.evaluate(() => [...document.querySelectorAll("#time-places .time-place")].map((b) => getComputedStyle(b, "::after").backgroundColor));
  check(same(bars, ["rgb(227, 235, 233)", "rgb(227, 235, 233)", "rgb(147, 163, 160)"]), "active bars in ink, the other in the muted color: " + bars.join(" / "));
}));

test("real data: a station bar sets its range, and the map and the panel follow", withPage({ page: realPage }, async (page, check) => {
  await page.locator('#time-places .time-place[data-place="NLS"]').click(); await page.waitForTimeout(80);
  const total = await page.evaluate(() => SKILLS.length), headline = await h.h2(page), m = headline.match(/^(\d+) von (\d+) Kenntnissen/);
  const faded = await page.locator("#map g.node.t-skill.out-of-time").count(), lines = await page.locator("#map path.shared-line").count();
  check((await timeLabel(page)) === "04.2012 – 08.2018" && !!m && Number(m[2]) === total && Number(m[1]) + faded === total && Number(m[1]) > 0, `Schrödingers Katze: ${headline}, ${faded} faded`);
  check(lines > 0 && lines <= 1000, `the map draws ${lines} lines through the stations of the range`);
  await h.click(page, "#time-reset");
  check((await h.h2(page)) === `${total} Kenntnisse in 6 Bereichen` && (await page.locator("#map g.node.out-of-time").count()) === 0, "Alle Jahre brings back the whole map");
}));

// Downloads: SVG, PNG and PDF of the map as drawn now, for every visitor.
const zlib = require("zlib"), crypto = require("crypto");
const { PDF_LIBS, PDF_FONTS } = require("./harness");
const { pdfText } = require("./site");
const LABELS = ["Entwicklung", "Künstliche Intelligenz", "Daten", "SPRACHEN", "WEB", "WERKZEUGE", "DATENBANKEN", "C#", "Python", "Go", "React", "CSS", "Claude Code", "Prompting", "SQL Server", "SQLite"];
const today = (page) => page.evaluate(() => { const d = new Date(); return { stamp: [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((x) => String(x).padStart(2, "0")).join("-"), de: d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) }; });
const downloadIdle = (page) => page.waitForFunction(() => [...document.querySelectorAll("#downloads button")].every((b) => !b.disabled), null, { timeout: 30000 });
// Clicks a download button and returns the file that the browser saved, with the status line after it.
async function download(page, kind) {
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click(`#downloads button[data-file="${kind}"]`)]);
  const data = fs.readFileSync(await file.path());
  await downloadIdle(page);
  return { name: file.suggestedFilename(), data, state: await page.locator("#download-state").innerText() };
}
// The parts of an exported SVG, read in the page: the layers of the map are the lines, the tree lines and the nodes.
const svgParts = (page, text) => page.evaluate((t) => {
  const doc = new DOMParser().parseFromString(t, "image/svg+xml"), root = doc.documentElement;
  const map = root.querySelector(":scope > g"), [lines, tree, nodeLayer] = map ? [...map.children].filter((e) => e.localName === "g") : [];
  const nodes = nodeLayer ? [...nodeLayer.children].map((g) => ({ text: (g.querySelector("text") || {}).textContent, opacity: g.getAttribute("opacity") || "1",
    star: !!g.querySelector('path:not([fill="none"])'), dashed: !!g.querySelector("circle[stroke-dasharray]"), font: (g.querySelector("text") || { getAttribute: () => "" }).getAttribute("font-family") })) : [];
  return { error: !!doc.querySelector("parsererror"), tag: root.localName, ns: root.namespaceURI, width: Number(root.getAttribute("width")), height: Number(root.getAttribute("height")), viewBox: root.getAttribute("viewBox"),
    texts: [...root.querySelectorAll("text")].map((e) => e.textContent), lines: lines ? lines.querySelectorAll("path").length : -1, nodes,
    classes: root.querySelectorAll("[class], [style]").length, background: (root.querySelector(":scope > rect") || { getAttribute: () => "" }).getAttribute("fill"),
    faces: [...root.querySelectorAll("style")].map((s) => s.textContent).join("\n").match(/@font-face \{[^}]*\}/g) || [] };
}, text);
// The text strings and drawing operators of a PDF from jsPDF: its streams are deflated, its standard fonts use WinAnsi.
function pdfParts(buffer) {
  const latin = buffer.toString("latin1"), streams = [];
  for (const m of latin.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length, raw = buffer.subarray(start, latin.indexOf("endstream", start));
    try { streams.push(zlib.inflateSync(raw).toString("latin1")); } catch (e) { streams.push(raw.toString("latin1")); }
  }
  // The texts as a reader finds them, also in the embedded font of the PDF (pdfText in tests/e2e/site.js).
  const content = streams.join("\n"), { strings, fonts } = pdfText(buffer);
  return { head: latin.slice(0, 5), strings, fonts, curves: (content.match(/ c\n/g) || []).length, lines: (content.match(/ l\n/g) || []).length, images: /\/Subtype\s*\/Image/.test(latin) };
}
const pngSize = (data) => ({ png: data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), width: data.readUInt32BE(16), height: data.readUInt32BE(20) });

for (const [label, mode] of [["signed-out reader", "signedOut"], ["signed-in viewer", "viewer"], ["saved copy without runtime", "noRuntime"], ["owner", "owner"]]) {
  test(`${label}: the panel offers SVG, PNG and PDF downloads`, withPage({ mode, seed }, async (page, check) => {
    const shown = await page.evaluate(() => { const e = document.getElementById("downloads"); return !e.hidden && e.getClientRects().length > 0; });
    check(shown && (await page.locator("#downloads-title").innerText()).toLowerCase() === "herunterladen", "the group Herunterladen shows");
    check(same(await page.locator("#downloads button").allInnerTexts(), ["SVG", "PNG", "PNG 4×", "PDF"]), "buttons SVG, PNG, PNG 4× and PDF");
    const file = await download(page, "svg"), day = await today(page);
    check(file.name === `skill-map-${day.stamp}.svg` && file.data.toString("utf8").startsWith("<?xml"), "the SVG downloads as " + file.name);
  }));
}
test("without d3 the page shows no download buttons", withPage({ mode: "noD3" }, async (page, check) => {
  check(await page.locator("#downloads").isHidden(), "the download group stays hidden");
  check((await h.h2(page)) === "Die Karte konnte nicht laden", "the page still explains that the map did not load");
}));

test("SVG download: a standalone file with every name, symbol and line of the map", withPage({}, async (page, check) => {
  const file = await download(page, "svg"), text = file.data.toString("utf8"), svg = await svgParts(page, text), day = await today(page);
  check(!svg.error && svg.tag === "svg" && svg.ns === "http://www.w3.org/2000/svg", "the file parses as an SVG document");
  check(svg.width > 0 && svg.height > 0 && svg.viewBox.split(" ").length === 4, `size ${svg.width} × ${svg.height} with a viewBox`);
  check(svg.classes === 0 && !text.includes("var(") && !/\bclass=/.test(text), "no class, no style attribute and no CSS variable");
  check(LABELS.every((l) => svg.texts.includes(l)), "every area, category and skill name of the fixture: " + LABELS.filter((l) => !svg.texts.includes(l)).join(", "));
  check(svg.texts.includes(`Skill-Atlas · Alex Beispiel (Demo) · ${day.de}`), "the title and the date at the bottom: " + svg.texts.at(-1));
  check(svg.nodes.length === 16, "16 nodes, without the hit areas");
  const by = Object.fromEntries(svg.nodes.map((n) => [n.text, n]));
  check(by["C#"].star && by["Python"].star && !by["Go"].star && by["Claude Code"].dashed && !by["CSS"].dashed, "rating symbols: stars for C# and Python, a dot for Go, a dashed ring for Claude Code");
  check(svg.lines === await page.locator("#map path.shared-line").count() && svg.lines > 0, `the ${svg.lines} drawn lines`);
  check(svg.background === "#f3f6f5", "the light background");
  check(svg.faces.length === 0 && /^Archivo,.*sans-serif$/.test(by["C#"].font), "without reachable font data, the names keep the font stack of the page: " + by["C#"].font);
  check(file.state === `Heruntergeladen: skill-map-${day.stamp}.svg. Die Schrift der Seite ließ sich nicht einbetten, die Datei nennt Ersatzschriften.`, "the status names the file and the fallback fonts: " + file.state);
}));

test("SVG download embeds the fonts that the page loads, only the faces in use", withPage({ fonts: true }, async (page, check) => {
  const file = await download(page, "svg"), svg = await svgParts(page, file.data.toString("utf8"));
  check(svg.faces.length === 2 && svg.faces.every((f) => f.includes('font-family: "Archivo"') && f.includes("data:font/woff2;base64,")), "two Archivo faces as data URLs: " + svg.faces.length);
  check(same(svg.faces.map((f) => (f.match(/font-weight: ([\d ]+);/) || [])[1]), ["400", "700"]), "the weights 400 and 700 of the names, not 500 or 600");
  check(svg.faces.every((f) => f.includes("U+0-FF") && !f.includes("U+100-2BA")), "only the latin subset that the names need, not latin-ext");
  const local = fs.readFileSync(path.join(repo, "selfhost", "vendor", "fonts", "archivo-latin-400-normal.woff2"));
  check(Buffer.from(svg.faces[0].match(/base64,([^)]+)\)/)[1], "base64").equals(local), "the data is the font file byte for byte");
  check(!file.state.includes("Ersatzschriften"), "no note on fallback fonts: " + file.state);
}));

test("SVG download follows the selection, the time range and the theme", withPage({ page: timePage() }, async (page, check) => {
  const all = await svgParts(page, (await download(page, "svg")).data.toString("utf8"));
  check(all.nodes.every((n) => n.opacity === "1"), "without a filter every node is opaque");
  await h.clickNode(page, "s:Python");
  const picked = await svgParts(page, (await download(page, "svg")).data.toString("utf8"));
  const pageFaded = await page.evaluate(() => [...document.querySelectorAll("#map g.node")].filter((g) => Number(getComputedStyle(g).opacity) < 1).map((g) => g.__data__.label).sort());
  check(picked.lines === await page.locator("#map path.shared-line").count() && picked.lines < all.lines, `a clicked skill: only its ${picked.lines} of ${all.lines} lines`);
  check(same(picked.nodes.filter((n) => n.opacity === "0.14").map((n) => n.text).sort(), pageFaded) && pageFaded.length > 0, "the nodes outside the selection fade as on the page: " + pageFaded.join(", "));
  await h.click(page, "#panel .back");
  await page.locator('#time-places .time-place[data-place="ALT"]').click(); await page.waitForTimeout(80);
  const timed = await svgParts(page, (await download(page, "svg")).data.toString("utf8")), outside = await page.evaluate(() => [...document.querySelectorAll("#map g.node.t-skill.out-of-time")].map((g) => g.__data__.label).sort());
  check(same(timed.nodes.filter((n) => n.opacity === "0.14" && outside.includes(n.text)).map((n) => n.text).sort(), outside) && outside.length > 0, "the skills outside the time range fade: " + outside.join(", "));
  check(timed.texts.at(-1).endsWith(" · Zeitraum " + await timeLabel(page)), "the footer names the time range: " + timed.texts.at(-1));
}));
test("SVG download in the dark theme keeps the dark colors", withPage({ colorScheme: "dark" }, async (page, check) => {
  const text = (await download(page, "svg")).data.toString("utf8"), svg = await svgParts(page, text);
  const fills = await page.evaluate((t) => { const doc = new DOMParser().parseFromString(t, "image/svg+xml"); return [...doc.querySelectorAll("text")].filter((e) => ["Entwicklung", "C#"].includes(e.textContent)).map((e) => e.getAttribute("fill")); }, text);
  check(svg.background === "#0f1517", "the dark background: " + svg.background);
  check(same(fills, ["#84a8f2", "#e3ebe9"]), "the area name in the dark area color, the skill name in the light ink: " + fills.join(" / "));
}));
test("SVG and PDF download keep the gradient lines", withPage({ page: gradientPage("skill") }, async (page, check) => {
  const text = (await download(page, "svg")).data.toString("utf8");
  const r = await page.evaluate((t) => {
    const doc = new DOMParser().parseFromString(t, "image/svg+xml"), ids = new Set([...doc.querySelectorAll("linearGradient")].map((g) => g.id));
    const refs = [...doc.querySelectorAll("path[stroke^='url(']")].map((p) => p.getAttribute("stroke").slice(5, -1));
    return { gradients: ids.size, refs: refs.length, resolved: refs.every((id) => ids.has(id)), stops: [...doc.querySelectorAll("stop")].every((s) => /^#[0-9a-f]{6}$/.test(s.getAttribute("stop-color"))) };
  }, text);
  const drawn = await page.locator("#map path.shared-line").count();
  check(r.gradients === drawn && r.refs === drawn && r.resolved, `each of the ${drawn} lines refers to its own gradient in the file`);
  check(r.stops, "the gradient stops carry plain colors");
  check(pdfParts((await download(page, "pdf")).data).head === "%PDF-", "the PDF of the gradient lines saves");
}));
test("the start points of the owner stay out of the file",withPage({ mode: "owner", seed }, async (page, check) => {
  check(await page.locator("#map .seed-layer text").count() === 3, "the owner sees 3 start points on the map");
  const svg = await svgParts(page, (await download(page, "svg")).data.toString("utf8"));
  check(!svg.texts.some((t) => t.startsWith("Start ")) && svg.nodes.length === 16, "the file has no start point and the 16 nodes");
  check(svg.texts.at(-1).startsWith("Skill-Atlas · Alex Beispiel (Demo) · "), "the footer has the title of the map: " + svg.texts.at(-1));
}));

test("PNG download: a PNG at 2 and at 4 times the size of the SVG", withPage({}, async (page, check) => {
  const svg = await svgParts(page, (await download(page, "svg")).data.toString("utf8")), day = await today(page);
  const two = await download(page, "png"), size2 = pngSize(two.data);
  check(two.name === `skill-map-${day.stamp}.png` && size2.png, "a PNG file named " + two.name);
  check(size2.width === svg.width * 2 && size2.height === svg.height * 2, `2 × ${svg.width} × ${svg.height}: ${size2.width} × ${size2.height}`);
  const four = await download(page, "png4"), size4 = pngSize(four.data);
  check(four.name === `skill-map-${day.stamp}-4x.png` && size4.png && size4.width === svg.width * 4 && size4.height === svg.height * 4, `PNG 4×: ${size4.width} × ${size4.height} as ${four.name}`);
}));
test("PNG download draws the names in the embedded font", withPage({ fonts: true }, async (page, check) => {
  const text = (await download(page, "svg")).data.toString("utf8"), png = (await download(page, "png")).data.toString("base64");
  // The PNG of the page against the same SVG drawn without the embedded font and without Archivo in the font stack.
  const r = await page.evaluate(async ([t, p]) => {
    const pixels = async (src, w, h) => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(img, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
    const doc = new DOMParser().parseFromString(t, "image/svg+xml"), w = Number(doc.documentElement.getAttribute("width")) * 2, h = Number(doc.documentElement.getAttribute("height")) * 2;
    const fallback = t.replace(/<defs><style>[\s\S]*?<\/style><\/defs>/, "").replace(/font-family="Archivo, /g, 'font-family="');
    const got = await pixels("data:image/png;base64," + p, w, h), plain = await pixels("data:image/svg+xml;charset=utf-8," + encodeURIComponent(fallback), w, h), again = await pixels("data:image/svg+xml;charset=utf-8," + encodeURIComponent(t), w, h);
    let differ = 0, same = 0;
    for (let i = 0; i < got.length; i += 4) { if (got[i] !== plain[i] || got[i + 1] !== plain[i + 1] || got[i + 2] !== plain[i + 2]) differ++; if (got[i] !== again[i] || got[i + 1] !== again[i + 1] || got[i + 2] !== again[i + 2]) same++; }
    return { differ, same, total: got.length / 4 };
  }, [text, png]);
  check(r.differ > 1000, `the names differ from the fallback font in ${r.differ} of ${r.total} pixels`);
  check(r.same < r.total * 0.001, `and match the SVG with its font, ${r.same} pixels apart`);
}));

test("PDF download: a vector PDF with every name as text, its libraries loaded on the first click", withPage({}, async (page, check) => {
  const asked = [], fonts = [];
  page.on("request", (r) => { const lib = Object.keys(PDF_LIBS).find((p) => r.url().endsWith("/" + p)); if (lib) asked.push(lib); });
  page.on("request", (r) => { const font = Object.keys(PDF_FONTS).find((p) => r.url().endsWith("/" + p)); if (font) fonts.push(font); });
  await page.waitForTimeout(100);
  check(asked.length === 0 && await page.evaluate(() => !window.jspdf), "the page loads no PDF library before the first click");
  check(fonts.length === 0, "the page loads no font of the PDF before the first click");
  const file = await download(page, "pdf"), pdf = pdfParts(file.data), day = await today(page);
  check(file.name === `skill-map-${day.stamp}.pdf` && pdf.head === "%PDF-", "a PDF file named " + file.name);
  check(same(asked, Object.keys(PDF_LIBS)), "the first click loads jsPDF, then svg2pdf.js, from vendor/ of the site");
  check(same(fonts.sort(), Object.keys(PDF_FONTS).sort()), "and the two files of Noto Sans from vendor/fonts/: " + fonts.join(", "));
  check(pdf.fonts.length > 0 && pdf.fonts.every((f) => f.name === "NotoSans" && f.embedded), "every text of the PDF is in the embedded font Noto Sans: " + JSON.stringify(pdf.fonts));
  check(LABELS.every((l) => pdf.strings.includes(l)), "every name is text in the PDF: " + LABELS.filter((l) => !pdf.strings.includes(l)).join(", "));
  check(pdf.strings.includes(`Skill-Atlas · Alex Beispiel (Demo) · ${day.de}`), "the title and the date as text");
  check(pdf.curves > 50 && pdf.lines > 0 && !pdf.images, `vector paths (${pdf.curves} curves, ${pdf.lines} lines) and no picture`);
  await download(page, "pdf");
  check(asked.length === 2, "a second PDF loads no library again");
  check(fonts.length === 2, "and no font again");
}));
test("PDF download says so when its library does not load, and loads it on the next click", withPage({}, async (page, check, context) => {
  await context.route("**/vendor/svg2pdf.js-*", (route) => route.abort());
  await page.click('#downloads button[data-file="pdf"]'); await downloadIdle(page);
  check((await page.locator("#download-state").innerText()) === "Die PDF-Bibliothek konnte nicht laden. Bitte später noch einmal versuchen." && await page.locator("#download-state.error").count() === 1, "the status explains the failed load");
  await context.unroute("**/vendor/svg2pdf.js-*");
  const file = await download(page, "pdf");
  check(pdfParts(file.data).head === "%PDF-", "the next click loads the library and saves the PDF");
}));

// Leftovers of the claude.ai page (B8 of the review): comments about the artifact database and its capabilities, and
// texts about the next build, which the self-hosted product does not have.
test("the page code names no claude.ai, no artifact database, no capability and no build of the page", async ({ check }) => {
  const code = fs.readFileSync(path.join(repo, "skills", "page.js"), "utf8");
  const found = [/claude\.ai/i, /artifact/i, /capabilit/i, /db rules/i, /signed[- ](out|in)/i, /(nächsten|letzten) (Export und )?Build/, /Projekteditor/].filter((re) => re.test(code));
  check(found.length === 0, "none of them in skills/page.js: " + found.map(String).join(", "));
});

test("the local copies of the PDF libraries match the versions and hashes in the page", async ({ check }) => {
  const template = fs.readFileSync(path.join(repo, "skills", "page.js"), "utf8");
  for (const [url, file] of Object.entries(PDF_LIBS)) {
    const m = template.match(new RegExp('\\["' + url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + '", "(sha\\d+)-([^"]+)"\\]'));
    const data = fs.readFileSync(path.join(repo, "selfhost", "vendor", file));
    check(!!m && crypto.createHash(m[1]).update(data).digest("base64") === m[2], `${file}: the page pins ${url} with the hash of the file in vendor/`);
  }
  // The font of the PDF (D4 of the final review): the page pins each file with its SHA-384, and the build with its SHA-256.
  const { PDF_FONT_FILES } = require(path.join(repo, "build_selfhost.js"));
  for (const [url, file] of Object.entries(PDF_FONTS)) {
    const m = template.match(new RegExp('"' + url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + '", "(sha\\d+)-([^"]+)"\\]'));
    const data = fs.readFileSync(path.join(repo, "selfhost", "vendor", file)), built = PDF_FONT_FILES.find(([name]) => file.endsWith("/" + name));
    check(!!m && crypto.createHash(m[1]).update(data).digest("base64") === m[2], `${file}: the page pins ${url} with the hash of the file in vendor/`);
    check(!!built && crypto.createHash("sha256").update(data).digest("hex") === built[1], `${file}: the build records its SHA-256 ` + (built ? built[1] : "nowhere"));
    const tables = Array.from({ length: data.readUInt16BE(4) }, (_, i) => data.toString("latin1", 12 + 16 * i, 16 + 16 * i));
    check(data.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) && tables.includes("glyf") && !tables.includes("fvar"), `${file}: a static TrueType font, no variable font: ` + tables.join(" "));
  }
  check(fs.readFileSync(path.join(repo, "selfhost", "vendor", "licenses", "Noto-Sans-OFL.txt"), "utf8").includes("SIL OPEN FONT LICENSE Version 1.1"), "the license of Noto Sans is in vendor/licenses/");
});

// Real data
test("real data: the SVG and the PDF hold every skill name", withPage({ page: realPage }, async (page, check) => {
  const names = await page.evaluate(() => [...SKILLS.map((s) => s[0]), ...GROUPS.map((g) => g[2].toUpperCase()), ...CLUSTERS.map((c) => c.name)]);
  const svg = await svgParts(page, (await download(page, "svg")).data.toString("utf8"));
  check(names.every((n) => svg.texts.includes(n)), `the SVG holds all ${names.length} names: ` + names.filter((n) => !svg.texts.includes(n)).join(", "));
  check(svg.lines === await page.locator("#map path.shared-line").count(), `the SVG holds the ${svg.lines} drawn lines`);
  const pdf = pdfParts((await download(page, "pdf")).data);
  check(names.every((n) => pdf.strings.includes(n)), `the PDF holds all ${names.length} names as text: ` + names.filter((n) => !pdf.strings.includes(n)).join(", "));
}));
test("real data: every area, rating, station and search works",withPage({ page: realPage }, async (page, check) => {
  const counts = await page.evaluate(() => ({ skills: SKILLS.length, groups: GROUPS.length, areas: CLUSTERS.length, nodes: document.querySelectorAll("#map g.node").length }));
  check(counts.nodes === counts.skills + counts.groups + counts.areas, `${counts.nodes} nodes for ${counts.skills} skills, ${counts.groups} categories, ${counts.areas} areas`);
  check((await h.h2(page)) === `${counts.skills} Kenntnisse in ${counts.areas} Bereichen`, "overview headline");
  const legend = await page.locator("#panel .legend button").allInnerTexts();
  const ratingTotal = legend.reduce((t, s) => t + Number(s.trim().split(/\s+/).pop()), 0);
  check(ratingTotal === counts.skills, "rating counts add up to all skills");
  for (let i = 0; i < legend.length; i++) {
    const want = Number(legend[i].trim().split(/\s+/).pop());
    await page.locator("#panel .legend button").nth(i).click(); await page.waitForTimeout(60);
    const got = (await h.chips(page)).length;
    check(got === want, `rating "${legend[i].split("\n")[0].trim()}": ${got} of ${want} skills`);
    await h.click(page, "#panel .back");
  }
  const chips = await page.locator("#areas .chip").count();
  for (let i = 0; i < chips; i++) {
    const chip = page.locator("#areas .chip").nth(i), id = (await chip.getAttribute("data-id")).slice(2);
    await chip.click(); await page.waitForTimeout(60);
    const want = await page.evaluate((c) => [...document.querySelectorAll("#map g.node")].filter((g) => g.__data__.cluster === c).length, id);
    check((await h.onIds(page)).length === want && (await h.pressed(page, `#areas .chip[data-id="c:${id}"]`)) === "true", `area ${id}: focus on its ${want} nodes`);
    const first = page.locator("#panel .chip").first(), label = (await first.innerText()).trim();
    await first.click(); await page.waitForTimeout(60);
    check((await h.h2(page)) === label && (await h.h3s(page)).includes("Eingesetzt bei"), `area ${id}: its first skill ${label} opens its panel`);
    await h.click(page, "#panel .back");
  }
  const stations = await page.locator("#panel .chips .chip").allInnerTexts();
  for (const name of stations) {
    await page.locator("#panel .chips .chip", { hasText: name }).first().click(); await page.waitForTimeout(60);
    check((await h.h2(page)) === name.trim(), `station ${name.trim()} opens`);
    await h.click(page, "#panel .back");
  }
  await h.search(page, "python");
  check(/^\d+ Treffer für „python“$/.test(await h.h2(page)) && (await h.classed(page, "match")).length >= 1, "search finds Python");
  await page.setViewportSize({ width: 400, height: 800 }); await page.waitForTimeout(150);
  check((await page.evaluate(() => document.documentElement.scrollWidth)) <= 400, "no sideways scroll at 400 px");
}));

run(tests, { only: process.argv.slice(2) }).then((ok) => { process.exitCode = ok ? 0 : 1; });

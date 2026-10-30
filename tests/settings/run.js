// Tests every setting of the force menu of the editor page on small test data with fixed start points.
// Each case loads a scenario through "Werte laden", moves one control to a second value through the menu,
// and measures what the setting promises. Screenshots on a grid go to tests/settings/out/report.html.
// Usage: node tests/settings/run.js [key ...]   (no key: all cases)
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const { TestSite, openPage, pageOf, withInit, LAYOUT } = require("../e2e/site");
const here = __dirname, out = path.join(here, "out"), shots = path.join(out, "shots");
// The map page of the site build on the test data, served from tests/settings/out/site. Its configurations pick none for
// readers, so the page starts with the values of layout.js, and every case loads PINNED. The ageing counts from a fixed
// day, so the cases do not change with the calendar.
fs.mkdirSync(out, { recursive: true });
const site = new TestSite(path.join(out, "site"));
const springsPage = withInit(pageOf(path.join(here, "fixture.js"), path.join(here, "fixture.projects.json"), path.join(here, "fixture.configs.json")),
  "window.EXPERIENCE_NOW_OVERRIDE = 2026.75;");
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });

// The defaults of layout.js at commit a8d3317, before his values of 2026-10-17 became the defaults. Every case pins
// all of them, so a new default in layout.js changes no scenario. A new setting of the menu needs its value here.
const PINNED = { fixed: false, seed: 4, ball: 1, areaCharge: 160, likeArea: 0.5, hold: 6.4, room: 10, roomEdge: false,
  categoryPull: 0.05, categoryRest: 60, groupCharge: 60, likeGroup: 1, likeGroupCross: 1, separation: 1, clusterGap: 2, reachCap: 40,
  standardSkills: true, skillHold: 1, skillRest: 10, skillRestLabel: 0.2, cohesion: 0.05, skillCharge: 30, likeSkill: 4, likeSkillCross: 4, pull: 0.05, rest: 20,
  areaScale: 1, groupScale: 1, skillScale: 1, showBridges: true, lineMode: "category", drawnBridges: 8, crossAreaOnly: true,
  bridgeColorLight: "#596763", bridgeColorDark: "#93a3a0", lineGradient: false, widthExp: 0.5, bridgeWidthMin: 0.4, bridgeWidthMax: 2.6,
  bridgeOpacityMin: 0.16, bridgeOpacityMax: 0.46, bridgeBend: 0.15, showExperience: true, experienceYears: 10, ageingStep: 3,
  ageingPerStep: 0.25, collide: 0.8, collideLabel: 0.32, ticks: 1500, friction: 0.4, range: 160, stepLabels: true, stepUntangle: true,
  lopsided: 4, clearance: 14, stepSidestep: true };
// Every case starts from this calm state: fixed areas, no charges between categories, no line springs, no repair steps.
const QUIET = { ...PINNED, fixed: true, areaCharge: 0, likeArea: 1, groupCharge: 0, likeGroup: 1, likeGroupCross: 1, separation: 0,
  skillRestLabel: 0, cohesion: 0, likeSkill: 1, likeSkillCross: 1, pull: 0, stepLabels: false, stepUntangle: false, stepSidestep: false };
// The menu of the built page: group, label and steps of each control. A line control ("look") keeps one value per mode.
// SPEC holds the keys of its texts (skills/forces.js); the cases and the report name each control by its German text,
// because the page of the cases runs in German.
const GERMAN_MENU = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "i18n", "de", "menu.json"), "utf8").split("\r").join(""));
const german = (key) => { if (!Object.hasOwn(GERMAN_MENU, key)) throw new Error("i18n/de/menu.json lacks " + key); return GERMAN_MENU[key].text; };
const spec = Object.fromEntries(JSON.parse(LAYOUT.match(/const SPEC = (\[.*?\]);\n/)[1]).flatMap((g) => g.items.map((it) => [it.key, { ...it, label: german(it.label), group: german(g.title) }])));
const LOOK = Object.keys(spec).filter((k) => spec[k].look), MODES = spec.lineMode.choice.map(([m]) => m);
// The scenario line of a case. The line values of QUIET and of the base count for all three modes, as before the
// split of the line values, so every case still starts from PINNED. A case can name its own sets in base.lines.
// With "flat", the line is an old line without "lines": its line values load into its mode, and the others take layout.js.
// With "defaults", the line names no line values, so every mode takes the values of layout.js.
function scenarioLine(c) {
  const line = { ...QUIET, ...c.base, [c.key]: c.low };
  delete line.lines;
  if (c.flat) return line;
  const shared = Object.fromEntries(LOOK.map((k) => [k, line[k]]));
  LOOK.forEach((k) => delete line[k]);
  if (c.defaults) return line;
  return { ...line, lines: Object.fromEntries(MODES.map((m) => [m, { ...shared, ...((c.base.lines || {})[m] || {}) }])) };
}
const NEAR = { sd: [-120, 0], ai: [120, 0] };
// The count of the lines: its slider, its number field, its "N von Max" text and the lines on the map.
const COUNT = "const r = document.getElementById('cfg-drawnBridges'), f = document.getElementById('cfg-drawnBridges-n'), o = document.getElementById('out-drawnBridges').textContent, n = T.lines('path.shared-line').length;";
const WIDE = [-260, -140, 260, 140], AREA_A = [-290, -90, -110, 90];

// The test data has no standard skill. For the cases of "Standard-Skills", "B2 fünf" (stations 2 and 3) is a standard
// skill since station 2, and only for these cases, so no other case changes. It is the only skill of B2 with a station
// of area A: through station 2 it shares a station with the 8 skills of A1 and the 5 skills of A2. Station 4 comes after
// station 3 in the order of PROJECTS, so with the switch on it counts there too.
const STANDARD_ON = [{ eval: "STANDARD['B2 fünf'] = { text: 'Standard in den Testdaten', since: 'P2' }; document.getElementById('cfg-run').click()" }];
const STANDARD_OFF = [{ eval: "delete STANDARD['B2 fünf']; document.getElementById('cfg-run').click()" }];
const STANDARD_LINES = "(() => { const l = T.lines('path.shared-line'), own = l.filter((p) => p.__data__.source.id === 's:B2 fünf' || p.__data__.target.id === 's:B2 fünf').length;"
  + " return own + ' Linien an „B2 fünf“, ' + l.length + ' gezeichnet, gesamt ' + springLineTotal(); })()";
// The switch, the setting in the page, the stored state and the line of "Werte kopieren": one value for all modes, and
// the old key "standardLinks" is in neither.
const STANDARD_STATE = "(() => { const v = JSON.parse(document.getElementById('spring-values').value), stored = JSON.parse(localStorage.getItem('skill-springs'));"
  + " return 'Schalter ' + (document.getElementById('cfg-standardSkills').checked ? 'an' : 'aus') + ', STANDARD_SKILLS ' + STANDARD_SKILLS + ', Zeile ' + v.standardSkills"
  + " + ', gespeichert ' + stored.standardSkills + ', in lines ' + (Object.values(v.lines).some((set) => 'standardSkills' in set) ? 'ja' : 'nein')"
  + " + ', Schema ' + v.schema + ', alter Schlüssel ' + ('standardLinks' in v || 'standardLinks' in stored ? 'ja' : 'nein'); })()";
// Station 4, the time range filter with station 4 active, and the panel after a click on "B2 fünf".
const STANDARD_VIEWS = "(() => { const n = T.skill('B2 fünf'); T.dom('s:B2 fünf').g.dispatchEvent(new MouseEvent('click', { bubbles: true }));"
  + " const badge = document.querySelector('#panel .badge'), list = [...document.querySelectorAll('#panel ul.list')][0];"
  + " return 'Station 4 ' + (standardAt(n, 'P4') ? 'ja' : 'nein') + ', Zeitraum Station 4 ' + (inTime(n, new Set(['P4']), new Set()) ? 'ja' : 'nein')"
  + " + ', Panel ' + (badge ? badge.textContent : list ? [...list.querySelectorAll('button')].map((b) => b.textContent).join(' und ') : 'leer'); })()";
const STANDARD_TIP = "Standard-Skills | An: Ein Standard-Skill gilt ab seiner Station „Standard seit“ für jede Station, auch im Zeitraumfilter. Er bekommt keine Linien und keine Federn, und das Panel zeigt seinen Hinweis. Aus: Standard-Skills zählen nur an ihren eigenen Stationen, wie jeder andere Skill.";
// 1 when the switch is the first control of the group "Skills".
const STANDARD_FIRST = "(() => { const d = [...document.querySelectorAll('#cfg-groups details')].find((x) => x.querySelector('summary').textContent === 'Skills'); return d.querySelector('.cfg-row').id === 'row-standardSkills' ? 1 : 0; })()";

// Measures run in the page. T holds the helpers, see installHelpers.
const catArea = "T.mean(T.cats().map((g) => T.dist(g, T.area(g.cluster))))";
const cases = [
  // Bereiche
  { key: "fixed", low: false, high: true, base: { fixed: false, likeArea: 8, areaCharge: 640, seed: 0.25, at: { sd: [-80, 0], ai: [80, 0] } }, view: WIDE,
    scenario: "Zwei Bereiche starten dicht beieinander und stoßen sich stark ab. Fest auf den Startpunkten müssen sie genau dort bleiben.",
    measure: "T.mean(T.areas().map((a) => T.dist(a, T.seed(a.cluster))))", unit: "Abstand Bereich–Startpunkt", expect: "zero" },
  { key: "seed", low: 0.25, high: 8, base: { fixed: false, likeArea: 8, areaCharge: 640, at: { sd: [-80, 0], ai: [80, 0] } }, view: WIDE,
    scenario: "Wie oben, die Bereiche sind frei. Mehr Zug zum Startpunkt hält sie näher an ihren Ringen.",
    measure: "T.mean(T.areas().map((a) => T.dist(a, T.seed(a.cluster))))", unit: "Abstand Bereich–Startpunkt", expect: "smaller" },
  { key: "ball", low: 0, high: 1, base: {}, view: AREA_A,
    scenario: "Die Kugel hält Platz für den Bereichsnamen frei. Mit voller Kugel liegen die Kategorien weiter vom Bereichszentrum.",
    measure: catArea, unit: "Abstand Kategorie–Bereich", expect: "larger" },
  { key: "areaCharge", low: 0, high: 640, base: { hold: 0.4 }, view: AREA_A,
    scenario: "Die Ladung des Bereichszentrums drückt seine Kategorien gegen eine weiche Feder nach außen.",
    measure: catArea, unit: "Abstand Kategorie–Bereich", expect: "larger" },
  { key: "likeArea", low: 0, high: 8, base: { fixed: false, seed: 0.25, areaCharge: 160, at: { sd: [-80, 0], ai: [80, 0] } }, view: WIDE,
    scenario: "Zwei freie Bereiche starten dicht beieinander. Mehr Abstoßung zwischen Bereichen treibt sie auseinander.",
    measure: "T.dist(T.area('sd'), T.area('ai'))", unit: "Abstand Bereich A–Bereich B", expect: "larger" },
  // Kategorien
  { key: "hold", low: 0.1, high: 51.2, base: { areaCharge: 640 }, view: AREA_A,
    scenario: "Die Ladung des Bereichs drückt die Kategorien nach außen. Eine stärkere Feder hält sie näher an ihrer Ruhelänge.",
    measure: "T.mean(T.cats().map((g) => Math.abs(T.dist(g, T.area(g.cluster)) - ballOf(T.area(g.cluster)) - AREA_ROOM)))", unit: "Abweichung von der Ruhelänge", expect: "smaller" },
  { key: "room", low: 0, high: 60, base: {}, view: AREA_A,
    scenario: "Die Ruhelänge der Feder Bereich–Kategorie wächst, die Kategorien rücken nach außen.",
    measure: catArea, unit: "Abstand Kategorie–Bereich", expect: "larger" },
  { key: "roomEdge", low: false, high: true, base: { skillRest: 20 }, view: AREA_A,
    scenario: "Zählt die Ruhelänge bis zum Wolkenrand, kommt der Wolkenradius dazu.",
    measure: catArea, unit: "Abstand Kategorie–Bereich", expect: "larger" },
  { key: "categoryPull", low: 0, high: 0.8, base: { skillCharge: 0, groupCharge: 60, categoryRest: 0, hold: 0.4 }, view: AREA_A,
    scenario: "A1 und A2 teilen eine Station. Ihre Ladung drückt sie auseinander, die Feder zwischen ihnen zieht sie zusammen. Die Skills sind ohne Ladung, und die Feder zum Bereich ist weich, sonst hält sie die Kategorien auf einem Ring fest.",
    measure: "T.dist(T.hub('sd-a1'), T.hub('sd-a2'))", unit: "Abstand A1–A2", expect: "smaller" },
  { key: "categoryRest", low: 0, high: 160, base: { categoryPull: 0.8, skillCharge: 0 }, view: AREA_A,
    scenario: "Mit starker Feder zwischen A1 und A2 bestimmt ihre Ruhelänge den Abstand.",
    measure: "T.dist(T.hub('sd-a1'), T.hub('sd-a2'))", unit: "Abstand A1–A2", expect: "larger" },
  { key: "groupCharge", low: 0, high: 480, base: { skillCharge: 0 }, view: AREA_A,
    scenario: "Die Ladung der Kategorien drückt die Kategorien eines Bereichs auseinander.",
    measure: "T.dist(T.hub('sd-a1'), T.hub('sd-a2'))", unit: "Abstand A1–A2", expect: "larger" },
  { key: "likeGroup", low: 0, high: 16, base: { groupCharge: 60, skillCharge: 0, hold: 0.4 }, view: AREA_A,
    scenario: "Abstoßung zwischen Kategorien desselben Bereichs, mit weicher Feder zum Bereich. Der Abstand von A1 zu B1 in einem anderen Bereich dient als Gegenprobe.",
    measure: "T.dist(T.hub('sd-a1'), T.hub('sd-a2'))", unit: "Abstand A1–A2", expect: "larger",
    control: "T.dist(T.hub('sd-a1'), T.hub('ai-b1'))", controlUnit: "Abstand A1–B1" },
  { key: "likeGroupCross", low: 0, high: 16, base: { groupCharge: 60, skillCharge: 0, hold: 0.4, at: NEAR }, view: WIDE,
    scenario: "Die Bereiche liegen nah, damit sich ihre Kategorien erreichen, und die Feder zum Bereich ist weich. Abstoßung zwischen Kategorien verschiedener Bereiche. Gegenprobe: A1–A2 im selben Bereich.",
    measure: "T.mean(T.cats().map((g) => T.nearest(g, T.cats().filter((o) => o.cluster !== g.cluster))))", unit: "nächste fremde Kategorie", expect: "larger",
    control: "T.dist(T.hub('sd-a1'), T.hub('sd-a2'))", controlUnit: "Abstand A1–A2" },
  { key: "separation", low: 0, high: 8, base: { categoryPull: 0.8, categoryRest: 0, skillRest: 20, skillCharge: 0 }, view: AREA_A,
    scenario: "Eine starke Feder ohne Ruhelänge zieht A1 und A2 ineinander. Die Trennung schiebt überlappende Wolken auseinander.",
    measure: "T.dist(T.hub('sd-a1'), T.hub('sd-a2'))", unit: "Abstand A1–A2", expect: "larger" },
  { key: "clusterGap", low: 0, high: 40, base: { categoryPull: 0.8, categoryRest: 0, skillRest: 20, skillCharge: 0, separation: 4 }, view: AREA_A,
    scenario: "Wie oben mit Trennung. Ein größerer Mindestabstand hält die Wolken weiter auseinander.",
    measure: "T.dist(T.hub('sd-a1'), T.hub('sd-a2'))", unit: "Abstand A1–A2", expect: "larger" },
  { key: "reachCap", low: 20, high: 1000, base: { categoryPull: 0.8, categoryRest: 0, skillRest: 40, skillCharge: 0, separation: 4 }, view: AREA_A,
    scenario: "Große Wolken (Ruhelänge 40). Mit kleiner Grenze zählt die Trennung nur 20 Einheiten Reichweite und trennt zu wenig.",
    measure: "T.dist(T.hub('sd-a1'), T.hub('sd-a2'))", unit: "Abstand A1–A2", expect: "larger" },
  // Skills
  { key: "standardSkills", low: true, high: false, base: { lineMode: "skill", drawnBridges: 1000 }, view: WIDE, prep: STANDARD_ON, after: STANDARD_OFF,
    scenario: "„B2 fünf“ ist hier ein Standard-Skill. An zählt er für keine Linie: 98 Skill-Paare verschiedener Bereiche. Aus ist er ein normaler Skill und zählt über seine Stationen: 13 Linien zu den Skills von A1 und A2 über Station 2, zusammen 111.",
    measure: STANDARD_LINES, unit: "Linien des Standard-Skills und aller Skills", expect: "text",
    lowText: "0 Linien an „B2 fünf“, 98 gezeichnet, gesamt 98", text: "13 Linien an „B2 fünf“, 111 gezeichnet, gesamt 111" },
  { key: "standardSkills", low: true, high: false, base: { pull: 1.6, drawnBridges: 0, at: { sd: [-300, 0], ai: [300, 0] } }, view: WIDE, prep: STANDARD_ON, after: STANDARD_OFF,
    scenario: "„B2 fünf“ ist hier ein Standard-Skill und die einzige Verbindung von B2 zu Bereich A. An zieht keine Feder an B2. Aus ziehen die Federn A1–B2 und A2–B2 die Wolke B2 zu Bereich A. Keine Linie ist gezeichnet.",
    measure: "T.dist(T.hub('ai-b2'), T.area('sd'))", unit: "Abstand B2–Bereich A", expect: "smaller",
    control: "T.dist(T.hub('ai-b1'), T.area('sd'))", controlUnit: "Abstand B1–Bereich A" },
  { key: "standardSkills", low: true, high: false, base: {}, view: WIDE, prep: STANDARD_ON, after: STANDARD_OFF,
    scenario: "„B2 fünf“ ist hier ein Standard-Skill seit Station 2. An zählt er für jede Station ab Station 2, also auch für Station 4 und im Zeitraumfilter mit Station 4, und das Panel zeigt seinen Hinweis. Aus zählt er nur an seinen Stationen 2 und 3, und das Panel listet sie.",
    measure: STANDARD_VIEWS, unit: "Station 4, Zeitraum, Panel", expect: "text",
    lowText: "Station 4 ja, Zeitraum Station 4 ja, Panel Standard in den Testdaten", text: "Station 4 nein, Zeitraum Station 4 nein, Panel Station 3 und Station 2" },
  { key: "standardSkills", low: true, high: false, base: {}, view: WIDE,
    scenario: "Der Schalter heißt „Standard-Skills“ und ist der erste Regler der Gruppe „Skills“. Ein Tooltip auf der Zeile erklärt An und Aus. Name und Tooltip bleiben beim Umschalten.",
    measure: "T.rowText('standardSkills')", unit: "Name | Tooltip", expect: "text", lowText: STANDARD_TIP, text: STANDARD_TIP,
    control: STANDARD_FIRST, controlUnit: "erster Regler der Gruppe Skills (1 = ja)", controlRatio: 1 },
  { key: "standardSkills", low: false, high: "Zeile ohne den Wert", label: "Standard-Skills: Zeile ohne den Wert", change: "aus → eine Zeile mit Schema 4 ohne „standardSkills“ laden",
    base: {}, view: WIDE, steps: [{ eval: "document.getElementById('spring-values').value = '{\"schema\":4,\"ticks\":300}'; document.getElementById('spring-load').click()" }],
    scenario: "Der Wert gilt für alle Modi, er steht oben in der Zeile und nicht unter „lines“. Eine Zeile ohne ihn lädt ihn an, wie in layout.js. Der alte Schlüssel „standardLinks“ steht weder in der Zeile noch im gespeicherten Stand.",
    measure: STANDARD_STATE, unit: "Schalter, Wert, Zeile, gespeichert", expect: "text",
    lowText: "Schalter aus, STANDARD_SKILLS false, Zeile false, gespeichert false, in lines nein, Schema 4, alter Schlüssel nein",
    text: "Schalter an, STANDARD_SKILLS true, Zeile true, gespeichert true, in lines nein, Schema 4, alter Schlüssel nein" },
  { key: "standardSkills", low: false, high: "Werte aus layout.js", label: "Standard-Skills: Werte aus layout.js", change: "aus → Werte aus layout.js",
    base: {}, view: WIDE, steps: [{ click: "spring-reset" }],
    scenario: "„Werte aus layout.js“ schaltet „Standard-Skills“ an, denn das ist der Standard.",
    measure: STANDARD_STATE, unit: "Schalter, Wert, Zeile, gespeichert", expect: "text",
    lowText: "Schalter aus, STANDARD_SKILLS false, Zeile false, gespeichert false, in lines nein, Schema 4, alter Schlüssel nein",
    text: "Schalter an, STANDARD_SKILLS true, Zeile true, gespeichert true, in lines nein, Schema 4, alter Schlüssel nein" },
  { key: "skillHold", low: 0.25, high: 32, base: { skillCharge: 120, likeSkill: 4 }, view: AREA_A,
    scenario: "Starke Ladung drückt die Skills nach außen. Eine stärkere Feder hält sie näher an ihrer Ruhelänge.",
    measure: "T.mean(T.skills().map((s) => Math.abs(T.dist(s, T.hub(s.group)) - SKILL_REST - s.lw * SKILL_REST_LABEL)))", unit: "Abweichung von der Ruhelänge", expect: "smaller" },
  { key: "skillRest", low: 0, high: 40, base: {}, view: AREA_A,
    scenario: "Die Ruhelänge der Feder Skill–Kategorie wächst, die Wolken werden größer.",
    measure: "T.mean(T.skills().map((s) => T.dist(s, T.hub(s.group))))", unit: "Abstand Skill–Kategorie", expect: "larger" },
  { key: "skillRestLabel", low: 0, high: 0.8, base: {}, view: AREA_A,
    scenario: "Lange Namen bekommen eine längere Feder. Gemessen: Abstand der zwei langen Namen in A1 minus Abstand der kurzen (Go, Zig, Elm).",
    measure: "T.mean(['Ein sehr langer Skillname', 'Noch ein langer Skillname'].map((l) => T.dist(T.skill(l), T.hub('sd-a1')))) - T.mean(['Go', 'Zig', 'Elm'].map((l) => T.dist(T.skill(l), T.hub('sd-a1'))))",
    unit: "lang minus kurz", expect: "larger" },
  { key: "cohesion", low: 0, high: 0.4, base: { skillCharge: 120, skillHold: 0.25 }, view: AREA_A,
    scenario: "Starke Ladung drückt die Skills gegen eine weiche Feder nach außen. Der Zug zur Mitte holt sie zur Kategorie zurück.",
    measure: "T.mean(T.skills().map((s) => T.dist(s, T.hub(s.group))))", unit: "Abstand Skill–Kategorie", expect: "smaller" },
  { key: "skillCharge", low: 0, high: 120, base: {}, view: AREA_A,
    scenario: "Die Ladung der Skills drückt die Skills auseinander.",
    measure: "T.mean(T.skills().map((s) => T.nearest(s, T.skills())))", unit: "nächster Skill", expect: "larger" },
  { key: "likeSkill", low: 0, high: 8, base: {}, view: AREA_A,
    scenario: "Abstoßung zwischen Skills desselben Bereichs. Gegenprobe: nächster Skill im anderen Bereich, die Bereiche sind weit weg.",
    measure: "T.mean(T.skills().map((s) => T.nearest(s, T.skills().filter((o) => o.cluster === s.cluster))))", unit: "nächster Skill im Bereich", expect: "larger" },
  { key: "likeSkillCross", low: 0, high: 8, base: { at: NEAR }, view: WIDE,
    scenario: "Die Bereiche liegen nah. Abstoßung zwischen Skills verschiedener Bereiche. Gegenprobe: nächster Skill im eigenen Bereich.",
    measure: "T.mean(T.skills().map((s) => T.nearest(s, T.skills().filter((o) => o.cluster !== s.cluster))))", unit: "nächster fremder Skill", expect: "larger",
    control: "T.mean(T.skills().map((s) => T.nearest(s, T.skills().filter((o) => o.cluster === s.cluster))))", controlUnit: "nächster Skill im Bereich" },
  // Linien: Kräfte
  { key: "pull", low: 0, high: 1.6, base: { drawnBridges: 0, at: { sd: [-300, 0], ai: [300, 0] } }, view: WIDE,
    scenario: "Die stärkste Verbindung führt von A1 zu B1. Keine Linie ist gezeichnet, trotzdem zieht ihre Feder beide Wolken zueinander.",
    measure: "T.dist(T.hub('sd-a1'), T.hub('ai-b1'))", unit: "Abstand A1–B1", expect: "smaller" },
  { key: "rest", low: 0, high: 150, base: { pull: 1.6, at: { sd: [-300, 0], ai: [300, 0] } }, view: WIDE,
    scenario: "Mit starker Linienfeder bestimmt ihre Ruhelänge, wie nah A1 und B1 kommen.",
    measure: "T.dist(T.hub('sd-a1'), T.hub('ai-b1'))", unit: "Abstand A1–B1", expect: "larger" },
  // Größe
  { key: "areaScale", low: 0.5, high: 2, base: {}, view: AREA_A, fixedView: true,
    scenario: "Bereiche von 50 % auf 200 %: Punkt und Schrift werden viermal so groß, bei gleichem Zoom.",
    measure: "+T.dom('c:sd').dot.getAttribute('r')", unit: "Radius Bereichspunkt", expect: "ratio", ratio: 4,
    control: "parseFloat(T.dom('c:sd').text.getAttribute('font-size'))", controlUnit: "Schrift Bereich", controlRatio: 4 },
  { key: "groupScale", low: 0.5, high: 2, base: {}, view: AREA_A, fixedView: true,
    scenario: "Kategorien von 50 % auf 200 %: Punkt und Schrift viermal so groß. Die Linie Bereich–Kategorie wächst mit beiden Ebenen, also doppelt so breit.",
    measure: "+T.dom('g:sd-a1').dot.getAttribute('r')", unit: "Radius Kategoriepunkt", expect: "ratio", ratio: 4,
    control: "+T.lines('path.tree').find((p) => p.__data__.kind === 'area').getAttribute('stroke-width')", controlUnit: "Breite Linie Bereich–Kategorie", controlRatio: 2 },
  { key: "skillScale", low: 0.5, high: 2, base: {}, view: AREA_A, fixedView: true,
    scenario: "Skills von 50 % auf 200 %: Schrift viermal so groß, die Linie Kategorie–Skill doppelt so breit.",
    measure: "parseFloat(T.dom('s:Go').text.getAttribute('font-size'))", unit: "Schrift Skill Go", expect: "ratio", ratio: 4,
    control: "+T.lines('path.tree').find((p) => p.__data__.kind === 'group').getAttribute('stroke-width')", controlUnit: "Breite Linie Kategorie–Skill", controlRatio: 2 },
  // Linien: Darstellung
  { key: "lineMode", low: "category", high: "skill", base: { drawnBridges: 48 }, view: WIDE,
    scenario: "Der Modus wechselt von Linien zwischen Kategorien zu Linien zwischen Skills. Gemessen: Anteil der Linien, deren beide Enden Skills sind.",
    measure: "T.endsOn('skill')", unit: "Linien zwischen Skills", expect: "equal", value: 1, lowValue: 0,
    // The control changes on purpose: it is the other side of the measure, all lines between categories before and none after.
    control: "T.endsOn('group')", controlUnit: "Linien zwischen Kategorien (Gegenprobe)", controlValues: [1, 0] },
  { key: "lineMode", low: "category", high: "skill", base: { pull: 1.6 }, view: WIDE,
    scenario: "Der Modus ändert keine Kraft: mit starker Linienfeder bleibt jeder Knoten, wo er war.",
    measure: "T.N().reduce((t, n) => t + n.x * 1.3 + n.y * 0.7, 0)", unit: "Prüfsumme aller Knotenpositionen", expect: "same" },
  { key: "drawnBridges", low: 0, high: 4, base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: 5 Kategorienpaare verschiedener Bereiche teilen Stationen. Die Karte zeigt genau die eingestellte Zahl.",
    measure: "T.lines('path.shared-line').length", unit: "Linien", expect: "count", lowCount: 0, highCount: 4 },
  { key: "drawnBridges", low: 24, high: 48, base: { lineMode: "skill" }, view: WIDE,
    scenario: "Skill-Skill: über 100 Skill-Paare verschiedener Bereiche, viele gleich stark. Die Karte zeigt genau die eingestellte Zahl.",
    measure: "T.lines('path.shared-line').length", unit: "Linien", expect: "count", lowCount: 24, highCount: 48 },
  { key: "drawnBridges", low: 24, high: 48, base: { lineMode: "skill" }, view: WIDE,
    scenario: "Skill-Skill: gezeichnet werden die Paare mit den meisten gemeinsamen Stationen. Keine fehlende Linie hat mehr Stationen als eine gezeichnete. Die 8 Paare von A1 mit „B3 eins“ teilen 2 Stationen, alle anderen 1.",
    measure: "T.strongestFirst()", unit: "stärkste zuerst (1 = ja)", expect: "equal", value: 1, lowValue: 1,
    control: "T.lines('path.shared-line').filter((p) => p.__data__.strength === 2).length", controlUnit: "gezeichnete Paare mit 2 Stationen", controlRatio: 1 },
  { key: "drawnBridges", low: 0, high: 48, base: { pull: 1.6 }, view: WIDE,
    scenario: "Die Zahl der gezeichneten Linien ändert keine Kraft: mit starker Linienfeder bleibt jeder Knoten, wo er war.",
    measure: "T.N().reduce((t, n) => t + n.x * 1.3 + n.y * 0.7, 0)", unit: "Prüfsumme aller Knotenpositionen", expect: "same" },
  { key: "drawnBridges", low: 0, high: 5, via: "slider", base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: der Regler endet bei der Gesamtzahl der Linien, hier 5, und erreicht sie. Zahlenfeld, Anzeige „alle (5)“ und Karte stimmen überein.",
    measure: `(() => { ${COUNT} return +r.max === 5 && springLineTotal() === 5 && n === 5 && +f.value === 5 && o === "alle (5)" ? 1 : 0; })()`, unit: "Regler am Ende, alles gleich (1 = ja)", expect: "equal", value: 1, lowValue: 0 },
  { key: "drawnBridges", low: 0, high: 111, via: "slider", base: { lineMode: "skill" }, view: WIDE,
    scenario: "Skill-Skill: der Regler endet bei 111, der Zahl aller Skill-Paare verschiedener Bereiche, und erreicht sie.",
    measure: `(() => { ${COUNT} return +r.max === 111 && springLineTotal() === 111 && n === 111 && +f.value === 111 && o === "alle (111)" ? 1 : 0; })()`, unit: "Regler am Ende, alles gleich (1 = ja)", expect: "equal", value: 1, lowValue: 0 },
  { key: "drawnBridges", low: 5, high: 100000, base: {}, view: WIDE,
    scenario: "Ein Wert über der Gesamtzahl zeigt alle 5 Linien, die Anzeige sagt „alle (5)“, und der Wert bleibt im Zahlenfeld stehen. Der Regler steht am Ende.",
    measure: `(() => { ${COUNT} return n === 5 && +r.value === 5 && +f.value === 100000 && o === "alle (5)" ? 1 : 0; })()`, unit: "alle Linien, Wert bleibt (1 = ja)", expect: "equal", value: 1, lowValue: 0 },
  { key: "drawnBridges", low: 4, high: 100000, base: { lineMode: "skill", crossAreaOnly: false }, view: WIDE,
    scenario: "Skill-Skill, auch im selben Bereich: ein Wert über der Gesamtzahl zeigt alle Linien dieses Modus, die Anzeige sagt „alle (N)“ mit N gleich der Gesamtzahl.",
    measure: `(() => { ${COUNT} const t = springLineTotal(); return t > 111 && n === t && +r.value === t && +f.value === 100000 && o === "alle (" + t + ")" ? 1 : 0; })()`, unit: "alle Linien, Wert bleibt (1 = ja)", expect: "equal", value: 1, lowValue: 0 },
  { key: "drawnBridges", low: 8, high: 1000, base: { lineMode: "skill" }, view: WIDE,
    scenario: "Unter der Anzahl steht der Hinweis, dass mehr als etwa 1000 Linien die Karte langsam machen können. 1000 liegt über den 111 Skill-Paaren der Testdaten, also zeigt die Karte alle.",
    measure: `(() => { ${COUNT} const h = document.querySelector("#row-drawnBridges .cfg-hint"); return n === 111 && o === "alle (111)" && !!h && h.textContent === "Mehr als etwa 1000 Linien können die Karte langsam machen." ? 1 : 0; })()`, unit: "alle Linien, Hinweis da (1 = ja)", expect: "equal", value: 1, lowValue: 0 },
  { key: "drawnBridges", low: 0, high: 37, base: { lineMode: "skill" }, view: WIDE,
    scenario: "Eine Zahl im Zahlenfeld stellt den Regler auf dieselbe Stelle, und die Karte zeigt genau so viele Linien.",
    measure: `(() => { ${COUNT} return +r.value === 37 && +f.value === 37 && n === 37 && o === "37 von 111" ? 1 : 0; })()`, unit: "Zahlenfeld, Regler und Karte gleich (1 = ja)", expect: "equal", value: 1, lowValue: 0 },
  { key: "crossAreaOnly", low: true, high: false, base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: ohne „Linien im eigenen Bereich ausblenden“ kommen die 3 Paare innerhalb eines Bereichs dazu: A1–A2, B1–B3 und B2–B3.",
    measure: "T.lines('path.shared-line').filter((p) => p.__data__.source.cluster === p.__data__.target.cluster).length", unit: "Linien im selben Bereich", expect: "count", lowCount: 0, highCount: 3 },
  { key: "crossAreaOnly", low: true, high: false, base: {}, view: WIDE,
    scenario: "Der Schalter heißt „Linien im eigenen Bereich ausblenden“. An heißt wie bisher: nur Linien zwischen Bereichen. Ein Tooltip auf der Zeile erklärt ihn. Name und Tooltip bleiben beim Umschalten.",
    measure: "T.rowText('crossAreaOnly')", unit: "Name | Tooltip", expect: "text",
    lowText: "Linien im eigenen Bereich ausblenden | Linien innerhalb des eigenen Bereichs werden weggelassen. Die Federn ändert das nicht.",
    text: "Linien im eigenen Bereich ausblenden | Linien innerhalb des eigenen Bereichs werden weggelassen. Die Federn ändert das nicht." },
  { key: "crossAreaOnly", low: true, high: false, base: { lineMode: "skill", drawnBridges: 1000 }, view: WIDE,
    scenario: "Skill-Skill: ohne „Linien im eigenen Bereich ausblenden“ kommen Linien zwischen Skills desselben Bereichs dazu, zum Beispiel A1–A2 über Station 2.",
    measure: "T.lines('path.shared-line').filter((p) => p.__data__.source.cluster === p.__data__.target.cluster).length", unit: "Linien im selben Bereich", expect: "larger", lowCount: 0 },
  { key: "showBridges", low: true, high: false, base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: Linien aus.",
    measure: "T.lines('path.shared-line').length", unit: "Linien", expect: "count", lowCount: 5, highCount: 0 },
  { key: "showBridges", low: true, high: false, base: { lineMode: "skill", drawnBridges: 48 }, view: WIDE,
    scenario: "Skill-Skill: Linien aus.",
    measure: "T.lines('path.shared-line').length", unit: "Linien", expect: "count", lowCount: 48, highCount: 0 },
  { key: "showBridges", low: true, high: false, base: {}, view: WIDE,
    scenario: "Ohne Linien wirken ihre 12 Regler nicht, dazu kommt das Zahlenfeld der Anzahl. Alle 13 Bedienelemente sind dann gesperrt und ausgegraut.",
    measure: "T.disabledControls()", unit: "gesperrte Bedienelemente", expect: "count", lowCount: 0, highCount: 13 },
  { key: "bridgeColorLight", low: "#596763", high: "#ff0000", base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: im hellen Modus nehmen alle Linien die neue Farbe an.",
    measure: "T.share('path.shared-line', (cs) => cs.stroke === 'rgb(255, 0, 0)')", unit: "Anteil roter Linien", expect: "equal", value: 1 },
  { key: "bridgeColorDark", low: "#93a3a0", high: "#ff0000", base: {}, view: WIDE, theme: "dark",
    scenario: "Kategorie-Kategorie: im dunklen Modus nehmen alle Linien die neue Farbe an.",
    measure: "T.share('path.shared-line', (cs) => cs.stroke === 'rgb(255, 0, 0)')", unit: "Anteil roter Linien", expect: "equal", value: 1 },
  { key: "widthExp", low: 0.25, high: 1, base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: ein höherer Exponent macht schwache Linien im Verhältnis dünner.",
    measure: "T.weakest('path.shared-line', 'stroke-width')", unit: "Breite der schwächsten Linie", expect: "smaller" },
  { key: "bridgeWidthMin", low: 0.1, high: 3, base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: die schwächste Linie wird breiter. Die stärkste behält ihre Breite (Gegenprobe).",
    measure: "T.weakest('path.shared-line', 'stroke-width')", unit: "Breite der schwächsten Linie", expect: "larger",
    control: "T.strongest('path.shared-line', 'stroke-width')", controlUnit: "Breite der stärksten Linie", controlRatio: 1 },
  { key: "bridgeWidthMax", low: 0.5, high: 10, base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: die stärkste Linie bekommt genau die eingestellte Breite.",
    measure: "T.strongest('path.shared-line', 'stroke-width')", unit: "Breite der stärksten Linie", expect: "equal", value: 10 },
  { key: "bridgeOpacityMin", low: 0.05, high: 1, base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: die schwächste Linie wird deckender.",
    measure: "T.weakest('path.shared-line', 'stroke-opacity')", unit: "Deckkraft der schwächsten Linie", expect: "larger" },
  { key: "bridgeOpacityMax", low: 0.25, high: 1, base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: die stärkste Linie bekommt genau die eingestellte Deckkraft.",
    measure: "T.strongest('path.shared-line', 'stroke-opacity')", unit: "Deckkraft der stärksten Linie", expect: "equal", value: 1 },
  { key: "bridgeBend", low: -0.35, high: 0.5, base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: die Krümmung ist der seitliche Versatz des Kontrollpunkts im Verhältnis zur Länge. Negativ biegt zur anderen Seite.",
    measure: "T.bend(T.lines('path.shared-line')[0])", unit: "Versatz / Länge", expect: "equal", value: 0.5, lowValue: -0.35 },
  { key: "bridgeColorLight", low: "#596763", high: "#ff0000", base: { lineMode: "skill", drawnBridges: 48 }, view: WIDE,
    scenario: "Skill-Skill: im hellen Modus nehmen alle Linien die neue Farbe an.",
    measure: "T.share('path.shared-line', (cs) => cs.stroke === 'rgb(255, 0, 0)')", unit: "Anteil roter Linien", expect: "equal", value: 1 },
  { key: "bridgeColorDark", low: "#93a3a0", high: "#ff0000", base: { lineMode: "skill", drawnBridges: 48 }, view: WIDE, theme: "dark",
    scenario: "Skill-Skill: im dunklen Modus nehmen alle Linien die neue Farbe an.",
    measure: "T.share('path.shared-line', (cs) => cs.stroke === 'rgb(255, 0, 0)')", unit: "Anteil roter Linien", expect: "equal", value: 1 },
  { key: "widthExp", low: 0.25, high: 1, base: { lineMode: "skill", drawnBridges: 48 }, view: WIDE,
    scenario: "Skill-Skill: ein höherer Exponent macht schwache Linien im Verhältnis dünner.",
    measure: "T.weakest('path.shared-line', 'stroke-width')", unit: "Breite der schwächsten Linie", expect: "smaller" },
  { key: "bridgeWidthMin", low: 0.1, high: 3, base: { lineMode: "skill", drawnBridges: 48 }, view: WIDE,
    scenario: "Skill-Skill: die schwächste Linie wird breiter. Die stärkste behält ihre Breite (Gegenprobe).",
    measure: "T.weakest('path.shared-line', 'stroke-width')", unit: "Breite der schwächsten Linie", expect: "larger",
    control: "T.strongest('path.shared-line', 'stroke-width')", controlUnit: "Breite der stärksten Linie", controlRatio: 1 },
  { key: "bridgeWidthMax", low: 0.5, high: 10, base: { lineMode: "skill", drawnBridges: 48 }, view: WIDE,
    scenario: "Skill-Skill: die stärkste Linie bekommt genau die eingestellte Breite.",
    measure: "T.strongest('path.shared-line', 'stroke-width')", unit: "Breite der stärksten Linie", expect: "equal", value: 10 },
  { key: "bridgeOpacityMin", low: 0.05, high: 1, base: { lineMode: "skill", drawnBridges: 48 }, view: WIDE,
    scenario: "Skill-Skill: die schwächste Linie wird deckender.",
    measure: "T.weakest('path.shared-line', 'stroke-opacity')", unit: "Deckkraft der schwächsten Linie", expect: "larger" },
  { key: "bridgeOpacityMax", low: 0.25, high: 1, base: { lineMode: "skill", drawnBridges: 48 }, view: WIDE,
    scenario: "Skill-Skill: die stärkste Linie bekommt genau die eingestellte Deckkraft.",
    measure: "T.strongest('path.shared-line', 'stroke-opacity')", unit: "Deckkraft der stärksten Linie", expect: "equal", value: 1 },
  { key: "bridgeBend", low: -0.35, high: 0.5, base: { lineMode: "skill", drawnBridges: 48 }, view: WIDE,
    scenario: "Skill-Skill: die Krümmung ist der seitliche Versatz des Kontrollpunkts im Verhältnis zur Länge. Negativ biegt zur anderen Seite.",
    measure: "T.bend(T.lines('path.shared-line')[0])", unit: "Versatz / Länge", expect: "equal", value: 0.5, lowValue: -0.35 },
  // Skill-Kategorie: one line from a skill to each other category it shares stations with, in the area color of the skill.
  { key: "lineMode", low: "category", high: "mixed", base: { drawnBridges: 1000 }, view: WIDE,
    scenario: "Der Modus wechselt zu Skill-Kategorie. Jede Linie beginnt genau auf einem Skill und endet genau auf dem Zentrum einer anderen Kategorie. Gegenprobe: Zahl der Linien, 5 Kategorienpaare vorher, 49 Linien von Skills zu Kategorien danach.",
    measure: "T.mixedEnds()", unit: "Linien von Skill zu Kategoriezentrum", expect: "equal", value: 1, lowValue: 0,
    // The control changes on purpose: the mode draws other lines, 5 category pairs before and 49 lines from skills after.
    control: "T.lines('path.shared-line').length", controlUnit: "Linien (Gegenprobe)", controlValues: [5, 49] },
  { key: "lineMode", low: "category", high: "mixed", base: { pull: 1.6 }, view: WIDE,
    scenario: "Skill-Kategorie ändert keine Kraft: mit starker Linienfeder bleibt jeder Knoten, wo er war.",
    measure: "T.N().reduce((t, n) => t + n.x * 1.3 + n.y * 0.7, 0)", unit: "Prüfsumme aller Knotenpositionen", expect: "same" },
  { key: "lineMode", low: "category", high: "mixed", base: { drawnBridges: 1000 }, view: WIDE,
    scenario: "Skill-Kategorie im hellen Modus: jede Linie hat die Farbe des Bereichs ihres Skills, Bereich A blau, Bereich B grün. Vorher sind alle Linien grau. Gegenprobe: dieselbe Farbe wie der Punkt des Bereichs.",
    measure: "T.strokeIs({ sd: 'rgb(44, 95, 196)', ai: 'rgb(10, 133, 115)' })", unit: "Anteil in der Farbe des Skill-Bereichs", expect: "equal", value: 1, lowValue: 0,
    // The control changes on purpose: the grey lines before take the color of the area dot after.
    control: "T.areaColored()", controlUnit: "Anteil in der Farbe des Bereichspunkts", controlValues: [0, 1] },
  { key: "lineMode", low: "category", high: "mixed", base: { drawnBridges: 1000 }, view: WIDE, theme: "dark",
    scenario: "Skill-Kategorie im dunklen Modus: jede Linie hat die helle Farbe des Bereichs ihres Skills aus dem dunklen Thema. Gegenprobe: dieselbe Farbe wie der Punkt des Bereichs.",
    measure: "T.strokeIs({ sd: 'rgb(132, 168, 242)', ai: 'rgb(69, 200, 177)' })", unit: "Anteil in der Farbe des Skill-Bereichs", expect: "equal", value: 1, lowValue: 0,
    // The control changes on purpose: the grey lines before take the color of the area dot after.
    control: "T.areaColored()", controlUnit: "Anteil in der Farbe des Bereichspunkts", controlValues: [0, 1] },
  { key: "lineMode", low: "category", high: "mixed", base: {}, view: WIDE,
    scenario: "In Skill-Kategorie haben die Linien die Farbe ihres Bereichs, darum wirken die zwei Linienfarben und der Farbverlauf nicht. Genau diese drei Regler sind gesperrt und ausgegraut.",
    measure: "T.disabledIds() === 'cfg-bridgeColorDark,cfg-bridgeColorLight,cfg-lineGradient' && T.offRows() === 'row-bridgeColorDark,row-bridgeColorLight,row-lineGradient' ? 1 : 0", unit: "genau die zwei Farben und der Verlauf gesperrt (1 = ja)", expect: "equal", value: 1, lowValue: 0,
    // The control changes on purpose: no control is locked before, and the three of the measure are locked after.
    control: "T.disabledControls()", controlUnit: "gesperrte Bedienelemente", controlValues: [0, 3] },
  { key: "lineMode", low: "mixed", high: "category", base: {}, view: WIDE,
    scenario: "Zurück zu Kategorie-Kategorie: die zwei Linienfarben und der Farbverlauf wirken wieder und sind frei.",
    measure: "T.disabledControls()", unit: "gesperrte Bedienelemente", expect: "count", lowCount: 3, highCount: 0 },
  { key: "showBridges", low: true, high: false, base: { lineMode: "mixed" }, view: WIDE,
    scenario: "Skill-Kategorie ohne Linien: alle 13 Bedienelemente der Linien sind gesperrt, die zwei Farben und der Farbverlauf mitgezählt.",
    measure: "T.disabledControls()", unit: "gesperrte Bedienelemente", expect: "count", lowCount: 3, highCount: 13 },
  { key: "drawnBridges", low: 12, high: 30, base: { lineMode: "mixed" }, view: WIDE,
    scenario: "Skill-Kategorie: 49 Linien von Skills zu Kategorien anderer Bereiche, viele gleich stark. Die Karte zeigt genau die eingestellte Zahl, auch wenn der Schnitt in gleich starke Linien fällt.",
    measure: "T.lines('path.shared-line').length", unit: "Linien", expect: "count", lowCount: 12, highCount: 30 },
  { key: "drawnBridges", low: 12, high: 30, base: { lineMode: "mixed" }, view: WIDE,
    scenario: "Skill-Kategorie: die Stärke einer Linie ist die Summe der gemeinsamen Stationen des Skills mit allen Skills der Kategorie. Keine fehlende Linie ist stärker als eine gezeichnete. Die stärkste: „B3 eins“ teilt mit jedem der 8 Skills von A1 zwei Stationen, also 16.",
    measure: "T.mixedStrongestFirst()", unit: "Stärken stimmen, stärkste zuerst (1 = ja)", expect: "equal", value: 1, lowValue: 1,
    control: "Math.max(...T.lines('path.shared-line').map((p) => p.__data__.strength)) / 16", controlUnit: "stärkste Linie / 16", controlRatio: 1 },
  { key: "drawnBridges", low: 0, high: 49, via: "slider", base: { lineMode: "mixed" }, view: WIDE,
    scenario: "Skill-Kategorie: der Regler endet bei 49, der Zahl aller Linien von Skills zu Kategorien anderer Bereiche, und erreicht sie. Die Anzeige sagt „alle (49)“.",
    measure: `(() => { ${COUNT} return +r.max === 49 && springLineTotal() === 49 && n === 49 && +f.value === 49 && o === "alle (49)" ? 1 : 0; })()`, unit: "Regler am Ende, alles gleich (1 = ja)", expect: "equal", value: 1, lowValue: 0 },
  { key: "drawnBridges", low: 0, high: 48, base: { lineMode: "mixed", pull: 1.6 }, view: WIDE,
    scenario: "Skill-Kategorie: die Zahl der gezeichneten Linien ändert keine Kraft.",
    measure: "T.N().reduce((t, n) => t + n.x * 1.3 + n.y * 0.7, 0)", unit: "Prüfsumme aller Knotenpositionen", expect: "same" },
  { key: "crossAreaOnly", low: true, high: false, base: { lineMode: "mixed", drawnBridges: 1000 }, view: WIDE,
    scenario: "Skill-Kategorie: ohne „Linien im eigenen Bereich ausblenden“ kommen 26 Linien zu Kategorien im eigenen Bereich dazu, zum Beispiel von jedem Skill von A1 zu A2 über Station 2. Gegenprobe: alle Linien enden weiter auf einem Kategoriezentrum.",
    measure: "T.lines('path.shared-line').filter((p) => p.__data__.source.cluster === p.__data__.target.cluster).length", unit: "Linien im selben Bereich", expect: "count", lowCount: 0, highCount: 26,
    control: "T.mixedEnds()", controlUnit: "Linien von Skill zu Kategoriezentrum", controlRatio: 1 },
  { key: "widthExp", low: 0.25, high: 1, base: { lineMode: "mixed", drawnBridges: 1000 }, view: WIDE,
    scenario: "Skill-Kategorie: ein höherer Exponent macht schwache Linien im Verhältnis dünner.",
    measure: "T.weakest('path.shared-line', 'stroke-width')", unit: "Breite der schwächsten Linie", expect: "smaller" },
  { key: "bridgeWidthMin", low: 0.1, high: 3, base: { lineMode: "mixed", drawnBridges: 1000 }, view: WIDE,
    scenario: "Skill-Kategorie: die schwächste Linie wird breiter. Die stärkste behält ihre Breite (Gegenprobe).",
    measure: "T.weakest('path.shared-line', 'stroke-width')", unit: "Breite der schwächsten Linie", expect: "larger",
    control: "T.strongest('path.shared-line', 'stroke-width')", controlUnit: "Breite der stärksten Linie", controlRatio: 1 },
  { key: "bridgeWidthMax", low: 0.5, high: 10, base: { lineMode: "mixed", drawnBridges: 1000 }, view: WIDE,
    scenario: "Skill-Kategorie: die stärkste Linie bekommt genau die eingestellte Breite.",
    measure: "T.strongest('path.shared-line', 'stroke-width')", unit: "Breite der stärksten Linie", expect: "equal", value: 10 },
  { key: "bridgeOpacityMin", low: 0.05, high: 1, base: { lineMode: "mixed", drawnBridges: 1000 }, view: WIDE,
    scenario: "Skill-Kategorie: die schwächste Linie wird deckender.",
    measure: "T.weakest('path.shared-line', 'stroke-opacity')", unit: "Deckkraft der schwächsten Linie", expect: "larger" },
  { key: "bridgeOpacityMax", low: 0.25, high: 1, base: { lineMode: "mixed", drawnBridges: 1000 }, view: WIDE,
    scenario: "Skill-Kategorie: die stärkste Linie bekommt genau die eingestellte Deckkraft.",
    measure: "T.strongest('path.shared-line', 'stroke-opacity')", unit: "Deckkraft der stärksten Linie", expect: "equal", value: 1 },
  { key: "bridgeBend", low: -0.35, high: 0.5, base: { lineMode: "mixed", drawnBridges: 1000 }, view: WIDE,
    scenario: "Skill-Kategorie: die Krümmung ist der seitliche Versatz des Kontrollpunkts im Verhältnis zur Länge. Negativ biegt zur anderen Seite.",
    measure: "T.bend(T.lines('path.shared-line')[0])", unit: "Versatz / Länge", expect: "equal", value: 0.5, lowValue: -0.35 },
  // Line values per mode (his wish of 2026-10-17): every mode keeps its own values for the controls below the mode.
  { key: "lineMode", low: "category", high: "skill", base: { lines: { category: { drawnBridges: 4, bridgeWidthMax: 10 }, skill: { drawnBridges: 37, bridgeWidthMax: 0.5 } } }, view: WIDE,
    scenario: "Jeder Modus hat eigene Linienwerte: Kategorie-Kategorie 4 Linien bis 10 breit, Skill-Skill 37 Linien bis 0,5 breit. Der Wechsel lädt die Werte des neuen Modus in die Regler, und die Karte zeigt sie.",
    measure: "T.lookShown()", unit: "Karte und Regler", expect: "text",
    lowText: "4 Linien, Anzahl 4, stärkste Linie 10 breit, Regler 10", text: "37 Linien, Anzahl 37, stärkste Linie 0,5 breit, Regler 0,5" },
  { key: "lineMode", low: "category", high: "category", base: {}, view: WIDE, change: "Breite 10 in Kategorie-Kategorie, Skill-Skill, zurück",
    prep: [{ set: ["bridgeWidthMax", 10] }, { set: ["lineMode", "skill"] }],
    scenario: "Kategorie-Kategorie: die Breite der stärksten Linie geht auf 10. Dann wechselt der Modus zu Skill-Skill, dort bleibt sie 2,6. Zurück bei Kategorie-Kategorie ist die 10 noch da, im Regler und auf der Karte.",
    measure: "T.lookShown()", unit: "Karte und Regler", expect: "text",
    lowText: "8 Linien, Anzahl 8, stärkste Linie 2,6 breit, Regler 2,6", text: "5 Linien, Anzahl 8, stärkste Linie 10 breit, Regler 10" },
  { key: "bridgeWidthMax", low: 2.6, high: 10, base: { lineMode: "skill" }, view: WIDE,
    scenario: "Skill-Skill: der Regler ändert nur den Wert von Skill-Skill. Kategorie-Kategorie und Skill-Kategorie behalten 2,6.",
    measure: "T.lookSets('bridgeWidthMax')", unit: "Breite der stärksten je Modus", expect: "text",
    lowText: "category 2,6 · skill 2,6 · mixed 2,6", text: "category 2,6 · skill 10 · mixed 2,6" },
  { key: "bridgeColorLight", low: "#596763", high: "#ff0000", base: {}, view: WIDE,
    scenario: "Kategorie-Kategorie: auch eine Farbe ändert nur den Wert des gewählten Modus.",
    measure: "T.lookSets('bridgeColorLight')", unit: "Farbe im hellen Modus je Modus", expect: "text",
    lowText: "category #596763 · skill #596763 · mixed #596763", text: "category #ff0000 · skill #596763 · mixed #596763" },
  { key: "lineMode", low: "category", high: "skill", base: {}, view: WIDE,
    scenario: "„Geändert“ vergleicht mit dem Standard des gewählten Modus. Das Szenario hat in allen Modi den alten gemeinsamen Satz. Er ist genau der Standard von Kategorie-Kategorie, dort ist kein Regler geändert. In Skill-Skill weichen 8 Regler ab: Anzahl, dunkle Farbe, Exponent, beide Breiten, beide Deckkräfte und Krümmung.",
    measure: "T.changedLook()", unit: "geänderte Linienregler", expect: "count", lowCount: 0, highCount: 8 },
  { key: "lineMode", low: "skill", high: "category", base: {}, defaults: true, view: WIDE,
    scenario: "Die Werte aus layout.js. Skill-Skill zeigt bis zu 1000 Linien, auch im eigenen Bereich, sehr dünn und schwach. Hier sind es alle 169. Kategorie-Kategorie zeigt die 8 stärksten Linien zwischen Bereichen, dicker und deckender. Die Testdaten haben nur 5 solche Paare.",
    measure: "T.lookSummary()", unit: "Linien", expect: "text",
    lowText: "alle (169) bei 1000, 169 gezeichnet, Breite 0,1 bis 0,5, Deckkraft 10 % bis 35 %, stärkste Linie 0,5 breit, im eigenen Bereich ja",
    text: "alle (5) bei 8, 5 gezeichnet, Breite 0,4 bis 2,6, Deckkraft 16 % bis 46 %, stärkste Linie 2,6 breit, im eigenen Bereich nein" },
  { key: "lineMode", low: "mixed", high: "Werte aus layout.js", label: "Werte aus layout.js", change: "eigene Werte in allen Modi → Werte aus layout.js",
    base: { lines: { category: { drawnBridges: 3 }, skill: { bridgeWidthMax: 10 }, mixed: { bridgeBend: -0.35 } } }, view: WIDE, steps: [{ click: "spring-reset" }],
    scenario: "Jeder Modus hat Werte, die von layout.js abweichen. „Werte aus layout.js“ setzt alle drei Sätze zurück, nicht nur den gewählten, und wählt wieder Skill-Skill.",
    measure: "T.lookIsDefault()", unit: "Satz gleich layout.js", expect: "text",
    lowText: "category nein · skill nein · mixed nein · Modus mixed", text: "category ja · skill ja · mixed ja · Modus skill" },
  { key: "lineMode", low: "skill", high: "skill", label: "Werte kopieren und laden", change: "kopieren, Werte aus layout.js, laden",
    base: { lines: { category: { drawnBridges: 3, bridgeWidthMax: 10 }, skill: { drawnBridges: 37, bridgeWidthMax: 0.5 }, mixed: { drawnBridges: 12, bridgeWidthMax: 5 } } }, view: WIDE,
    steps: [{ eval: "window.copiedLine = document.getElementById('spring-values').value" }, { click: "spring-reset" },
      { eval: "document.getElementById('spring-values').value = window.copiedLine; document.getElementById('spring-load').click()" }],
    scenario: "Die Zeile von „Werte kopieren“ trägt alle drei Sätze unter „lines“, ohne flache Linienwerte. Nach „Werte aus layout.js“ bringt „Werte laden“ mit dieser Zeile alle drei Sätze zurück.",
    measure: "T.copiedSets()", unit: "Zeile und Anzahl/Breite je Modus", expect: "text",
    lowText: "lines: category, skill, mixed · flach: keine · category 3/10 · skill 37/0,5 · mixed 12/5", text: "lines: category, skill, mixed · flach: keine · category 3/10 · skill 37/0,5 · mixed 12/5" },
  { key: "lineMode", low: "mixed", high: "category", flat: true, base: { drawnBridges: 12, bridgeWidthMax: 5 }, view: WIDE,
    scenario: "Eine alte Zeile ohne „lines“: Modus Skill-Kategorie, 12 Linien bis 5 breit. Ihre Linienwerte gelten für Skill-Kategorie, die Meldung sagt das. Kategorie-Kategorie bekommt die Werte aus layout.js: 8 Linien bis 2,6 breit.",
    measure: "T.lookShown()", unit: "Karte und Regler", expect: "text",
    lowText: "12 Linien, Anzahl 12, stärkste Linie 5 breit, Regler 5", text: "5 Linien, Anzahl 8, stärkste Linie 2,6 breit, Regler 2,6",
    control: "document.getElementById('spring-message').textContent.includes('Die Linienwerte außerhalb von „lines“ gelten für den Modus Skill-Kategorie.') ? 1 : 0", controlUnit: "Meldung nennt den Modus (1 = ja)", controlRatio: 1 },
  { key: "lineMode", low: "mixed", high: "skill", base: {}, view: WIDE, prep: [{ eval: "document.getElementById('spring-values').value = '{\"drawnBridges\":12}'; document.getElementById('spring-load').click()" }],
    scenario: "Eine alte Zeile ohne Modus, nur mit 12 Linien, lädt in den gewählten Modus Skill-Kategorie, und der Modus bleibt. Skill-Skill hat danach die Werte aus layout.js: 1000, also alle 169 Linien.",
    measure: "T.modeCount()", unit: "Modus und Linien", expect: "text", lowText: "mixed, 12 Linien, Anzahl 12", text: "skill, 169 Linien, Anzahl 1000" },
  { key: "lineMode", low: "category", high: "skill", base: { lines: { category: { drawnBridges: 4 }, skill: { drawnBridges: 37 } } }, view: WIDE,
    prep: [{ eval: "document.getElementById('cfg-auto').click()" }], after: [{ eval: "document.getElementById('cfg-auto').click()" }],
    scenario: "Ohne „automatisch“: der Wechsel zu Skill-Skill lädt dessen Werte sofort in die Regler. Die Karte wartet auf „Neu berechnen“ und zeigt noch die 4 Linien.",
    measure: "T.pending()", unit: "Regler, Karte, wartet", expect: "text", lowText: "Anzahl 4, 4 Linien, wartet nein", text: "Anzahl 37, 4 Linien, wartet ja" },
  // Farbverlauf (his wish of 2026-10-17, off by default): each line runs from the area color of one end to the other.
  { key: "lineGradient", low: false, high: true, base: { lineMode: "skill", drawnBridges: 1000, crossAreaOnly: false }, view: WIDE,
    scenario: "Skill-Skill, alle 169 Linien: 111 zwischen den Bereichen, 58 im eigenen Bereich. Mit Farbverlauf hat jede Linie einen eigenen Verlauf von der Bereichsfarbe ihres ersten Endes zur Bereichsfarbe des zweiten. Eine Linie zwischen den Bereichen ist zweifarbig, eine Linie im eigenen Bereich einfarbig. Ohne Farbverlauf hat keine Linie einen Verlauf.",
    measure: "T.gradients()", unit: "Linien und Verläufe", expect: "text",
    lowText: "169 Linien, 0 Verläufe, 0 passend, zwischen Bereichen 0 von 111 zweifarbig, im eigenen Bereich 0 von 58 einfarbig",
    text: "169 Linien, 169 Verläufe, 169 passend, zwischen Bereichen 111 von 111 zweifarbig, im eigenen Bereich 58 von 58 einfarbig" },
  { key: "lineGradient", low: false, high: true, base: { crossAreaOnly: false }, view: WIDE,
    scenario: "Kategorie-Kategorie, alle 8 Linien: 5 zwischen den Bereichen, 3 im eigenen Bereich (A1–A2, B1–B3, B2–B3). Jede Linie bekommt ihren Verlauf zwischen den Bereichsfarben ihrer zwei Kategorien.",
    measure: "T.gradients()", unit: "Linien und Verläufe", expect: "text",
    lowText: "8 Linien, 0 Verläufe, 0 passend, zwischen Bereichen 0 von 5 zweifarbig, im eigenen Bereich 0 von 3 einfarbig",
    text: "8 Linien, 8 Verläufe, 8 passend, zwischen Bereichen 5 von 5 zweifarbig, im eigenen Bereich 3 von 3 einfarbig" },
  { key: "lineGradient", low: false, high: true, base: {}, view: WIDE, theme: "dark",
    scenario: "Kategorie-Kategorie im dunklen Modus: die 5 Linien laufen von der dunklen Bereichsfarbe von B zur dunklen Bereichsfarbe von A, dieselben Farben wie die Punkte der Bereiche.",
    measure: "T.gradients() + ' · ' + T.stopPairs()", unit: "Linien, Verläufe und Farben", expect: "text",
    lowText: "5 Linien, 0 Verläufe, 0 passend, zwischen Bereichen 0 von 5 zweifarbig, im eigenen Bereich 0 von 0 einfarbig · ",
    text: "5 Linien, 5 Verläufe, 5 passend, zwischen Bereichen 5 von 5 zweifarbig, im eigenen Bereich 0 von 0 einfarbig · rgb(69, 200, 177) → rgb(132, 168, 242)" },
  { key: "lineGradient", low: false, high: true, base: {}, view: WIDE,
    scenario: "Mit Farbverlauf nehmen die Linien die Bereichsfarben, darum wirken die zwei Linienfarben nicht. Genau diese zwei Regler sind dann gesperrt und ausgegraut.",
    measure: "T.disabledIds() + ' | ' + T.offRows()", unit: "gesperrte Regler | ausgegraute Zeilen", expect: "text",
    lowText: " | ", text: "cfg-bridgeColorDark,cfg-bridgeColorLight | row-bridgeColorDark,row-bridgeColorLight" },
  { key: "lineGradient", low: false, high: true, base: {}, view: WIDE,
    scenario: "Der Schalter heißt „Farbverlauf zwischen Bereichsfarben“, ein Tooltip auf der Zeile erklärt ihn.",
    measure: "T.rowText('lineGradient')", unit: "Name | Tooltip", expect: "text",
    lowText: "Farbverlauf zwischen Bereichsfarben | Jede Linie läuft von der Bereichsfarbe des einen Endes zur Bereichsfarbe des anderen. Gilt für Skill-Skill und Kategorie-Kategorie.",
    text: "Farbverlauf zwischen Bereichsfarben | Jede Linie läuft von der Bereichsfarbe des einen Endes zur Bereichsfarbe des anderen. Gilt für Skill-Skill und Kategorie-Kategorie." },
  { key: "lineGradient", low: false, high: true, base: { pull: 1.6 }, view: WIDE,
    scenario: "Der Farbverlauf ändert keine Kraft: mit starker Linienfeder bleibt jeder Knoten, wo er war.",
    measure: "T.N().reduce((t, n) => t + n.x * 1.3 + n.y * 0.7, 0)", unit: "Prüfsumme aller Knotenpositionen", expect: "same" },
  { key: "lineGradient", low: true, high: true, change: "Zeile ohne lineGradient laden, dann an", base: {}, view: WIDE,
    prep: [{ eval: "document.getElementById('spring-values').value = '{\"lineMode\":\"skill\",\"lines\":{\"skill\":{\"drawnBridges\":48}}}'; document.getElementById('spring-load').click()" }],
    scenario: "Das Szenario hat den Farbverlauf in allen Modi an. Eine Zeile ohne den Wert, wie die Zeilen vor dieser Einstellung, lädt ihn in allen Modi aus. Danach schaltet der Regler ihn nur für Skill-Skill wieder an.",
    measure: "T.gradientSets()", unit: "Verläufe und Satz je Modus", expect: "text",
    lowText: "48 Linien, 0 Verläufe · category aus · skill aus · mixed aus", text: "48 Linien, 48 Verläufe · category aus · skill an · mixed aus" },
  { key: "lineMode", low: "category", high: "mixed", base: { drawnBridges: 1000, lines: { category: { lineGradient: true }, mixed: { lineGradient: true } } }, view: WIDE,
    scenario: "Skill-Kategorie: der Farbverlauf wirkt nicht, auch wenn er im Satz von Skill-Kategorie an ist. Vorher zeigt Kategorie-Kategorie 5 Linien mit Verlauf. Danach hat keine Linie einen Verlauf, jede hat die Farbe ihres Skill-Bereichs, und der Regler ist gesperrt.",
    measure: "T.mixedGradient()", unit: "Verläufe, Farbe, Regler", expect: "text",
    lowText: "5 Verläufe, Anteil in der Farbe des Skill-Bereichs 0, Regler frei", text: "0 Verläufe, Anteil in der Farbe des Skill-Bereichs 1, Regler gesperrt" },
  // Erfahrung
  { key: "showExperience", low: false, high: true, base: {}, view: WIDE,
    scenario: "Jeder Skill mit Station bekommt einen Erfahrungsring. 30 von 31 Skills haben eine Station, „Ohne Station“ hat keine.",
    measure: "document.querySelectorAll('#map .xp').length", unit: "Ringe", expect: "count", lowCount: 0, highCount: 30,
    control: "T.dom('s:Ohne Station').g.querySelectorAll('.xp').length + (T.dom('s:Ohne Station').g.querySelector('title').textContent === 'Ohne Station' ? 1 : 0)", controlUnit: "Ringe von „Ohne Station“ plus 1 für einen Tooltip ohne Erfahrung", controlRatio: 1 },
  { key: "showExperience", low: false, high: true, base: {}, view: [130, -60, 290, 60],
    scenario: "Java: zehn Jahre bis 2020, seitdem nicht mehr. Heute ist für den Test Oktober 2026, also 5,75 Jahre her. Der Ring ist voll, und die Stufe 3 bis 6 Jahre macht 25 % davon grau.",
    measure: "T.ring('Java').aged", unit: "grauer Anteil des Rings", expect: "equal", value: 0.25, lowValue: 0,
    // The control changes on purpose: without a ring nothing is colored, and the full ring keeps 75 % in color beside the grey 25 %.
    control: "T.ring('Java').fresh", controlUnit: "farbiger Anteil (Gegenprobe)", controlValues: [0, 0.75] },
  { key: "showExperience", low: false, high: true, base: {}, view: AREA_A,
    scenario: "Der Tooltip nennt Jahre und letzte Nutzung. Go: Station 1 (2020, 36 Monate) und Station 2 (2021, 12 Monate).",
    measure: "T.dom('s:Go').g.querySelector('title').textContent === 'Go · 4 Jahre Erfahrung, zuletzt genutzt 2021' ? 1 : 0", unit: "Tooltip stimmt (1 = ja)", expect: "equal", value: 1, lowValue: 0 },
  { key: "showExperience", low: true, high: false, base: {}, view: AREA_A,
    scenario: "Ohne Ring wirken seine 3 Regler nicht. Sie sind dann gesperrt und ausgegraut.",
    measure: "T.disabledControls()", unit: "gesperrte Regler", expect: "count", lowCount: 0, highCount: 3 },
  { key: "experienceYears", low: 5, high: 10, base: { showExperience: true }, view: AREA_A,
    scenario: "Go hat 4 Jahre Erfahrung. Bei 5 Jahren für den vollen Ring füllt Go 80 %, bei 10 Jahren 40 %.",
    measure: "T.ring('Go').fresh + T.ring('Go').aged", unit: "gefüllter Anteil des Rings", expect: "ratio", ratio: 0.5 },
  { key: "ageingStep", low: 5, high: 1, base: { showExperience: true }, view: AREA_A,
    scenario: "Go wurde zuletzt 2021 genutzt, das Ende liegt 4,75 Jahre zurück. Mit Stufen von 5 Jahren altert Go noch nicht, mit Stufen von 1 Jahr viermal um 25 %.",
    measure: "T.ring('Go').aged / (T.ring('Go').fresh + T.ring('Go').aged)", unit: "grauer Anteil der Erfahrung", expect: "equal", value: 1, lowValue: 0 },
  { key: "ageingPerStep", low: 0.1, high: 0.5, base: { showExperience: true }, view: AREA_A,
    scenario: "Go liegt in der Stufe 3 bis 6 Jahre. Der graue Anteil ist genau der Wert je Stufe.",
    measure: "T.ring('Go').aged / (T.ring('Go').fresh + T.ring('Go').aged)", unit: "grauer Anteil der Erfahrung", expect: "equal", value: 0.5, lowValue: 0.1 },
  // Kollision
  { key: "collide", low: 0, high: 1, base: { skillRest: 0, skillHold: 32, cohesion: 0.4, skillCharge: 0 }, view: AREA_A,
    scenario: "Alle Skills werden in ihre Kategorie gezogen. Die Kollision hält ihre Kreise auseinander.",
    measure: "T.overlaps(T.skills())", unit: "überlappende Skill-Paare", expect: "smaller" },
  { key: "collideLabel", low: 0, high: 0.5, base: { skillRest: 0, skillHold: 32, cohesion: 0.4, skillCharge: 0, collide: 1 }, view: AREA_A,
    scenario: "Wie oben mit voller Kollision. Schließt der Kreis einen Teil des Namens ein, rücken die Skills weiter auseinander.",
    measure: "T.mean(T.skills().map((s) => T.nearest(s, T.skills())))", unit: "nächster Skill", expect: "larger" },
  // Simulation
  { key: "ticks", low: 100, high: 1500, base: { skillRest: 0, skillHold: 32, cohesion: 0.4, skillCharge: 0, collide: 0.2 }, view: AREA_A,
    scenario: "Alle Skills werden in ihre Kategorie gezogen, die Kollision ist schwach. Die Kräfte kühlen nach etwa 300 Schritten ab, die Zusammenstöße wirken weiter. Mehr Schritte lösen die Überlappung auf.",
    measure: "T.ballOverlap(T.skills())", unit: "Summe der Überlappung der Kollisionskreise", expect: "smaller" },
  { key: "friction", low: 0.1, high: 0.8, base: { skillCharge: 120, skillHold: 0.25 }, view: AREA_A,
    scenario: "Starke Ladung treibt die Skills auseinander, bis die Simulation abkühlt. Mehr Reibung bremst sie, die Wolken bleiben kleiner.",
    measure: "T.mean(T.skills().map((s) => T.dist(s, T.hub(s.group))))", unit: "Abstand Skill–Kategorie", expect: "smaller" },
  { key: "range", low: 40, high: 320, base: { groupCharge: 480, at: NEAR }, view: WIDE,
    scenario: "Die Bereiche liegen nah. Mit kurzer Reichweite erreichen sich die Kategorien der zwei Bereiche nicht.",
    measure: "T.mean(T.cats().map((g) => T.nearest(g, T.cats().filter((o) => o.cluster !== g.cluster))))", unit: "nächste fremde Kategorie", expect: "larger" },
  // Nachbearbeitung
  { key: "stepLabels", low: false, high: true, base: { skillRest: 0, skillHold: 32, cohesion: 0.4, skillCharge: 0, collide: 0 }, view: AREA_A,
    scenario: "Alle Skills liegen übereinander. Das Entzerren schiebt die Namen auseinander.",
    measure: "T.labelOverlaps()", unit: "überlappende Namen", expect: "smaller" },
  { key: "stepUntangle", low: false, high: true, base: { categoryPull: 0.8, categoryRest: 0, skillRest: 15 }, view: AREA_A,
    scenario: "A1 und A2 liegen ineinander. Das Entwirren holt Skills, die näher an der fremden Kategorie liegen, zurück.",
    measure: "T.foreign()", unit: "Skills näher an fremder Kategorie", expect: "smaller" },
  { key: "lopsided", low: 2, high: 1000, base: { stepUntangle: true, room: 0, hold: 51.2, skillRest: 20 }, view: AREA_A,
    scenario: "Die Kategorien liegen an der Kugel des Bereichs, ihre Skills nur auf einer Seite. Ab einer Lücke von 2 gleichen Abständen verteilt der Schritt sie gleichmäßig.",
    measure: "T.widestGap()", unit: "größte Lücke / gleicher Abstand", expect: "larger" },
  { key: "clearance", low: 0, high: 28, base: { stepUntangle: true, categoryPull: 0.8, categoryRest: 30, skillRest: 15 }, view: AREA_A,
    scenario: "A1 und A2 liegen dicht. Der Mindestabstand fremder Skills hält Skills verschiedener Kategorien auseinander.",
    measure: "T.closestForeign()", unit: "nächster Skill einer anderen Kategorie", expect: "larger" },
  { key: "stepSidestep", low: false, high: true, base: { stepLabels: true, areaScale: 2, room: 5, ball: 0.25 }, view: AREA_A,
    scenario: "Großer Bereichsname, die Kategorien liegen dicht daran. Das Entzerren schiebt Skills weit hinaus, das Ausweichen holt sie seitlich zurück.",
    measure: "T.farthest()", unit: "weitester Skill / Median der Wolke", expect: "smaller" },
];

function installHelpers() {
  const N = () => d3.selectAll("#map g.node").data();
  const by = (id) => N().find((n) => n.id === id);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mean = (a) => a.length ? a.reduce((t, v) => t + v, 0) / a.length : 0;
  const skills = () => N().filter((n) => n.type === "skill");
  const hub = (g) => by("g:" + g);
  const own = (s) => dist(s, hub(s.group));
  const lines = (sel) => [...document.querySelectorAll(sel)];
  const byStrength = (sel) => lines(sel).sort((a, b) => a.__data__.share - b.__data__.share);
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const num = (v) => String(Math.round(v * 1000) / 1000).replace(".", ",");
  window.T = {
    N, by, dist, mean, skills, hub, lines,
    area: (c) => by("c:" + c), skill: (l) => by("s:" + l),
    areas: () => N().filter((n) => n.type === "area"), cats: () => N().filter((n) => n.type === "group"),
    seed: (c) => { const at = CLUSTERS.find((x) => x.id === c).at; return { x: at[0] * 0.5, y: at[1] * 0.5 }; },
    nearest: (n, pool) => Math.min(...pool.filter((o) => o !== n).map((o) => dist(n, o))),
    dom: (id) => { const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__.id === id); return { g, dot: g.querySelector("circle.dot-area, circle.dot-group"), text: g.querySelector("text") }; },
    share: (sel, test) => { const l = lines(sel); return l.length ? l.filter((p) => test(getComputedStyle(p))).length / l.length : 0; },
    weakest: (sel, attr) => +byStrength(sel)[0].getAttribute(attr),
    strongest: (sel, attr) => +byStrength(sel).at(-1).getAttribute(attr),
    // Signed offset of the control point from the chord middle, divided by the chord length.
    bend: (p) => { const m = p.getAttribute("d").match(/M([-\d.e]+),([-\d.e]+)Q([-\d.e]+),([-\d.e]+) ([-\d.e]+),([-\d.e]+)/).slice(1).map(Number);
      const [x1, y1, cx, cy, x2, y2] = m, dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
      return ((cx - (x1 + x2) / 2) * -dy + (cy - (y1 + y2) / 2) * dx) / len2; },
    ballOverlap: (pool) => { let t = 0; for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) t += Math.max(0, ballOf(pool[i]) + ballOf(pool[j]) - dist(pool[i], pool[j])); return t; },
    // Shares of the experience ring of a skill, as the template writes them on its two arcs.
    ring: (label) => { const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__.id === "s:" + label), part = (c) => { const e = g && g.querySelector(c); return e ? Number(e.dataset.share) : 0; };
      return { fresh: part(".xp-fresh"), aged: part(".xp-aged") }; },
    // 1 when no line left out has more shared places than a drawn one.
    strongestFirst: () => {
      const id = (a, b) => [a.id, b.id].sort().join("|"), drawn = new Set(lines("path.shared-line").map((p) => id(p.__data__.source, p.__data__.target)));
      const all = computeLayout().links.filter((l) => l.kind === "use" && (!LINE_CROSS_AREA || l.source.cluster !== l.target.cluster));
      const inW = all.filter((l) => drawn.has(id(l.source, l.target))).map((l) => l.w), outW = all.filter((l) => !drawn.has(id(l.source, l.target))).map((l) => l.w);
      return inW.length === drawn.size && Math.min(...inW) >= Math.max(0, ...outW) ? 1 : 0; },
    // Share of the drawn lines whose two ends are nodes of this type.
    endsOn: (type) => { const l = lines("path.shared-line"); return l.length ? l.filter((p) => p.__data__.source.type === type && p.__data__.target.type === type).length / l.length : 0; },
    // Skill-Kategorie: share of the drawn lines that start exactly on a skill and end exactly on the hub of another category.
    mixedEnds: () => { const l = lines("path.shared-line"); return l.length ? l.filter((p) => {
      const d = p.__data__, m = p.getAttribute("d").match(/^M([-\d.e]+),([-\d.e]+)Q[-\d.e]+,[-\d.e]+ ([-\d.e]+),([-\d.e]+)$/);
      const [x1, y1, x2, y2] = m ? m.slice(1).map(Number) : [NaN, NaN, NaN, NaN];
      return d.source.type === "skill" && by(d.source.id) === d.source && d.target.type === "group" && by(d.target.id) === d.target && d.target.group !== d.source.group
        && Math.hypot(x1 - d.source.x, y1 - d.source.y) < 1e-6 && Math.hypot(x2 - d.target.x, y2 - d.target.y) < 1e-6; }).length / l.length : 0; },
    // Skill-Kategorie: 1 when each drawn line has the strength the use links give and no line left out is stronger.
    mixedStrongestFirst: () => {
      const want = new Map();
      computeLayout().links.filter((l) => l.kind === "use" && (!LINE_CROSS_AREA || l.source.cluster !== l.target.cluster)).forEach((l) => {
        [[l.source, l.target], [l.target, l.source]].forEach(([s, o]) => { const k = s.id + "|g:" + o.group; want.set(k, (want.get(k) || 0) + l.w); }); });
      const drawn = lines("path.shared-line").map((p) => [p.__data__.source.id + "|" + p.__data__.target.id, p.__data__.strength]), keys = new Set(drawn.map(([k]) => k));
      const out = [...want].filter(([k]) => !keys.has(k)).map(([, w]) => w);
      return drawn.length && keys.size === drawn.length && drawn.every(([k, s]) => want.get(k) === s) && Math.min(...drawn.map(([, s]) => s)) >= Math.max(0, ...out) ? 1 : 0; },
    // Share of the drawn lines whose stroke is the given color of the area of their first end.
    strokeIs: (colors) => { const l = lines("path.shared-line"); return l.length ? l.filter((p) => getComputedStyle(p).stroke === colors[p.__data__.source.cluster]).length / l.length : 0; },
    // Share of the drawn lines whose stroke is the fill of the area dot of their first end.
    areaColored: () => { const l = lines("path.shared-line"); return l.length ? l.filter((p) => getComputedStyle(p).stroke === getComputedStyle(window.T.dom("c:" + p.__data__.source.cluster).dot).fill).length / l.length : 0; },
    // The gradient of a drawn line and the computed colors of its stops, or null when its stroke is no gradient.
    gradientOf: (p) => { const m = getComputedStyle(p).stroke.match(/^url\("?#([^")]+)"?\)$/), g = m && document.getElementById(m[1]);
      return g && g.tagName === "linearGradient" ? { g, stops: [...g.querySelectorAll("stop")].map((s) => getComputedStyle(s).stopColor) } : null; },
    // Drawn lines and gradients. A gradient fits when it runs in map units from the first end to the second end of its line,
    // and its two stops have the colors of the area dots of these ends.
    gradients: () => {
      const l = lines("path.shared-line"), dot = (c) => getComputedStyle(window.T.dom("c:" + c).dot).fill, of = window.T.gradientOf;
      const fits = (p) => { const d = p.__data__, x = of(p); if (!x) return false; const at = (a, v) => Math.abs(+x.g.getAttribute(a) - v) < 1e-6;
        return x.g.getAttribute("gradientUnits") === "userSpaceOnUse" && at("x1", d.source.x) && at("y1", d.source.y) && at("x2", d.target.x) && at("y2", d.target.y)
          && x.stops.length === 2 && x.stops[0] === dot(d.source.cluster) && x.stops[1] === dot(d.target.cluster); };
      const cross = l.filter((p) => p.__data__.source.cluster !== p.__data__.target.cluster), inside = l.filter((p) => !cross.includes(p));
      return l.length + " Linien, " + document.querySelectorAll("#map linearGradient").length + " Verläufe, " + l.filter(fits).length + " passend, zwischen Bereichen "
        + cross.filter((p) => { const x = of(p); return x && x.stops[0] !== x.stops[1]; }).length + " von " + cross.length + " zweifarbig, im eigenen Bereich "
        + inside.filter((p) => { const x = of(p); return x && x.stops[0] === x.stops[1]; }).length + " von " + inside.length + " einfarbig"; },
    // The different pairs of stop colors of the drawn lines.
    stopPairs: () => [...new Set(lines("path.shared-line").map(window.T.gradientOf).filter(Boolean).map((x) => x.stops.join(" → ")))].sort().join(" · "),
    // Lines and gradients on the map, and the gradient switch in the set of each mode.
    gradientSets: () => lines("path.shared-line").length + " Linien, " + document.querySelectorAll("#map linearGradient").length + " Verläufe · "
      + Object.entries(springCurrent().lines).map(([m, set]) => m + " " + (set.lineGradient ? "an" : "aus")).join(" · "),
    // Skill-Kategorie: gradients on the map, share of lines in the area color of their skill, and the state of the switch.
    mixedGradient: () => document.querySelectorAll("#map linearGradient").length + " Verläufe, Anteil in der Farbe des Skill-Bereichs "
      + num(window.T.areaColored()) + ", Regler " + (document.getElementById("cfg-lineGradient").disabled ? "gesperrt" : "frei"),
    // Line values per mode: what the map and the controls show, the stored sets, and the line of "Werte kopieren".
    lookShown: () => { const l = lines("path.shared-line"), w = l.length ? Math.max(...l.map((p) => +p.getAttribute("stroke-width"))) : 0;
      return l.length + " Linien, Anzahl " + document.getElementById("cfg-drawnBridges-n").value + ", stärkste Linie " + num(w) + " breit, Regler " + document.getElementById("out-bridgeWidthMax").textContent; },
    lookSets: (key) => Object.entries(springCurrent().lines).map(([m, set]) => m + " " + (typeof set[key] === "number" ? num(set[key]) : set[key])).join(" · "),
    lookIsDefault: () => Object.keys(SPRING_DEFAULTS.lines).map((m) => m + " " + (JSON.stringify(springCurrent().lines[m]) === JSON.stringify(SPRING_DEFAULTS.lines[m]) ? "ja" : "nein")).join(" · ") + " · Modus " + LINE_MODE,
    lookSummary: () => { const l = lines("path.shared-line"), out = (k) => document.getElementById("out-" + k).textContent;
      return out("drawnBridges") + " bei " + document.getElementById("cfg-drawnBridges-n").value + ", " + l.length + " gezeichnet, Breite " + out("bridgeWidthMin") + " bis " + out("bridgeWidthMax")
        + ", Deckkraft " + out("bridgeOpacityMin") + " bis " + out("bridgeOpacityMax") + ", stärkste Linie " + num(Math.max(...l.map((p) => +p.getAttribute("stroke-width")))) + " breit, im eigenen Bereich "
        + (l.some((p) => p.__data__.source.cluster === p.__data__.target.cluster) ? "ja" : "nein"); },
    copiedSets: () => { const v = JSON.parse(document.getElementById("spring-values").value), flat = SPRING_LOOK.filter((k) => k in v);
      return "lines: " + Object.keys(v.lines).join(", ") + " · flach: " + (flat.length ? flat.join(", ") : "keine") + " · "
        + Object.entries(v.lines).map(([m, set]) => m + " " + set.drawnBridges + "/" + num(set.bridgeWidthMax)).join(" · "); },
    modeCount: () => LINE_MODE + ", " + lines("path.shared-line").length + " Linien, Anzahl " + document.getElementById("cfg-drawnBridges-n").value,
    pending: () => "Anzahl " + document.getElementById("cfg-drawnBridges-n").value + ", " + lines("path.shared-line").length + " Linien, wartet " + (document.getElementById("cfg-run").classList.contains("dirty") ? "ja" : "nein"),
    changedLook: () => SPRING_LOOK.filter((k) => document.getElementById("row-" + k).classList.contains("changed")).length,
    rowText: (key) => { const r = document.getElementById("row-" + key); return r.textContent.trim() + " | " + r.title; },
    disabledIds: () => [...document.querySelectorAll("#cfg-groups input:disabled, #cfg-groups select:disabled")].map((e) => e.id).sort().join(),
    offRows: () => [...document.querySelectorAll("#cfg-groups .cfg-row.off")].map((e) => e.id).sort().join(),
    disabledControls: () => document.querySelectorAll("#cfg-groups input:disabled, #cfg-groups select:disabled").length,
    overlaps: (pool) => { let c = 0; for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) if (dist(pool[i], pool[j]) < pool[i].r + pool[j].r - 0.01) c++; return c; },
    labelOverlaps: () => { const ns = N(), b = ns.map(labelBox); let c = 0;
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) if (b[i].x0 < b[j].x1 && b[j].x0 < b[i].x1 && b[i].y0 < b[j].y1 && b[j].y0 < b[i].y1) c++; return c; },
    foreign: () => skills().filter((s) => N().some((h) => h.type === "group" && h.group !== s.group && dist(s, h) < own(s))).length,
    widestGap: () => Math.max(...N().filter((n) => n.type === "group").map((h) => {
      const ang = skills().filter((s) => s.group === h.group).map((s) => Math.atan2(s.y - h.y, s.x - h.x)).sort((a, b) => a - b);
      if (ang.length < 3) return 0;
      return Math.max(...ang.map((a, i) => (i + 1 < ang.length ? ang[i + 1] : ang[0] + 2 * Math.PI) - a)) / (2 * Math.PI / ang.length); })),
    closestForeign: () => Math.min(...skills().map((s) => Math.min(...skills().filter((o) => o.group !== s.group).map((o) => dist(s, o))))),
    farthest: () => Math.max(...skills().map((s) => own(s) / median(skills().filter((o) => o.group === s.group).map(own)))),
  };
  // A grid of 10 units under the map, labeled every 50 units, so distances can be read from the screenshots.
  const vp = document.querySelector("#map").querySelector(":scope > g"), ns = "http://www.w3.org/2000/svg";
  const grid = document.createElementNS(ns, "g");
  for (let v = -400; v <= 400; v += 10) {
    const major = v % 50 === 0;
    for (const [x1, y1, x2, y2] of [[v, -300, v, 300], [-400, v, 400, v]]) {
      const l = document.createElementNS(ns, "line");
      Object.entries({ x1, y1, x2, y2, stroke: major ? "#b9c2c0" : "#e2e7e6", "stroke-width": major ? 1 : 0.6, "vector-effect": "non-scaling-stroke" }).forEach(([k, x]) => l.setAttribute(k, x));
      grid.append(l);
    }
    // x values every 100 units on rows 100 apart; y values every 50 units on columns between the x labels.
    const marks = !major ? [] : [...(v % 100 === 0 ? [-200, -100, 0, 100, 200].map((y) => [v, y, "x " + v]) : []),
      ...(Math.abs(v) <= 300 ? [-250, -50, 150, 350].map((x) => [x, v, "y " + v]) : [])];
    for (const [x, y, text] of marks) {
      const t = document.createElementNS(ns, "text");
      Object.entries({ x, y, dx: "0.3em", dy: "-0.3em", fill: "#7f8b88", "font-family": "monospace", class: "grid-label" }).forEach(([k, val]) => t.setAttribute(k, val));
      t.textContent = text; grid.append(t);
    }
  }
  vp.insertBefore(grid, vp.firstChild);
  const style = document.createElement("style");
  style.textContent = ".cfg-show, .hint { display: none !important; }";
  document.head.append(style);
}

const fmt = (v) => typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v);
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const de = (v) => typeof v === "boolean" ? (v ? "an" : "aus") : typeof v === "number" ? fmt(v).replace(".", ",") : String(v);

// The report: a summary, then per setting its scenario, both values, the measures and both screenshots.
function writeReport(results, errors) {
  const passed = results.filter((r) => r.pass).length, groups = [...new Set(results.map((r) => r.group))];
  const slug = (g) => "g-" + g.toLowerCase().replace(/[^a-z0-9äöü]+/g, "-");
  const card = (r) => `
    <article class="case ${r.pass ? "ok" : "bad"}" id="${esc(r.id)}">
      <div class="text">
        <p class="eyebrow">${esc(r.group)}</p>
        <h3>${esc(r.label)}</h3>
        <p class="scenario">${esc(r.scenario)}</p>
        <dl>
          <dt>Einstellung</dt><dd class="num">${esc(r.change || de(r.low) + " → " + de(r.high))}</dd>
          <dt>${esc(r.unit)}</dt><dd class="num">${esc(de(r.a))} → ${esc(de(r.b))}</dd>
          <dt>Erwartet</dt><dd>${esc(r.expect === "text" ? promise(r) : promise(r).replace(/\./g, ","))}</dd>
          ${r.control ? `<dt>${esc(r.controlUnit)}</dt><dd class="num">${esc(de(r.ca))} → ${esc(de(r.cb))}${" (soll " + esc(controlPromise(r).replace(/\./g, ",")) + ")"}</dd>` : ""}
        </dl>
        <p class="status">${r.pass ? "bestanden" : "nicht bestanden" + (r.wired ? "" : ": der Regler setzt " + esc(de(r.stored))) + (r.message ? ": " + esc(r.message) : "")}</p>
      </div>
      <figure><img src="shots/${esc(r.id)}-a.png" alt="${esc(r.label)} bei ${esc(de(r.low))}" loading="lazy" width="944" height="696"><figcaption>${esc(de(r.low))}</figcaption></figure>
      <figure><img src="shots/${esc(r.id)}-b.png" alt="${esc(r.label)} bei ${esc(de(r.high))}" loading="lazy" width="944" height="696"><figcaption>${esc(de(r.high))}</figcaption></figure>
    </article>`;
  // A local file with the fonts of the system: the report loads nothing from another host.
  const page = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prüfstand Federmodell</title>
<style>
/* Layout: a test log. Summary on top, then one row per setting: text left, before and after screenshots right. */
:root {
  --bg: #f3f6f5; --surface: #ffffff; --ink: #17201e; --muted: #596763; --line: #d2dad8; --accent: #2c5fc4;
  --ok: #0a7a5e; --ok-bg: #e2f3ee; --bad: #b3263d; --bad-bg: #fbe6ea;
  --font-ui: "Archivo", "Segoe UI", system-ui, sans-serif; --font-mono: "IBM Plex Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #0f1517; --surface: #151d20; --ink: #e3ebe9; --muted: #93a3a0; --line: #2a3638; --accent: #84a8f2;
  --ok: #45c8b1; --ok-bg: #12302b; --bad: #f07d8f; --bad-bg: #3a1a20; color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #0f1517; --surface: #151d20; --ink: #e3ebe9; --muted: #93a3a0; --line: #2a3638; --accent: #84a8f2;
  --ok: #45c8b1; --ok-bg: #12302b; --bad: #f07d8f; --bad-bg: #3a1a20; color-scheme: dark; }
body { background: var(--bg); color: var(--ink); font-family: var(--font-ui); font-size: 14px; line-height: 1.5; }
.wrap { max-width: 1400px; margin: 0 auto; padding-block: 24px 48px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 28px; }
h1 { margin: 0; font-size: 26px; letter-spacing: -0.01em; text-wrap: balance; }
h2 { margin: 0; font-size: 18px; text-wrap: balance; }
h3 { margin: 0; font-size: 16px; text-wrap: balance; }
p { margin: 0; max-width: 68ch; }
.summary { display: grid; gap: 10px; }
.tally { font-family: var(--font-mono); font-size: 15px; font-variant-numeric: tabular-nums; }
.tally strong { color: ${passed === results.length ? "var(--ok)" : "var(--bad)"}; }
.muted { color: var(--muted); }
nav { display: flex; flex-wrap: wrap; gap: 6px; }
nav a { color: var(--ink); text-decoration: none; border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 3px 12px; font-size: 13px; }
nav a:hover, nav a:focus-visible { border-color: var(--accent); outline: none; }
section { display: grid; gap: 14px; }
.case { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr) minmax(0, 1.35fr); gap: 14px; align-items: start; background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--ok); border-radius: 8px; padding: 14px; }
.case.bad { border-left-color: var(--bad); }
.text { display: grid; gap: 8px; min-width: 0; }
.eyebrow { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.scenario { color: var(--ink); }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 12px; margin: 0; font-size: 13px; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 12.5px; }
.status { justify-self: start; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 2px 10px; color: var(--ok); background: var(--ok-bg); }
.bad .status { color: var(--bad); background: var(--bad-bg); }
figure { margin: 0; display: grid; gap: 4px; min-width: 0; }
figure img { width: 100%; height: auto; max-width: 100%; border: 1px solid var(--line); border-radius: 6px; background: #f3f6f5; }
figcaption { font-family: var(--font-mono); font-size: 12px; color: var(--muted); }
@media (max-width: 900px) { .case { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .text { grid-column: 1 / -1; } }
@media (max-width: 520px) { .case { grid-template-columns: minmax(0, 1fr); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="summary">
    <h1>Prüfstand Federmodell</h1>
    <p class="tally"><strong>${passed} von ${results.length}</strong> Einstellungen tun, was ihr Name sagt.${errors.length ? " Fehler auf der Seite: " + esc(errors.join(" | ")) : ""}</p>
    <p>Jede Einstellung des Federmodells läuft auf einer kleinen Testdatenbank mit festen Startpunkten: Bereich A und Bereich B, die Kategorien A1, A2, B1, B2 und B3 und drei Stationen. A1 und B1 teilen Station 1 und bilden die stärkste graue Linie. Jeder Fall lädt sein Szenario über „Werte laden“, stellt den zweiten Wert über den Regler im Menü ein und misst, was die Einstellung verspricht.</p>
    <p class="muted">Das Raster hat 10 Einheiten, die Beschriftung steht alle 100 Einheiten. Beide Bilder eines Falls zeigen denselben Ausschnitt im selben Maßstab. Stand ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC, gebaut aus skills/layout.js und skills/forces.js.</p>
    <nav aria-label="Gruppen">${groups.map((g) => `<a href="#${slug(g)}">${esc(g)}</a>`).join("")}</nav>
  </div>
  ${groups.map((g) => `<section id="${slug(g)}"><h2>${esc(g)}</h2>${results.filter((r) => r.group === g).map(card).join("")}</section>`).join("\n  ")}
</div>
</body>
</html>
`;
  fs.writeFileSync(path.join(out, "report.html"), page);
}
const near = (a, b) => Math.abs(a - b) <= 1e-6 + 0.01 * Math.abs(b);
function judge(c, a, b) {
  switch (c.expect) {
    // A change below 5 % counts as no effect.
    case "smaller": return b < a - Math.max(1e-6, 0.05 * Math.abs(a));
    case "larger": return b > a + Math.max(1e-6, 0.05 * Math.abs(a)) && (c.lowCount === undefined || a === c.lowCount);
    case "zero": return Math.abs(b) < 0.01 && a > 1;
    case "equal": return near(b, c.value) && (c.lowValue === undefined || near(a, c.lowValue));
    case "count": return a === c.lowCount && b === c.highCount;
    case "same": return Math.abs(b - a) < 1e-9;
    case "ratio": return near(b / a, c.ratio);
    case "text": return b === c.text && (c.lowText === undefined || a === c.lowText);
  }
}
// A control without a ratio shows that the setting changes nothing else: a change below 5 % counts as no effect
// (CLAUDE.md). A control that changes on purpose names its two values in controlValues, and its case says why.
function controlPass(c, ca, cb) {
  if (c.controlRatio !== undefined) return near(cb / ca, c.controlRatio);
  if (c.controlValues) return near(ca, c.controlValues[0]) && near(cb, c.controlValues[1]);
  return Math.abs(cb - ca) < Math.max(1e-6, 0.05 * Math.abs(ca));
}
const controlPromise = (c) => c.controlRatio !== undefined ? "× " + fmt(c.controlRatio) : c.controlValues ? fmt(c.controlValues[0]) + " → " + fmt(c.controlValues[1]) : "unverändert, unter 5 %";
const promise = (c) => ({ smaller: "kleiner", larger: "größer", zero: "0", equal: "= " + fmt(c.value) + (c.lowValue !== undefined ? " (vorher " + fmt(c.lowValue) + ")" : ""),
  count: fmt(c.lowCount) + " → " + fmt(c.highCount), ratio: "× " + fmt(c.ratio), same: "unverändert",
  text: "„" + c.text + "“" + (c.lowText !== undefined && c.lowText !== c.text ? " (vorher „" + c.lowText + "“)" : "") })[c.expect];

(async () => {
  const only = process.argv.slice(2);
  const browser = await chromium.launch();
  await site.start();
  // The viewer owns the page, so it sets up the force menu. The page has no database here. errors holds the page errors
  // and every request to another host.
  const { page, errors } = await openPage(browser, site, springsPage, { runtime: { mode: "owner", db: false, delays: { use: 0 } }, console: false,
    contextOptions: { viewport: { width: 1300, height: 860 }, reducedMotion: "reduce", colorScheme: "light" } });
  await page.waitForFunction(() => window.springMeasure && !document.getElementById("cfg").hidden, null, { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.evaluate(installHelpers);
  // A setting without a pinned value would take its default from layout.js, and the cases would follow that default.
  const unpinned = Object.keys(spec).filter((k) => !(k in PINNED));
  if (unpinned.length) throw new Error("no pinned value in PINNED for: " + unpinned.join(", "));
  // The keys of SPEC are the format of saved configurations, so a change needs a new version (tests/settings/schema.json).
  const schemaErrors = require("./schema-guard").schemaProblems(LAYOUT);
  if (schemaErrors.length) throw new Error(schemaErrors.join("\n"));
  const groups = await page.evaluate(() => [...document.querySelectorAll("#cfg-groups details")].map((d) => d.open));
  if (!groups.length || groups.some(Boolean)) throw new Error("every group of the menu must start collapsed: " + groups.filter(Boolean).length + " of " + groups.length + " open");
  await page.evaluate(() => { document.getElementById("cfg-hide").click(); });
  const idle = () => page.waitForFunction(() => !document.getElementById("spring-load").disabled && !/Berechne/.test(document.getElementById("cfg-measures").textContent), null, { timeout: 60000 });
  // One control through the menu, the way a person changes it.
  const setControl = (key, value, via) => {
    const step = spec[key] && spec[key].steps ? spec[key].steps.indexOf(value) : null;
    if (step === -1) throw new Error(key + ": " + value + " is no step of the slider");
    return page.evaluate(([key, value, step, count, via]) => {
      const input = document.getElementById("cfg-" + key);
      // A count takes its value through the number field, or through its slider when the case says so.
      if (count) {
        const target = via === "slider" ? input : document.getElementById("cfg-" + key + "-n");
        target.value = String(value);
        if (via === "slider") target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return "count";
      }
      if (input.type === "checkbox") { if (input.checked !== value) input.click(); }
      else if (input.type === "color") { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); return "color"; }
      else if (input.tagName === "SELECT") { input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); }
      else if (input.type === "range") { input.value = String(step); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }
      return input.type;
    }, [key, value, step, !!(spec[key] && spec[key].count), via]);
  };
  // A step of a case: a control ({ set: [key, value, via] }), a click on a button ({ click: id }) or a piece of script
  // ({ eval: code }). The page settles after each step; a color needs no new layout.
  const runStep = async (s) => {
    const type = s.set ? await setControl(...s.set) : s.click ? await page.evaluate((id) => { document.getElementById(id).click(); }, s.click)
      : await page.evaluate("(() => { " + s.eval + "; })()");
    if (type !== "color") { await page.waitForTimeout(40); await idle(); }
  };
  const results = [];
  const missing = Object.keys(spec).filter((k) => !cases.some((c) => c.key === k));
  for (const [i, c] of cases.entries()) {
    if (only.length && !only.includes(c.key)) continue;
    const id = String(i + 1).padStart(2, "0") + "-" + c.key;
    await page.evaluate((theme) => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; }, c.theme);
    await page.evaluate((text) => { document.getElementById("spring-values").value = text; document.getElementById("spring-load").click(); }, JSON.stringify(scenarioLine(c)));
    await page.waitForTimeout(40); await idle();
    const message = await page.evaluate(() => { const m = document.getElementById("spring-message"); return m.classList.contains("error") ? m.textContent : ""; });
    // Steps that set up the case before the first measure, for example a value in another mode.
    for (const s of c.prep || []) await runStep(s);
    const measure = async () => {
      // The grid labels keep 11 pixels on screen at every zoom.
      await page.evaluate((view) => { window.springShow(view); const k = d3.zoomTransform(document.getElementById("map")).k;
        document.querySelectorAll(".grid-label").forEach((t) => t.setAttribute("font-size", 11 / k)); }, c.view);
      return page.evaluate(([m, k]) => [eval(m), k ? eval(k) : null], [c.measure, c.control || ""]);
    };
    const [a, ca] = await measure();
    await page.locator("#map").screenshot({ path: path.join(shots, id + "-a.png") });
    // The second value goes through the control itself, the way a person changes it, or through the steps of the case.
    for (const s of c.steps || [{ set: [c.key, c.high, c.via] }]) await runStep(s);
    // The value in the page: a line value is the value of the active mode.
    const stored = await page.evaluate((key) => { const v = springCurrent(); return key in v ? v[key] : v.lines[v.lineMode][key]; }, c.key);
    const [b, cb] = await measure();
    await page.locator("#map").screenshot({ path: path.join(shots, id + "-b.png") });
    // Steps that leave the page as the next case expects it, for example "automatisch" on again.
    for (const s of c.after || []) await runStep(s);
    const wired = c.steps ? true : stored === c.high;
    const pass = !message && wired && judge(c, a, b) && (!c.control || controlPass(c, ca, cb));
    const r = { id, ...c, label: c.label || (spec[c.key] ? spec[c.key].label : c.key), group: spec[c.key] ? spec[c.key].group : "", a, b, ca, cb, wired, stored, message, pass };
    results.push(r);
    console.log(`${pass ? "PASS" : "FAIL"} ${r.group.padEnd(26)} ${r.label.slice(0, 46).padEnd(46)} ${fmt(c.low).padStart(7)} -> ${fmt(c.high).padEnd(7)} ${c.unit}: ${fmt(a)} -> ${fmt(b)} (soll ${promise(c)})`
      + (c.control ? ` | ${c.controlUnit}: ${fmt(ca)} -> ${fmt(cb)} (soll ${controlPromise(c)})` : "") + (wired ? "" : ` | Regler setzt ${fmt(stored)}`) + (message ? " | " + message : ""));
  }
  if (!only.length && missing.length) console.log("NO CASE for: " + missing.join(", "));
  console.log(errors.length ? "page errors: " + errors.join(" | ") : "no page errors");
  console.log(`${results.filter((r) => r.pass).length} of ${results.length} passed`);
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 1));
  if (!only.length) writeReport(results, errors);
  await browser.close();
  await site.close();
  process.exitCode = results.every((r) => r.pass) && !errors.length ? 0 : 1;
})();

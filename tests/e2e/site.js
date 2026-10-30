// The test pages of the browser suites: map pages of the same build as the site (build_selfhost.js), with the test
// runtime (tests/e2e/test-runtime.js) in place of the runtime of the site. A test site is a folder with the files that
// every map page needs (the page code, the layout, d3, jsPDF, svg2pdf.js, the fonts) and one page and data file for each
// page that a test opens. It is served over HTTP on 127.0.0.1, and every request to another host fails the test.
//
// A page is { title, data, projects, configs, layout, init }: the data in the shape of skills/data.js (text), the
// projects (an array with ids), the configurations ({ reader, configs }), the layout (the text of assets/layout.js, null
// for the layout of the build) and a script that runs before the page, for example an override of a constant of
// layout.js. Playwright runs that script inside a function, so an override sets a property of window:
// "window.LINE_MODE_OVERRIDE = 'category';". Pages with the same files share them.
//
// A page can also carry the texts of its map (texts, as dataOfMap of build_selfhost.js gives them) and the runtime of a
// kind of map page of the site (runtime: a key of RUNTIMES, for example "example"), which then replaces the test
// runtime. pageOfMap and withRuntime make them, for a check of a page as a visitor of the site sees it.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const repo = path.join(__dirname, "..", "..");
const { mapAssets, mapPage, dataScript, dataOfMap, readMapFile, readConfigs, layoutScript, RUNTIMES, RUNTIME_FILES } = require(path.join(repo, "build_selfhost.js"));
const { TITLE } = require(path.join(repo, "save_example.js"));
const { serve } = require(path.join(repo, "tests", "selfhost", "server.js"));
const plain = (file) => fs.readFileSync(file, "utf8").split("\r").join("");

// The page of a data file in the shape of skills/data.js, its projects file and its configurations file (null: none).
// The heading is the title of his CV map, as on the example map of the site.
function pageOf(dataFile, projectsFile, configsFile = null, { title = TITLE } = {}) {
  return Object.freeze({ title, data: plain(dataFile), projects: JSON.parse(plain(projectsFile)), configs: readConfigs(configsFile, () => {}), layout: null, init: "" });
}
// The same page with a script that runs before it, with changed data, or with a changed layout.
const withInit = (page, script) => Object.freeze({ ...page, init: page.init + script + "\n" });
const withData = (page, edit) => Object.freeze({ ...page, data: edit(page.data) });
const LAYOUT = layoutScript();
const withLayout = (page, edit) => Object.freeze({ ...page, layout: edit(page.layout || LAYOUT) });
// The page of a map file (the format of selfhost/FORMAT.md), as the site shows it: its title, data, projects,
// configurations and texts, read with the rules of an import.
const pageOfMap = (mapFile) => Object.freeze({ ...dataOfMap(readMapFile(mapFile)), layout: null, init: "" });
// The same page with the runtime of a kind of map page of the site in place of the test runtime.
function withRuntime(page, kind) {
  if (!Object.hasOwn(RUNTIMES, kind)) throw new Error("no runtime of the site: " + kind);
  return Object.freeze({ ...page, runtime: kind });
}

class TestSite {
  // Writes the files of every map page and the test runtime into dir, which it empties first.
  constructor(dir) {
    this.dir = dir;
    fs.rmSync(dir, { recursive: true, force: true });
    const files = mapAssets();
    files.set("assets/test-runtime.js", plain(path.join(__dirname, "test-runtime.js")));
    for (const [rel, content] of files) this.write(rel, content);
    this.pages = new Map();
    this.server = null;
  }
  write(rel, content) {
    const file = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  // The address of a page in the site, relative to its root. A page gets its files on the first call; name fixes the
  // name of its HTML file.
  file(page, name = null) {
    // The texts and the runtime count only when a page has them, so every other page keeps its key.
    const extra = [...(page.texts ? [page.texts] : []), ...(page.runtime ? [page.runtime] : [])];
    const key = crypto.createHash("sha1").update(JSON.stringify([page.title, page.data, page.projects, page.configs, page.layout, ...extra])).digest("hex").slice(0, 12);
    const known = this.pages.get(key);
    if (known && (!name || name === known)) return known;
    const rel = name || `p-${key}.html`;
    const layout = page.layout === null ? null : `assets/${key}.layout.js`;
    if (layout) this.write(layout, page.layout);
    this.write(`assets/${key}.data.js`, dataScript(page, page.layout || LAYOUT));
    const runtime = page.runtime ? RUNTIMES[page.runtime] : [{ src: "assets/test-runtime.js" }];
    if (page.runtime) runtime.forEach(({ src }) => this.write(src, plain(RUNTIME_FILES[src])));
    let html = mapPage({ title: page.title, runtime, data: `assets/${key}.data.js` });
    if (layout) html = html.replace('<script src="assets/layout.js"></script>', `<script src="${layout}"></script>`);
    this.write(rel, html);
    this.pages.set(key, rel);
    return rel;
  }
  // Starts the server once, also when several tests ask at the same time.
  async start() {
    this.starting = this.starting || serve(this.dir).then((server) => { this.server = server; });
    await this.starting;
    return this;
  }
  get origin() { return this.server.origin; }
  url(page) { return this.server.url + (typeof page === "string" ? page : this.file(page)); }
  async close() {
    if (this.starting) await this.starting.catch(() => {});
    if (this.server) await this.server.close();
    this.server = null; this.starting = null;
  }
}

// A browser context on a test site, and a tab that opens page. runtime: the configuration of the test runtime
// (test-runtime.js). fonts: false serves an empty vendor/fonts/fonts.css, so the names keep the fonts of the system, as
// the tests had them before; true serves the fonts of the site. noD3: the request for d3 fails. errors collects the page
// errors, the console errors that ignore does not match (with console true) and every request to another host.
// language: the language that the page shows (i18n/README.md), German by default, so that every check keeps its name and
// its expectation; null keeps the choice of the page, English on a first visit.
async function openPage(browser, site, page, { runtime = { mode: "signedOut" }, contextOptions = {}, fonts = false, noD3 = false, init = [], console: logConsole = true, ignore = null, goto = true, language = "de" } = {}) {
  const context = await browser.newContext(contextOptions);
  const errors = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (!url.startsWith(site.origin + "/")) { errors.push("request to another host: " + url); return route.abort(); }
    const where = new URL(url).pathname;
    if (!fonts && where === "/vendor/fonts/fonts.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: "" });
    if (noD3 && where === "/vendor/d3-7.9.0.min.js") return route.abort();
    return route.continue();
  });
  await context.addInitScript((config) => { window.__testRuntime = config; }, runtime);
  if (language) await context.addInitScript(chooseLanguage, language);
  // An init script is a text, a function, or [function, argument].
  for (const script of [...init, page && page.init].filter(Boolean)) await (Array.isArray(script) ? context.addInitScript(script[0], script[1]) : context.addInitScript(script));
  const tab = await context.newPage();
  // A map page starts its first layout one frame after the parse (skills/page.js), often after the load event. goto and
  // reload wait for that start, as they waited for the load event before.
  for (const name of ["goto", "reload"]) {
    const plain = tab[name].bind(tab);
    tab[name] = async (...args) => {
      const response = await plain(...args);
      await tab.waitForFunction(() => !document.getElementById("map") || window.skillMapStarted === true, null, { timeout: 30000 });
      return response;
    };
  }
  tab.on("pageerror", (error) => errors.push(error.message));
  if (logConsole) tab.on("console", (message) => { if (message.type() === "error" && !(ignore && ignore.test(message.text()))) errors.push(message.text()); });
  if (goto && page) await tab.goto(site.url(page));
  return { context, page: tab, errors };
}

// The init script that chooses the language of the pages of a context before they load (i18n/i18n.js).
function chooseLanguage(code) { try { localStorage.setItem("skill-map-language", code); } catch (error) { /* a frame without storage */ } }

// The catalogs of the interface texts (i18n/), for the checks of a page in English. englishOf(german) gives the English
// text of the keys whose German text is german. germanIn(text) gives the German interface texts that text holds: the
// texts of two words or more and 10 characters or more that differ from English and hold no placeholder, so that a word
// of the content of a map does not count.
const CATALOGS = require(path.join(repo, "i18n", "tools", "catalogs.js")).read().catalogs;
function englishOf(german) {
  const english = [...new Set([...CATALOGS.de].filter(([, e]) => e.text === german).map(([key]) => CATALOGS.en.get(key).text))];
  if (english.length !== 1) throw new Error(`the German text ${german} has ${english.length} English texts`);
  return english[0];
}
const GERMAN = [...new Set([...CATALOGS.de].filter(([key, e]) => typeof e.text === "string" && CATALOGS.en.has(key) && e.text !== CATALOGS.en.get(key).text
  && !e.text.includes("{") && /\S\s+\S/.test(e.text) && e.text.length >= 10).map(([, e]) => e.text))];
const germanIn = (text) => GERMAN.filter((german) => text.includes(german));
// The texts of a PDF of jsPDF, as a reader that searches it finds them: the string of each Tj, in the order of the page,
// decoded through the font that draws it. A standard font writes (text) in Windows-1252. An embedded font writes <hex>
// glyph ids, and its ToUnicode map gives their characters. fonts lists the fonts that the texts use: { name, embedded }.
const WIN_ANSI_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
function pdfText(buffer) {
  const zlib = require("zlib"), latin = buffer.toString("latin1"), objects = new Map();
  for (const m of latin.matchAll(/(\d+) 0 obj\b/g)) {
    const start = m.index + m[0].length, end = latin.indexOf("endobj", start), body = latin.slice(start, end), at = body.search(/stream\r?\n/);
    let stream = null;
    if (at >= 0) {
      const from = start + at + body.slice(at).match(/stream\r?\n/)[0].length, raw = buffer.subarray(from, latin.indexOf("endstream", from));
      try { stream = zlib.inflateSync(raw).toString("latin1"); } catch (error) { stream = raw.toString("latin1"); }
    }
    objects.set(m[1], { dict: at >= 0 ? body.slice(0, at) : body, stream });
  }
  // The resource name of each font (/F1) and its object, and the map of a font with a ToUnicode stream.
  const fonts = new Map();
  for (const { dict } of objects.values()) {
    const block = dict.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (block) for (const r of block[1].matchAll(/\/(\w+)\s+(\d+) 0 R/g)) fonts.set(r[1], r[2]);
  }
  const unicode = (id) => {
    const font = objects.get(id), ref = font && font.dict.match(/\/ToUnicode (\d+) 0 R/), cmap = ref && objects.get(ref[1]) && objects.get(ref[1]).stream;
    if (!cmap) return null;
    const map = new Map(), text = (h) => String.fromCharCode(...h.match(/.{4}/g).map((x) => parseInt(x, 16)));
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) map.set(parseInt(p[1], 16), text(p[2]));
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const p of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
      for (let g = parseInt(p[1], 16), u = parseInt(p[3], 16); g <= parseInt(p[2], 16); g++, u++) map.set(g, String.fromCharCode(u));
    }
    return map;
  };
  const maps = new Map(), used = new Map(), strings = [];
  for (const { stream } of objects.values()) {
    if (!stream || !/\bTj\b/.test(stream)) continue;
    let current = null;
    for (const op of stream.matchAll(/\/(\w+)\s+[\d.]+\s+Tf|\(((?:\\.|[^\\)])*)\)\s*Tj|<([0-9a-fA-F]*)>\s*Tj/g)) {
      if (op[1]) { current = op[1]; continue; }
      const id = fonts.get(current);
      if (!maps.has(id)) maps.set(id, unicode(id));
      const map = maps.get(id), name = ((objects.get(id) || { dict: "" }).dict.match(/\/BaseFont \/([\w+-]+)/) || [])[1] || current;
      used.set(name, { name, embedded: !!map });
      if (op[3] !== undefined) strings.push((op[3].match(/.{4}/g) || []).map((g) => (map && map.get(parseInt(g, 16))) || "�").join(""));
      else strings.push([...op[2].replace(/\\([0-7]{3})/g, (x, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, "$1")]
        .map((c) => c >= "\x80" && c <= "\x9f" ? WIN_ANSI_HIGH[c.charCodeAt(0) - 0x80] : c).join(""));
    }
  }
  return { strings, fonts: [...used.values()], title: (latin.match(/\/Title \(((?:\\.|[^\\)])*)\)/) || [])[1] };
}
// The text of a key without placeholders, English by default.
function textOf(key, language = "en") {
  const entry = CATALOGS[language].get(key);
  if (!entry || typeof entry.text !== "string") throw new Error("no text " + key + " in " + language);
  return entry.text;
}

module.exports = { TestSite, openPage, chooseLanguage, englishOf, germanIn, textOf, pdfText, pageOf, pageOfMap, withInit, withData, withLayout, withRuntime, LAYOUT, repo };

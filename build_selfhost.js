// Builds the site in dist/selfhost/: static files for any web server, and the files that the compose stack of stages b
// and c serves (server/README.md). On a plain web space the site stores nothing on the server: each visitor keeps his
// maps in his own browser and exports them as files (selfhost/runtime/local.js, selfhost/FORMAT.md).
//
//   index.html       the start page: the example map, new maps, the maps of this browser, "Map-Datei öffnen"
//   map.html         the editor of a map of this browser (map.html?id=<map id>)
//   example.html    the example map, read-only: the map file selfhost/site/example.it-skills-map.json
//   imprint.html, privacy.html   drafts with placeholders, each with the German text and its English translation
//   server-map.html  the map page of stage b: the server (server/, PAGE_FILE) sends it for every map of an account,
//                    with the runtime of the server, and as the embed view /e/... (assets/embed.js). A web space without
//                    the server does not need it.
//   assets/          the interface texts of every language (i18n.js), the page code of the map pages (page.js), the
//                    layout with the force menu (layout.js), the data of each map page (*.data.js), the runtimes, the
//                    embed view, the templates for new maps (templates.js: the default set of selfhost/site/default-set.js
//                    and an empty map), the scripts and styles of the start page, the icon
//   vendor/          d3, jsPDF, svg2pdf.js, the fonts and their licenses
//
// A map page is skills/editor_template.html with the head of the site and its scripts: the runtime of its kind, d3, its
// data file, the layout and the page code. Only the script tags of the runtime differ between the kinds: the example
// map, a map of this browser, a map on the server. Every link is relative, so the site works in any folder of a web
// space. Each address of a script, a style or an image carries the version of its file (versionAddresses). No page
// loads anything from another host, and no page holds an inline script. On the server, the start page
// also shows the maps of the account (assets/account.js), once the server names itself in the data block
// it-skills-server (server/app/pages.py). A plain web space never does, so there the site stays stage a.
// Usage: node build_selfhost.js [outDir]
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { forcesLayout, lineReference } = require("./skills/forces");
const catalogs = require("./i18n/tools/catalogs");

const repo = __dirname, SKILLS = path.join(repo, "skills"), SELF = path.join(repo, "selfhost");
const OUT = path.join(repo, "dist", "selfhost");
// SKILLMAP_EXAMPLE names another map file for the example map, for example the fictional demo of save_demo.js.
const EXAMPLE = process.env.SKILLMAP_EXAMPLE ? path.resolve(process.env.SKILLMAP_EXAMPLE) : path.join(SELF, "site", "example.it-skills-map.json");
const DEFAULT_SET = path.join(SELF, "site", "default-set.js");
const AI_EXAMPLE = path.join(SELF, "site", "ai", "example.it-skills-map.json");
// The details of the provider for the legal pages. SKILLMAP_LEGAL names a JSON file with the keys name, address (lines
// split by a new line), email, host, retention and authority. Each key fills its placeholder in German and English. A
// key that is missing keeps its placeholder, and the draft note goes away only when no placeholder is left.
const LEGAL_PLACEHOLDERS = { name: ["NAME"], address: ["ANSCHRIFT", "ADDRESS"], email: ["E-MAIL"], host: ["HOSTING-ANBIETER", "HOSTING PROVIDER"],
  retention: ["SPEICHERFRIST", "RETENTION PERIOD"], authority: ["AUFSICHTSBEHÖRDE", "SUPERVISORY AUTHORITY"] };
const MASKED = new Set(["address", "email"]);
function fillLegal(html) {
  if (!process.env.SKILLMAP_LEGAL) return html;
  const values = JSON.parse(fs.readFileSync(path.resolve(process.env.SKILLMAP_LEGAL), "utf8"));
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // The address and the e-mail address go into the page as numeric character references. A browser shows the same
  // text, and a screen reader and a copy work as before, but a scraper that searches the raw HTML for a street or an
  // "@" finds nothing. It stops simple scrapers only, not one that parses the page.
  const mask = (text) => [...text].map((c) => "&#" + c.codePointAt(0) + ";").join("");
  for (const [key, names] of Object.entries(LEGAL_PLACEHOLDERS)) {
    // The second name of a key is the English placeholder. It takes the value of <key>En when the file has one.
    names.forEach((name, i) => {
      const value = i === names.length - 1 && names.length > 1 && typeof values[key + "En"] === "string" ? values[key + "En"] : values[key];
      if (typeof value !== "string" || !value.trim()) return;
      const lines = value.trim().split(/\r?\n/).map((line) => MASKED.has(key) ? mask(line) : escape(line));
      html = html.split(`<span class="placeholder">[${name}]</span>`).join(lines.join("<br>"));
    });
  }
  return html.includes('class="placeholder"') ? html : html.replace(/<p class="draft">.*<\/p>\n?/g, "");
}
// The map of a page that shows no map of its own until its runtime loads one: map.html and server-map.html.
const BLANK = { format: "it-skills-map", schema: 1, title: "Skill-Map", collections: {} };
const plain = (file) => fs.readFileSync(file, "utf8").split("\r").join("");
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// The Content-Security-Policy of the site: no page may load from another host, run an inline script, send a form or
// open a frame elsewhere. style-src keeps 'unsafe-inline', because the page writes style attributes. Each page carries
// the policy as a meta tag, for a web space without headers. On the server, the proxy (server/proxy/Caddyfile) and the
// app (SITE_POLICY in server/app/pages.py) send it as a header with base-uri and frame-ancestors;
// server/tests/test_stack.py compares the three copies.
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; "
  + "connect-src 'self'; frame-src 'self'; object-src 'none'; form-action 'none'";
const CSP = POLICY + "; base-uri 'none'";
// The head of a page. A title with a key (text) comes from the catalogs; the title of a map page is the title of its map.
const head = (title, key = null) => [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
  '<meta name="referrer" content="no-referrer">',
  `<title${key ? ` data-i18n="${esc(key)}"` : ""}>${esc(title)}</title>`,
  '<link rel="icon" href="assets/icon.svg" type="image/svg+xml">',
  '<link rel="stylesheet" href="vendor/fonts/fonts.css">',
].join("\n");

// The fonts of the page: Archivo and IBM Plex Mono 5.3.0, latin subset, as @font-face rules for the local files.
const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const FONTS = [["Archivo", "archivo", [400, 500, 600, 700]], ["IBM Plex Mono", "ibm-plex-mono", [400, 500]]];
const fontCss = () => "/* Archivo and IBM Plex Mono, latin subset, from the local files. Licenses: ../licenses/ */\n"
  + FONTS.flatMap(([family, file, weights]) => weights.map((w) => `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${w}; font-display: swap; `
    + `src: url("${file}-latin-${w}-normal.woff2") format("woff2"); unicode-range: ${LATIN}; }`)).join("\n") + "\n";
// The libraries in vendor/ as their published files: d3 for every map page, jsPDF and svg2pdf.js for the PDF download.
const LIBRARIES = ["d3-7.9.0.min.js", "jspdf-4.2.1.umd.min.js", "svg2pdf.js-2.8.1.umd.min.js"];
// The font of the text in the PDF download (D4 of the final review): Noto Sans 2.015, the static TrueType files of
// regular and bold, unhinted, with the SIL Open Font License 1.1 (vendor/licenses/Noto-Sans-OFL.txt). It draws Latin with
// its accents, Greek and Cyrillic. The page loads it on the first PDF, with the SHA-384 of each file (PDF_FONTS in
// skills/page.js). Source: https://github.com/notofonts/notofonts.github.io, fonts/NotoSans/unhinted/ttf/, as
// NotoSans-Regular.ttf and NotoSans-Bold.ttf. The build stops if a file is not the file of this list.
const PDF_FONT_FILES = [
  ["noto-sans-2.015-400-normal.ttf", "f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8"],
  ["noto-sans-2.015-700-normal.ttf", "87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9"],
];
function pdfFont(name, sha256) {
  const data = fs.readFileSync(path.join(SELF, "vendor", "fonts", name)), got = crypto.createHash("sha256").update(data).digest("hex");
  if (got !== sha256) throw new Error(`selfhost/vendor/fonts/${name} has the SHA-256 ${got}, but the build expects ${sha256}`);
  return data;
}

// The layout with the force menu, as the map pages load it (assets/layout.js).
const layoutScript = () => forcesLayout(plain(path.join(SKILLS, "layout.js")));
// The pseudo language of the tests: the English texts, each between the two marks, so that a browser run finds every text
// of a page that comes from no catalog (tests/selfhost/run.js). Its locale stays the English one. Only a test build has
// it (build(out, { pseudo: true })); the site never does.
const PSEUDO = Object.freeze({ code: "qps", open: "\u27e6", close: "\u27e7" });
function pseudoTexts(english) {
  const mark = (text) => PSEUDO.open + text + PSEUDO.close;
  return Object.fromEntries(Object.entries(english).map(([key, text]) => [key, key === "language.locale" ? text : key === "language.name" ? mark("Pseudo")
    : typeof text === "string" ? mark(text) : Object.fromEntries(Object.entries(text).map(([form, value]) => [form, mark(value)]))]));
}
// The interface texts, as every page of the site loads them first (assets/i18n.js): the texts of the catalogs in i18n/,
// the function t of i18n/i18n.js (i18n/README.md) and the dropdown of the languages (selfhost/site/language.js). pseudo
// adds the pseudo language of the tests.
function i18nScript({ pseudo = false } = {}) {
  const texts = catalogs.texts();
  if (pseudo) texts[PSEUDO.code] = pseudoTexts(texts.en);
  return "// The interface texts of every language, made by build_selfhost.js from i18n/ (i18n/README.md).\nwindow.SKILL_MAP_TEXTS = "
    + JSON.stringify(texts) + ";\n" + plain(path.join(repo, "i18n", "i18n.js")) + plain(path.join(SELF, "site", "language.js"));
}
// The function t of the English texts, for the code of the site that the build runs (runtimeStore): i18n.js in a stand-in
// of a browser without storage and without a document.
function englishTexts(script = i18nScript()) {
  const win = {};
  new Function("window", "localStorage", "document", script)(win, undefined, undefined);
  return win;
}
// The files that every map page needs, by their path in the site: the page code, the layout, the icon, the libraries,
// the fonts and the licenses. The tests serve the same files next to their own pages. pseudo: see i18nScript.
function mapAssets({ pseudo = false } = {}) {
  const files = new Map();
  files.set("assets/i18n.js", i18nScript({ pseudo }));
  files.set("assets/page.js", plain(path.join(SKILLS, "page.js")));
  files.set("assets/layout.js", layoutScript());
  files.set("assets/icon.svg", plain(path.join(SELF, "site", "icon.svg")));
  LIBRARIES.forEach((name) => files.set("vendor/" + name, fs.readFileSync(path.join(SELF, "vendor", name))));
  files.set("vendor/fonts/fonts.css", fontCss());
  FONTS.forEach(([, file, weights]) => weights.forEach((w) => files.set(`vendor/fonts/${file}-latin-${w}-normal.woff2`, fs.readFileSync(path.join(SELF, "vendor", "fonts", `${file}-latin-${w}-normal.woff2`)))));
  PDF_FONT_FILES.forEach(([name, sha256]) => files.set("vendor/fonts/" + name, pdfFont(name, sha256)));
  fs.readdirSync(path.join(SELF, "vendor", "licenses")).forEach((name) => files.set("vendor/licenses/" + name, fs.readFileSync(path.join(SELF, "vendor", "licenses", name))));
  return files;
}

const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
// The configurations file of an export (skills/configs.json): { reader: <config id> | null, configs: [{ id, name, schema,
// values, savedAt }] }. null or a missing file means no configurations: every viewer starts with the values of layout.js.
function readConfigs(file, warn = (text) => console.warn(text)) {
  if (file === null) return { reader: null, configs: [] };
  if (!fs.existsSync(file)) {
    warn(`warning: ${file} not found, the page has no configurations, so readers see the values of layout.js`);
    return { reader: null, configs: [] };
  }
  return checkConfigs(JSON.parse(plain(file)), file, warn);
}
function checkConfigs(raw, where, warn) {
  if (!isObject(raw) || !Array.isArray(raw.configs) || !(raw.reader === null || typeof raw.reader === "string")) {
    throw new Error(where + ": expected { \"reader\": <config id> | null, \"configs\": [ ... ] }");
  }
  raw.configs.forEach((c, i) => {
    if (!isObject(c) || typeof c.id !== "string" || !c.id || typeof c.name !== "string" || !isObject(c.values)) {
      throw new Error(where + ": configuration " + (i + 1) + " needs an id, a name and values");
    }
  });
  if (raw.reader !== null && !raw.configs.some((c) => c.id === raw.reader)) {
    warn(`warning: ${where} picks "${raw.reader}" for readers, but has no configuration with that id, so readers see the values of layout.js`);
  }
  return { reader: raw.reader, configs: raw.configs.map(({ id, name, schema, values, savedAt }) => ({ id, name, schema, values, savedAt })) };
}

// The data of a map file for its page: the constants in the shape of skills/data.js, the projects as an array with ids,
// the configurations with the pick for readers and the texts of the map (settings/texts). The page reads each field with the fallbacks of its database
// (skills/page.js), and the order of each collection is the order of the page. A configuration without a name or values
// and a pick of a missing configuration drop out, as the page would ignore them.
function dataOfMap(map) {
  const c = isObject(map.collections) ? map.collections : {};
  const text = (x) => typeof x === "string" ? x : "";
  const orderOf = (doc) => Number.isFinite(doc.order) ? doc.order : Number.MAX_SAFE_INTEGER;
  const ordered = (name) => Object.entries(isObject(c[name]) ? c[name] : {}).filter(([, doc]) => isObject(doc))
    .sort(([, a], [, b]) => orderOf(a) - orderOf(b) || text(a.name).localeCompare(text(b.name), "de"));
  const areas = ordered("areas").filter(([, a]) => text(a.name));
  const COLORS = Object.fromEntries(areas.map(([id, a]) => [id, /^#[0-9a-f]{6}$/i.test(a.color) ? a.color.toLowerCase() : "#596763"]));
  const ring = (i, n) => [Math.round(Math.cos(2 * Math.PI * i / Math.max(1, n) - Math.PI / 2) * 340), Math.round(Math.sin(2 * Math.PI * i / Math.max(1, n) - Math.PI / 2) * 200)];
  const CLUSTERS = areas.map(([id, a], i) => ({ id, name: a.name, at: Array.isArray(a.at) && a.at.length === 2 && a.at.every(Number.isFinite) ? a.at.slice() : ring(i, areas.length) }));
  const GROUPS = ordered("groups").filter(([, g]) => text(g.name) && Object.hasOwn(COLORS, g.area)).map(([id, g]) => [id, g.area, g.name]);
  const groupIds = new Set(GROUPS.map(([id]) => id)), names = new Set();
  const skills = ordered("skills").filter(([, s]) => text(s.name) && groupIds.has(s.group) && !names.has(s.name) && names.add(s.name));
  const SKILLS = skills.map(([, s]) => [s.name, s.group, [3, 2, 1, 0, -1].includes(s.rating) ? s.rating : 1, (Array.isArray(s.places) ? s.places.filter((p) => typeof p === "string") : []).join(" ")]);
  const STANDARD = Object.fromEntries(skills.filter(([, s]) => isObject(s.standard) && typeof s.standard.text === "string" && typeof s.standard.since === "string")
    .map(([, s]) => [s.name, { text: s.standard.text, since: s.standard.since }]));
  const stations = ordered("stations").filter(([, s]) => text(s.name));
  const PROJECTS = Object.fromEntries(stations.map(([id, s]) => [id, { months: Number.isFinite(s.months) && s.months >= 0 ? s.months : 0, name: s.name, when: text(s.when),
    kind: text(s.kind) || "Arbeitgeber", note: text(s.note) }]));
  // The short name of each station. The page itself names an indirect use (a place with a trailing "i") with the text
  // skill.indirect of the catalogs, in the language of the page, so the data file holds no word of a language for it.
  const WHERE = Object.fromEntries(stations.map(([id, s]) => [id, text(s.short) || s.name]));
  const projects = Object.entries(isObject(c.projects) ? c.projects : {}).filter(([, p]) => isObject(p)).map(([id, p]) => ({ id, ...p }));
  const configs = Object.entries(isObject(c.configs) ? c.configs : {}).filter(([, d]) => isObject(d) && typeof d.name === "string" && isObject(d.values))
    .map(([id, { name, schema, values, savedAt }]) => ({ id, name, schema, values, savedAt }));
  const pick = isObject(c.settings) && isObject(c.settings.reader) && typeof c.settings.reader.config === "string" ? c.settings.reader.config : null;
  const reader = pick && configs.some((d) => d.id === pick) ? pick : null;
  const texts = isObject(c.settings) && Object.hasOwn(c.settings, "texts") && isObject(c.settings.texts) ? c.settings.texts : {};
  const mapTexts = typeof texts.privateNote === "string" && texts.privateNote ? { privateNote: texts.privateNote } : {};
  const constants = { COLORS, CLUSTERS, GROUPS, WHERE, KI: -1, SKILLS, STANDARD, PROJECTS };
  const data = Object.entries(constants).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`).join("\n") + "\n";
  return { title: typeof map.title === "string" && map.title ? map.title : "Skill-Map", data, projects, configs: { reader, configs }, texts: mapTexts };
}

// The data file of a map page: the title of its map, the data in the shape of skills/data.js, the snapshot of the
// projects and the configurations for a reader without a database, the texts of the map (MAP_TEXTS) and the line
// measure of the values of layout.js.
function dataScript({ title, data, projects, configs, texts = {} }, layout = layoutScript()) {
  const text = data.replace(/\s*$/, "\n") + "const STATIC_PROJECTS = " + JSON.stringify(projects) + ";\nconst STATIC_CONFIGS = " + JSON.stringify(configs) + ";\n"
    + "const MAP_TEXTS = " + JSON.stringify(texts) + ";\n";
  return "// The data of a map page, made by build_selfhost.js.\nconst MAP_TITLE = " + JSON.stringify(title) + ";\n" + text
    + "// The line measure of the values of layout.js, computed by the build.\nconst LINE_REFERENCE = " + lineReference(text, layout) + ";\n";
}

// The script tags of the runtime of each kind of map page. A map page of local.js names its kind in data-map.
// assets/embed.js turns the page into the embed view when the runtime offers features.embed (/e/... of the server).
const RUNTIMES = {
  example: [{ src: "assets/runtime-local.js", map: "example" }],
  browser: [{ src: "assets/runtime-local.js", map: "browser" }],
  server: [{ src: "assets/runtime-local.js" }, { src: "assets/runtime-server.js" }, { src: "assets/embed.js" }],
};
// The source file of each script of the runtimes, by its path in the site. The tests serve them next to their own pages.
const RUNTIME_FILES = { "assets/runtime-local.js": path.join(SELF, "runtime", "local.js"), "assets/runtime-server.js": path.join(SELF, "runtime", "server.js"),
  "assets/embed.js": path.join(SELF, "site", "embed.js") };
const scriptTag = ({ src, map }) => `<script src="${esc(src)}"${map ? ` data-map="${esc(map)}"` : ""}></script>`;
// A map page: the template with the head of the site, the script tags of its runtime and its data file.
function mapPage({ title, runtime, data }) {
  const template = plain(path.join(SKILLS, "editor_template.html"));
  if (!template.startsWith("<style>")) throw new Error("skills/editor_template.html must start with its <style>");
  const end = template.indexOf("</style>") + "</style>".length;
  let body = template.slice(end).trim();
  for (const [mark, tags] of [["<!--@RUNTIME@-->", runtime.map(scriptTag).join("\n")], ["<!--@DATA@-->", scriptTag({ src: data })]]) {
    if (body.split(mark).length !== 2) throw new Error("skills/editor_template.html must hold " + mark + " once");
    body = body.replace(mark, () => tags);
  }
  // English is the language of a first visit; assets/i18n.js sets the language that the page shows.
  return `<!doctype html>\n<html lang="en">\n<head>\n${head(title)}\n${template.slice(0, end)}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

// The color tokens of the map page (light and dark), so the start page and the legal pages share them.
function tokens() {
  const css = plain(path.join(SKILLS, "editor_template.html"));
  const found = css.match(/:root \{\n[\s\S]*?\n\}\n@media \(prefers-color-scheme: dark\) \{\n[\s\S]*?\n\}\n:root\[data-theme="dark"\] \{\n[\s\S]*?\n\}\n/);
  if (!found) throw new Error("the color tokens of skills/editor_template.html were not found");
  return "/* The color tokens of the map page (skills/editor_template.html), copied by build_selfhost.js. */\n" + found[0];
}

// Runs the runtime of the site in a small stand-in of a browser, so the build reads a map file with the rules of an import.
// Its texts are English.
function runtimeStore(runtimeSource) {
  const texts = englishTexts(), win = { addEventListener() {}, ...texts };
  new Function("window", "location", "document", "t", runtimeSource)(win, { search: "" }, undefined, texts.t);
  return win.SkillMapRuntime;
}
function readMap(file, R) {
  const parsed = R.store.parseFile(plain(file));
  if (parsed.error) throw new Error(file + ": " + parsed.error);
  return parsed.map;
}
// A map file, read with the rules of an import, as the build reads the example map. The tests build pages from it.
const readMapFile = (file) => readMap(file, runtimeStore(plain(RUNTIME_FILES["assets/runtime-local.js"])));
// The default set of a new map (selfhost/site/default-set.js): { title, empty, collections }, whose names are keys of the
// catalogs. The file names each key as t("<key>"); the build reads it with a t that gives the key itself. Each key must be
// in English, and the map, with the texts of each language, must pass the rules of an import and keep every document.
// Areas, categories and skills carry an order, as in the map file, so the layout stays stable.
function defaultSet(R) {
  const set = new Function("t", "return (" + plain(DEFAULT_SET) + "\n);")((key) => key);
  const texts = catalogs.texts(), keys = [set.title, set.empty];
  for (const docs of Object.values(set.collections)) for (const doc of Object.values(docs)) keys.push(doc.name);
  const missing = keys.filter((key) => typeof key !== "string" || typeof texts.en[key] !== "string");
  if (missing.length) throw new Error(DEFAULT_SET + ": no English text for " + missing.join(", "));
  for (const [code, own] of Object.entries(texts)) {
    const text = (key) => typeof own[key] === "string" ? own[key] : texts.en[key];
    const collections = Object.fromEntries(Object.entries(set.collections).map(([name, docs]) => [name,
      Object.fromEntries(Object.entries(docs).map(([id, doc]) => [id, { ...doc, name: text(doc.name) }]))]));
    for (const [title, content] of [[text(set.title), collections], [text(set.empty), {}]]) {
      const result = R.store.parseFile(JSON.stringify({ format: R.FORMAT, schema: R.SCHEMA, title, exportedAt: "2026-10-19T00:00:00Z", collections: content }));
      if (result.error) throw new Error(DEFAULT_SET + " in " + code + ": " + result.error);
      for (const [name, docs] of Object.entries(content)) {
        if (Object.keys(result.map.collections[name] || {}).length !== Object.keys(docs).length) throw new Error(DEFAULT_SET + " in " + code + ": the import drops a document of " + name);
      }
    }
  }
  return set;
}

// The version of a file: the first 12 hex digits of the SHA-256 of its content.
const contentHash = (content) => crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
// Gives each address of a file of the site in a page or a style a version: assets/page.js?v=<hash of its content>. After
// an update the address changes with the content, so a browser never runs old page code with a new page. The proxy (and
// the web server of DEPLOY.md) lets the browser keep an address with a version for a year, and asks it to check every
// other file again. The fonts get their version in fonts.css first, so the version of fonts.css follows them. Only the
// files that a page loads get one: scripts, styles, the icon and images, not the links to pages and to the licenses.
function versionAddresses(files) {
  const versioned = (rel) => files.has(rel) && !rel.endsWith(".html") ? rel + "?v=" + contentHash(files.get(rel)) : null;
  const css = "vendor/fonts/fonts.css";
  files.set(css, String(files.get(css)).replace(/url\("([^"?]+)"\)/g, (all, name) => { const v = versioned("vendor/fonts/" + name); return v ? `url("${v.slice("vendor/fonts/".length)}")` : all; }));
  for (const [rel, content] of files) {
    if (!rel.endsWith(".html")) continue;
    files.set(rel, String(content).replace(/<(?:script|link|img)\b[^>]*>/gi, (tag) => tag.replace(/\b(src|href)="([^"?#]+)"/, (all, name, address) => {
      const v = versioned(address);
      return v ? `${name}="${v}"` : all;
    })));
  }
}

// A handle shares the top-level paths with the site and the app: <BASE_URL>/<handle> is the address of an owner. So no
// handle may be a top-level name of the site (a folder, or a file without its extension) or of the app (the first name
// of each route of server/app). The server refuses every name of RESERVED in server/app/security.py as a handle, and the
// proxy sends every path of a reserved subdomain to the app (server/proxy/reserved.caddy). The build stops when a
// top-level name has the form of a handle (HANDLE_RE, without "--") and RESERVED lacks it, or when the two lists differ.
const SERVER_APP = path.join(repo, "server", "app"), RESERVED_CADDY = path.join(repo, "server", "proxy", "reserved.caddy");
function handleRules() {
  const source = plain(path.join(SERVER_APP, "security.py"));
  const form = source.match(/^HANDLE_RE = re\.compile\(r"([^"]+)"\)$/m), list = source.match(/^RESERVED = frozenset\("""([\s\S]*?)"""\.split\(\)\)$/m);
  if (!form || !list) throw new Error("server/app/security.py: HANDLE_RE or RESERVED was not found");
  const pattern = new RegExp(form[1]);
  return { reserved: new Set(list[1].split(/\s+/).filter(Boolean)), isHandle: (name) => pattern.test(name) && !name.includes("--") };
}
// The top-level names of the app: the prefix of each router, else the first name of each of its routes.
function appNames() {
  const names = new Set();
  for (const file of fs.readdirSync(SERVER_APP).filter((name) => name.endsWith(".py"))) {
    const source = plain(path.join(SERVER_APP, file));
    const prefixes = [...source.matchAll(/APIRouter\(\s*prefix="([^"]*)"/g)].map((m) => m[1]);
    const routes = [...source.matchAll(/@(?:router|app)\.(?:get|post|put|patch|delete|api_route)\(\s*"([^"]*)"/g)].map((m) => m[1]);
    for (const address of prefixes.length ? prefixes : routes) {
      const first = address.split("/")[1] || "";
      if (first && !first.startsWith("{")) names.add(first.replace(/\.[^.]*$/, ""));
    }
  }
  return names;
}
// The names of reserved.caddy: one regular expression of the Host header, ^(?:name|name|...)\.
function caddyNames(text = plain(RESERVED_CADDY)) {
  const found = text.match(/^@reserved header_regexp reserved Host \(\?i\)\^\(\?:([a-z0-9|-]+)\)\\\.$/m);
  if (!found) throw new Error("server/proxy/reserved.caddy: the line @reserved header_regexp reserved Host (?i)^(?:...)\\. was not found");
  return new Set(found[1].split("|"));
}
// The top-level names of the site and the app that are free as a handle, and the names in which RESERVED and
// reserved.caddy differ. siteFiles: the paths of the files of the site. Empty lists mean that every name is safe.
function topLevelProblems(siteFiles, { rules = handleRules(), caddy = caddyNames() } = {}) {
  const names = new Set(appNames());
  for (const rel of siteFiles) names.add(rel.includes("/") ? rel.split("/")[0] : rel.replace(/\.[^.]*$/, ""));
  const free = [...names].filter((name) => rules.isHandle(name) && !rules.reserved.has(name)).sort();
  const differ = [...new Set([...rules.reserved, ...caddy])].filter((name) => rules.reserved.has(name) !== caddy.has(name)).sort();
  return { names: [...names].sort(), free, differ };
}
function checkTopLevelNames(siteFiles) {
  const { free, differ } = topLevelProblems(siteFiles);
  if (free.length) throw new Error("these top-level names of the site or the app are free as a handle: " + free.join(", ")
    + ". Add them to RESERVED in server/app/security.py and to server/proxy/reserved.caddy.");
  if (differ.length) throw new Error("RESERVED in server/app/security.py and server/proxy/reserved.caddy differ in: " + differ.join(", "));
}

// Every page and style of the site, checked for a link to another host. A link of an <a> tag to an https address is
// allowed, because the browser loads nothing from it until the reader follows it.
function checkLocal(file, text) {
  const loaded = text.replace(/<a\s[^>]*>/gi, (tag) => tag.replace(/\bhref\s*=\s*(["'])https:\/\/[^"'\s>]+\1/i, ""));
  const external = loaded.match(/(?:\b(?:src|href|action|poster|data)\s*=\s*["']?|url\(\s*["']?|@import\s+["'])(?:https?:)?\/\/[^"')\s>]+/gi);
  if (external) throw new Error(file + " links to another host: " + external.join(", "));
}

// A folder at dir, also where a file of an older build has the name of the folder.
function folderAt(dir) {
  try {
    if (fs.statSync(dir).isDirectory()) return;
    fs.rmSync(dir);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    folderAt(path.dirname(dir));
  }
  fs.mkdirSync(dir);
}
// Moves a file to its place in one step: the place has either the old file or the new one. Windows refuses the rename
// for a moment while another program has the old file open, so it tries again for up to a second.
function moveInto(from, to) {
  if (fs.existsSync(to) && fs.statSync(to).isDirectory()) fs.rmSync(to, { recursive: true, force: true });
  for (let tries = 0; ; tries++) {
    try { return fs.renameSync(from, to); } catch (error) {
      if (tries >= 50 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
// Writes the files of the site into out. The proxy and the app of the compose stack serve out while a build runs (an
// update), so out is never empty and never holds half a file. Each file goes to a folder next to out first, and then
// takes the place of its old version in one rename. The pages come last, so that no new page names a file that is not
// there yet. Then the files of the old build that the new one lacks go. out itself stays, because the stack mounts it,
// and a new folder would hide the build from the stack.
function writeSite(out, files) {
  const stage = path.join(path.dirname(out), "." + path.basename(out) + ".build-" + process.pid);
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    for (const [rel, content] of files) {
      const file = path.join(stage, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    const order = [...files.keys()].sort((a, b) => a.endsWith(".html") - b.endsWith(".html"));
    for (const rel of order) {
      const file = path.join(out, rel);
      folderAt(path.dirname(file));
      moveInto(path.join(stage, rel), file);
    }
    const keep = new Set(files.keys());
    const prune = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix + entry.name, full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          prune(full, rel + "/");
          if (!fs.readdirSync(full).length) fs.rmdirSync(full);
        } else if (!keep.has(rel)) fs.rmSync(full, { force: true });
      }
    };
    prune(out, "");
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// The site in out. pseudo adds the pseudo language of the tests (i18nScript); the site of node build_selfhost.js never
// has it. Every file is ready and checked before the first one goes to out, so a failed build leaves the old site.
function build(out = OUT, { pseudo = false } = {}) {
  const files = mapAssets({ pseudo });
  const put = (rel, content) => files.set(rel, content);
  const runtimeSource = plain(path.join(SELF, "runtime", "local.js")), R = runtimeStore(runtimeSource);
  const example = readMap(EXAMPLE, R), layout = files.get("assets/layout.js");

  put("assets/example.data.js", dataScript(dataOfMap(example), layout));
  put("assets/map.data.js", dataScript(dataOfMap(BLANK), layout));
  put("example.html", mapPage({ title: example.title, runtime: RUNTIMES.example, data: "assets/example.data.js" }));
  put("map.html", mapPage({ title: BLANK.title, runtime: RUNTIMES.browser, data: "assets/map.data.js" }));
  put("server-map.html", mapPage({ title: BLANK.title, runtime: RUNTIMES.server, data: "assets/map.data.js" }));
  // The titles of the start page and of the legal pages come from the catalogs.
  const english = englishTexts();
  for (const [name, title, key] of [["index.html", english.t("start.pageTitle"), "start.pageTitle"], ["imprint.html", english.t("legal.imprintTitle"), "legal.imprintTitle"],
    ["privacy.html", english.t("legal.privacyTitle"), "legal.privacyTitle"], ["ai.html", english.t("ai.pageTitle"), "ai.pageTitle"]]) {
    const source = fillLegal(plain(path.join(SELF, "site", name)));
    if (source.split("<!--@HEAD@-->").length !== 2) throw new Error(name + " must hold <!--@HEAD@--> once");
    put(name, source.replace("<!--@HEAD@-->", () => head(title, key)));
  }
  for (const [rel, file] of Object.entries(RUNTIME_FILES)) put(rel, plain(file));
  put("assets/templates.js", "// The templates for a new map, made by build_selfhost.js from selfhost/site/default-set.js and templates.js.\nwindow.SKILL_MAP_DEFAULT_SET = "
    + JSON.stringify(defaultSet(R), null, 1) + ";\n" + plain(path.join(SELF, "site", "templates.js")));
  put("assets/start.js", plain(path.join(SELF, "site", "start.js")));
  put("assets/agent.js", plain(path.join(SELF, "site", "agent.js")));
  put("assets/ai.js", plain(path.join(SELF, "site", "ai.js")));
  // The files for AI tools. The example passes the rules of an import, or the build stops. SKILLMAP_SITE_URL, for
  // example https://it-skills.net, makes the links of llms.txt absolute. Without it they are relative.
  readMap(AI_EXAMPLE, R);
  const siteBase = (process.env.SKILLMAP_SITE_URL || "").replace(/\/+$/, "");
  put("llms.txt", plain(path.join(SELF, "site", "llms.txt")).split("@SITE@").join(siteBase ? siteBase + "/" : ""));
  put("license.txt", plain(path.join(repo, "LICENSE")));
  put("ai/format.txt", plain(path.join(SELF, "site", "ai", "format.txt")));
  put("ai/example.it-skills-map.json", plain(AI_EXAMPLE));
  put("assets/account.js", plain(path.join(SELF, "site", "account.js")));
  put("assets/site.css", tokens() + plain(path.join(SELF, "site", "site.css")));
  versionAddresses(files);
  checkTopLevelNames(files.keys());

  for (const [rel, content] of files) {
    if (/\.(html|css|js|svg)$/.test(rel) && !rel.startsWith("vendor/")) checkLocal(rel, String(content));
  }
  writeSite(out, files);
  const size = [...files.values()].reduce((t, c) => t + Buffer.byteLength(c), 0);
  console.log(`built ${path.relative(process.cwd(), out) || "."}: ${files.size} files, ${Math.round(size / 1024)} KB, the example map "${example.title}"${pseudo ? ", with the pseudo language " + PSEUDO.code : ""}`);
}

if (require.main === module) build(path.resolve(process.argv[2] || OUT));
module.exports = { build, mapAssets, mapPage, dataScript, dataOfMap, readMapFile, readConfigs, layoutScript, i18nScript, contentHash, topLevelProblems, handleRules, caddyNames,
  RUNTIMES, RUNTIME_FILES, POLICY, CSP, OUT, EXAMPLE, DEFAULT_SET, PSEUDO, PDF_FONT_FILES };

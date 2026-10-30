// Reads the catalogs of the interface texts (i18n/README.md). The build, the check and the two tools of the batch
// translation read them with this module. There are two folders of catalogs, each with one folder per language:
//
//   i18n/<language>/              the texts of the pages (FILES)
//   server/app/i18n/<language>/   the texts of the server (SERVER_FILES): its error texts, its mails and the texts that it
//                                 writes into a map. The image of the server holds only the folder server/, so its
//                                 catalogs live there. The pages show the error texts too, so the build takes errors.json
//                                 into assets/i18n.js (PAGE_SERVER_FILES); the other files of the server stay out of it.
//
// A key is unique across both folders. An English entry is "key": { "text": ..., "note": ... }, an entry of another
// language "key": { "text": ..., "source": ... }. A text is a string, or an object with the forms of Intl.PluralRules
// ({ "one": ..., "other": ... }). read() stops on a file that breaks these rules, so that no build carries a broken catalog.
const fs = require("fs"), path = require("path");

const ROOT = path.join(__dirname, "..");
const REPO = path.join(ROOT, "..");
const SERVER_ROOT = path.join(REPO, "server", "app", "i18n");
const SOURCE = "en";
// The parts of the product, in the order of the files. A language may leave out a file, English may not.
const FILES = ["page.json", "menu.json", "site.json", "account.json", "server.json", "default.json"];
const SERVER_FILES = ["errors.json", "mail.json", "content.json"];
// The files of the server whose texts the pages show too.
const PAGE_SERVER_FILES = ["errors.json"];
const FORMS = ["zero", "one", "two", "few", "many", "other"];
const KEY = /^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)+$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const plain = (file) => fs.readFileSync(file, "utf8").split("\r").join("");

// The two folders of catalogs: the folder on disk, its name in messages and its files.
const folders = (root = ROOT, serverRoot = SERVER_ROOT) => [
  { dir: root, name: path.relative(REPO, root).split(path.sep).join("/") || "i18n", files: FILES },
  { dir: serverRoot, name: path.relative(REPO, serverRoot).split(path.sep).join("/") || "server/app/i18n", files: SERVER_FILES },
];

// The forms of a text: [text] for a string, the values of a plural object.
const formsOf = (text) => typeof text === "string" ? [text] : Object.values(text);
// The names of the placeholders of a text, sorted, each once.
const placeholdersOf = (text) => [...new Set(formsOf(text).flatMap((form) => [...form.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();
const sameText = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A text with plural forms in one language has them in every language: a count that English counts in its words needs
// the forms of the other language too, as "1 Kenntnis" against "2 Kenntnisse". The problem of a translation, or null.
const pluralProblem = (english, text) => (typeof english === "string") === (typeof text === "string") ? null
  : typeof english === "string" ? "a plural, but English has none" : "no plural, but English has the forms " + Object.keys(english).join(", ");

function checkText(text, where) {
  if (typeof text === "string") {
    if (!text) throw new Error(where + ": the text is empty");
  } else if (text && typeof text === "object" && !Array.isArray(text)) {
    const forms = Object.keys(text);
    if (!forms.includes("other") || forms.some((f) => !FORMS.includes(f)) || formsOf(text).some((f) => typeof f !== "string" || !f)) {
      throw new Error(where + ": a text with a plural is an object of the forms " + FORMS.join(", ") + ", with other, and each form is a text");
    }
  } else throw new Error(where + ": the text is a string or an object of plural forms");
  if (formsOf(text).some((f) => /[<>&"]/.test(f))) throw new Error(where + ": a text holds no <, >, & or \" (write “ ” or „ “)");
}

const languagesIn = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && LANGUAGE.test(d.name)).map((d) => d.name) : [];
const sortLanguages = (list) => [...new Set(list)].sort((a, b) => (a === SOURCE ? -1 : b === SOURCE ? 1 : a.localeCompare(b)));

// { languages: [code], pageLanguages, serverLanguages, catalogs: { <code>: Map(key -> { text, note | source, file, folder }) } }.
// English comes first. languages holds the languages of both folders; check.js fails when the two folders differ.
function read(root = ROOT, serverRoot = SERVER_ROOT) {
  const all = folders(root, serverRoot);
  const found = all.map((folder) => sortLanguages(languagesIn(folder.dir)));
  all.forEach((folder, i) => { if (!found[i].includes(SOURCE)) throw new Error(`${folder.name}/en/ is missing: English is the source catalog`); });
  const languages = sortLanguages(found.flat());
  const catalogs = {};
  for (const code of languages) {
    const entries = new Map();
    for (const folder of all) {
      const dir = path.join(folder.dir, code);
      if (!fs.existsSync(dir)) continue;
      const names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const name of names) if (!folder.files.includes(name)) throw new Error(`${folder.name}/${code}/${name}: the files are ${folder.files.join(", ")}`);
      for (const name of folder.files) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) {
          if (code === SOURCE) throw new Error(`${folder.name}/${code}/${name} is missing`);
          continue;
        }
        let raw;
        try { raw = JSON.parse(plain(file)); } catch (error) { throw new Error(`${folder.name}/${code}/${name}: ${error.message}`); }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${folder.name}/${code}/${name}: the file is one object of entries`);
        for (const [key, entry] of Object.entries(raw)) {
          const where = `${folder.name}/${code}/${name}: ${key}`;
          if (!KEY.test(key)) throw new Error(where + ": a key is <part>.<name>, in camelCase, with a dot between the parts");
          if (entries.has(key)) throw new Error(where + ": the key is in " + pathOf(entries.get(key), code) + " too");
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(where + ": an entry is { text, " + (code === SOURCE ? "note" : "source") + " }");
          checkText(entry.text, where);
          if (code === SOURCE) {
            if (typeof entry.note !== "string" || !entry.note.trim()) throw new Error(where + ": an English entry has a note for the translator");
            if (Object.keys(entry).some((k) => k !== "text" && k !== "note")) throw new Error(where + ": an English entry has only text and note");
          } else {
            if (entry.source !== undefined) checkText(entry.source, where + " (source)");
            if (Object.keys(entry).some((k) => k !== "text" && k !== "source")) throw new Error(where + ": an entry of a translation has only text and source");
          }
          entries.set(key, { ...entry, file: name, folder: folder.name });
        }
      }
    }
    catalogs[code] = entries;
  }
  return { languages, pageLanguages: found[0], serverLanguages: found[1], catalogs };
}

// The path of the file of an entry in a language, relative to the repository: i18n/de/page.json.
const pathOf = (entry, code) => `${entry.folder}/${code}/${entry.file}`;

// A catalog file in its one layout: one entry per line, in the order of the keys given, so a change of one text is a
// change of one line. entries: [[key, { text, note | source }]].
const value = (text) => typeof text === "string" ? JSON.stringify(text)
  : "{ " + FORMS.filter((f) => Object.hasOwn(text, f)).map((f) => JSON.stringify(f) + ": " + JSON.stringify(text[f])).join(", ") + " }";
function format(entries) {
  if (!entries.length) return "{}\n";
  return "{\n" + entries.map(([key, e]) => "  " + JSON.stringify(key) + ": { \"text\": " + value(e.text)
    + (e.note !== undefined ? ", \"note\": " + JSON.stringify(e.note) : "") + (e.source !== undefined ? ", \"source\": " + value(e.source) : "") + " }").join(",\n") + "\n}\n";
}
// Writes every file of every language in that layout. A translation takes the order of the English keys of its file, and
// a key that English lacks goes to the end, where the check names it.
function write(root = ROOT, serverRoot = SERVER_ROOT) {
  const { languages, catalogs } = read(root, serverRoot);
  const order = new Map([...catalogs[SOURCE].keys()].map((key, i) => [key, i]));
  for (const folder of folders(root, serverRoot)) for (const code of languages) for (const name of folder.files) {
    const entries = [...catalogs[code]].filter(([, e]) => e.file === name && e.folder === folder.name).map(([key, { file, folder: f, ...e }]) => [key, e]);
    if (code !== SOURCE) entries.sort(([a], [b]) => (order.has(a) ? order.get(a) : Infinity) - (order.has(b) ? order.get(b) : Infinity));
    const file = path.join(folder.dir, code, name);
    if (!entries.length && !fs.existsSync(file)) continue;
    const text = format(entries);
    if (!fs.existsSync(file) || plain(file) !== text) fs.writeFileSync(file, text);
  }
}

// The texts of every language for the pages: { <code>: { <key>: text } }, without notes and sources. They are the
// texts of i18n/ and of the files of the server that the pages show (PAGE_SERVER_FILES), not the mails.
function texts(root = ROOT, serverRoot = SERVER_ROOT) {
  const { languages, catalogs } = read(root, serverRoot);
  const server = folders(root, serverRoot)[1].name;
  const forPages = (e) => e.folder !== server || PAGE_SERVER_FILES.includes(e.file);
  return Object.fromEntries(languages.map((code) => [code, Object.fromEntries([...catalogs[code]].filter(([, e]) => forPages(e)).map(([key, e]) => [key, e.text]))]));
}

module.exports = { ROOT, REPO, SERVER_ROOT, SOURCE, FILES, SERVER_FILES, PAGE_SERVER_FILES, LANGUAGE, folders, read, texts, write, format, pathOf, placeholdersOf, sameText, formsOf,
  pluralProblem };

// node i18n/tools/catalogs.js --write: brings every catalog file into its layout.
if (require.main === module && process.argv.includes("--write")) { write(); console.log("the catalogs are in their layout"); }

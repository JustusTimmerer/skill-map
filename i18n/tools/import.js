// The second half of a batch translation (i18n/README.md): merges a filled file of export.js into the catalog of its
// language. Each filled entry goes into the file of its English key, in the same folder (i18n/ or server/app/i18n/), with
// source = the English text of the export.
// Usage: node i18n/tools/import.js <file>
//
// It skips an entry with an empty text, an entry whose placeholders differ from English, an entry whose plural forms
// are not forms of Intl.PluralRules, an entry without plural forms whose English text has them (or the other way
// round), and an entry whose key or English text changed since the export. It names each one, and the next export lists
// those keys again.
const fs = require("fs"), path = require("path");
const catalogs = require("./catalogs");

// root and serverRoot: other folders of catalogs than i18n/ and server/app/i18n/, for a test of the import.
function merge(batch, { root, serverRoot } = {}) {
  const code = batch && batch.language;
  if (typeof code !== "string" || !catalogs.LANGUAGE.test(code) || code === catalogs.SOURCE) throw new Error("the file names no language to import");
  if (!batch.entries || typeof batch.entries !== "object") throw new Error("the file has no entries");
  const { catalogs: all } = catalogs.read(root, serverRoot), en = all[catalogs.SOURCE];
  // The folders of the language: i18n/<code>/ and server/app/i18n/<code>/, each with its files.
  const folders = catalogs.folders(root, serverRoot).map((folder) => ({ name: folder.name, dir: path.join(folder.dir, code), files: folder.files }));
  const files = new Map(), merged = [], skipped = [];
  const fileOf = (folder, name) => {
    const file = path.join(folder.dir, name);
    if (!files.has(file)) files.set(file, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
    return files.get(file);
  };
  for (const [key, entry] of Object.entries(batch.entries)) {
    const english = en.get(key), text = entry && entry.text;
    if (!english) { skipped.push(`${key}: English has no such key any more`); continue; }
    if (!catalogs.sameText(entry.english, english.text)) { skipped.push(`${key}: its English text changed since the export`); continue; }
    if (text === "" || text === undefined || text === null) { skipped.push(`${key}: no text yet`); continue; }
    try { checkOne(text, key); } catch (error) { skipped.push(`${key}: ${error.message}`); continue; }
    const plural = catalogs.pluralProblem(english.text, text);
    if (plural) { skipped.push(`${key}: the text has ${plural}`); continue; }
    if (catalogs.placeholdersOf(text).join() !== catalogs.placeholdersOf(english.text).join()) {
      skipped.push(`${key}: other placeholders than English {${catalogs.placeholdersOf(english.text).join("} {")}}`);
      continue;
    }
    // A key that moved to another file of English leaves its old file.
    for (const folder of folders) for (const name of folder.files) {
      const home = folder.name === english.folder && name === english.file;
      if (!home && fs.existsSync(path.join(folder.dir, name)) && Object.hasOwn(fileOf(folder, name), key)) delete fileOf(folder, name)[key];
    }
    fileOf(folders.find((folder) => folder.name === english.folder), english.file)[key] = { text, source: english.text };
    merged.push(key);
  }
  for (const [file, entries] of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries, null, 2) + "\n");
  }
  // The layout of the catalogs: one entry per line, in the order of English (catalogs.write).
  catalogs.write(root, serverRoot);
  return { code, merged, skipped };
}

// The rules of a text of the catalogs, for one entry (catalogs.js checks the same for whole files).
function checkOne(text, key) {
  const forms = ["zero", "one", "two", "few", "many", "other"];
  const list = typeof text === "string" ? [text] : text && typeof text === "object" && !Array.isArray(text) ? Object.values(text) : null;
  if (!list || list.some((f) => typeof f !== "string" || !f)) throw new Error("a text is a string or an object of plural forms");
  if (typeof text === "object" && (!Object.hasOwn(text, "other") || Object.keys(text).some((f) => !forms.includes(f)))) throw new Error("a plural text has the form other and only the forms " + forms.join(", "));
  if (list.some((f) => /[<>&"]/.test(f))) throw new Error("a text holds no <, >, & or \"");
  return key;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node i18n/tools/import.js <file of export.js>"); process.exit(2); }
  let result;
  try { result = merge(JSON.parse(fs.readFileSync(file, "utf8"))); } catch (error) { console.error("import failed: " + error.message); process.exit(1); }
  result.skipped.forEach((line) => console.log("skipped  " + line));
  console.log(`${result.merged.length} keys merged into i18n/${result.code}/ and server/app/i18n/${result.code}/, ${result.skipped.length} skipped. Run npm run check:texts next.`);
}

module.exports = { merge };

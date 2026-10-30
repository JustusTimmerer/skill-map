// The first half of a batch translation (i18n/README.md): writes every key that a language lacks, and every key whose
// source is not the English text of today, into one file for the translator.
// Usage: node i18n/tools/export.js <language> [file]   (default file: i18n/batches/<language>-<date>.json)
//
// The file: { language, exportedAt, entries: { <key>: { file, english, note, usedIn, previous?, text } } }. file is the
// English file of the key (i18n/en/page.json or server/app/i18n/en/mail.json), english the English text of today,
// previous the translation of a stale key, and text is empty for the translator.
const fs = require("fs"), path = require("path");
const catalogs = require("./catalogs");
const scan = require("./scan");

function open(code) {
  const { catalogs: all } = catalogs.read();
  if (code === catalogs.SOURCE) throw new Error("English is the source catalog; name another language");
  const en = all[catalogs.SOURCE], other = all[code] || new Map(), { used } = scan.usedKeys();
  const entries = {};
  for (const [key, entry] of en) {
    const known = other.get(key);
    if (known && catalogs.sameText(known.source, entry.text)) continue;
    const usedIn = used.has(key) ? [...used.get(key)] : [];
    entries[key] = { file: catalogs.pathOf(entry, catalogs.SOURCE), english: entry.text, note: entry.note, usedIn, ...(known ? { previous: known.text } : {}), text: "" };
  }
  return { language: code, exportedAt: new Date().toISOString(), entries };
}

if (require.main === module) {
  const [code, out] = process.argv.slice(2);
  if (!code || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(code)) { console.error("usage: node i18n/tools/export.js <language> [file]"); process.exit(2); }
  const batch = open(code);
  const file = path.resolve(out || path.join(catalogs.ROOT, "batches", `${code}-${batch.exportedAt.slice(0, 10)}.json`));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(batch, null, 2) + "\n");
  const n = Object.keys(batch.entries).length, stale = Object.values(batch.entries).filter((e) => e.previous !== undefined).length;
  console.log(`${path.relative(process.cwd(), file)}: ${n} keys of ${code} to translate, ${stale} of them stale`);
}

module.exports = { open };

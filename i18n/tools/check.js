// The check of the interface texts: npm run check:texts (i18n/README.md). It reads the catalogs of the pages (i18n/) and
// of the server (server/app/i18n/). It fails when
//   - the code uses a key that English lacks: a key of the pages, a key of the server, or the text of an error of the
//     server (error.<code> or error.<code>.<variant>), or the server names a key or an error code that is no literal string,
//   - nothing uses a key of English,
//   - another language has a key that English lacks, or holds it in another file than English,
//   - the placeholders of a key differ between English and another language,
//   - the pages and the server have other languages,
//   - a text of English has plural forms and its translation has none, or the other way round.
// It warns about each key that another language lacks, and about each key whose source is not the English text of
// today: that translation is open or stale. With --complete, these warnings fail too (a merge into main).
// A catalog file that breaks the format (i18n/tools/catalogs.js) fails the check too.
// Usage: node i18n/tools/check.js [--complete] [--verbose]   (--verbose also lists the keys that the code builds at run time)
const catalogs = require("./catalogs");
const scan = require("./scan");

// root and serverRoot: other folders of catalogs than i18n/ and server/app/i18n/, for a test of the check.
function check({ complete = false, root, serverRoot } = {}) {
  const { languages, pageLanguages, serverLanguages, catalogs: all } = catalogs.read(root, serverRoot);
  const en = all[catalogs.SOURCE], { used, dynamic, serverDynamic } = scan.usedKeys();
  const rules = [
    { name: "every key that the code uses is in English", problems: [] },
    { name: "the code uses every key of English", problems: [] },
    { name: "every key of another language is in English, in the same file", problems: [] },
    { name: "the placeholders of each key are the same in every language", problems: [] },
    { name: "the server has the languages of the pages", problems: [] },
    { name: "a text has plural forms in every language or in none", problems: [] },
  ];
  const warnings = [];
  for (const [key, files] of used) if (!en.has(key)) rules[0].problems.push(`${key}: ${[...files].join(", ")}`);
  serverDynamic.forEach((where) => rules[0].problems.push(where));
  for (const [key, entry] of en) if (!used.has(key)) rules[1].problems.push(`${key} (${catalogs.pathOf(entry, catalogs.SOURCE)})`);
  for (const code of languages.filter((c) => c !== catalogs.SOURCE)) {
    const other = all[code];
    for (const [key, entry] of other) {
      if (!en.has(key)) { rules[2].problems.push(`${code}: ${key} (${catalogs.pathOf(entry, code)})`); continue; }
      const english = en.get(key);
      if (entry.file !== english.file || entry.folder !== english.folder) rules[2].problems.push(`${code}: ${key} is in ${catalogs.pathOf(entry, code)}, in English in ${catalogs.pathOf(english, catalogs.SOURCE)}`);
      const a = catalogs.placeholdersOf(english.text), b = catalogs.placeholdersOf(entry.text);
      if (a.join() !== b.join()) rules[3].problems.push(`${code}: ${key}: en {${a.join("} {")}}, ${code} {${b.join("} {")}}`);
      const plural = catalogs.pluralProblem(english.text, entry.text);
      if (plural) rules[5].problems.push(`${code}: ${key} has ${plural} (${catalogs.pathOf(entry, code)})`);
      if (!catalogs.sameText(entry.source, english.text)) warnings.push(`${code}: ${key} is stale: its source is not the English text of today`);
    }
    for (const key of en.keys()) if (!other.has(key)) warnings.push(`${code} lacks ${key}`);
  }
  for (const code of pageLanguages.filter((c) => !serverLanguages.includes(c))) rules[4].problems.push(`${code}: i18n/${code}/ has no folder server/app/i18n/${code}/`);
  for (const code of serverLanguages.filter((c) => !pageLanguages.includes(c))) rules[4].problems.push(`${code}: server/app/i18n/${code}/ has no folder i18n/${code}/`);
  if (complete) rules.push({ name: "every language has every key, translated from the English text of today (--complete)", problems: warnings.splice(0) });
  return { languages, keys: en.size, used: used.size, rules, warnings, dynamic };
}

if (require.main === module) {
  const complete = process.argv.includes("--complete"), verbose = process.argv.includes("--verbose");
  let result;
  try { result = check({ complete }); } catch (error) { console.log("FAIL the catalogs: " + error.message); process.exit(1); }
  const { languages, keys, used, rules, warnings, dynamic } = result;
  for (const rule of rules) {
    console.log((rule.problems.length ? "FAIL " : "ok   ") + rule.name);
    rule.problems.forEach((line) => console.log("       " + line));
  }
  warnings.forEach((line) => console.log("WARN " + line));
  if (verbose) dynamic.forEach((line) => console.log("info a key that the code builds at run time: " + line));
  const failed = rules.filter((r) => r.problems.length).length;
  console.log(`${rules.length - failed} of ${rules.length} checks passed: ${keys} keys in English, ${used} keys in the code, languages ${languages.join(", ")}, ${warnings.length} warnings`);
  process.exitCode = failed ? 1 : 0;
}

module.exports = { check };

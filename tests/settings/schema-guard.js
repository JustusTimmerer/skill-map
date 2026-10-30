// The guard for the format of the values of the force menu. The keys of SPEC in the built page must be the keys that
// tests/settings/schema.json lists for SPRING_SCHEMA, so a new, renamed or removed setting cannot change the format of
// saved configurations without a new version and a migration step.
const fs = require("fs"), path = require("path");
const SCHEMA_FILE = path.join(__dirname, "schema.json");

// The problems of a built editor page, as sentences. An empty list means the page and schema.json agree.
function schemaProblems(html, file = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"))) {
  const spec = html.match(/const SPEC = (\[.*?\]);\n/), version = html.match(/const SPRING_SCHEMA = (\d+);/);
  if (!spec || !version) return ["the page has no SPEC or no SPRING_SCHEMA"];
  const items = JSON.parse(spec[1]).flatMap((g) => g.items), schema = Number(version[1]), versions = file.versions || {};
  const problems = [];
  for (let n = 1; n <= schema; n++) if (!versions[n]) problems.push("schema.json has no entry for version " + n);
  if (versions[schema + 1]) problems.push("schema.json has version " + (schema + 1) + ", but SPRING_SCHEMA is " + schema);
  const entry = versions[schema];
  if (!entry) return problems;
  // A line control has one value per mode (its "look" field); every other control is a top-level key.
  const now = { top: items.filter((it) => !it.look).map((it) => it.key), lines: items.filter((it) => it.look).map((it) => it.key) };
  const diff = [];
  for (const part of ["top", "lines"]) {
    const added = now[part].filter((k) => !entry[part].includes(k)), gone = entry[part].filter((k) => !now[part].includes(k));
    if (added.length) diff.push("new in SPEC (" + part + "): " + added.join(", "));
    if (gone.length) diff.push("gone from SPEC (" + part + "): " + gone.join(", "));
  }
  if (diff.length) problems.push("SPEC changed: raise SPRING_SCHEMA and add a migration step. Version " + schema + " in tests/settings/schema.json differs: " + diff.join("; ") + ".");
  return problems;
}

module.exports = { schemaProblems, SCHEMA_FILE };

// Writes the example map of the site, selfhost/site/example.it-skills-map.json, from his data: skills/data.js,
// skills/projects.json and skills/configs.json. The file is a map file in the format of selfhost/FORMAT.md, with the
// configurations and the pick for readers. build_selfhost.js reads it for the example map (example.html) and for the
// IT template of a new map. Run it again after each export from the live editor.
// Usage: node save_example.js [outFile]
const fs = require("fs"), path = require("path");

const repo = __dirname, SKILLS = path.join(repo, "skills");
const OUT = path.join(repo, "selfhost", "site", "example.it-skills-map.json");
const TITLE = "Skill-Atlas · Alex Beispiel (Demo)";
// The note below "Private Projekte" in the overview of his map (settings/texts.privateNote in selfhost/FORMAT.md).
const PRIVATE_NOTE = "In der Freizeit mit eigenen Abonnements von KI-Anbietern umgesetzt.";
// The collections in the order of selfhost/FORMAT.md, as an export writes them.
const COLLECTIONS = ["areas", "stations", "groups", "skills", "projects", "configs", "settings"];
const plain = (file) => fs.readFileSync(file, "utf8").split("\r").join("");

// The constants of a data file in the shape of skills/data.js.
function readData(text) {
  return new Function(text + "\nreturn { COLORS, CLUSTERS, GROUPS, WHERE, SKILLS, STANDARD, PROJECTS };")();
}
// A document id from a name, as the editor makes the id of a new skill.
function slug(text) {
  const plainText = text.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return plainText.slice(0, 60).replace(/-+$/, "") || "kenntnis";
}
// The documents of a collection, sorted by id, as an export writes them.
const byId = (docs) => Object.fromEntries(Object.keys(docs).sort().map((id) => [id, docs[id]]));

// The collections of a map from data in the shape of skills/data.js, the projects (an array with ids) and the
// configurations ({ reader, configs }). Each area, station, category and skill keeps its place in data.js as its
// order, so the map keeps its layout. The document settings/texts holds the note below "Private Projekte".
function collectionsOf(data, projects, configs) {
  const d = readData(data);
  const areas = Object.fromEntries(d.CLUSTERS.map((c, i) => [c.id, { name: c.name, color: d.COLORS[c.id], at: c.at.slice(), order: i }]));
  const stations = Object.fromEntries(Object.entries(d.PROJECTS).map(([id, p], i) => [id, { name: p.name, short: d.WHERE[id] && d.WHERE[id] !== p.name ? d.WHERE[id] : "",
    kind: p.kind, when: p.when, months: p.months, note: p.note, order: i }]));
  const groups = Object.fromEntries(d.GROUPS.map(([id, area, name], i) => [id, { name, area, order: i }]));
  const skills = {};
  d.SKILLS.forEach(([name, group, rating, where], i) => {
    let id = slug(name);
    for (let n = 2; skills[id]; n++) id = slug(name) + "-" + n;
    skills[id] = { name, group, rating, places: String(where || "").split(/\s+/).filter(Boolean), order: i, ...(d.STANDARD[name] ? { standard: { ...d.STANDARD[name] } } : {}) };
  });
  const projectDocs = Object.fromEntries(projects.map(({ id, ...p }) => [id, { name: p.name, station: p.station, base: p.base === true, order: p.order, when: p.when || "", skills: p.skills.slice() }]));
  const configDocs = Object.fromEntries(configs.configs.map(({ id, name, schema, values, savedAt }) => [id, { name, schema, values, savedAt }]));
  const settings = { ...(configs.reader ? { reader: { config: configs.reader } } : {}), texts: { privateNote: PRIVATE_NOTE } };
  const all = { areas, stations, groups, skills, projects: projectDocs, configs: configDocs, settings };
  return Object.fromEntries(COLLECTIONS.filter((name) => Object.keys(all[name]).length).map((name) => [name, byId(all[name])]));
}

// The example map from the files of his data. The time of the export stays as it is while the map stays the same, so a
// run without a change leaves the file as it is.
function exampleMap(files = {}) {
  const dataFile = files.data || path.join(SKILLS, "data.js"), projectsFile = files.projects || path.join(SKILLS, "projects.json");
  const configsFile = files.configs || path.join(SKILLS, "configs.json"), outFile = files.out || OUT;
  const configs = fs.existsSync(configsFile) ? JSON.parse(plain(configsFile)) : { reader: null, configs: [] };
  const collections = collectionsOf(plain(dataFile), JSON.parse(plain(projectsFile)), configs);
  let exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (fs.existsSync(outFile)) {
    const before = JSON.parse(plain(outFile));
    if (before.title === TITLE && JSON.stringify(before.collections) === JSON.stringify(collections)) exportedAt = before.exportedAt;
  }
  return { format: "it-skills-map", schema: 1, title: TITLE, exportedAt, collections };
}

if (require.main === module) {
  const outFile = path.resolve(process.argv[2] || OUT);
  const map = exampleMap({ out: outFile });
  fs.writeFileSync(outFile, JSON.stringify(map, null, 2) + "\n");
  const counts = Object.entries(map.collections).map(([name, docs]) => `${Object.keys(docs).length} ${name}`).join(", ");
  console.log(`wrote ${path.relative(process.cwd(), outFile)}: "${map.title}", ${counts}, exported at ${map.exportedAt}`);
}

module.exports = { exampleMap, collectionsOf, readData, TITLE, OUT };

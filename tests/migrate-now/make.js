const fs = require("fs"), path = require("path");
const src = fs.readFileSync(process.argv[2], "utf8");
const { SKILLS, GROUPS, STANDARD, PROJECTS, WHERE } = new Function(src + "; return { SKILLS, GROUPS, STANDARD, PROJECTS, WHERE };")();
function slug(text) {
  const plain = text.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return plain.slice(0, 60).replace(/-+$/, "") || "skill";
}
const groups = GROUPS.map(([id, area, name], order) => ({ op: "set", collection: "groups", doc_id: id, data: { name, area, order } }));
const taken = new Set();
const skills = SKILLS.map(([name, group, rating, where], order) => {
  let id = slug(name), stem = id;
  for (let i = 2; taken.has(id); i++) id = stem + "-" + i;
  taken.add(id);
  const data = { name, group, rating, places: where ? where.split(" ") : [], order };
  if (STANDARD[name]) data.standard = { text: STANDARD[name].text, since: STANDARD[name].since };
  return { op: "set", collection: "skills", doc_id: id, data };
});
const unknownPlaces = skills.filter((s) => s.data.places.some((p) => !PROJECTS[p]));
console.log("groups", groups.length, "skills", skills.length, "standard", skills.filter((s) => s.data.standard).length);
console.log("places outside PROJECTS:", unknownPlaces.map((s) => s.data.name + " " + s.data.places.join(" ")).join("; ") || "none");
console.log("renamed ids:", skills.filter((s) => s.doc_id !== slug(s.data.name)).map((s) => s.data.name + " -> " + s.doc_id).join("; ") || "none");
const all = [...groups, ...skills];
for (let i = 0; i * 50 < all.length; i++) fs.writeFileSync(path.join(__dirname, `batch${i + 1}.json`), JSON.stringify(all.slice(i * 50, i * 50 + 50)));
console.log("batches", Math.ceil(all.length / 50));

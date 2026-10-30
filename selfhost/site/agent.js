// The entry of the start page for AI agents and scripts: window.SkillMap. It reads a map as the import of a map file
// does, checks the links between the documents, and stores the map in this browser. The format is described in
// ai/format.txt, and llms.txt names this entry. The page needs no network for it.
(() => {
  "use strict";
  const R = window.SkillMapRuntime;
  if (!R) return;
  const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  const RATINGS = [-1, 0, 1, 2, 3];
  const MAX_WARNINGS = 50;
  const docs = (map, name) => (isObject(map.collections[name]) ? Object.entries(map.collections[name]).filter(([, doc]) => isObject(doc)) : []);

  // The problems that the import accepts but that make the map wrong: a link to a document that is not there, a
  // rating that the page does not know, a name twice. An agent reads them and fixes the map.
  function lint(map) {
    const warnings = [];
    const warn = (text) => warnings.push(text);
    const areas = new Set(docs(map, "areas").map(([id]) => id)), groups = new Set(docs(map, "groups").map(([id]) => id));
    const stations = new Set(docs(map, "stations").map(([id]) => id)), names = new Map();
    if (!areas.size) warn("The map has no areas, so it shows nothing.");
    for (const [id, doc] of docs(map, "areas")) {
      if (typeof doc.name !== "string" || !doc.name.trim()) warn(`areas/${id}: the field "name" is missing, so the page does not show the area.`);
      if (doc.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(doc.color))) warn(`areas/${id}: "color" must look like #2c5fc4.`);
      if (doc.at !== undefined && !(Array.isArray(doc.at) && doc.at.length === 2 && doc.at.every(Number.isFinite))) warn(`areas/${id}: "at" must be two numbers, [x, y].`);
    }
    for (const [id, doc] of docs(map, "groups")) {
      if (typeof doc.name !== "string" || !doc.name.trim()) warn(`groups/${id}: the field "name" is missing.`);
      if (!areas.has(doc.area)) warn(`groups/${id}: "area" is ${JSON.stringify(doc.area)}, which is no id in areas, so the page does not show the category.`);
    }
    for (const [id, doc] of docs(map, "stations")) {
      if (typeof doc.name !== "string" || !doc.name.trim()) warn(`stations/${id}: the field "name" is missing.`);
      if (/i$/.test(id)) warn(`stations/${id}: a station id must not end in "i", because places marks an indirect use with a trailing "i".`);
      if (id === "PRIVAT") warn(`stations/${id}: the id PRIVAT is reserved for private projects.`);
    }
    for (const [id, doc] of docs(map, "skills")) {
      const name = typeof doc.name === "string" ? doc.name.trim() : "";
      if (!name) warn(`skills/${id}: the field "name" is missing.`);
      else if (names.has(name)) warn(`skills/${id}: the name ${JSON.stringify(name)} is also the name of skills/${names.get(name)}. A name must be unique.`);
      else names.set(name, id);
      if (!groups.has(doc.group)) warn(`skills/${id}: "group" is ${JSON.stringify(doc.group)}, which is no id in groups, so the page does not show the skill.`);
      if (!RATINGS.includes(doc.rating)) warn(`skills/${id}: "rating" must be one of ${RATINGS.join(", ")}.`);
      if (doc.places !== undefined && !Array.isArray(doc.places)) warn(`skills/${id}: "places" must be a list of station ids.`);
      else for (const place of doc.places || []) {
        const station = stations.has(place) ? place : String(place).replace(/i$/, "");
        if (!stations.has(station)) warn(`skills/${id}: "places" names ${JSON.stringify(place)}, which is no id in stations.`);
      }
      if (isObject(doc.standard) && !stations.has(doc.standard.since)) warn(`skills/${id}: standard.since is ${JSON.stringify(doc.standard.since)}, which is no id in stations.`);
    }
    for (const [id, doc] of docs(map, "projects")) {
      if (typeof doc.name !== "string" || !doc.name.trim()) warn(`projects/${id}: the field "name" is missing.`);
      if (doc.station !== "PRIVAT" && !stations.has(doc.station)) warn(`projects/${id}: "station" is ${JSON.stringify(doc.station)}, which is no id in stations and not PRIVAT.`);
      if (doc.skills !== undefined && !Array.isArray(doc.skills)) warn(`projects/${id}: "skills" must be a list of skill names.`);
      else for (const skill of doc.skills || []) if (!names.has(skill)) warn(`projects/${id}: "skills" names ${JSON.stringify(skill)}, which is the name of no skill.`);
    }
    return warnings.length > MAX_WARNINGS ? [...warnings.slice(0, MAX_WARNINGS), `and ${warnings.length - MAX_WARNINGS} more.`] : warnings;
  }

  const counts = (map) => Object.fromEntries(R.COLLECTIONS.map((name) => [name, docs(map, name).length]));
  // The map file as text, from a text or an object.
  function textOf(input) {
    if (typeof input === "string") return input;
    try { return JSON.stringify(input); } catch (error) { return null; }
  }
  function read(input) {
    const text = textOf(input);
    if (text === undefined || text === null) return { error: "The input must be the text of a map file or an object." };
    if (new Blob([text]).size > R.MAX_FILE_BYTES) return { error: `The map file is larger than ${R.MAX_FILE_MB} MB.` };
    return R.store.parseFile(text);
  }

  // Checks a map file and stores nothing: { ok, title, counts, warnings } or { ok: false, error }.
  function validate(input) {
    const parsed = read(input);
    if (parsed.error) return { ok: false, error: parsed.error };
    return { ok: true, title: parsed.map.title, counts: counts(parsed.map), warnings: lint(parsed.map) };
  }
  // Stores a map file as a new map of this browser: { ok, id, url, title, counts, warnings } or { ok: false, error }.
  // With { open: true } the page then opens the map. The default is to stay on the page, so that the caller reads the
  // answer first and opens the url itself.
  function importMap(input, options = {}) {
    const parsed = read(input);
    if (parsed.error) return { ok: false, error: parsed.error };
    let id;
    try { id = R.store.create(parsed.map.title, parsed.map.collections); } catch (error) { return { ok: false, error: error.message }; }
    const url = new URL(R.mapUrl(id), location.href).href;
    if (isObject(options) && options.open === true) location.href = url;
    return { ok: true, id, url, title: parsed.map.title, counts: counts(parsed.map), warnings: lint(parsed.map) };
  }

  const at = (name) => new URL(name, location.href).href;
  window.SkillMap = Object.freeze({
    format: R.FORMAT, schema: R.SCHEMA,
    docs: Object.freeze({ llms: at("llms.txt"), format: at("ai/format.txt"), example: at("ai/example.it-skills-map.json") }),
    validate, importMap,
  });
})();

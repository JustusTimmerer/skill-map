// The code of the map page, assets/page.js of the site. Before it, the page loads the runtime of its host, d3, its data
// file (assets/<page>.data.js: MAP_TITLE, the data in the shape of skills/data.js, STATIC_PROJECTS, STATIC_CONFIGS,
// MAP_TEXTS and LINE_REFERENCE) and the layout with the force menu (assets/layout.js), all as files of the site (build_selfhost.js).
//
// The runtime is the only code that talks to the host. A runtime file of the site sets window.SKILL_MAP_RUNTIME before
// this file runs: selfhost/runtime/local.js for the example map and the maps of this browser, selfhost/runtime/server.js
// for a map on the server. db() gives the same promise on every call, of the database of the map or of null. isOwner()
// gives a promise of true or false. A runtime can also offer features, home, texts, mapInfo(), rename(), exportMap() and
// openMapFile() (selfhost/runtime/local.js names them). Without a runtime, the page shows the data of its data file to a
// reader.
const runtime = window.SKILL_MAP_RUNTIME || { db: () => Promise.resolve(null), isOwner: () => Promise.resolve(false) };
// What the runtime lets the page offer. The runtimes of the site name editStructure: the owner edits the areas and
// stations in the database; and mapFile: the export and the import of the map file, and a link to the start page. A
// runtime without features shows the map of the data file, and its owner edits the projects and the catalog.
// OWN_MAP: the runtime knows the map and its title (runtime.mapInfo), so the page is the map of a visitor and not the
// CV map of the data file. Its texts then name nobody.
// TEXTS: the sentences that say where the map lives, which differ between the hosts (selfhost/runtime/local.js).
const FEATURES = runtime.features || {};
const OWN_MAP = typeof runtime.mapInfo === "function";
const TEXTS = runtime.texts || {};
const panel = document.getElementById("panel");
// The heading names the map of the data file; the map of a visitor names its own title once the runtime knows it.
document.getElementById("title").textContent = MAP_TITLE;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// The interface texts come from the catalogs in i18n/ through t (assets/i18n.js, which every page loads first).
const RATING = { 3: t("rating.veryGood"), 2: t("rating.good"), 1: t("rating.basic"), 0: t("rating.unused"), [-1]: t("rating.ai") };
const PROJECT_COLLECTION = "projects";
const SAVE_DELAY_MS = 400;

function symbolMarkup(kind, r) {
  if (kind === 3) return `<path class="s-fill" d="${starPath(r, r * 0.45)}" stroke-width="${r * 0.1}" stroke-linejoin="round"/>`;
  if (kind === 2) return `<circle class="s-ring" r="${r}" stroke-width="${r * 0.2}"/><path class="s-fill" style="stroke:none" d="${starPath(r * 0.72, r * 0.32)}"/>`;
  if (kind === 1) return `<circle class="s-fill" r="${r}" stroke-width="${r * 0.12}"/>`;
  if (kind === KI) return `<circle class="s-ring" r="${r}" stroke-width="${r * 0.28}" stroke-dasharray="${r * 0.62} ${r * 0.42}"/>`;
  return `<circle class="s-ring" r="${r}" stroke-width="${r * 0.3}"/>`;
}
const legendIcon = (kind, area) => `<svg ${area ? `class="k-${esc(area)}"` : 'style="--c: var(--ink)"'} width="20" height="20" viewBox="-10 -10 20 20">${symbolMarkup(kind, kind === 3 ? 8 : kind === 2 ? 6.4 : 4.8)}</svg>`;

// The stem of a new id from a name. A name without a letter of a to z or a digit, such as "日本", gets the stem "item".
// The ids that a page made before keep their stem "projekt": nothing renames a stored id.
function slug(text) {
  const plain = text.toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return plain.slice(0, 60).replace(/-+$/, "") || "item";
}

async function retryOnce(call) {
  try {
    return await call();
  } catch (error) {
    if (!error || error.code !== "unavailable") throw error;
    await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 800));
    return call();
  }
}

// One document per project in the database of the map; local edits win over snapshots until their write has landed.
function createStore(onChange) {
  // writing counts the writes of each project that are on their way, again holds the projects that changed meanwhile.
  const projects = new Map(), timers = new Map(), writing = new Map(), again = new Set(), removed = new Set();
  let collection = null, available = null, loaded = false, readOnly = false, mayWrite = false, lastError = "";
  const dirty = (id) => timers.has(id) || writing.has(id) || again.has(id);
  const normalize = (data) => ({
    name: typeof data.name === "string" ? data.name : "",
    station: typeof data.station === "string" ? data.station : "",
    base: data.base === true,
    order: Number.isFinite(data.order) ? data.order : 0,
    when: typeof data.when === "string" ? data.when : "",
    skills: Array.isArray(data.skills) ? data.skills.filter((s) => typeof s === "string") : [],
  });

  async function connect() {
    const db = await runtime.db();
    available = !!db;
    if (!db) {
      // Without a database (the example map, a saved copy of the page) the page shows the projects of its data file.
      if (typeof STATIC_PROJECTS !== "undefined") {
        STATIC_PROJECTS.forEach(({ id, ...data }) => projects.set(id, normalize(data)));
        loaded = true;
      }
      onChange("data");
      return;
    }
    collection = db.collection(PROJECT_COLLECTION);
    collection.onSnapshot((snap) => {
      const seen = new Set(snap.docs.map((doc) => doc.id));
      snap.docs.forEach((doc) => { if (!dirty(doc.id) && !removed.has(doc.id)) projects.set(doc.id, normalize(doc.data())); });
      [...projects.keys()].forEach((id) => { if (!seen.has(id) && !dirty(id)) projects.delete(id); });
      loaded = true;
      onChange("data");
    }, (error) => { lastError = error.code; onChange("status"); });
  }
  function save(id) {
    lastError = "";
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => { timers.delete(id); flush(id); }, SAVE_DELAY_MS));
    onChange("status");
  }
  // A change waits while an earlier write of the same project is on its way, and its newest body goes when that write
  // ends. now sends it at once, beside the write on its way (flushAll).
  async function flush(id, now = false) {
    if (writing.has(id) && !now) { again.add(id); return; }
    writing.set(id, (writing.get(id) || 0) + 1);
    onChange("status");
    const body = projects.get(id), ref = collection.doc(id);
    let refused = false;
    try {
      await retryOnce(() => body ? ref.set({ ...body, skills: [...body.skills] }) : ref.delete());
    } catch (error) {
      lastError = error && error.code ? error.code : t("status.unknownError");
      // Only a refusal of the right makes the projects read-only for this visit, and the view drops its edit controls.
      // Any other refusal fails this one write; the status names it, and the next write tries again.
      if (lastError === "permission_denied" && !readOnly) { readOnly = true; refused = true; }
    }
    if (writing.get(id) > 1) writing.set(id, writing.get(id) - 1); else writing.delete(id);
    if (again.delete(id)) flush(id); else onChange(refused ? "data" : "status");
  }
  function remove(id) {
    projects.delete(id);
    removed.add(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
    flush(id);
  }
  // Every change goes to the runtime now: on pagehide, when the tab hides, at the end of the edit mode and before an
  // export. A project whose earlier write is still on its way sends its newest body at once too (D1 of the final
  // review), because the page can be gone before that write ends. The runtime of the server sends it behind that write,
  // or at once and without base when the page goes (selfhost/runtime/server.js).
  function flushAll() {
    [...timers.keys()].forEach((id) => { clearTimeout(timers.get(id)); timers.delete(id); flush(id); });
    [...again].forEach((id) => { again.delete(id); flush(id, true); });
  }
  return {
    projects, connect, save, remove, flushAll,
    allowWrites() { mayWrite = true; },
    taken: (id) => projects.has(id) || removed.has(id),
    get available() { return available; },
    get loaded() { return loaded; },
    get writable() { return available === true && loaded && !readOnly && mayWrite; },
    get error() { return lastError; },
    get status() {
      if (available === false) return "offline";
      if (readOnly) return "readonly";
      if (lastError) return "error";
      if (timers.size || writing.size) return "pending";
      return loaded ? "saved" : "connecting";
    },
  };
}

// Collections of documents that the owner edits in the page: a change applies at once and stays over older snapshots
// until its write has landed. writeMany applies several changes as one, so a delete with its dependents draws once.
function createCollections(KINDS, normalize, onChange) {
  const docs = Object.fromEntries(KINDS.map((k) => [k, new Map()])), shown = Object.fromEntries(KINDS.map((k) => [k, new Map()]));
  const pending = new Map(), seen = new Set();
  let db = null, lastError = "";
  function rebuild(kind) {
    shown[kind] = new Map(docs[kind]);
    pending.forEach((body, key) => {
      const [k, id] = key.split("/");
      if (k !== kind) return;
      if (body) shown[kind].set(id, body); else shown[kind].delete(id);
    });
  }
  async function connect() {
    db = await runtime.db();
    if (!db) return;
    KINDS.forEach((kind) => db.collection(kind).onSnapshot((snap) => {
      docs[kind] = new Map(snap.docs.map((doc) => [doc.id, normalize[kind](doc.data())]));
      seen.add(kind);
      rebuild(kind);
      onChange();
    }, (error) => { lastError = error.code; onChange(); }));
  }
  // Applies the changes at once and keeps them over older snapshots until their writes have landed.
  async function writeMany(changes) {
    const kinds = [...new Set(changes.map(([kind]) => kind))];
    changes.forEach(([kind, id, body]) => pending.set(kind + "/" + id, body));
    lastError = "";
    kinds.forEach(rebuild);
    onChange();
    await Promise.all(changes.map(async ([kind, id, body]) => {
      const ref = db.collection(kind).doc(id);
      try {
        await retryOnce(() => body ? ref.set(body) : ref.delete());
        if (body) docs[kind].set(id, body); else docs[kind].delete(id);
      } catch (error) {
        lastError = error && error.code ? error.code : t("status.unknownError");
      }
      pending.delete(kind + "/" + id);
    }));
    kinds.forEach(rebuild);
    onChange();
  }
  return {
    connect, writeMany, write: (kind, id, body) => writeMany([[kind, id, body]]),
    docs: (kind) => shown[kind],
    get loaded() { return !!db && seen.size === KINDS.length; },
    get pending() { return pending.size > 0; },
    get error() { return lastError; },
  };
}

// All categories and skills of the database; the data file of the page holds the same for a page without one.
function createCatalog(onChange) {
  const orderOf = (data) => Number.isFinite(data.order) ? data.order : Number.MAX_SAFE_INTEGER;
  const normalize = {
    groups: (data) => ({ name: typeof data.name === "string" ? data.name : "", area: typeof data.area === "string" ? data.area : "", order: orderOf(data) }),
    skills: (data) => {
      const skill = {
        name: typeof data.name === "string" ? data.name : "",
        group: typeof data.group === "string" ? data.group : "",
        rating: [3, 2, 1, 0, KI].includes(data.rating) ? data.rating : 1,
        places: Array.isArray(data.places) ? data.places.filter((p) => typeof p === "string") : [],
        order: orderOf(data),
      };
      const standard = data.standard;
      if (standard && typeof standard.text === "string" && typeof standard.since === "string") skill.standard = { text: standard.text, since: standard.since };
      return skill;
    },
  };
  const docs = createCollections(["groups", "skills"], normalize, onChange);
  return {
    connect: docs.connect, write: docs.write, writeMany: docs.writeMany,
    get groups() { return docs.docs("groups"); },
    get skills() { return docs.docs("skills"); },
    get loaded() { return docs.loaded; },
    get pending() { return docs.pending; },
    get error() { return docs.error; },
  };
}

// The areas and stations of a map whose runtime offers editStructure (the self-hosted site): the collections "areas",
// { name, color, at, order }, and "stations", { name, short, kind, when, months, note, order }, with the fields of
// CLUSTERS, COLORS, WHERE and PROJECTS in data.js. Without the feature the page never opens them and keeps data.js.
const AREA_ID = /^[a-z][a-z0-9_-]{0,39}$/, STATION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const STATION_KINDS = ["Arbeitgeber", "Ausbildung", "Privates Projekt"];
// The page shows each stored kind with its text; a kind outside the list shows as it is stored.
const KIND_TEXTS = new Map([["Arbeitgeber", t("station.kindEmployer")], ["Ausbildung", t("station.kindEducation")], ["Privates Projekt", t("station.kindPrivate")]]);
const kindText = (kind) => KIND_TEXTS.has(kind) ? KIND_TEXTS.get(kind) : kind;
function createStructure(onChange) {
  const orderOf = (data) => Number.isFinite(data.order) ? data.order : Number.MAX_SAFE_INTEGER;
  const text = (x) => typeof x === "string" ? x : "";
  const normalize = {
    areas: (data) => ({ name: text(data.name), color: /^#[0-9a-f]{6}$/i.test(data.color) ? data.color.toLowerCase() : "#596763",
      at: Array.isArray(data.at) && data.at.length === 2 && data.at.every(Number.isFinite) ? [data.at[0], data.at[1]] : null, order: orderOf(data) }),
    stations: (data) => ({ name: text(data.name), short: text(data.short), kind: text(data.kind) || STATION_KINDS[0], when: text(data.when),
      months: Number.isFinite(data.months) && data.months >= 0 ? data.months : 0, note: text(data.note), order: orderOf(data) }),
  };
  const docs = createCollections(["areas", "stations"], normalize, onChange);
  return {
    connect: () => FEATURES.editStructure ? docs.connect() : Promise.resolve(), write: docs.write, writeMany: docs.writeMany,
    get areas() { return docs.docs("areas"); },
    get stations() { return docs.docs("stations"); },
    get loaded() { return docs.loaded; },
    get pending() { return docs.pending; },
    get error() { return docs.error; },
  };
}

// The first layout takes seconds and blocks the page. It starts after the next paint, so the reader sees the loading
// message in place of a blank map, also when the scripts come from the cache.
function startOnce() {
  try {
    if (!window.d3) panel.innerHTML = `<h2>${t("map.notLoaded")}</h2><p>${t("map.notLoadedHint")}</p>`;
    else start();
  } finally {
    document.getElementById("map-loading").hidden = true;
    window.skillMapStarted = true;
    document.dispatchEvent(new Event("skillmap:started"));
  }
}
// A hidden page gets no frame until it shows, so it starts at once. A frame of another site outside the view gets no
// frames either, so the timer starts it.
if (document.hidden) startOnce();
else {
  let started = false;
  const once = () => { if (!started) { started = true; startOnce(); } };
  requestAnimationFrame(() => setTimeout(once, 0));
  setTimeout(once, 200);
}

function start() {
  // The configuration for readers of the data file (STATIC_CONFIGS: the pick of its map file) applies before the first
  // layout, so the map is drawn once. Without a pick, the values of layout.js apply.
  const builtPick = STATIC_CONFIGS.configs.find((c) => c.id === STATIC_CONFIGS.reader) || null;
  const builtState = builtPick ? springConfigState(builtPick) : null;
  if (builtState) springApply(builtState);
  const baseGroups = GROUPS.slice(), baseSkills = SKILLS.slice();
  let nodes = [], links = [], byId = new Map(), groupName = new Map(), node = null, treeLink = null;
  // The id of the clicked skill, category or area whose lines the map shows, or null for the lines of the whole map.
  let lineSelection = null;
  // Time range filter (his wish of 2026-10-17): the months from the start of the earliest station to NOW_MONTH.
  // timeRange is { from, to } in months, or null for all years. timeActive holds the active places and timeSkills the
  // ids of the skills in the range; both are null without a range, and then nothing is filtered.
  // The first month changes only when the stations of a self-hosted map change (applyStructure).
  const firstMonth = () => Math.min(NOW_MONTH, ...Object.values(PROJECTS).map((p) => placeMonths(p.when)).filter(Boolean).map((m) => m.from));
  let TIME_FIRST = firstMonth();
  const TIME_LAST = NOW_MONTH;
  let timeRange = null, timeActive = null, timeSkills = null;
  // The names of the areas and of the categories, by id. A name or an id of the map is looked up only as a key of a Map or
  // as an own key of a table (stationOf), so "constructor" or "toString" in a map is no member of a plain object.
  const areaName = new Map(CLUSTERS.map((c) => [c.id, c.name]));
  // The station of a code (placeOf in layout.js): a code of the map that is no station gives null.
  const stationOf = placeOf;

  const svg = d3.select("#map");
  const viewport = svg.append("g");
  const useLayer = viewport.append("g"), treeLayer = viewport.append("g"), nodeLayer = viewport.append("g");
  // An arc from one share of the circle to another, clockwise from the top. Real arcs, because dashed circles leave a gap.
  const arcPath = (r, from, to) => {
    if (to - from <= 0) return "";
    if (to - from > 0.9999) return `M0,${-r}A${r},${r} 0 1 1 0,${r}A${r},${r} 0 1 1 0,${-r}`;
    const at = (f) => `${r * Math.sin(2 * Math.PI * f)},${-r * Math.cos(2 * Math.PI * f)}`;
    return `M${at(from)}A${r},${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${at(to)}`;
  };
  // The ring starts at the top and runs clockwise: first the fresh years, then the aged share, both out of EXPERIENCE_FULL_YEARS.
  const experienceRing = (n) => {
    const fill = Math.min(1, n.xpYears / EXPERIENCE_FULL_YEARS), fresh = fill * (1 - n.xpAgeing), aged = fill * n.xpAgeing, r = n.r + 1.1;
    return `<g class="xp"><circle class="xp-track" r="${r}"/>`
      + `<path class="xp-fresh" data-share="${fresh}" d="${arcPath(r, 0, fresh)}"/>`
      + `<path class="xp-aged" data-share="${aged}" d="${arcPath(r, fresh, fresh + aged)}"/></g>`;
  };
  const experienceText = (n) => {
    const years = Math.round(n.xpYears * 2) / 2, months = Math.max(1, Math.round(n.xpYears * 12));
    const span = n.xpYears < 1 ? t("experience.months", { count: months })
      : t("experience.years", { count: years, years: SkillMapI18n.number(years, { useGrouping: false, maximumFractionDigits: 1 }) });
    return n.xpAsOf !== null && n.xpAsOf !== undefined ? t("experience.textAsOf", { span, year: n.xpLastYear, month: monthText(n.xpAsOf) })
      : t("experience.text", { span, year: n.xpLastYear });
  };
  // A month as "MM.YYYY" in every language, the format of the dates of the stations and of the forms. Intl gives no fixed
  // numeric month: the browser formats de-DE as "MM/YYYY".
  const monthText = (m) => String(m % 12 + 1).padStart(2, "0") + "." + Math.floor(m / 12);
  // One line system: pairs of categories, pairs of skills, or skill to category, by LINE_MODE, of the whole map or of the
  // selection. A line from a skill to a category takes the area color of the skill. The lines change no force.
  // The id of the gradient of a line comes from its key: each character other than a letter, a digit or "-" becomes its code.
  const gradientId = (l) => "line-gradient-" + l.key.replace(/[^A-Za-z0-9-]/g, (c) => "_" + c.charCodeAt(0).toString(16) + "_");
  function drawLines() {
    const selected = lineSelection ? byId.get(lineSelection) : null;
    // With a time range, a line counts only its connections through the active places.
    const drawn = SHOW_LINES ? drawnLines(nodes, links, selected, timeActive) : [];
    // With LINE_GRADIENT, a Skill-Skill or Kategorie-Kategorie line runs along its chord from the area color of its source
    // to the area color of its target, in map units. The stops read the area colors of the theme, so a theme change needs
    // no new drawing. Without the option, the map has no gradients.
    const gradient = LINE_GRADIENT && LINE_MODE !== "mixed";
    useLayer.selectAll("defs.line-gradients").data(gradient ? [drawn] : []).join((enter) => enter.insert("defs", ":first-child").attr("class", "line-gradients"))
      .selectAll("linearGradient").data((d) => d, (l) => l.key)
      .join((enter) => enter.append("linearGradient").attr("gradientUnits", "userSpaceOnUse").call((g) => { g.append("stop").attr("offset", 0); g.append("stop").attr("offset", 1); }))
      .attr("id", gradientId).attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y).attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y)
      .call((g) => g.select("stop:first-child").style("stop-color", (l) => `var(--c-${l.source.cluster})`))
      .call((g) => g.select("stop:last-child").style("stop-color", (l) => `var(--c-${l.target.cluster})`));
    useLayer.selectAll("path.shared-line").data(drawn).join("path")
      .attr("class", (l) => l.kind === "mixed-line" ? `shared-line mixed k-${l.source.cluster}` : "shared-line")
      .attr("d", (l) => { const x1 = l.source.x, y1 = l.source.y, x2 = l.target.x, y2 = l.target.y, mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        return `M${x1},${y1}Q${mx - (y2 - y1) * LINE_BEND},${my + (x2 - x1) * LINE_BEND} ${x2},${y2}`; })
      .attr("stroke-width", (l) => LINE_WIDTH_MIN + (LINE_WIDTH_MAX - LINE_WIDTH_MIN) * l.share)
      .attr("stroke-opacity", (l) => LINE_OPACITY_MIN + (LINE_OPACITY_MAX - LINE_OPACITY_MIN) * l.share)
      .style("stroke", gradient ? (l) => `url(#${gradientId(l)})` : null);
    svg.classed("line-filter", !!selected);
  }
  // Runs again whenever categories or skills added in the editor change the data.
  function drawMap() {
    ({ nodes, links } = computeLayout());
    byId = new Map(nodes.map((n) => [n.id, n]));
    groupName = new Map(GROUPS.map(([id, , name]) => [id, name]));
    // A time range set before a new layout: the ageing counts to its end, and the lines count its places.
    if (timeRange) { nodes.forEach((n) => { if (n.type === "skill") Object.assign(n, experienceOf(n.places, timeRange.to)); }); computeTime(); }
    [useLayer, treeLayer, nodeLayer].forEach((layer) => layer.selectAll("*").remove());
    svg.style("--shared-light", LINE_COLOR_LIGHT).style("--shared-dark", LINE_COLOR_DARK);
    drawLines();
    treeLink = treeLayer.selectAll("path").data(links.filter((l) => l.kind === "group" ? SHOW_SKILL_LINKS : l.kind === "area" && SHOW_AREA_LINKS)).join("path")
      .attr("class", (l) => `tree k-${l.source.cluster}`).attr("d", linkPath)
      // A line grows with the sizes of both levels it connects.
      .attr("stroke-width", (l) => l.kind === "area" ? AREA_LINK_WIDTH * Math.sqrt(AREA_SCALE * GROUP_SCALE) : SKILL_LINK_WIDTH * Math.sqrt(GROUP_SCALE * SKILL_SCALE));
    node = nodeLayer.selectAll("g").data(nodes).join("g")
      .attr("class", (n) => `node k-${n.cluster} t-${n.type}`).attr("transform", (n) => `translate(${n.x},${n.y})`);
    node.append("circle").attr("class", "hit").attr("r", (n) => n.r + 3);
    node.each(function (n) {
      if (n.type === "skill") this.insertAdjacentHTML("beforeend", `<circle class="mark" r="${n.r + 2}" stroke-width="0.7"/>` + symbolMarkup(n.rating, n.r) + (hasRing(n) ? experienceRing(n) : ""));
      else d3.select(this).append("circle").attr("class", n.type === "area" ? "dot-area" : "dot-group").attr("r", n.r).attr("stroke-width", n.type === "area" ? 0.8 * AREA_SCALE : 0.5 * GROUP_SCALE);
    });
    node.filter((n) => n.type === "skill").append("title").text((n) => n.label + (hasRing(n) ? ` · ${experienceText(n)}` : ""));
    node.append("rect").attr("class", "card").attr("rx", 0.8);
    node.append("text").attr("text-anchor", "middle").attr("class", (n) => n.type === "skill" ? "t-skill" : n.type === "group" ? "t-group" : "t-area")
      .attr("font-weight", (n) => n.type === "skill" && n.rating < 3 ? 400 : 700).text((n) => n.label);
    bindNodes();
    if (timeRange) markTime();
  }
  // The skills in the time range: a skill counts when one of its places is active, an active project holds it, or an
  // active place counts for it as a standard skill (inTime in layout.js). A project without its own months takes the
  // months of its station.
  function computeTime() {
    if (!timeRange) { timeActive = null; timeSkills = null; return; }
    timeActive = activePlaces(timeRange.from, timeRange.to);
    const projectSkills = new Set();
    store.projects.forEach((p) => { if (inMonths(projectMonths(p), timeRange.from, timeRange.to)) p.skills.forEach((name) => projectSkills.add(name)); });
    timeSkills = new Set(nodes.filter((n) => n.type === "skill" && inTime(n, timeActive, projectSkills)).map((n) => n.id));
  }
  const inRange = (s) => !timeSkills || timeSkills.has(s.id);
  const placeInRange = (key) => !timeActive || timeActive.has(key);
  const projectInRange = (p) => !timeRange || inMonths(projectMonths(p), timeRange.from, timeRange.to);
  // Skills outside the range fade, and so do categories and areas without a skill in it, with their tree lines.
  function markTime() {
    const groups = new Set(), areas = new Set();
    nodes.forEach((n) => { if (n.type === "skill" && inRange(n)) { groups.add(n.group); areas.add(n.cluster); } });
    const out = (n) => !!timeSkills && (n.type === "skill" ? !timeSkills.has(n.id) : n.type === "group" ? !groups.has(n.group) : !areas.has(n.cluster));
    node.classed("out-of-time", out);
    treeLink.classed("out-of-time", (l) => out(l.target));
  }
  drawMap();

  let scale = 1, interacted = false, focusSet = null, selectedId = null, labelAlways = new Set();
  const baseSize = (n) => n.type === "area" ? AREA_PT * AREA_SCALE : n.type === "group" ? GROUP_PT * GROUP_SCALE : n.fs;
  // Labels keep a readable size on screen; small skill names appear once they are large enough to read.
  function updateLabels() {
    node.each(function (n) {
      const size = n.type === "area" ? Math.max(AREA_PT, 15 / scale) * AREA_SCALE : n.type === "group" ? Math.min(GROUP_PT * 1.25, Math.max(GROUP_PT, 9 / scale)) * GROUP_SCALE : n.fs;
      const visible = n.type !== "skill" || (focusSet && focusSet.has(n.id)) || labelAlways.has(n.label) || n.fs * scale >= (n.rating === 3 ? 6.5 : 7.5);
      const width = n.lw * size / baseSize(n), height = size * 1.1;
      const top = n.type === "area" ? -n.r - 1.5 - height : n.r + 0.4 + ringRoom(n);
      const g = d3.select(this);
      g.select("text").attr("display", visible ? null : "none").attr("font-size", size).attr("y", top + size * 0.86);
      g.select("rect").attr("display", visible ? null : "none").attr("x", -width / 2 - 0.5).attr("y", top - 0.2).attr("width", width + 1).attr("height", height + 0.4);
    });
  }

  const zoom = d3.zoom().scaleExtent([0.3, 14]).on("zoom", (event) => {
    viewport.attr("transform", event.transform);
    scale = event.transform.k;
    updateLabels();
    if (event.sourceEvent) interacted = true;
  });
  svg.call(zoom).on("dblclick.zoom", null);
  function zoomTo(subset, animate = true) {
    // A map without nodes, such as a new empty map, shows its middle.
    const b = subset.length ? layoutBounds(subset, 6) : { x0: -120, x1: 120, y0: -80, y1: 80 }, el = svg.node(), bar = document.getElementById("editbar");
    const top = bar.hidden ? 0 : bar.offsetTop + bar.offsetHeight;
    const w = el.clientWidth || 800, h = (el.clientHeight || 600) - top;
    const k = Math.min(w / (b.x1 - b.x0), h / (b.y1 - b.y0), 7);
    const transform = d3.zoomIdentity.translate(w / 2 - k * (b.x0 + b.x1) / 2, top + h / 2 - k * (b.y0 + b.y1) / 2).scale(k);
    (animate && !reducedMotion ? svg.transition().duration(550) : svg).call(zoom.transform, transform);
  }
  const fitAll = (animate) => zoomTo(nodes, animate);
  fitAll(false);
  new ResizeObserver(() => { if (!interacted) fitAll(false); }).observe(svg.node());
  document.getElementById("zoom-in").onclick = () => { interacted = true; svg.transition().duration(reducedMotion ? 0 : 250).call(zoom.scaleBy, 1.6); };
  document.getElementById("zoom-out").onclick = () => { interacted = true; svg.transition().duration(reducedMotion ? 0 : 250).call(zoom.scaleBy, 1 / 1.6); };
  document.getElementById("zoom-fit").onclick = () => { interacted = false; fitAll(true); };

  const withParents = (skills) => { const ids = new Set(); skills.forEach((s) => { ids.add(s.id); ids.add("g:" + s.group); ids.add("c:" + s.cluster); }); return ids; };
  function setFocus(ids, selected) {
    focusSet = ids; selectedId = selected || null;
    // Only a click on a skill (s:), a category (g:) or an area (c:) filters the lines; hover and other views do not.
    const lineTarget = selectedId && /^[sgc]:/.test(selectedId) ? selectedId : null;
    if (lineTarget !== lineSelection) { lineSelection = lineTarget; drawLines(); }
    svg.classed("focus", !!ids);
    node.classed("on", (n) => !!ids && ids.has(n.id)).classed("selected", (n) => n.id === selectedId);
    treeLink.classed("on", (l) => !!ids && ids.has(l.source.id) && ids.has(l.target.id));
    updateLabels();
    document.querySelectorAll("#areas .chip").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.id === selected)));
  }
  const skillsOf = (predicate) => nodes.filter((n) => n.type === "skill" && predicate(n));
  const order = Object.keys(PROJECTS);
  const newestFirst = [...order].reverse();
  const PRIVATE_STATION = "PRIVAT";
  const stationOrder = [PRIVATE_STATION, ...newestFirst.filter((k) => PROJECTS[k].kind !== "Privates Projekt")];
  // The three orders again, in place, after the stations of a self-hosted map changed (applyStructure).
  function orderStations() {
    order.splice(0, order.length, ...Object.keys(PROJECTS));
    newestFirst.splice(0, newestFirst.length, ...[...order].reverse());
    stationOrder.splice(0, stationOrder.length, PRIVATE_STATION, ...newestFirst.filter((k) => PROJECTS[k].kind !== "Privates Projekt"));
  }
  // A standard skill counts for every place from the one it became standard at, while "Standard-Skills" is on (standardAt
  // in layout.js).
  const usedIn = (key) => skillsOf((s) => s.places.includes(key) || standardAt(s, key));

  // Panel views: "atlas" is the atlas itself; "projects", "project", "form" and "edit" belong to the project editor.
  let view = "atlas", currentId = null, formId = null, editing = false, confirmDelete = false, rerenderAtlas = null, rerenderTime = null, matchNames = [];
  let catalogForm = null, confirmSkillDelete = null;
  const store = createStore((kind) => { showStatus(); if (kind === "data") refresh(); });
  const catalog = createCatalog(() => {
    showStatus();
    if (applyCatalog()) { setFocus(focusSet, selectedId); if (!interacted) fitAll(false); if (forcesRedraw) forcesRedraw(); }
    refresh();
  });
  // The texts of the map (settings/texts in selfhost/FORMAT.md): privateNote, the note below "Private Projekte" in the
  // overview. The data file holds them for a page without a database; with one, its document settings/texts holds them.
  const mapTexts = { privateNote: typeof MAP_TEXTS !== "undefined" && MAP_TEXTS && typeof MAP_TEXTS.privateNote === "string" ? MAP_TEXTS.privateNote : "" };
  // Areas and stations of a self-hosted map (FEATURES.editStructure). The configurations start after their first
  // snapshot, so the start points of the configuration for readers apply to the areas of the database.
  let picksStarted = !FEATURES.editStructure, confirmStructure = null;
  const structure = createStructure(() => {
    showStatus();
    if (applyStructure()) {
      if (!applyCatalog()) drawMap();
      setFocus(focusSet, selectedId);
      if (!interacted) fitAll(false);
      if (forcesRedraw) forcesRedraw();
    }
    if (!picksStarted && structure.loaded) { picksStarted = true; connectPicks(); }
    refresh();
  });
  const baseStandard = { ...STANDARD };
  const byOrder = ([, a], [, b]) => a.order - b.order || a.name.localeCompare(b.name, "de");
  let catalogSignature = JSON.stringify([baseGroups, baseSkills, baseStandard]);
  // With categories in the database it is the source; without them (no database, or none yet) the data file stays.
  function applyCatalog() {
    const fromDb = catalogInDb();
    const groups = fromDb ? [...catalog.groups].filter(([, g]) => areaName.has(g.area) && g.name).sort(byOrder).map(([id, g]) => [id, g.area, g.name]) : baseGroups;
    const groupIds = new Set(groups.map(([id]) => id)), names = new Set();
    const docs = fromDb ? [...catalog.skills].sort(byOrder).filter(([, s]) => s.name && groupIds.has(s.group) && !names.has(s.name) && names.add(s.name)) : [];
    const skills = fromDb ? docs.map(([, s]) => [s.name, s.group, s.rating, s.places.join(" ")]) : baseSkills;
    const standard = fromDb ? Object.fromEntries(docs.filter(([, s]) => s.standard).map(([, s]) => [s.name, s.standard])) : baseStandard;
    const signature = JSON.stringify([groups, skills, standard]);
    if (signature === catalogSignature) return false;
    catalogSignature = signature;
    GROUPS.splice(0, GROUPS.length, ...groups);
    SKILLS.splice(0, SKILLS.length, ...skills);
    Object.keys(STANDARD).forEach((name) => delete STANDARD[name]);
    // Own properties, also for a skill named "__proto__", which Object.assign would take as the prototype.
    Object.entries(standard).forEach(([name, note]) => Object.defineProperty(STANDARD, name, { value: note, writable: true, enumerable: true, configurable: true }));
    drawMap();
    return true;
  }
  // Areas and stations from the database of a self-hosted map, in place of the embedded data. The page keeps the
  // constants of data.js and changes what they hold, so every function that reads them sees the map of the database.
  // Areas keep their order. Stations run from the oldest start on, as in data.js; a station without a date comes last.
  // An area keeps its current start point, from a configuration or a drag in the force menu, until the start point of its
  // document changes. "Werte aus layout.js" sets the start points of the documents.
  let structureSignature = "";
  const areaDocAt = new Map();
  const startMonth = (s) => { const m = placeMonths(s.when); return m ? m.from : Number.MAX_SAFE_INTEGER; };
  const ringSeed = (i, n) => [Math.round(Math.cos(2 * Math.PI * i / Math.max(1, n) - Math.PI / 2) * 340), Math.round(Math.sin(2 * Math.PI * i / Math.max(1, n) - Math.PI / 2) * 200)];
  function applyStructure() {
    if (!structure.loaded) return false;
    const areaList = [...structure.areas].filter(([id, a]) => AREA_ID.test(id) && a.name).sort(byOrder);
    const stations = [...structure.stations].filter(([id, s]) => STATION_ID.test(id) && !/i$/.test(id) && id !== PRIVATE_STATION && s.name)
      .sort(([, a], [, b]) => startMonth(a) - startMonth(b) || a.order - b.order || a.name.localeCompare(b.name, "de"));
    const signature = JSON.stringify([areaList, stations]);
    if (signature === structureSignature) return false;
    structureSignature = signature;
    const before = new Map(CLUSTERS.map((c) => [c.id, c]));
    const docAt = new Map(areaList.map(([id, a], i) => [id, a.at || ringSeed(i, areaList.length)]));
    CLUSTERS.splice(0, CLUSTERS.length, ...areaList.map(([id, a]) => {
      const at = docAt.get(id), old = before.get(id), same = areaDocAt.get(id) === JSON.stringify(at);
      return { id, name: a.name, at: old && same ? old.at : at.slice() };
    }));
    areaDocAt.clear();
    docAt.forEach((at, id) => areaDocAt.set(id, JSON.stringify(at)));
    Object.keys(SPRING_DEFAULTS.at).forEach((id) => { if (!docAt.has(id)) delete SPRING_DEFAULTS.at[id]; });
    docAt.forEach((at, id) => { SPRING_DEFAULTS.at[id] = at.slice(); });
    [COLORS, PROJECTS, WHERE].forEach((o) => Object.keys(o).forEach((k) => delete o[k]));
    areaName.clear();
    areaList.forEach(([id, a]) => { COLORS[id] = a.color; areaName.set(id, a.name); });
    stations.forEach(([id, s]) => {
      PROJECTS[id] = { months: s.months, name: s.name, when: s.when, kind: s.kind, note: s.note };
      const short = s.short || s.name;
      // A place with a trailing "i" is an indirect use of the station (selfhost/FORMAT.md), as ISSi in data.js.
      WHERE[id] = short; WHERE[id + "i"] = t("skill.indirect", { station: short });
    });
    const weights = placeWeights();
    Object.keys(PLACE_WEIGHT).forEach((k) => delete PLACE_WEIGHT[k]);
    Object.assign(PLACE_WEIGHT, weights);
    orderStations();
    paintAreaColors();
    renderAreaChips();
    buildTimeBar();
    return true;
  }
  // The colors of the areas of a self-hosted map, in place of the fixed tokens of the six areas of data.js. The dark
  // theme takes each color mixed with white, so it stays readable on the dark background.
  function paintAreaColors() {
    let style = document.getElementById("area-colors");
    if (!style) { style = document.createElement("style"); style.id = "area-colors"; document.head.appendChild(style); }
    const darkOf = (hex) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.62 + 255 * 0.38).toString(16).padStart(2, "0")).join("");
    const vars = (dark) => CLUSTERS.map((c) => `--c-${c.id}: ${dark ? darkOf(COLORS[c.id]) : COLORS[c.id]};`).join(" ");
    style.textContent = `:root { ${vars(false)} }\n@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars(true)} } }\n`
      + `:root[data-theme="dark"] { ${vars(true)} }\n` + CLUSTERS.map((c) => `.k-${c.id} { --c: var(--c-${c.id}); }`).join("\n");
  }
  // Everyone reads; only the owner gets the editing controls, and the runtime refuses the writes of every other visitor.
  let reader = true;
  // The title of the map of a visitor (OWN_MAP), from the runtime; null on the CV map.
  let mapTitle = null;
  // { id, title } of the map of a visitor from the runtime, asked once; null on the CV map and for a missing map.
  const mapInfoOnce = OWN_MAP ? Promise.resolve().then(() => runtime.mapInfo()).catch(() => null) : Promise.resolve(null);
  const shownName = (p) => reader ? p.name.replace(/ \(ohne Linien\)$/, "") : p.name || t("project.noName");
  const visibleProjects = () => [...store.projects].filter(([, p]) => !reader || p.skills.length);
  const catalogInDb = () => catalog.loaded && catalog.groups.size > 0;
  // Editing waits for the categories in the database; a first category alone would hide every built-in skill. A map of the
  // self-hosted site has no built-in skills, so its owner edits as soon as the catalog has loaded, also an empty one.
  const canEditCatalog = () => !reader && store.writable && (FEATURES.editStructure ? catalog.loaded : catalogInDb());
  const canEditStructure = () => !!FEATURES.editStructure && !reader && store.writable && structure.loaded;
  const nextOrderIn = (docs) => Math.max(-1, ...[...docs.values()].map((entry) => entry.order).filter((n) => Number.isFinite(n) && n < Number.MAX_SAFE_INTEGER)) + 1;
  const skillDocId = (name) => { for (const [id, s] of catalog.skills) if (s.name === name) return id; return null; };
  const nextOrder = (kind) => Math.max(-1, ...[...catalog[kind].values()].map((entry) => entry.order).filter(Number.isFinite).filter((n) => n < Number.MAX_SAFE_INTEGER)) + 1;
  const skillRank = new Map(SKILLS.map(([name], i) => [name, i]));
  const rankOf = (name) => skillRank.has(name) ? skillRank.get(name) : SKILLS.length;
  const sortSkills = (names) => [...new Set(names)].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b, "de"));
  const skillNode = (name) => byId.get("s:" + name);
  const stationRank = (code) => stationOrder.includes(code) ? stationOrder.indexOf(code) : stationOrder.length;
  const stationName = (code) => code === PRIVATE_STATION ? t("station.private") : stationOf(code) ? stationOf(code).name : code;
  const byStationOrder = ([, a], [, b]) => stationRank(a.station) - stationRank(b.station) || a.order - b.order || a.name.localeCompare(b.name, "de");
  const countText = (p) => t("count.skills", { count: p.skills.length });
  const projectsButton = document.getElementById("projects-btn");
  const statusEl = document.getElementById("save-state");
  const editbar = document.getElementById("editbar");

  function selectSkill(n, zoomIn) {
    setFocus(withParents([n]), n.id);
    if (zoomIn) zoomTo([n, byId.get("g:" + n.group)]);
    renderSkill(n);
  }
  function selectGroup(g) {
    const skills = skillsOf((s) => s.group === g.group);
    setFocus(withParents(skills), g.id);
    zoomTo([g, ...skills]);
    renderGroup(g);
  }
  function selectArea(id) {
    const members = nodes.filter((n) => n.cluster === id);
    setFocus(new Set(members.map((n) => n.id)), "c:" + id);
    zoomTo(members);
    renderArea(id);
  }
  function selectProject(key) {
    const skills = usedIn(key);
    setFocus(withParents(skills), "p:" + key);
    renderProject(key, skills);
  }
  function selectRating(rating) {
    const skills = skillsOf((s) => s.rating === rating);
    setFocus(withParents(skills), "r:" + rating);
    renderRating(rating, skills);
  }
  function clear() { setFocus(null); node.classed("match", false); renderOverview(); }

  function bindNodes() {
    node.on("click", (event, n) => {
      event.stopPropagation();
      if (editing) {
        if (n.type === "skill") toggleSkill(n.label);
        else zoomTo(n.type === "group" ? [n, ...skillsOf((s) => s.group === n.group)] : nodes.filter((m) => m.cluster === n.cluster));
        return;
      }
      if (n.type === "skill") selectSkill(n, false); else if (n.type === "group") selectGroup(n); else selectArea(n.cluster);
    });
    node.on("pointerenter", (event, n) => {
      if (editing || event.pointerType !== "mouse" || selectedId || n.type !== "skill") return;
      setFocus(withParents([n]), null);
    });
    node.on("pointerleave", (event, n) => { if (!editing && event.pointerType === "mouse" && !selectedId && n.type === "skill") setFocus(null); });
  }
  svg.on("click", () => { if (view === "atlas" && selectedId) clear(); });

  const areas = document.getElementById("areas");
  // The area chips of the header, drawn again when the areas of a self-hosted map change, and the label of the map with
  // the number of its areas.
  function renderAreaChips() {
    svg.attr("aria-label", CLUSTERS.length ? t("map.labelAreas", { count: CLUSTERS.length }) : t("map.label"));
    areas.innerHTML = CLUSTERS.map((c) => `<button type="button" class="chip k-${esc(c.id)}" data-id="c:${esc(c.id)}" aria-pressed="false"><i></i>${esc(c.name)}</button>`).join("");
    areas.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => {
      if (editing) { zoomTo(nodes.filter((n) => n.cluster === chip.dataset.id.slice(2))); return; }
      if (selectedId === chip.dataset.id) { clear(); fitAll(true); } else selectArea(chip.dataset.id.slice(2));
    }));
  }
  renderAreaChips();

  const search = document.getElementById("q");
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    if (editing) {
      const matches = query ? skillsOf((s) => s.label.toLowerCase().includes(query)) : [];
      matchNames = matches.map((s) => s.label);
      node.classed("match", (n) => matches.includes(n));
      paint();
      return;
    }
    if (!query) { clear(); return; }
    const matches = skillsOf((s) => s.label.toLowerCase().includes(query));
    node.classed("match", (n) => matches.includes(n));
    setFocus(withParents(matches), "search", null);
    renderSearch(query, matches);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const query = search.value.trim().toLowerCase();
    const first = skillsOf((s) => s.label.toLowerCase().includes(query))[0];
    if (first && editing) zoomTo([first, byId.get("g:" + first.group)]);
    else if (first) selectSkill(first, true);
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && editing) stopEditing(); });

  // "kind|value": the value is a name of the map and can hold a "|" of its own, so only the first "|" splits.
  const splitFirst = (text) => { const at = text.indexOf("|"); return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + 1)]; };
  panel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-act]");
    if (action) { const [kind, value] = splitFirst(action.dataset.act); act(kind, value); return; }
    const target = event.target.closest("[data-go]");
    if (!target || editing) return;
    const [kind, value] = splitFirst(target.dataset.go);
    if (kind === "skill") selectSkill(byId.get("s:" + value), true);
    else if (kind === "group") selectGroup(byId.get("g:" + value));
    else if (kind === "area") selectArea(value);
    else if (kind === "project") selectProject(value);
    else if (kind === "rating") selectRating(Number(value));
    else { search.value = ""; clear(); fitAll(true); }
  });
  projectsButton.addEventListener("click", () => {
    if (editing) { stopEditing(); showProjectList(); }
    else if (view === "atlas") showProjectList();
    else { search.value = ""; clear(); }
  });
  document.getElementById("editbar-done").addEventListener("click", () => stopEditing());
  window.addEventListener("pagehide", () => store.flushAll());
  document.addEventListener("visibilitychange", () => { if (document.hidden) store.flushAll(); });

  const byRating = (a, b) => b.rating - a.rating || a.label.localeCompare(b.label, "de");
  const skillChip = (s) => `<button type="button" class="chip k-${esc(s.cluster)}${offTime(!inRange(s))}" data-go="skill|${esc(s.label)}"><i></i>${esc(s.label)}</button>`;
  const projectChip = (key) => `<button type="button" class="chip${offTime(!placeInRange(key))}" data-go="project|${esc(key)}">${esc(PROJECTS[key].name)}</button>`;
  const back = `<button type="button" class="back" data-go="overview|">${t("overview.back")}</button>`;
  // A view that only a new time range draws again names its own function in again.
  function showAtlas(html, rerender, again) {
    view = "atlas"; rerenderAtlas = rerender || null; rerenderTime = again || rerenderAtlas;
    projectsButton.setAttribute("aria-pressed", "false");
    panel.innerHTML = html;
  }

  // The strength of a line is its number of connections. The duration of a station plays no part (his rule, 2026-10-17).
  const LINES_TEXT = { skill: t("overview.linesSkill"), category: t("overview.linesCategory"), mixed: t("overview.linesMixed") };
  const linesText = () => SHOW_LINES ? (Object.hasOwn(LINES_TEXT, LINE_MODE) ? LINES_TEXT[LINE_MODE] : LINES_TEXT.category) : t("overview.noLines");
  // With a time range, the counts of the overview count the skills and projects in it, and the rest fades.
  const offTime = (out) => out ? " off-time" : "";
  const projectsText = () => {
    const inTime = (list) => list.filter(([, p]) => projectInRange(p)).length;
    if (reader) {
      if (!store.loaded) return t("projects.loading");
      const list = visibleProjects();
      return timeRange ? t("overview.projectsReaderInRange", { count: list.length, shown: inTime(list) }) : t("overview.projectsReader", { count: list.length });
    }
    if (store.available === false) return t("overview.noProjectDatabase");
    if (!store.loaded) return t("projects.loading");
    return timeRange ? t("overview.projectsOwnerInRange", { count: store.projects.size, shown: inTime([...store.projects]) }) : t("overview.projectsOwner", { count: store.projects.size });
  };
  function renderOverview() {
    const own = newestFirst.filter((k) => PROJECTS[k].kind === "Privates Projekt"), employers = newestFirst.filter((k) => !own.includes(k));
    const shown = skillsOf(inRange), areasShown = CLUSTERS.filter((c) => shown.some((s) => s.cluster === c.id)).length;
    // The owner of a self-hosted map adds areas and stations here. The note below "Private Projekte" comes from the map
    // (settings/texts). The private projects of a map of a visitor show only when it has some.
    const edit = canEditStructure();
    const addArea = edit ? `${CLUSTERS.length ? "" : `<p class="muted">${t("overview.noAreas")}</p>`}
      <div class="actions"><button type="button" class="add" data-act="new-area|">${t("overview.addArea")}</button></div>` : "";
    const addStation = edit ? `${order.length ? "" : `<p class="muted">${t("overview.noStations")}</p>`}
      <div class="actions"><button type="button" class="add" data-act="new-station|">${t("overview.addStation")}</button></div>` : "";
    const privateNote = mapTexts.privateNote ? `
      <p class="muted">${esc(mapTexts.privateNote)}</p>` : "";
    const privatePart = own.length || !OWN_MAP ? `
      <h3>${t("overview.privateProjects")}</h3>${privateNote}
      <div class="chips">${own.map(projectChip).join("")}</div>` : "";
    const mapPart = OWN_MAP && !reader && mapTitle !== null ? `
      <h3>${t("overview.map")}</h3>
      <p class="muted">${t("overview.mapTitle", { title: esc(mapTitle), place: esc(TEXTS.mapPlace || "") })}</p>
      <div class="actions"><button type="button" data-act="export-map|">${t("overview.export")}</button><button type="button" data-act="edit-title|">${t("overview.editTitle")}</button></div>` : "";
    const heading = timeRange
      ? t("overview.heading", { skills: t("overview.skillsInRange", { count: SKILLS.length, shown: shown.length }), areas: t("overview.areasInRange", { count: areasShown }) })
      : t("overview.heading", { skills: t("overview.skills", { count: SKILLS.length }), areas: t("overview.areas", { count: CLUSTERS.length }) });
    showAtlas(`
      <h2>${heading}</h2>
      <p class="muted">${linesText()}</p>${timeRange && !shown.length ? `<p class="muted">${t("overview.noStationInRange")}</p>` : ""}
      <h3>${t("overview.projects")}</h3>
      <p class="muted">${projectsText()}</p>
      <div class="actions"><button type="button" class="primary" data-act="list|">${t("overview.openProjects")}</button></div>
      <h3>${t("overview.byRating")}</h3>
      <div class="legend">${[3, 2, 1, KI, 0].filter((r) => skillsOf((s) => s.rating === r).length).map((r) => { const count = shown.filter((s) => s.rating === r).length;
        return `<button type="button"${count ? "" : ' class="off-time"'} data-go="rating|${r}" aria-pressed="false">${legendIcon(r)}<span>${RATING[r]}</span><span>${count}</span></button>`; }).join("")}</div>
      <h3>${t("overview.areasHeading")}</h3>
      <div class="areas-list">${CLUSTERS.map((c) => { const count = shown.filter((s) => s.cluster === c.id).length;
        return `<button type="button" class="k-${esc(c.id)}${offTime(!count)}" data-go="area|${esc(c.id)}"><i></i><span>${esc(c.name)}</span><span>${count}</span></button>`; }).join("")}</div>${addArea}
      <h3>${t("overview.stations")}</h3>
      <div class="chips">${employers.map(projectChip).join("")}</div>${addStation}${privatePart}${mapPart}`, renderOverview);
  }
  function placesList(s) {
    // While "Standard-Skills" is on, a standard skill shows its note instead of its stations (standardNote in layout.js).
    if (standardNote(s)) return `<span class="badge k-${esc(s.cluster)}">${esc(standardNote(s))}</span>`;
    if (!s.tags.length) return `<p class="muted">${t("skill.noStation")}</p>`;
    // A place that is no station, for example in an imported map file, is left out.
    const keys = [...new Set(s.tags)].filter((k) => stationOf(k.replace(/i$/, ""))).sort((a, b) => order.indexOf(b.replace(/i$/, "")) - order.indexOf(a.replace(/i$/, "")));
    return `<ul class="list">${keys.map((k) => { const key = k.replace(/i$/, ""), p = stationOf(key);
      return `<li${placeInRange(key) ? "" : ' class="off-time"'}><button type="button" class="linkbtn" data-go="project|${esc(key)}">${k !== key ? t("skill.indirect", { station: esc(p.name) }) : esc(p.name)}</button><span class="when">${esc(p.when)}</span></li>`; }).join("")}</ul>`;
  }
  function projectsOf(s) {
    if (store.available === false && !store.loaded) return "";
    if (!store.loaded) return `<h3>${t("skill.inProjects")}</h3><p class="muted">${t("projects.loading")}</p>`;
    const own = [...store.projects].filter(([, p]) => p.skills.includes(s.label)).sort(byStationOrder);
    return `<h3>${t("skill.inProjects")}</h3>` + (own.length
      ? `<ul class="list">${own.map(([id, p]) => `<li${projectInRange(p) ? "" : ' class="off-time"'}><button type="button" class="linkbtn" data-act="open|${esc(id)}">${esc(shownName(p))}</button><span class="when">${esc(stationName(p.station))} · ${p.order}</span></li>`).join("")}</ul>`
      : `<p class="muted">${t("skill.noProject")}</p>`);
  }
  function renderSkill(s) {
    const addedId = canEditCatalog() ? skillDocId(s.label) : null;
    const usage = [...store.projects.values()].filter((p) => p.skills.includes(s.label)).length;
    const tools = addedId ? `<div class="actions"><button type="button" data-act="edit-skill|${esc(addedId)}">${t("action.edit")}</button><button type="button" data-act="ask-delete-skill|${esc(addedId)}">${t("action.delete")}</button></div>` : "";
    const question = usage ? t("confirm.deleteSkillInProjects", { name: esc(s.label), count: usage }) : t("confirm.deleteSkill", { name: esc(s.label) });
    const confirm = addedId && confirmSkillDelete === addedId ? `<div class="confirm" role="alert"><p>${question}</p>
      <div class="actions"><button type="button" class="danger" data-act="delete-skill|${esc(addedId)}">${t("action.deleteForever")}</button><button type="button" data-act="cancel-delete-skill|">${t("action.cancel")}</button></div></div>` : "";
    showAtlas(`
      ${back}
      <span class="crumb k-${esc(s.cluster)}"><button type="button" class="linkbtn" data-act="area|${esc(s.cluster)}">${esc(areaName.get(s.cluster))}</button> › <button type="button" class="linkbtn" data-act="group|${esc(s.group)}">${esc(groupName.get(s.group))}</button></span>
      <h2>${esc(s.label)}</h2>
      <span class="rating">${legendIcon(s.rating, s.cluster)}${RATING[s.rating]}</span>
      ${tools}${confirm}
      <h3>${t("skill.usedAt")}</h3>
      ${placesList(s)}
      ${projectsOf(s)}`, () => { const fresh = byId.get(s.id); if (fresh) renderSkill(fresh); else clear(); });
  }
  function renderGroup(g) {
    const skills = skillsOf((s) => s.group === g.group);
    const tools = canEditCatalog() ? `<div class="actions"><button type="button" class="primary" data-act="new-skill|${esc(g.group)}">${t("group.addSkill")}</button>${catalog.groups.has(g.group)
      ? `<button type="button" data-act="edit-group|${esc(g.group)}">${t("group.edit")}</button>` : ""}</div>` : "";
    showAtlas(`${back}<span class="crumb k-${esc(g.cluster)}"><button type="button" class="linkbtn" data-act="area|${esc(g.cluster)}">${esc(areaName.get(g.cluster))}</button> › ${esc(g.name)}</span><h2>${esc(g.name)}</h2>${tools}
      ${skills.length ? `<div class="chips">${skills.sort(byRating).map(skillChip).join("")}</div>` : `<p class="muted">${t("group.empty")}</p>`}`,
      () => { const fresh = byId.get(g.id); if (fresh) renderGroup(fresh); else clear(); });
  }
  function renderArea(id) {
    // An area that a change in another tab removed leaves its view.
    if (!areaName.has(id)) { clear(); return; }
    const own = canEditStructure() ? `<button type="button" data-act="edit-area|${esc(id)}">${t("area.edit")}</button><button type="button" data-act="ask-delete-area|${esc(id)}">${t("action.delete")}</button>` : "";
    const tools = canEditCatalog() ? `<div class="actions"><button type="button" class="primary" data-act="new-group|${esc(id)}">${t("area.addGroup")}</button>${own}</div>${structureConfirm("area", id)}` : "";
    showAtlas(`${back}<h2 class="k-${esc(id)}">${esc(areaName.get(id))}</h2>${tools}` + GROUPS.filter((g) => g[1] === id).map(([gid, , name]) =>
      `<h3><button type="button" class="linkbtn" data-go="group|${esc(gid)}">${esc(name)}</button></h3><div class="chips">${skillsOf((s) => s.group === gid).sort(byRating).map(skillChip).join("")}</div>`).join(""),
      () => renderArea(id));
  }

  // Catalog editor: categories and skills added by the owner
  const cleanText = (text) => text.trim().replace(/\s+/g, " ");
  function showCatalogForm(form, html) {
    view = "form"; rerenderAtlas = null; formId = null; catalogForm = form;
    projectsButton.setAttribute("aria-pressed", "false");
    panel.innerHTML = html;
    document.getElementById("catalog-form").addEventListener("submit", { group: submitGroup, skill: submitSkill, area: submitArea, station: submitStation, title: submitTitle }[form.kind]);
    document.getElementById("cf-name").focus();
  }
  function formError(text) {
    const error = document.getElementById("cf-error");
    error.textContent = text; error.hidden = false;
  }
  const formButtons = (isNew) => `<p id="cf-error" class="error" role="alert" hidden></p>
    <div class="actions"><button type="submit" class="primary">${isNew ? t("action.create") : t("action.save")}</button><button type="button" data-act="cancel-catalog|">${t("action.cancel")}</button>`;
  // The back button of the forms of the catalog and the structure.
  const formBack = () => `<button type="button" class="back" data-act="cancel-catalog|">${t("action.back")}</button>`;
  function renderGroupForm(area, id, back) {
    const g = id ? catalog.groups.get(id) : null;
    const empty = !!g && !skillsOf((s) => s.group === id).length;
    showCatalogForm({ kind: "group", area, id, back }, `${formBack()}
      <span class="crumb k-${esc(area)}">${esc(areaName.get(area))}</span><h2>${g ? t("form.editGroup") : t("form.newGroup")}</h2>
      <form id="catalog-form" class="form" novalidate>
        <label for="cf-name">${t("form.name")}</label>
        <input id="cf-name" type="text" maxlength="60" autocomplete="off" value="${g ? esc(g.name) : ""}">
        ${formButtons(!g)}${empty ? `<button type="button" class="danger" data-act="delete-group|${esc(id)}">${t("action.delete")}</button>` : ""}</div>
        ${g && !empty ? `<p class="muted small">${t("form.groupNotEmpty")}</p>` : ""}
      </form>`);
  }
  // What the fields do: they act only while the switch "Standard-Skills" (STANDARD_SKILLS in layout.js) is on.
  const standardHint = () => STANDARD_SKILLS ? t("form.standardHintOn") : t("form.standardHintOff");
  // The note of a standard skill as the form suggests it, with the short station name of WHERE like the notes in data.js.
  const standardText = (code) => t("form.standardSuggestion", { station: (Object.hasOwn(WHERE, code) && WHERE[code]) || stationName(code) });
  function renderSkillForm(group, id, back) {
    const s = id ? catalog.skills.get(id) : null;
    const current = s ? s.group : group, rating = s ? s.rating : 1, places = s ? s.places : [];
    const area = (GROUPS.find(([gid]) => gid === current) || [, ""])[1];
    // "Standard seit" lists the stations and private projects from the oldest on, as the station views count them.
    const standard = s && s.standard ? s.standard : null;
    const sinceCodes = standard && !order.includes(standard.since) ? [...order, standard.since] : order;
    showCatalogForm({ kind: "skill", id, back }, `${formBack()}
      <span class="crumb k-${esc(area)}">${esc(areaName.get(area) || "")} › ${esc(groupName.get(current) || "")}</span><h2>${s ? t("form.editSkill") : t("form.newSkill")}</h2>
      <form id="catalog-form" class="form" novalidate>
        <label for="cf-name">${t("form.name")}</label>
        <input id="cf-name" type="text" maxlength="60" autocomplete="off" value="${s ? esc(s.name) : ""}">
        <label for="cf-group">${t("form.group")}</label>
        <select id="cf-group">${CLUSTERS.map((c) => `<optgroup label="${esc(c.name)}">${GROUPS.filter((g) => g[1] === c.id).map(([gid, , name]) =>
          `<option value="${esc(gid)}"${gid === current ? " selected" : ""}>${esc(name)}</option>`).join("")}</optgroup>`).join("")}</select>
        <label for="cf-rating">${t("form.rating")}</label>
        <select id="cf-rating">${[3, 2, 1, KI, 0].map((r) => `<option value="${r}"${r === rating ? " selected" : ""}>${RATING[r]}</option>`).join("")}</select>
        <fieldset><legend>${t("form.places")}</legend>${newestFirst.map((k) => `<label class="check"><input type="checkbox" name="cf-place" value="${esc(k)}"${places.includes(k) ? " checked" : ""}>${esc(PROJECTS[k].name)}</label>`).join("")}${order.length ? ""
          : `<p class="muted small">${t("form.noStations")}</p>`}</fieldset>
        <fieldset${order.length ? "" : " hidden"}><legend>${t("form.standard")}</legend>
          <label class="check" for="cf-standard"><input id="cf-standard" type="checkbox"${standard ? " checked" : ""}>${t("form.standardSkill")}</label>
          <div id="cf-standard-fields" class="std-fields"${standard ? "" : " hidden"}>
            <label for="cf-since">${t("form.standardSince")}</label>
            <select id="cf-since">${sinceCodes.map((k) => `<option value="${esc(k)}"${k === (standard ? standard.since : order[0]) ? " selected" : ""}>${esc(stationName(k))}</option>`).join("")}</select>
            <label for="cf-standard-text">${t("form.standardText")}</label>
            <input id="cf-standard-text" type="text" maxlength="160" autocomplete="off" value="${standard ? esc(standard.text) : ""}">
            <p class="muted small" id="cf-standard-hint">${standardHint()}</p>
          </div>
        </fieldset>
        ${formButtons(!s)}</div>
      </form>`);
    bindStandardFields();
  }
  // The station and the note show only while "Standard-Skill" is on. Turning it on with an empty note picks the oldest
  // checked station (else the first of the list) and suggests its note. A station change updates the note while it is
  // still the suggestion of the old station; a note the owner typed stays.
  function bindStandardFields() {
    const box = document.getElementById("cf-standard"), fields = document.getElementById("cf-standard-fields");
    const since = document.getElementById("cf-since"), text = document.getElementById("cf-standard-text");
    let shownSince = since.value;
    box.addEventListener("change", () => {
      fields.hidden = !box.checked;
      if (!box.checked || text.value.trim()) return;
      const own = [...document.querySelectorAll('input[name="cf-place"]:checked')].map((input) => input.value).filter((k) => order.includes(k));
      since.value = own.length ? own.reduce((a, b) => order.indexOf(a) <= order.indexOf(b) ? a : b) : order[0];
      shownSince = since.value;
      text.value = standardText(since.value);
    });
    since.addEventListener("change", () => {
      if (text.value.trim() === standardText(shownSince)) text.value = standardText(since.value);
      shownSince = since.value;
    });
  }
  function submitGroup(event) {
    event.preventDefault();
    const { area, id } = catalogForm;
    const name = cleanText(document.getElementById("cf-name").value);
    const taken = GROUPS.some(([gid, , other]) => gid !== id && other.toLowerCase() === name.toLowerCase());
    const problem = !canEditCatalog() ? t("form.cannotSave") : !name ? t("form.nameMissing") : taken ? t("form.groupTaken") : "";
    if (problem) { formError(problem); return; }
    let groupId = id;
    if (!groupId) {
      const stem = area + "-" + slug(name);
      groupId = stem;
      for (let i = 2; GROUPS.some(([gid]) => gid === groupId) || catalog.groups.has(groupId); i++) groupId = stem + "-" + i;
    }
    const old = id ? catalog.groups.get(id) : null;
    catalog.write("groups", groupId, { name, area, order: old ? old.order : nextOrder("groups") });
    selectGroup(byId.get("g:" + groupId));
  }
  function replaceInProjects(from, to) {
    store.projects.forEach((p, projectId) => {
      if (!p.skills.includes(from)) return;
      store.projects.set(projectId, { ...p, skills: to ? sortSkills(p.skills.map((s) => s === from ? to : s)) : p.skills.filter((s) => s !== from) });
      store.save(projectId);
    });
  }
  function submitSkill(event) {
    event.preventDefault();
    const { id } = catalogForm;
    const old = id ? catalog.skills.get(id) : null;
    const name = cleanText(document.getElementById("cf-name").value);
    const group = document.getElementById("cf-group").value;
    const rating = Number(document.getElementById("cf-rating").value);
    const places = [...document.querySelectorAll('input[name="cf-place"]:checked')].map((box) => box.value);
    const isStandard = document.getElementById("cf-standard").checked;
    const since = document.getElementById("cf-since").value, standardNote = document.getElementById("cf-standard-text").value.trim();
    const taken = SKILLS.some(([other]) => other.toLowerCase() === name.toLowerCase() && (!old || other !== old.name));
    const problem = !canEditCatalog() ? t("form.cannotSave") : !name ? t("form.nameMissing")
      : taken ? t("form.skillTaken") : !groupName.has(group) ? t("form.groupMissing")
      : isStandard && !standardNote ? t("form.standardTextMissing") : "";
    if (problem) { formError(problem); return; }
    let skillId = id;
    if (!skillId) {
      const stem = slug(name);
      skillId = stem;
      for (let i = 2; catalog.skills.has(skillId); i++) skillId = stem + "-" + i;
    }
    if (old && old.name !== name) replaceInProjects(old.name, name);
    const body = { name, group, rating, places, order: old ? old.order : nextOrder("skills") };
    // The write replaces the whole document, so a skill saved without the box loses its standard field.
    if (isStandard) body.standard = { text: standardNote, since };
    catalog.write("skills", skillId, body);
    // A new skill returns to its category, where "+ Skill" adds the next one. An edit shows the skill.
    const category = !old && byId.get("g:" + group);
    if (category) selectGroup(category); else selectSkill(byId.get("s:" + name), true);
  }
  function deleteSkill(id) {
    const s = catalog.skills.get(id);
    confirmSkillDelete = null;
    if (!s || !canEditCatalog()) return;
    replaceInProjects(s.name, null);
    catalog.write("skills", id, null);
    clear();
  }
  function deleteGroup(id) {
    const g = catalog.groups.get(id);
    if (!g || !canEditCatalog() || skillsOf((s) => s.group === id).length) return;
    catalog.write("groups", id, null);
    selectArea(g.area);
  }

  // Areas and stations of a self-hosted map (FEATURES.editStructure): the owner creates, renames, recolors and deletes
  // them. The id of a new area comes from its name in small letters; the id of a new station is a short code in capitals,
  // like the codes of data.js, so it never ends in the "i" that marks an indirect place.
  const PALETTE = ["#2c5fc4", "#0a8573", "#a96a06", "#7a4ca6", "#c0384f", "#566170", "#1b7f3b", "#b4540a", "#2a7f9e", "#8a3f7a"];
  // A start point for a new area: the middle for the first one, else the point of a ring farthest from the others.
  function freeSeed() {
    if (!CLUSTERS.length) return [0, 0];
    let best = null, room = -1;
    for (let i = 0; i < 24; i++) {
      const p = ringSeed(i, 24), r = Math.min(...CLUSTERS.map((c) => Math.hypot(c.at[0] - p[0], c.at[1] - p[1])));
      if (r > room) { room = r; best = p; }
    }
    return best;
  }
  function renderAreaForm(id) {
    const a = id ? structure.areas.get(id) : null, c = id ? CLUSTERS.find((x) => x.id === id) : null;
    const at = c ? c.at : freeSeed(), used = Object.values(COLORS);
    const color = a ? a.color : PALETTE.find((p) => !used.includes(p)) || PALETTE[CLUSTERS.length % PALETTE.length];
    showCatalogForm({ kind: "area", id, back: () => { if (id && areaName.has(id)) selectArea(id); else clear(); } }, `${formBack()}
      <h2>${a ? t("form.editArea") : t("form.newArea")}</h2>
      <form id="catalog-form" class="form" novalidate>
        <label for="cf-name">${t("form.name")}</label>
        <input id="cf-name" type="text" maxlength="60" autocomplete="off" value="${a ? esc(a.name) : ""}">
        <label for="cf-color">${t("form.color")}</label>
        <input id="cf-color" type="color" value="${esc(color)}">
        <fieldset><legend>${t("form.startPoint")}</legend><div class="pair">
          <label for="cf-x">x</label><input id="cf-x" type="number" step="1" inputmode="numeric" value="${Math.round(at[0])}">
          <label for="cf-y">y</label><input id="cf-y" type="number" step="1" inputmode="numeric" value="${Math.round(at[1])}"></div></fieldset>
        <p class="muted small">${t("form.startPointHint")}</p>
        ${formButtons(!a)}</div>
      </form>`);
  }
  function submitArea(event) {
    event.preventDefault();
    const { id } = catalogForm;
    const name = cleanText(document.getElementById("cf-name").value), color = document.getElementById("cf-color").value.toLowerCase();
    const xText = document.getElementById("cf-x").value.trim(), yText = document.getElementById("cf-y").value.trim(), x = Number(xText), y = Number(yText);
    const taken = CLUSTERS.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase());
    const problem = !canEditStructure() ? t("form.cannotSave") : !name ? t("form.nameMissing") : taken ? t("form.areaTaken")
      : !/^#[0-9a-f]{6}$/.test(color) ? t("form.colorMissing") : !xText || !yText || !Number.isFinite(x) || !Number.isFinite(y) ? t("form.startPointInvalid") : "";
    if (problem) { formError(problem); return; }
    let areaId = id;
    if (!areaId) {
      let stem = slug(name).slice(0, 34).replace(/-+$/, "");
      if (!/^[a-z]/.test(stem)) stem = "b-" + stem;
      areaId = stem;
      for (let i = 2; areaName.has(areaId) || structure.areas.has(areaId); i++) areaId = stem + "-" + i;
    }
    const old = id ? structure.areas.get(id) : null;
    structure.write("areas", areaId, { name, color, at: [Math.round(x), Math.round(y)], order: old ? old.order : nextOrderIn(structure.areas) });
    catalogForm = null; view = "atlas";
    selectArea(areaId);
  }
  function renderStationForm(key) {
    const s = key ? structure.stations.get(key) : null, kind = s ? s.kind : STATION_KINDS[0];
    const kinds = STATION_KINDS.includes(kind) ? STATION_KINDS : [...STATION_KINDS, kind];
    showCatalogForm({ kind: "station", id: key, back: () => { if (key && stationOf(key)) selectProject(key); else clear(); } }, `${formBack()}
      <h2>${s ? t("form.editStation") : t("form.newStation")}</h2>
      <form id="catalog-form" class="form" novalidate>
        <label for="cf-name">${t("form.name")}</label>
        <input id="cf-name" type="text" maxlength="80" autocomplete="off" placeholder="${t("form.stationExample")}" value="${s ? esc(s.name) : ""}">
        <label for="cf-short">${t("form.short")}</label>
        <input id="cf-short" type="text" maxlength="40" autocomplete="off" placeholder="${t("form.shortExample")}" value="${s ? esc(s.short) : ""}">
        <label for="cf-kind">${t("form.kind")}</label>
        <select id="cf-kind">${kinds.map((k) => `<option value="${esc(k)}"${k === kind ? " selected" : ""}>${esc(kindText(k))}</option>`).join("")}</select>
        <label for="cf-when">${t("form.when")}</label>
        <input id="cf-when" type="text" maxlength="40" autocomplete="off" placeholder="${t("form.whenExample")}" value="${s ? esc(s.when) : ""}">
        <label for="cf-months">${t("form.months")}</label>
        <input id="cf-months" type="number" min="0" step="0.1" inputmode="decimal" value="${s ? s.months : ""}">
        <p class="muted small">${t("form.monthsHint")}</p>
        <label for="cf-note">${t("form.note")}</label>
        <textarea id="cf-note" maxlength="600" rows="4">${s ? esc(s.note) : ""}</textarea>
        ${formButtons(!s)}</div>
      </form>`);
  }
  function submitStation(event) {
    event.preventDefault();
    const { id } = catalogForm;
    const field = (name) => cleanText(document.getElementById(name).value);
    const name = field("cf-name"), short = field("cf-short"), kind = document.getElementById("cf-kind").value, when = field("cf-when");
    const note = document.getElementById("cf-note").value.trim(), monthsText = document.getElementById("cf-months").value.trim().replace(",", ".");
    const span = placeMonths(when), months = monthsText === "" ? (span ? span.to - span.from + 1 : 0) : Number(monthsText);
    const taken = Object.entries(PROJECTS).some(([k, p]) => k !== id && p.name.toLowerCase() === name.toLowerCase());
    const problem = !canEditStructure() ? t("form.cannotSave") : !name ? t("form.nameMissing") : taken ? t("form.stationTaken")
      : when && !whenValid(when) ? t("form.whenInvalid")
      : !Number.isFinite(months) || months < 0 ? t("form.monthsInvalid") : "";
    if (problem) { formError(problem); return; }
    let key = id;
    if (!key) {
      let stem = slug(name).split("-")[0].toUpperCase().slice(0, 10);
      if (!/^[A-Z]/.test(stem)) stem = ("S" + stem).slice(0, 10);
      key = stem;
      for (let i = 2; stationOf(key) || structure.stations.has(key) || key === PRIVATE_STATION; i++) key = stem + i;
    }
    const old = id ? structure.stations.get(id) : null;
    structure.write("stations", key, { name, short, kind, when, months: Math.round(months * 10) / 10, note, order: old ? old.order : nextOrderIn(structure.stations) });
    catalogForm = null; view = "atlas";
    selectProject(key);
  }
  // What depends on an area or a station, for the question before its delete. A delete takes its dependents with it:
  // the categories and skills of an area, the projects of a station. The skills of a station lose only that station, and
  // a standard skill since that station becomes a normal skill.
  function areaDependents(id) {
    const groups = [...catalog.groups].filter(([, g]) => g.area === id).map(([gid]) => gid);
    const skills = [...catalog.skills].filter(([, s]) => groups.includes(s.group));
    const names = new Set(skills.map(([, s]) => s.name));
    return { groups, skills, projects: [...store.projects].filter(([, p]) => p.skills.some((n) => names.has(n))) };
  }
  function stationDependents(key) {
    return { skills: [...catalog.skills].filter(([, s]) => s.places.some((p) => p === key || p === key + "i")),
      standard: [...catalog.skills].filter(([, s]) => s.standard && s.standard.since === key),
      projects: [...store.projects].filter(([, p]) => p.station === key) };
  }
  function structureConfirm(kind, id) {
    if (!confirmStructure || confirmStructure.kind !== kind || confirmStructure.id !== id) return "";
    let name, parts;
    if (kind === "area") {
      const d = areaDependents(id);
      name = areaName.get(id);
      parts = d.groups.length ? [t("confirm.areaContent", { groups: t("confirm.groups", { count: d.groups.length }), skills: t("count.skills", { count: d.skills.length }) }),
        ...(d.projects.length ? [t("confirm.areaProjects", { count: d.projects.length })] : [])] : [t("confirm.areaEmpty")];
    } else {
      const d = stationDependents(id);
      name = stationOf(id).name;
      parts = [...(d.skills.length ? [t("confirm.stationSkills", { count: d.skills.length })] : []),
        ...(d.projects.length ? [t("confirm.stationProjects", { count: d.projects.length })] : []),
        ...(d.standard.length ? [t("confirm.stationStandard", { count: d.standard.length })] : [])];
      if (!parts.length) parts = [t("confirm.stationEmpty")];
    }
    return `<div class="confirm" role="alert"><p>${t("confirm.deleteWith", { name: esc(name), parts: parts.join(" ") })}</p>
      <div class="actions"><button type="button" class="danger" data-act="delete-${kind}|${esc(id)}">${t("action.deleteForever")}</button><button type="button" data-act="cancel-delete-structure|">${t("action.cancel")}</button></div></div>`;
  }
  function deleteArea(id) {
    confirmStructure = null;
    if (!canEditStructure() || !areaName.has(id)) return;
    const { groups, skills } = areaDependents(id);
    skills.forEach(([, s]) => replaceInProjects(s.name, null));
    if (groups.length) catalog.writeMany([...skills.map(([sid]) => ["skills", sid, null]), ...groups.map((gid) => ["groups", gid, null])]);
    structure.write("areas", id, null);
    clear();
  }
  function deleteStation(key) {
    confirmStructure = null;
    if (!canEditStructure() || !stationOf(key)) return;
    const { skills, standard, projects } = stationDependents(key), changed = new Map();
    skills.forEach(([sid, s]) => changed.set(sid, { ...s, places: s.places.filter((p) => p !== key && p !== key + "i") }));
    standard.forEach(([sid, s]) => { const body = { ...(changed.get(sid) || s) }; delete body.standard; changed.set(sid, body); });
    if (changed.size) catalog.writeMany([...changed].map(([sid, body]) => ["skills", sid, body]));
    projects.forEach(([pid]) => store.remove(pid));
    structure.write("stations", key, null);
    clear();
  }
  // The title of a map of the self-hosted site, which the runtime stores with the map.
  function renderTitleForm() {
    showCatalogForm({ kind: "title", id: null, back: () => clear() }, `${formBack()}
      <h2>${t("titleForm.heading")}</h2>
      <form id="catalog-form" class="form" novalidate>
        <label for="cf-name">${t("titleForm.label")}</label>
        <input id="cf-name" type="text" maxlength="120" autocomplete="off" value="${esc(mapTitle || "")}">
        <p class="muted small">${t("titleForm.hint")}</p>
        ${formButtons(false)}</div>
      </form>`);
  }
  async function submitTitle(event) {
    event.preventDefault();
    const title = cleanText(document.getElementById("cf-name").value);
    if (!title) { formError(t("titleForm.missing")); return; }
    // The message of a refused rename comes from the runtime, which makes it from the answer of its host.
    try { mapTitle = await runtime.rename(title); } catch (error) { formError(t("titleForm.notSaved", { message: error && error.message ? error.message : "" })); return; }
    showHeader();
    catalogForm = null; view = "atlas";
    clear();
  }
  function catalogAct(kind, value) {
    const skillOf = (id) => catalog.skills.has(id) ? byId.get("s:" + catalog.skills.get(id).name) : null;
    if (kind === "new-group") renderGroupForm(value, null, () => selectArea(value));
    else if (kind === "edit-group") renderGroupForm(catalog.groups.get(value).area, value, () => selectGroup(byId.get("g:" + value)));
    else if (kind === "delete-group") deleteGroup(value);
    else if (kind === "new-skill") renderSkillForm(value, null, () => selectGroup(byId.get("g:" + value)));
    else if (kind === "edit-skill") renderSkillForm(null, value, () => { const n = skillOf(value); if (n) selectSkill(n, false); else clear(); });
    else if (kind === "ask-delete-skill") { confirmSkillDelete = value; renderSkill(skillOf(value)); }
    else if (kind === "cancel-delete-skill") { confirmSkillDelete = null; if (rerenderAtlas) rerenderAtlas(); }
    else if (kind === "delete-skill") deleteSkill(value);
    else if (kind === "cancel-catalog") { const form = catalogForm; catalogForm = null; view = "atlas"; form.back(); }
    else if (kind === "new-area" || kind === "edit-area") renderAreaForm(value || null);
    else if (kind === "new-station" || kind === "edit-station") renderStationForm(value || null);
    else if (kind === "ask-delete-area") { confirmStructure = { kind: "area", id: value }; renderArea(value); }
    else if (kind === "ask-delete-station") { confirmStructure = { kind: "station", id: value }; selectProject(value); }
    else if (kind === "cancel-delete-structure") { const c = confirmStructure; confirmStructure = null; if (c && c.kind === "area") renderArea(c.id); else if (c) selectProject(c.id); }
    else if (kind === "delete-area") deleteArea(value);
    else if (kind === "delete-station") deleteStation(value);
    else if (kind === "edit-title") renderTitleForm();
    else if (kind === "export-map") exportMap();
    else return false;
    return true;
  }
  function renderProject(key, skills) {
    const p = stationOf(key);
    if (!p) { clear(); return; }
    // The owner of a self-hosted map edits and deletes the station here.
    const tools = canEditStructure() ? `<div class="actions"><button type="button" data-act="edit-station|${esc(key)}">${t("station.edit")}</button><button type="button" data-act="ask-delete-station|${esc(key)}">${t("action.delete")}</button></div>${structureConfirm("station", key)}` : "";
    showAtlas(`${back}<span class="crumb">${esc(kindText(p.kind))} · ${esc(p.when)}${placeInRange(key) ? "" : " · " + t("station.outOfRange")}</span><h2>${esc(p.name)}</h2>${tools}<p>${esc(p.note)}</p>
      <h3>${t("station.skills", { count: skills.length })}</h3><div class="chips">${skills.sort(byRating).map(skillChip).join("")}</div>`, null, () => renderProject(key, skills));
  }
  // "N skills", or with a time range "M of N skills in the time range".
  const countInRange = (skills) => timeRange ? t("rating.skillsInRange", { count: skills.length, shown: skills.filter(inRange).length }) : t("rating.skills", { count: skills.length });
  function renderRating(rating, skills) {
    showAtlas(`${back}<span class="rating">${legendIcon(rating)}${countInRange(skills)}</span><h2>${RATING[rating][0].toUpperCase() + RATING[rating].slice(1)}</h2>` +
      CLUSTERS.map((c) => { const inArea = skills.filter((s) => s.cluster === c.id).sort(byRating);
        return inArea.length ? `<h3>${esc(c.name)}</h3><div class="chips">${inArea.map(skillChip).join("")}</div>` : ""; }).join(""), null, () => renderRating(rating, skills));
  }
  function renderSearch(query, matches) {
    const enter = timeRange ? t("search.enterInRange", { count: matches.filter(inRange).length }) : t("search.enter");
    showAtlas(`${back}<h2>${t("search.hits", { count: matches.length, query: esc(query) })}</h2>
      ${matches.length ? `<div class="chips">${matches.sort(byRating).map(skillChip).join("")}</div><p class="muted">${enter}</p>` : `<p class="muted">${t("search.none")}</p>`}`,
      null, () => renderSearch(query, matches));
  }

  // Project editor
  function showProjects(name, html) {
    view = name; rerenderAtlas = null;
    projectsButton.setAttribute("aria-pressed", "true");
    panel.innerHTML = html;
  }
  function showStatus() {
    const state = reader ? "reader" : catalog.error || structure.error ? "error" : (catalog.pending || structure.pending) && store.status === "saved" ? "pending" : store.status;
    statusEl.dataset.state = state;
    const texts = { connecting: () => t("status.connecting"), offline: () => t("status.offline"), pending: () => t("status.pending"), saved: () => t("status.saved"),
      readonly: () => t("status.readonly"), error: () => t("status.error", { code: store.error || catalog.error || structure.error }), reader: () => "" };
    statusEl.textContent = Object.hasOwn(texts, state) ? texts[state]() : "";
  }
  function storeNotice() {
    if (reader) return "";
    if (store.available === false) return `<p class="notice">${TEXTS.noDatabase ? t("notice.noDatabaseHint", { hint: esc(TEXTS.noDatabase) }) : t("notice.noDatabase")}</p>`;
    if (!store.loaded) return `<p class="muted">${t("projects.loading")}</p>`;
    if (store.status === "readonly") return `<p class="notice">${t("notice.readOnly")}</p>`;
    return "";
  }
  function paint() {
    const p = editing ? store.projects.get(currentId) : null;
    labelAlways = new Set(p ? [...p.skills, ...matchNames] : []);
    svg.classed("editing", !!p);
    node.classed("assigned", (n) => !!p && n.type === "skill" && p.skills.includes(n.label));
    editbar.hidden = !p;
    if (p) {
      document.getElementById("editbar-name").textContent = p.name;
      document.getElementById("editbar-count").textContent = `${stationName(p.station)} · ${countText(p)}`;
    }
    updateLabels();
  }
  function refresh() {
    // New project data can bring skills into the time range or take them out.
    if (timeRange) { computeTime(); markTime(); showTime(); }
    const lost = currentId !== null && !store.projects.has(currentId);
    if (lost) { editing = false; currentId = null; }
    paint();
    if (view === "form") return;
    if (view === "projects" || (lost && view !== "atlas")) showProjectList();
    else if (view === "project") openProject(currentId);
    else if (view === "edit") renderEditing();
    else if (rerenderAtlas) rerenderAtlas();
  }

  function assignedList(p) {
    if (!p.skills.length) return `<p class="muted">${reader ? t("project.noSkillsReader") : editing ? t("project.noSkillsEditing") : t("project.noSkillsOwner")}</p>`;
    const tag = (name, cluster) => `<span class="chip tag${cluster ? " k-" + esc(cluster) : ""}"><i></i>${cluster
      ? `<button type="button" class="linkbtn" data-act="locate|${esc(name)}">${esc(name)}</button>` : `<span>${esc(name)}</span>`}${store.writable
      ? `<button type="button" class="x" data-act="remove|${esc(name)}" aria-label="${t("project.removeSkill", { name: esc(name) })}" title="${t("project.remove")}">×</button>` : ""}</span>`;
    const known = p.skills.map(skillNode).filter(Boolean), unknown = p.skills.filter((s) => !skillNode(s));
    return CLUSTERS.map((c) => {
      const own = known.filter((s) => s.cluster === c.id);
      return own.length ? `<h3>${esc(c.name)}</h3><div class="chips">${own.map((s) => tag(s.label, c.id)).join("")}</div>` : "";
    }).join("") + (unknown.length ? `<h3>${t("project.notOnMap")}</h3><div class="chips">${unknown.map((s) => tag(s, "")).join("")}</div>` : "");
  }
  function renderProjectList() {
    const entries = visibleProjects().sort(byStationOrder);
    const used = [...new Set(entries.map(([, p]) => p.station))];
    const empty = stationOrder.filter((code) => !used.includes(code));
    // With a time range, a station without an active project in the list fades, and so does each project outside it.
    const stationOut = (code) => !!timeRange && !entries.some(([, p]) => p.station === code && projectInRange(p));
    const sections = used.map((code) => `<section class="station">
        <div class="station-head${offTime(stationOut(code))}"><h3>${esc(stationName(code))}</h3>${stationOf(code) ? `<span class="when">${esc(stationOf(code).when)}</span>` : ""}</div>
        <ol class="plist">${entries.filter(([, p]) => p.station === code).map(([id, p]) => `<li${projectInRange(p) ? "" : ' class="off-time"'}><button type="button" data-act="open|${esc(id)}">
          <span class="num">${p.order}</span><span class="pname">${esc(shownName(p))}${p.base && !reader ? ` <span class="flag">${t("projects.noLines")}</span>` : ""}${p.when ? ` <span class="when">${esc(p.when)}</span>` : ""}</span>
          <span class="count" title="${t("projects.skillCountTitle")}">${p.skills.length}</span></button></li>`).join("")}</ol>
        ${store.writable ? `<button type="button" class="add" data-act="new|${esc(code)}">${t("projects.add")}</button>` : ""}</section>`).join("");
    showProjects("projects", `${back}<h2>${t("projects.heading")}</h2>
      <p class="muted">${t("projects.intro")}</p>
      ${storeNotice()}
      ${store.writable ? `<div class="actions"><button type="button" class="primary" data-act="new|">${t("projects.new")}</button></div>` : ""}
      ${sections || (store.loaded ? `<p class="muted">${t("projects.none")}</p>` : "")}
      ${store.writable && empty.length ? `<h3>${t("projects.emptyStations")}</h3><div class="chips">${empty.map((code) =>
        `<button type="button" class="chip" data-act="new|${esc(code)}">+ ${esc(stationName(code))}</button>`).join("")}</div>` : ""}`);
  }
  function renderProjectView() {
    const p = store.projects.get(currentId);
    const actions = store.writable ? `<div class="actions"><button type="button" class="primary" data-act="edit|">${t("project.assign")}</button>
      <button type="button" data-act="form|">${t("action.edit")}</button><button type="button" data-act="ask-delete|">${t("action.delete")}</button></div>` : "";
    const confirm = confirmDelete ? `<div class="confirm" role="alert"><p>${t("confirm.deleteProject", { name: esc(p.name), skills: countText(p) })}</p>
      <div class="actions"><button type="button" class="danger" data-act="delete|">${t("action.deleteForever")}</button><button type="button" data-act="cancel-delete|">${t("action.cancel")}</button></div></div>` : "";
    showProjects("project", `<button type="button" class="back" data-act="list|">${t("projects.back")}</button>
      <span class="crumb">${esc(stationName(p.station))} · ${t("project.number", { number: p.order })}${p.when ? ` · ${esc(p.when)}` : ""}</span><h2>${esc(shownName(p))}</h2>
      ${p.base ? `<span class="badge">${reader ? t("project.baseReader") : t("project.baseOwner")}</span>` : ""}
      ${storeNotice()}${actions}${confirm}<h3>${countText(p)}</h3>${assignedList(p)}`);
  }
  function renderEditing() {
    const p = store.projects.get(currentId);
    showProjects("edit", `<span class="crumb">${t("edit.crumb", { station: esc(stationName(p.station)) })}</span><h2>${esc(p.name)}</h2>
      <p class="muted">${t("edit.help")}</p>
      ${storeNotice()}<div class="actions"><button type="button" class="primary" data-act="done|">${t("action.done")}</button></div>
      <h3>${countText(p)}</h3>${assignedList(p)}`);
  }
  const nextNumber = (code) => Math.max(0, ...[...store.projects.values()].filter((p) => p.station === code).map((p) => p.order)) + 1;
  function renderForm(id, station) {
    const p = id ? store.projects.get(id) : null;
    const current = store.projects.get(currentId);
    const code = p ? p.station : station || (current ? current.station : stationOrder[0]);
    const codes = stationOrder.includes(code) ? stationOrder : [...stationOrder, code];
    formId = id;
    showProjects("form", `<button type="button" class="back" data-act="cancel-form|">${p ? t("form.backToProject") : t("projects.back")}</button>
      <h2>${p ? t("form.editProject") : t("form.newProject")}</h2>
      <form id="project-form" class="form" novalidate>
        <label for="pf-name">${t("form.name")}</label>
        <input id="pf-name" type="text" maxlength="120" autocomplete="off" value="${p ? esc(p.name) : ""}">
        <label for="pf-station">${t("form.station")}</label>
        <select id="pf-station">${codes.map((k) => `<option value="${esc(k)}"${k === code ? " selected" : ""}>${esc(stationName(k))}</option>`).join("")}</select>
        <label for="pf-when">${t("form.projectWhen")}</label>
        <input id="pf-when" type="text" maxlength="40" autocomplete="off" placeholder="${t("form.projectWhenExample")}" value="${p ? esc(p.when) : ""}">
        <label for="pf-order">${t("form.order")}</label>
        <input id="pf-order" type="number" min="0" step="1" inputmode="numeric" value="${p ? p.order : nextNumber(code)}">
        <label class="check" for="pf-base"><input id="pf-base" type="checkbox"${p && p.base ? " checked" : ""}>${t("form.base")}</label>
        <p class="muted small">${t("form.baseHint")}</p>
        <p id="pf-error" class="error" role="alert" hidden></p>
        <div class="actions"><button type="submit" class="primary">${p ? t("action.save") : t("action.create")}</button><button type="button" data-act="cancel-form|">${t("action.cancel")}</button></div>
      </form>`);
    const numberInput = document.getElementById("pf-order");
    let numberTouched = false;
    numberInput.addEventListener("input", () => { numberTouched = true; });
    document.getElementById("pf-station").addEventListener("change", (event) => { if (!p && !numberTouched) numberInput.value = nextNumber(event.target.value); });
    document.getElementById("project-form").addEventListener("submit", submitForm);
    document.getElementById("pf-name").focus();
  }
  function submitForm(event) {
    event.preventDefault();
    const name = document.getElementById("pf-name").value.trim().replace(/\s+/g, " ");
    const station = document.getElementById("pf-station").value;
    const raw = document.getElementById("pf-order").value.trim();
    const number = raw === "" ? nextNumber(station) : Number(raw);
    const base = document.getElementById("pf-base").checked;
    const when = document.getElementById("pf-when").value.trim().replace(/\s+/g, " ");
    const problem = !store.writable ? t("form.cannotSave")
      : !name ? t("form.nameMissing")
      : !Number.isInteger(number) || number < 0 ? t("form.orderInvalid")
      : when && !whenValid(when) ? t("form.whenInvalid")
      : formId && !store.projects.has(formId) ? t("form.projectGone") : "";
    if (problem) {
      const error = document.getElementById("pf-error");
      error.textContent = problem; error.hidden = false;
      return;
    }
    let id = formId;
    if (id) store.projects.set(id, { ...store.projects.get(id), name, station, base, order: number, when });
    else {
      const stem = station.toLowerCase() + "-" + slug(name);
      id = stem;
      for (let i = 2; store.taken(id); i++) id = stem + "-" + i;
      store.projects.set(id, { name, station, base, order: number, when, skills: [] });
    }
    store.save(id);
    openProject(id);
  }

  function showProjectList() {
    currentId = null; confirmDelete = false;
    setFocus(null); node.classed("match", false);
    renderProjectList();
  }
  function focusProject() {
    const skills = store.projects.get(currentId).skills.map(skillNode).filter(Boolean);
    setFocus(skills.length ? withParents(skills) : null, "proj:" + currentId);
  }
  function openProject(id) {
    currentId = id;
    focusProject();
    renderProjectView();
  }
  function startEditing() {
    if (!store.writable || !store.projects.has(currentId)) return;
    editing = true; confirmDelete = false; matchNames = [];
    search.value = ""; node.classed("match", false);
    setFocus(null);
    paint();
    if (!interacted) fitAll(false);
    renderEditing();
  }
  function stopEditing() {
    editing = false; matchNames = [];
    search.value = ""; node.classed("match", false);
    store.flushAll();
    paint();
    if (!interacted) fitAll(false);
    if (store.projects.has(currentId)) openProject(currentId); else showProjectList();
  }
  function setAssigned(name, on) {
    const p = store.projects.get(currentId);
    if (!p || !store.writable || p.skills.includes(name) === on) return;
    store.projects.set(currentId, { ...p, skills: on ? sortSkills([...p.skills, name]) : p.skills.filter((s) => s !== name) });
    store.save(currentId);
    if (editing) { paint(); renderEditing(); } else openProject(currentId);
  }
  const toggleSkill = (name) => { const p = store.projects.get(currentId); if (p) setAssigned(name, !p.skills.includes(name)); };
  function act(kind, value) {
    if (catalogAct(kind, value)) return;
    if (kind === "list") showProjectList();
    else if (kind === "new") renderForm(null, value);
    else if (kind === "open") { confirmDelete = false; openProject(value); }
    else if (kind === "edit") startEditing();
    else if (kind === "done") stopEditing();
    else if (kind === "form") renderForm(currentId);
    else if (kind === "cancel-form") { if (formId && store.projects.has(formId)) openProject(formId); else showProjectList(); }
    else if (kind === "ask-delete" || kind === "cancel-delete") { confirmDelete = kind === "ask-delete"; renderProjectView(); }
    else if (kind === "delete") { store.remove(currentId); showProjectList(); }
    else if (kind === "remove") setAssigned(value, false);
    else if (kind === "area") { if (areaName.has(value)) selectArea(value); }
    else if (kind === "group") { const g = byId.get("g:" + value); if (g) selectGroup(g); }
    else if (kind === "locate") { const n = skillNode(value); if (n) zoomTo([n, byId.get("g:" + n.group)]); }
  }

  // Time range filter: two handles over the months from TIME_FIRST to TIME_LAST. The start handle sits at the start of
  // its month and the end handle at the end of its month, so the bar of a station ends where its handles sit. A drag or a
  // click on the track moves the nearer handle by whole months. An arrow key moves one month, Page Up and Page Down one
  // year, Home and End to the ends. A click on a station bar sets the range to that station. The filter changes the view
  // only: the layout and the forces stay.
  const timebar = document.getElementById("timebar");
  const timeEls = Object.fromEntries(["label", "reset", "places", "track", "fill", "from", "to", "years"].map((k) => [k, document.getElementById("time-" + k)]));
  let TIME_MONTHS = TIME_LAST - TIME_FIRST + 1;
  // The names of the months in the language of the page, for the screen reader text of the handles.
  const MONTH_NAMES = Array.from({ length: 12 }, (_, m) => SkillMapI18n.date(new Date(2000, m, 1), { month: "long" }));
  // The left edge of month m, in percent of the track.
  const timeAt = (m) => (m - TIME_FIRST) / TIME_MONTHS * 100;
  // Years only when the range runs from January to December, else month and year.
  const rangeText = (from, to) => from % 12 === 0 && to % 12 === 11
    ? (to - from === 11 ? String(from / 12) : `${from / 12} – ${(to - 11) / 12}`)
    : from === to ? monthText(from) : `${monthText(from)} – ${monthText(to)}`;
  let timeFrom = TIME_FIRST, timeTo = TIME_LAST, timeSignature = "", timeXpEnd = null, timeDrag = null;
  // The bars of the stations, each in the first lane where it does not overlap the bar before it. A self-hosted map draws
  // them again when its stations change, and hides the control while no station has a date.
  let placeBars = [];
  function drawPlaceBars() {
    const laneEnds = [];
    timeEls.places.innerHTML = "";
    placeBars = Object.keys(PROJECTS).map((key) => ({ key, m: placeMonths(PROJECTS[key].when) }))
      .filter((b) => b.m && b.m.to >= TIME_FIRST && b.m.from <= TIME_LAST).sort((a, b) => a.m.from - b.m.from).map((b) => {
        let lane = laneEnds.findIndex((end) => end < b.m.from);
        if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = b.m.to;
        const from = Math.max(b.m.from, TIME_FIRST), to = Math.min(b.m.to, TIME_LAST), p = PROJECTS[b.key];
        const el = document.createElement("button");
        Object.assign(el, { type: "button", className: "time-place", tabIndex: -1, title: `${p.name} · ${p.when}` });
        el.setAttribute("aria-label", t("time.setToStation", { name: p.name, when: p.when }));
        el.dataset.place = b.key;
        Object.assign(el.style, { left: timeAt(from) + "%", width: timeAt(to + 1) - timeAt(from) + "%", top: lane * 6 + "px" });
        el.addEventListener("click", () => setTime(from, to));
        timeEls.places.appendChild(el);
        return { key: b.key, el };
      });
    timeEls.places.style.height = laneEnds.length * 6 + "px";
    if (FEATURES.editStructure) timebar.hidden = !placeBars.length;
  }
  drawPlaceBars();
  // New stations of a self-hosted map: a new span of months and new bars, and the range is all years again.
  function buildTimeBar() {
    TIME_FIRST = firstMonth(); TIME_MONTHS = TIME_LAST - TIME_FIRST + 1;
    timeFrom = TIME_FIRST; timeTo = TIME_LAST; timeRange = null; timeActive = null; timeSkills = null; timeSignature = ""; timeXpEnd = null;
    drawPlaceBars(); drawYears(); showTime();
  }
  // A tick at the start of each year, and a label every 1, 2, 5, 10 or 20 years, as the width allows.
  function drawYears() {
    const perYear = (timeEls.track.clientWidth || 300) / TIME_MONTHS * 12, step = [1, 2, 5, 10, 20].find((s) => s * perYear >= 34) || 50;
    let html = "";
    for (let y = Math.ceil(TIME_FIRST / 12); y <= Math.floor(TIME_LAST / 12); y++) {
      html += `<i style="left:${timeAt(y * 12)}%"></i>` + (y % step === 0 ? `<span style="left:${timeAt(y * 12)}%">${y}</span>` : "");
    }
    timeEls.years.innerHTML = html;
  }
  new ResizeObserver(drawYears).observe(timeEls.track);
  function showTime() {
    const full = !timeRange;
    timeEls.label.textContent = full ? t("time.all") : rangeText(timeFrom, timeTo);
    timeEls.reset.classList.toggle("idle", full);
    timebar.classList.toggle("timed-bar", !full);
    timeEls.from.style.left = timeAt(timeFrom) + "%";
    timeEls.to.style.left = timeAt(timeTo + 1) + "%";
    Object.assign(timeEls.fill.style, { left: timeAt(timeFrom) + "%", width: timeAt(timeTo + 1) - timeAt(timeFrom) + "%" });
    [[timeEls.from, TIME_FIRST, timeTo, timeFrom], [timeEls.to, timeFrom, TIME_LAST, timeTo]].forEach(([el, min, max, now]) => {
      el.setAttribute("aria-valuemin", min); el.setAttribute("aria-valuemax", max); el.setAttribute("aria-valuenow", now);
      el.setAttribute("aria-valuetext", `${MONTH_NAMES[now % 12]} ${Math.floor(now / 12)}`);
    });
    placeBars.forEach(({ key, el }) => el.classList.toggle("on", !full && timeActive.has(key)));
  }
  // The ageing of the rings counts to the end of the range when it ends before NOW_MONTH (experienceOf in layout.js).
  // The years of experience stay, so the ring keeps its room and no label moves.
  function redrawRings() {
    node.filter((n) => n.type === "skill").each(function (n) {
      Object.assign(n, experienceOf(n.places, timeRange ? timeRange.to : null));
      const ring = this.querySelector("g.xp");
      if (ring) ring.outerHTML = experienceRing(n);
      if (hasRing(n)) d3.select(this).select("title").text(`${n.label} · ${experienceText(n)}`);
    });
  }
  function setTime(from, to) {
    timeFrom = Math.max(TIME_FIRST, Math.min(from, TIME_LAST));
    timeTo = Math.max(timeFrom, Math.min(to, TIME_LAST));
    timeRange = timeFrom === TIME_FIRST && timeTo === TIME_LAST ? null : { from: timeFrom, to: timeTo };
    computeTime();
    const xpEnd = timeRange && timeRange.to < NOW_MONTH ? timeRange.to : null;
    if (xpEnd !== timeXpEnd) { timeXpEnd = xpEnd; redrawRings(); }
    showTime();
    // The map and the panel change only when the active places or the skills in the range change.
    const signature = timeRange ? [...timeActive].sort().join() + "|" + [...timeSkills].sort().join() : "";
    if (signature === timeSignature) return;
    timeSignature = signature;
    markTime();
    drawLines();
    if (view === "atlas" && rerenderTime) rerenderTime();
    else if (view === "projects") renderProjectList();
    else if (view === "project") renderProjectView();
  }
  const monthAt = (event) => { const box = timeEls.track.getBoundingClientRect(); return TIME_FIRST + Math.round((event.clientX - box.left) / box.width * TIME_MONTHS); };
  const moveHandle = (which, event) => which === "from" ? setTime(Math.min(monthAt(event), timeTo), timeTo) : setTime(timeFrom, Math.max(monthAt(event) - 1, timeFrom));
  timeEls.track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const box = timeEls.track.getBoundingClientRect(), x = event.clientX;
    const xFrom = box.left + timeAt(timeFrom) / 100 * box.width, xTo = box.left + timeAt(timeTo + 1) / 100 * box.width;
    const handle = event.target.closest(".time-handle");
    // On a handle, that handle moves; when both handles lie on each other, the direction of the first move decides.
    let which = handle && xTo - xFrom >= 12 ? (handle === timeEls.from ? "from" : "to") : handle ? null
      : x <= xFrom ? "from" : x >= xTo ? "to" : x - xFrom <= xTo - x ? "from" : "to";
    timeDrag = { which, id: event.pointerId, x };
    timeEls.track.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (which) { timeEls[which].focus({ preventScroll: true }); if (!handle) moveHandle(which, event); }
  });
  timeEls.track.addEventListener("pointermove", (event) => {
    if (!timeDrag || event.pointerId !== timeDrag.id) return;
    if (!timeDrag.which) {
      if (event.clientX === timeDrag.x) return;
      timeDrag.which = event.clientX < timeDrag.x ? "from" : "to";
      timeEls[timeDrag.which].focus({ preventScroll: true });
    }
    moveHandle(timeDrag.which, event);
  });
  const stopDrag = (event) => { if (timeDrag && event.pointerId === timeDrag.id) timeDrag = null; };
  timeEls.track.addEventListener("pointerup", stopDrag);
  timeEls.track.addEventListener("pointercancel", stopDrag);
  [["from", timeEls.from], ["to", timeEls.to]].forEach(([which, el]) => el.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -12, PageUp: 12 }[event.key];
    const now = which === "from" ? timeFrom : timeTo;
    const target = step !== undefined ? now + step : event.key === "Home" ? (which === "from" ? TIME_FIRST : timeFrom)
      : event.key === "End" ? (which === "from" ? timeTo : TIME_LAST) : null;
    if (target === null) return;
    event.preventDefault();
    if (which === "from") setTime(Math.min(target, timeTo), timeTo); else setTime(timeFrom, Math.max(target, timeFrom));
  }));
  timeEls.reset.addEventListener("click", () => {
    const hadFocus = document.activeElement === timeEls.reset;
    setTime(TIME_FIRST, TIME_LAST);
    if (hadFocus) timeEls.from.focus();
  });
  showTime();

  // The configuration that readers see (the plan of 2026-10-18). With a database, the document settings/reader names it
  // ({ config, pickedAt }), and the collection configs holds the configurations ({ name, schema, values, savedAt }). A
  // reader follows a new pick at once. The owner takes the pick once at start, while his menu is unchanged; after that
  // his menu state is his own. A pick of a missing configuration, a failed subscription or no database keep the state
  // that the map shows: the pick of the data file or the values of layout.js.
  const CONFIGS = "configs", SETTINGS = "settings", READER_DOC = "reader", TEXTS_DOC = "texts";
  const picks = { ready: false, db: null, docs: null, pick: undefined, pickedAt: "", failed: { configs: "", settings: "" }, settled: false, ownerChanged: false, listener: null };
  // Set by the force menu of the owner: forcesView lays out the state through the menu, forcesRedraw draws its start
  // points and measures again after a new layout of the catalog.
  let forcesView = null, forcesRedraw = null;
  // The picked configuration, as far as both snapshots tell: undefined while one of them is missing.
  function pickResult() {
    if (picks.docs === null || picks.pick === undefined) return undefined;
    if (picks.pick === null) return { status: "none" };
    const config = picks.docs.find((d) => d.id === picks.pick);
    return config ? { status: "ok", config } : { status: "missing", id: picks.pick };
  }
  function followPick() {
    if (picks.listener) picks.listener();
    const result = pickResult();
    if (result === undefined) return;
    const first = !picks.settled;
    picks.settled = true;
    if (!reader && (!first || picks.ownerChanged)) return;
    const state = result.status === "ok" ? springConfigState(result.config) : null;
    if (state) showState(state);
  }
  // Shows a full state. Nothing happens when it is the state of the map. The menu of the owner lays it out through its
  // own steps; a reader keeps the station or project filter, the time range and the search, and the zoom until he zoomed.
  function showState(state) {
    const before = JSON.stringify(springCurrent());
    springApply(state);
    if (JSON.stringify(springCurrent()) === before) return;
    if (forcesView) { forcesView(); return; }
    drawMap();
    setFocus(focusSet, selectedId);
    const query = search.value.trim().toLowerCase();
    if (query && !editing) node.classed("match", (n) => n.type === "skill" && n.label.toLowerCase().includes(query));
    if (!interacted) fitAll(false);
    refresh();
  }
  async function connectPicks() {
    const db = await runtime.db();
    picks.ready = true; picks.db = db;
    if (!db) { followPick(); return; }
    const fail = (kind) => (error) => { picks.failed[kind] = error && error.code ? error.code : "unavailable"; followPick(); };
    try {
      db.collection(CONFIGS).onSnapshot((snap) => {
        picks.docs = snap.docs.map((doc) => {
          const data = doc.data() || {};
          return { id: doc.id, name: typeof data.name === "string" && data.name.trim() ? data.name : doc.id, schema: data.schema,
            savedAt: typeof data.savedAt === "string" ? data.savedAt : "", values: data.values };
        }).sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.name.localeCompare(b.name));
        picks.failed.configs = "";
        followPick();
      }, fail("configs"));
    } catch (error) { fail("configs")(error); }
    try {
      db.collection(SETTINGS).onSnapshot((snap) => {
        const doc = snap.docs.find((d) => d.id === READER_DOC), data = doc ? doc.data() || {} : null;
        picks.pick = data && typeof data.config === "string" && data.config ? data.config : null;
        picks.pickedAt = data && typeof data.pickedAt === "string" ? data.pickedAt : "";
        picks.failed.settings = "";
        // The texts of the map: with a database, its document settings/texts is their source.
        const texts = snap.docs.find((d) => d.id === TEXTS_DOC), body = texts ? texts.data() || {} : {}, note = typeof body.privateNote === "string" ? body.privateNote : "";
        if (note !== mapTexts.privateNote) { mapTexts.privateNote = note; if (view === "atlas" && rerenderAtlas) rerenderAtlas(); }
        followPick();
      }, fail("settings"));
    } catch (error) { fail("settings")(error); }
  }

  // The force menu of the owner, which replaces the spring model page (the plan of 2026-10-18): every setting of SPEC,
  // the start points of the areas to drag, the measures, the configuration store with the pick for readers, and the
  // state of this browser (stateKey). It runs only for the owner (detectOwner). Other visitors get no menu, no start
  // points and no measures, and the page neither reads nor writes the state of the browser for them.
  function setupForces(stateKey) {
    const seedLayer = viewport.append("g").attr("class", "seed-layer");
    // Start points: one ring per area where its seed pulls; a dashed line leads to where the area hub ended up.
    window.springDrawSeeds = (visible, onDrop) => {
      seedLayer.selectAll("*").remove();
      if (!visible) return;
      const hubOf = new Map(nodes.filter((n) => n.type === "area").map((a) => [a.cluster, a]));
      const at = (c) => [c.at[0] * 0.5, c.at[1] * 0.5];
      const item = seedLayer.selectAll("g").data(CLUSTERS).join("g").attr("class", (c) => "seed k-" + c.id);
      item.append("line").attr("class", "seed-line").attr("x1", (c) => at(c)[0]).attr("y1", (c) => at(c)[1]).attr("x2", (c) => hubOf.get(c.id).x).attr("y2", (c) => hubOf.get(c.id).y);
      const handle = item.append("g").attr("class", "seed-handle").attr("transform", (c) => "translate(" + at(c) + ")");
      handle.append("circle").attr("r", 6);
      handle.append("text").attr("y", -8.5).attr("text-anchor", "middle").text((c) => t("menu.seed.name", { name: c.name }));
      handle.append("title").text(t("menu.seed.drag"));
      handle.call(d3.drag()
        .subject((event, c) => ({ x: at(c)[0], y: at(c)[1] }))
        .on("drag", function (event, c) {
          d3.select(this).attr("transform", "translate(" + event.x + "," + event.y + ")");
          d3.select(this.parentNode).select("line").attr("x1", event.x).attr("y1", event.y);
        })
        .on("end", (event, c) => {
          if (Math.hypot(event.x - at(c)[0], event.y - at(c)[1]) < 0.5) return;
          c.at = [Math.round(event.x * 2), Math.round(event.y * 2)]; onDrop();
        }));
    };
    window.springFit = () => fitAll(false);
    // The number of lines in the current mode and area setting, the end of the count slider.
    window.springLineTotal = () => lineTotal(nodes, links);
    // Shows a fixed region of the map, so two layouts compare at the same scale.
    window.springShow = ([x0, y0, x1, y1]) => {
      const box = svg.node(), w = box.clientWidth, h = box.clientHeight, k = Math.min(w / (x1 - x0), h / (y1 - y0));
      interacted = true;
      svg.call(zoom.transform, d3.zoomIdentity.translate(w / 2 - k * (x0 + x1) / 2, h / 2 - k * (y0 + y1) / 2).scale(k));
    };
    // A new layout from the menu. The overview comes back, as in the spring model; the project editor keeps its view.
    window.springRelayout = () => {
      const t0 = performance.now();
      drawMap(); setFocus(null); node.classed("match", false); fitAll(false);
      if (view === "atlas") renderOverview(); else refresh();
      return { ...window.springMeasure(), seconds: (performance.now() - t0) / 1000 };
    };
    window.springMeasure = () => {
      const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const lines = categoryLinks(nodes, links), areas = nodes.filter((n) => n.type === "area"), hubs = nodes.filter((n) => n.type === "group");
      const members = (h) => nodes.filter((n) => n.type === "skill" && n.group === h.group);
      const ownArea = (h) => areas.find((a) => a.cluster === h.cluster);
      const lopsided = hubs.filter((h) => {
        const angles = members(h).map((n) => Math.atan2(n.y - h.y, n.x - h.x)).sort((a, b) => a - b);
        if (angles.length < 3) return false;
        const widest = Math.max(...angles.map((a, i) => (i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI) - a));
        return widest > 2 * (2 * Math.PI / angles.length);
      });
      const offset = d3.mean(hubs, (h) => { const m = members(h); return Math.hypot(d3.mean(m, (n) => n.x) - h.x, d3.mean(m, (n) => n.y) - h.y) / d3.mean(m, (n) => dist(n, h)); });
      return {
        lineLength: d3.sum(lines, (l) => dist(l.source, l.target) * l.pull), lopsided: lopsided.length, clouds: hubs.length, offset,
        foreign: hubs.filter((h) => areas.some((a) => a !== ownArea(h) && dist(h, a) < dist(h, ownArea(h)))).map((h) => h.name),
        areaDistance: d3.mean(hubs, (h) => dist(h, ownArea(h))), skillDistance: d3.mean(hubs, (h) => d3.mean(members(h), (n) => dist(n, h))),
      };
    };

    // The menu in the language of the page: a copy of SPEC with the text of each key in place of the key
    // (skills/forces.js). Every later use of a text of SPEC reads this copy.
    const MENU = SPEC.map((g) => ({ ...g, title: t(g.title), note: t(g.note), items: g.items.map((it) => ({ ...it, label: t(it.label),
      ...(it.tip ? { tip: t(it.tip) } : {}), ...(it.hint ? { hint: t(it.hint) } : {}),
      ...(it.choice ? { choice: it.choice.map(([value, key]) => [value, t(key)]) } : {}) })) }));
    const items = MENU.flatMap((g) => g.items);
    const el = (id) => document.getElementById(id);
    const menu = el("cfg"), auto = el("cfg-auto"), run = el("cfg-run"), seeds = el("spring-seeds"), values = el("spring-values"), measures = el("cfg-measures");
    const number = (v) => SkillMapI18n.number(Math.round(v * 1000) / 1000, { useGrouping: false, maximumFractionDigits: 3 });
    const format = (it, v) => it.bool ? "" : it.none !== undefined && v >= it.none ? t("menu.value.noLimit") : it.unit === "%" ? Math.round(v * 100) + " %" : number(v) + (it.unit || "");
    const nearest = (it, v) => it.steps.reduce((best, s, i) => Math.abs(s - v) < Math.abs(it.steps[best] - v) ? i : best, 0);
    const input = (it) => el("cfg-" + it.key);
    // A row with a tip explains its setting in a tooltip.
    const row = (it, cls) => 'class="' + cls + '" id="row-' + it.key + '"' + (it.tip ? ' title="' + it.tip.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"' : "");
    // The menu: one collapsible section per group, one row per setting. Every group starts collapsed (his wish, 2026-10-17).
    el("cfg-groups").innerHTML = MENU.map((g) =>'<details><summary>' + g.title + '</summary><p class="cfg-note">' + g.note + '</p>'
      + g.items.map((it) => it.bool
        ? '<label ' + row(it, "cfg-row cfg-check") + ' for="cfg-' + it.key + '"><input id="cfg-' + it.key + '" type="checkbox">' + it.label + '</label>'
        : it.choice
        ? '<label ' + row(it, "cfg-row cfg-color") + ' for="cfg-' + it.key + '"><span>' + it.label + '</span><select id="cfg-' + it.key + '">'
          + it.choice.map(([value, text]) => '<option value="' + value + '">' + text + '</option>').join("") + '</select></label>'
        : it.color
        ? '<label ' + row(it, "cfg-row cfg-color") + ' for="cfg-' + it.key + '"><span>' + it.label + '</span><input id="cfg-' + it.key + '" type="color"></label>'
        : it.count
        ? '<div ' + row(it, "cfg-row") + '><span>' + it.label + ' <output id="out-' + it.key + '"></output></span><div class="cfg-count">'
          + '<input id="cfg-' + it.key + '" type="range" min="0" max="0" step="1" aria-label="' + it.label + '">'
          + '<input id="cfg-' + it.key + '-n" type="number" min="0" step="1" inputmode="numeric" aria-label="' + t("menu.count.asNumber", { label: it.label }) + '"></div>'
          + (it.hint ? '<small class="cfg-hint" id="hint-' + it.key + '">' + it.hint + '</small>' : '') + '</div>'
        : '<label ' + row(it, "cfg-row") + ' for="cfg-' + it.key + '"><span>' + it.label + ' <output id="out-' + it.key + '"></output></span><input id="cfg-' + it.key + '" type="range" min="0" max="' + (it.steps.length - 1) + '" step="1"></label>').join("")
      + '</details>').join("");
    // A line value belongs to a mode. The menu shows the values of the active mode, and its "changed" mark compares
    // them with the defaults of that mode.
    const valueOf = (v, it) => it.look ? v.lines[v.lineMode][it.key] : v[it.key];
    const defaultOf = (v, it) => it.look ? SPRING_DEFAULTS.lines[v.lineMode][it.key] : SPRING_DEFAULTS[it.key];
    const modeName = (m) => items.find((it) => it.key === "lineMode").choice.find(([value]) => value === m)[1];
    const field = (it) => el("cfg-" + it.key + "-n");
    // A count runs from 0 to the number of lines. A value at or above it shows all lines and stays as it is.
    const countText = (v, max) => v >= max ? t("menu.count.all", { total: max }) : t("menu.count.of", { count: v, total: max });
    const browser = el("spring-browser");
    const controls = () => [...items.map(input), ...items.filter((it) => it.count).map(field), run, auto, seeds, el("spring-reset"), el("spring-favourite"), browser, el("spring-load"), el("cfg-hide")];
    // The state that this browser stored last for this map, or null. The owner starts from the configuration for readers;
    // "Letzter Stand im Browser" loads this state.
    const STORED = stateKey;
    function storedState() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORED));
        return saved && typeof saved === "object" && !Array.isArray(saved) && typeof saved.pull === "number" ? saved : null;
      } catch (e) { return null; }
    }
    const markBrowser = () => { browser.disabled = !storedState(); };
    function sync() {
      const v = springCurrent();
      items.forEach((it) => {
        const value = valueOf(v, it), changed = value !== defaultOf(v, it);
        if (it.bool) { input(it).checked = !!value; return; }
        if (it.color || it.choice) { input(it).value = value; el("row-" + it.key).classList.toggle("changed", changed); return; }
        if (it.count) {
          const max = window.springLineTotal ? window.springLineTotal() : 0;
          input(it).max = String(max); input(it).value = String(Math.min(value, max)); field(it).value = String(value);
          el("out-" + it.key).textContent = countText(value, max);
          el("row-" + it.key).classList.toggle("changed", changed);
          return;
        }
        input(it).value = nearest(it, value);
        el("out-" + it.key).textContent = format(it, value);
        el("row-" + it.key).classList.toggle("changed", changed);
      });
      // The line names its version, so a later page can migrate it.
      values.value = JSON.stringify({ schema: SPRING_SCHEMA, ...v });
      applyNeeds();
      markBrowser();
    }
    // A control whose main switch is off has no effect, so it is disabled and greyed out. The same holds for a control
    // that has no effect while another control has a certain value (offIn: [key, value], or a list of such pairs), for
    // example a mode. The value of a switch is true or false.
    const holds = ([key, value]) => { const p = items.find((q) => q.key === key); return (p.bool ? input(p).checked : input(p).value) === value; };
    function applyNeeds() {
      items.forEach((it) => {
        if (!it.needs && !it.offIn) return;
        const off = !!(it.needs && !input(items.find((p) => p.key === it.needs)).checked)
          || !!(it.offIn && (Array.isArray(it.offIn[0]) ? it.offIn : [it.offIn]).some(holds));
        input(it).disabled = off;
        if (it.count) field(it).disabled = off;
        el("row-" + it.key).classList.toggle("off", off);
      });
    }
    // A loaded value between two menu steps stays until its own slider moves. The line controls show the values of the
    // active mode, so they go back into that mode, also when the mode itself changed.
    function read() {
      const v = springCurrent(), shown = v.lines[v.lineMode];
      items.forEach((it) => {
        const into = it.look ? shown : v;
        if (it.bool) { into[it.key] = input(it).checked; return; }
        if (it.color || it.choice) { into[it.key] = input(it).value; return; }
        if (it.count) { into[it.key] = Math.max(0, Math.round(Number(field(it).value)) || 0); return; }
        const i = Number(input(it).value);
        if (i !== nearest(it, into[it.key])) into[it.key] = it.steps[i];
      });
      return v;
    }
    const byKey = new Map(items.map((it) => [it.key, it]));
    // The check of the configuration for readers too (springFits in skills/forces.js).
    const fits = springFits;
    const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
    // Values from a line, a saved configuration or a test: the steps of springMigrate bring them to SPRING_SCHEMA, then
    // each value must fit its control. A wrong type loads nothing. Unknown keys are left out and named. Values of a newer
    // page load the keys that this page knows, and a value that does not fit is left out and named too.
    function readValues(raw) {
      if (!isObject(raw)) return { error: t("menu.values.notObject") };
      const early = [];
      if (raw.schema !== undefined && !(Number.isInteger(raw.schema) && raw.schema >= 1)) early.push("schema");
      if (raw.lines !== undefined && !isObject(raw.lines)) early.push("lines");
      else Object.entries(raw.lines || {}).forEach(([m, set]) => { if (SPRING_MODES.includes(m) && !isObject(set)) early.push("lines." + m); });
      if (early.length) return { error: t("menu.values.wrongType", { list: early.join(", ") }) };
      const migrated = springMigrate(raw), v = JSON.parse(JSON.stringify(migrated.values)), unknown = [], wrong = [];
      for (const [k, x] of Object.entries(v)) {
        if (k === "at") {
          if (!isObject(x)) { wrong.push(["at"]); continue; }
          for (const [id, p] of Object.entries(x)) {
            if (!CLUSTERS.some((c) => c.id === id)) unknown.push(["at", id]);
            else if (!(Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) wrong.push(["at", id]);
          }
        } else if (k === "lines") {
          // The line values of each mode: a set for each mode it names, with keys of the line controls.
          for (const [m, set] of Object.entries(x)) {
            if (!SPRING_MODES.includes(m)) { unknown.push(["lines", m]); continue; }
            for (const [lk, lx] of Object.entries(set)) {
              if (!byKey.has(lk) || !byKey.get(lk).look) unknown.push(["lines", m, lk]);
              else if (!fits(byKey.get(lk), lx)) wrong.push(["lines", m, lk]);
            }
          }
        } else if (!byKey.has(k) || byKey.get(k).look) unknown.push([k]);
        else if (!fits(byKey.get(k), x)) wrong.push([k]);
      }
      const names = (paths) => paths.map((p) => p.join("."));
      if (wrong.length && !migrated.newer) return { error: t("menu.values.wrongType", { list: names(wrong).join(", ") }) };
      // A line whose every key is unknown would only set the page back to layout.js.
      const named = Object.keys(raw).filter((k) => k !== "schema");
      if (named.length && named.every((k) => unknown.some((p) => p.length === 1 && p[0] === k))) return { error: t("menu.values.noneKnown", { list: named.join(", ") }) };
      [...unknown, ...wrong].forEach((p) => { const parent = p.slice(0, -1).reduce((o, k) => o && o[k], v); if (parent) delete parent[p.at(-1)]; });
      // A number outside the range of its control takes the nearer end (springClamp in skills/forces.js).
      const clamped = [];
      const clamp = (set, key, path) => { const x = springClamp(key, set[key]); if (x !== set[key]) { set[key] = x; clamped.push(path); } };
      Object.keys(v).forEach((k) => { if (k !== "at" && k !== "lines") clamp(v, k, [k]); });
      Object.entries(v.lines || {}).forEach(([m, set]) => Object.keys(set).forEach((lk) => clamp(set, lk, ["lines", m, lk])));
      return { values: v, from: migrated.from, newer: migrated.newer, notes: migrated.notes, unknown: names(unknown), skipped: names(wrong), clamped: names(clamped) };
    }
    const message = el("spring-message");
    const say = (text, error) => { message.textContent = text; message.classList.toggle("error", !!error); };
    // A name in quotation marks, with the marks of the language.
    const quoted = (text) => t("menu.quoted", { text });
    const labelOf = (key) => quoted(byKey.has(key) ? byKey.get(key).label : Object.hasOwn(SPRING_OLD_LABELS, key) ? t(SPRING_OLD_LABELS[key]) : key);
    const andList = (list) => list.length > 1 ? t("menu.list.and", { first: list.slice(0, -1).join(", "), last: list.at(-1) }) : list.join("");
    const onOff = (on) => on ? t("menu.state.on") : t("menu.state.off");
    // What the steps of springMigrate did, and what was left out, for the page message. "who" is the subject of the first
    // sentence: menu.who.line, menu.who.config or menu.who.browser.
    function migrationText(r, who) {
      const parts = [];
      if (r.newer) parts.push(t("menu.migrate.newer", { who, from: r.from, schema: SPRING_SCHEMA }));
      else if (r.notes.length) parts.push(t("menu.migrate.done", { who, from: r.from, schema: SPRING_SCHEMA }));
      r.notes.forEach((n) => {
        if (n.flatMode) parts.push(t("menu.migrate.flat", { mode: modeName(n.flatMode) }));
        if (n.split.length) parts.push(t("menu.migrate.split", { count: n.split.length, list: andList(n.split.map(labelOf)) }));
        if (n.added.length) parts.push(t("menu.migrate.added", { count: n.added.length, list: andList(n.added.map(labelOf)) }));
        if (n.standard) parts.push(t("menu.migrate.standard", { oldLabel: labelOf("standardLinks"), oldState: onOff(n.standard.links), newLabel: labelOf("standardSkills"), newState: onOff(n.standard.skills) }));
      });
      const retired = r.notes.flatMap((n) => n.retired);
      if (retired.length) parts.push(t("menu.migrate.retired", { list: retired.join(", ") }));
      if (r.unknown.length) parts.push(t("menu.migrate.unknown", { list: r.unknown.join(", ") }));
      if (r.skipped.length) parts.push(t("menu.migrate.skipped", { list: r.skipped.join(", ") }));
      if (r.clamped.length) parts.push(t("menu.migrate.clamped", { list: r.clamped.join(", ") }));
      return parts.length ? " " + parts.join(" ") : "";
    }
    // Values between two menu steps, for the page message.
    function betweenText(v) {
      const between = [...items.filter((it) => !it.look && it.steps && v[it.key] !== undefined && !it.steps.includes(v[it.key])).map((it) => it.label),
        ...Object.entries(v.lines || {}).flatMap(([m, set]) => items.filter((it) => it.look && it.steps && set[it.key] !== undefined && !it.steps.includes(set[it.key])).map((it) => t("menu.between.inMode", { label: it.label, mode: modeName(m) })))];
      return between.length ? " " + t("menu.between.text", { list: between.join(", ") }) : "";
    }
    // Values missing in the line take the value of layout.js, so a line gives the same map as in the measurements.
    // The line values of each mode are under "lines". An old line carries them flat: they load into its mode (SPRING_STEPS).
    function load() {
      let raw;
      try { raw = JSON.parse(values.value.trim()); } catch (e) { say(t("menu.values.notJson"), true); return; }
      const r = readValues(raw);
      if (r.error) { say(r.error, true); return; }
      const sets = Object.entries(isObject(raw.lines) ? raw.lines : {}).map(([m, set]) => Object.keys(set).filter((k) => r.values.lines && r.values.lines[m] && r.values.lines[m][k] !== undefined).length).filter(Boolean);
      const given = items.filter((it) => raw[it.key] !== undefined && !r.unknown.includes(it.key) && !r.skipped.includes(it.key));
      relayout(springMerge(r.values));
      const parts = [t("menu.load.values", { count: given.length }),
        ...(sets.length ? [t("menu.load.lineValues", { count: sets.reduce((sum, n) => sum + n, 0), modes: t("menu.load.modes", { count: sets.length }) })] : []),
        ...(r.values.at ? [t("menu.load.startPoints", { count: Object.keys(r.values.at).length })] : [])];
      say(t("menu.load.done", { list: andList(parts) }) + migrationText(r, t("menu.who.line")) + betweenText(r.values));
    }
    // A saved configuration loads through the same steps. The saved document stays as it is until it is saved again.
    // With "fromBrowser", it is the state that this browser stored last ("Letzter Stand im Browser").
    function loadConfig(config, fromBrowser = false) {
      const what = fromBrowser ? t("menu.config.browserState") : quoted(config.name);
      if (!isObject(config.values)) { say(t("menu.config.noValues", { what }), true); return false; }
      const r = readValues(Number.isInteger(config.schema) ? { ...config.values, schema: config.schema } : config.values);
      if (r.error) { say(t("menu.config.notLoaded", { what, reason: r.error }), true); return false; }
      // A mode without its own line values (an old flat line has values for one mode) is named once.
      const set = (m) => (r.values.lines && r.values.lines[m]) || {}, absent = (m) => SPRING_LOOK.filter((k) => set(m)[k] === undefined);
      const missing = [...items.filter((it) => !it.look && r.values[it.key] === undefined).map((it) => it.key),
        ...SPRING_MODES.filter((m) => absent(m).length >= SPRING_LOOK.length - 1).map((m) => t("menu.config.modeLineValues", { mode: modeName(m) })),
        ...SPRING_MODES.filter((m) => absent(m).length && absent(m).length < SPRING_LOOK.length - 1).flatMap((m) => absent(m).map((k) => "lines." + m + "." + k)),
        ...CLUSTERS.filter((c) => !(r.values.at && Object.hasOwn(r.values.at, c.id))).map((c) => "at." + c.id)];
      relayout(springMerge(r.values));
      const same = r.from === SPRING_SCHEMA, schema = SPRING_SCHEMA, list = missing.join(", ");
      const loaded = fromBrowser ? (same ? t("menu.config.loadedBrowserSame", { schema }) : t("menu.config.loadedBrowser"))
        : same ? t("menu.config.loadedSame", { name: config.name, schema }) : t("menu.config.loaded", { name: config.name });
      say(loaded + migrationText(r, fromBrowser ? t("menu.who.browser") : t("menu.who.config"))
        + (!fromBrowser && (r.notes.length || r.newer) ? " " + t("menu.config.keepsEntry") : "")
        + (missing.length ? " " + (fromBrowser ? t("menu.config.missingBrowser", { list }) : t("menu.config.missing", { list })) : "") + betweenText(r.values));
      return true;
    }
    // Colors need no new layout: the lines take the new color at once.
    function paintColors() {
      const map = el("map");
      map.style.setProperty("--shared-light", LINE_COLOR_LIGHT);
      map.style.setProperty("--shared-dark", LINE_COLOR_DARK);
    }
    function report(m) {
      const rows = [
        // The build measures the reference on its own data, so the map of a visitor has none.
        [t("menu.measure.lineLength"), OWN_MAP ? String(Math.round(m.lineLength)) : t("menu.measure.withReference", { value: Math.round(m.lineLength), reference: LINE_REFERENCE })],
        [t("menu.measure.lopsided"), t("menu.measure.of", { count: m.lopsided, total: m.clouds })],
        [t("menu.measure.offset"), t("menu.measure.radii", { count: Math.round(m.offset * 100) / 100, value: number(Math.round(m.offset * 100) / 100) })],
        [t("menu.measure.skillCategory"), number(Math.round(m.skillDistance))],
        [t("menu.measure.categoryArea"), number(Math.round(m.areaDistance))],
        [t("menu.measure.foreign"), m.foreign.length ? m.foreign.join(", ") : t("menu.measure.none")],
      ];
      if (m.seconds) rows.push([t("menu.measure.time"), t("menu.measure.seconds", { value: number(Math.round(m.seconds * 10) / 10) })]);
      // Every value is escaped: the names of the categories come from the map, and an editor of a team map writes them.
      measures.innerHTML = rows.map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>").join("");
    }
    function save() { try { localStorage.setItem(STORED, JSON.stringify({ schema: SPRING_SCHEMA, ...springCurrent() })); } catch (e) {} }
    // A layout from the menu is the owner's own: it marks the menu as changed and stores the state in this browser. The
    // pick for readers at start (forcesView) does neither, so "Letzter Stand im Browser" keeps the state of the last visit.
    function relayout(v, mine = true) {
      if (mine) picks.ownerChanged = true;
      springApply(v); sync();
      if (mine) save();
      run.classList.remove("dirty");
      measures.innerHTML = "<dt>" + t("menu.measure.computing") + "</dt><dd></dd>";
      controls().forEach((c) => { c.disabled = true; });
      setTimeout(() => {
        report(window.springRelayout());
        window.springDrawSeeds(seeds.checked, () => relayout(springCurrent()));
        controls().forEach((c) => { c.disabled = false; });
        applyNeeds();
        markBrowser();
      }, 30);
    }
    // A change of a setting makes the menu state the owner's own, also a change that waits for "Neu berechnen".
    ["input", "change"].forEach((type) => menu.addEventListener(type, (e) => { if (e.target.closest("#cfg-groups")) picks.ownerChanged = true; }, true));
    items.forEach((it) => {
      const c = input(it);
      if (it.color) {
        c.addEventListener("input", () => { springApply({ [it.key]: c.value }); paintColors(); sync(); save(); });
        return;
      }
      if (it.steps) c.addEventListener("input", () => { el("out-" + it.key).textContent = format(it, it.steps[c.value]); });
      if (it.count) {
        // The slider and the number field stay in sync; either one lays the map out again.
        c.addEventListener("input", () => { field(it).value = c.value; el("out-" + it.key).textContent = countText(Number(c.value), Number(c.max)); });
        field(it).addEventListener("change", () => {
          const n = Math.max(0, Math.round(Number(field(it).value)) || 0);
          field(it).value = String(n); c.value = String(Math.min(n, Number(c.max)));
          if (auto.checked) relayout(read()); else run.classList.add("dirty");
        });
      }
      c.addEventListener("change", () => {
        applyNeeds();
        if (auto.checked) relayout(read());
        // Without "automatisch" a new mode still loads its values into the menu at once, so no control shows a value of
        // another mode. The map waits for "Neu berechnen".
        else if (it.key === "lineMode") { springApply(read()); sync(); save(); run.classList.add("dirty"); }
        else run.classList.add("dirty");
      });
    });
    run.addEventListener("click", () => relayout(read()));
    seeds.addEventListener("change", () => window.springDrawSeeds(seeds.checked, () => relayout(springCurrent())));
    el("spring-reset").addEventListener("click", () => relayout(JSON.parse(JSON.stringify(SPRING_DEFAULTS))));
    el("spring-favourite").addEventListener("click", () => relayout(JSON.parse(JSON.stringify(SPRING_FIRST))));
    // The state of the last visit loads through the same steps as a saved configuration.
    browser.addEventListener("click", () => {
      const saved = storedState();
      if (!saved) { markBrowser(); return; }
      loadConfig({ name: t("menu.foot.browser"), schema: saved.schema, values: saved }, true);
    });
    el("spring-copy").addEventListener("click", () => {
      values.select();
      if (navigator.clipboard) navigator.clipboard.writeText(values.value).catch(() => {});
    });
    el("spring-load").addEventListener("click", load);
    values.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); load(); } });
    const show = el("cfg-show");
    const setOpen = (open) => {
      menu.hidden = !open; show.hidden = open;
      menu.parentNode.classList.toggle("cfg-open", open); menu.parentNode.classList.toggle("cfg-shut", !open);
      window.springFit();
    };
    // On a phone the menu covers the map, so it closes when the window becomes that narrow, as it starts closed there.
    window.matchMedia("(max-width: 700px)").addEventListener("change", (e) => { if (e.matches && !menu.hidden) setOpen(false); });
    el("cfg-hide").addEventListener("click", () => setOpen(false));
    show.addEventListener("click", () => setOpen(true));
    setOpen(!window.matchMedia("(max-width: 700px)").matches);
    sync();
    report(window.springMeasure());
    window.springDrawSeeds(seeds.checked, () => relayout(springCurrent()));
    forcesView = () => relayout(springCurrent(), false);
    forcesRedraw = () => { report(window.springMeasure()); window.springDrawSeeds(seeds.checked, () => relayout(springCurrent())); };

    // The configuration store (his wish of 2026-10-17): named states in the collection "configs" of the database of this
    // page, one document per name, { name, schema, values, savedAt }. The id of a document comes from its name. "Für
    // Leser" writes settings/reader, the pick that readers see (the plan of 2026-10-18). Without a database the section
    // says so, and the rest of the menu works as before.
    const cfgStore = { ask: null, deleting: null, busy: false, readOnly: false };
    const ui = { state: el("store-state"), reader: el("store-reader"), form: el("store-form"), name: el("store-name"), save: el("store-save"), ask: el("store-ask"), list: el("store-list"), message: el("store-message") };
    const when = (iso) => { const d = new Date(iso); return iso && !isNaN(d) ? SkillMapI18n.date(d, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : t("menu.store.noDate"); };
    // A safe document id: small letters, digits and hyphens. A name without a letter of a to z or a digit gets the id
    // "config". Before, such a name got "konfiguration": a map that has a configuration of that id and none of the id
    // "config" keeps saving such a name there, so that a save asks before it overwrites, as before.
    const OLD_CONFIG_ID = "konfiguration";
    const configSlug = (name) => name.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "")
      || (docsNow().some((d) => d.id === OLD_CONFIG_ID) && !docsNow().some((d) => d.id === "config") ? OLD_CONFIG_ID : "config");
    const storeSay = (text, error) => { ui.message.textContent = text; ui.message.classList.toggle("error", !!error); };
    // A short fault of the platform gets one more try after a short pause. Every other refusal goes to the message.
    const once = async (f) => {
      try { return await f(); } catch (e) {
        if (!e || e.code !== "unavailable") throw e;
        await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 400));
        return f();
      }
    };
    const schemaText = (d) => Number.isInteger(d.schema) ? t("menu.store.schema", { schema: d.schema }) + (d.schema > SPRING_SCHEMA ? '<span class="store-newer"> · ' + t("menu.store.newer") + '</span>' : "") : t("menu.store.noSchema");
    const docsNow = () => picks.docs || [];
    // What readers see, for the line above the list. Without a pick in the database, readers see the pick of the data
    // file or the values of layout.js.
    function readerText() {
      const built = builtPick ? quoted(builtPick.name) : t("menu.reader.layoutValues");
      if (!picks.ready) return "";
      if (!picks.db) return t("menu.reader.sees", { what: built });
      const failed = picks.failed.settings || picks.failed.configs;
      if (failed) return t("menu.reader.unreadable", { reason: failed });
      const result = pickResult();
      if (result === undefined) return "";
      if (result.status === "none") return t("menu.reader.none", { what: built });
      if (result.status === "missing") return t("menu.reader.missing", { id: result.id });
      // The pick travels with the map file.
      return picks.pickedAt ? t("menu.reader.pickedAt", { name: result.config.name, when: when(picks.pickedAt) }) : t("menu.reader.picked", { name: result.config.name });
    }
    function storeRender() {
      const { ask, deleting, busy, readOnly } = cfgStore, db = picks.db, docs = docsNow(), loaded = picks.docs !== null, failed = picks.failed.configs;
      if (deleting && !docs.some((d) => d.id === deleting)) cfgStore.deleting = null;
      ui.state.textContent = !picks.ready ? t("menu.store.connecting")
        : !db ? t("menu.store.unavailable")
        : failed ? t("menu.store.noAnswer", { reason: failed })
        : !loaded ? t("menu.store.loading")
        : readOnly ? t("menu.store.readOnly")
        : docs.length ? "" : t("menu.store.empty");
      ui.state.hidden = !ui.state.textContent;
      ui.reader.textContent = readerText();
      ui.reader.hidden = !ui.reader.textContent;
      ui.form.hidden = !db || !loaded || !!failed || readOnly;
      ui.save.disabled = busy;
      ui.ask.hidden = !ask;
      ui.ask.innerHTML = ask ? '<p>' + t("menu.store.exists", { name: esc(ask.existing.name), when: esc(when(ask.existing.savedAt)) })
        + (ask.id === picks.pick ? " " + t("menu.store.readersSeeNew") : "") + '</p>'
        + '<div class="store-actions"><button type="button" data-act="overwrite">' + t("menu.store.overwrite") + '</button><button type="button" data-act="keep">' + t("menu.store.cancel") + '</button></div>' : "";
      ui.list.hidden = !db || !docs.length;
      // The picked entry says so, has no "Für Leser" and cannot be deleted, so readers never lose their configuration.
      ui.list.innerHTML = docs.map((d) => '<li data-id="' + esc(d.id) + '"' + (d.id === picks.pick ? ' class="store-picked"' : "") + '><div class="store-entry"><span class="store-name">' + esc(d.name) + '</span>'
        + '<span class="store-meta">' + esc(when(d.savedAt)) + ' · ' + schemaText(d) + (d.id === picks.pick ? " · " + t("menu.store.forReaders") : "") + '</span></div>'
        + (cfgStore.deleting === d.id
          ? '<p class="store-confirm">' + t("menu.store.confirmDelete", { name: esc(d.name) }) + '</p><div class="store-actions"><button type="button" data-act="delete">' + t("menu.store.delete") + '</button><button type="button" data-act="keep-delete">' + t("menu.store.cancel") + '</button></div>'
          : '<div class="store-actions"><button type="button" data-act="load">' + t("menu.store.load") + '</button>' + (readOnly ? ""
            : (d.id === picks.pick ? "" : '<button type="button" data-act="reader">' + t("menu.store.pick") + '</button>')
            + '<button type="button" data-act="ask-delete"' + (d.id === picks.pick ? ' title="' + t("menu.store.pickOtherFirst") + '"' : "") + '>' + t("menu.store.delete") + '</button>') + '</div>')
        + '</li>').join("");
      ui.list.querySelectorAll('button[data-act="delete"], button[data-act="ask-delete"], button[data-act="reader"]').forEach((b) => { b.disabled = busy || b.closest("li").dataset.id === picks.pick && b.dataset.act !== "reader"; });
    }
    // "what" names the write: menu.store.what.save, menu.store.what.pick or menu.store.what.delete.
    function storeRefused(e, what) {
      const code = e && e.code ? e.code : t("menu.store.unknownCode");
      // Only a refusal of the right means that this view may not write: the store stays readable for this visit. Any other
      // refusal fails this one write and names its reason.
      if (code === "permission_denied") cfgStore.readOnly = true;
      storeSay(code === "permission_denied" ? t("menu.store.refused.denied", { what })
        : code === "quota_exceeded" ? t("menu.store.refused.full", { what })
        : code === "invalid_argument" ? t("menu.store.refused.invalid", { what, reason: e && e.message ? e.message : t("menu.store.refused.document") })
        : t("menu.store.failed", { what, code }), true);
    }
    // Saves the computed state. A name that is taken asks in the page before it overwrites.
    async function storeSave(confirmed) {
      if (cfgStore.busy) return;
      const name = ui.name.value.trim().replace(/\s+/g, " ");
      if (!name) { storeSay(t("menu.store.nameMissing"), true); return; }
      const id = configSlug(name), existing = docsNow().find((d) => d.id === id);
      if (existing && !confirmed) { cfgStore.ask = { id, existing }; storeSay(""); storeRender(); return; }
      cfgStore.ask = null; cfgStore.busy = true; storeRender();
      const body = { name, schema: SPRING_SCHEMA, values: JSON.parse(JSON.stringify(springCurrent())), savedAt: new Date().toISOString() };
      try {
        await once(() => picks.db.collection(CONFIGS).doc(id).set(body));
        ui.name.value = "";
        storeSay((existing ? t("menu.store.overwritten", { name }) : t("menu.store.saved", { name }))
          + (run.classList.contains("dirty") ? " " + t("menu.store.pendingLeftOut") : ""));
      } catch (e) { storeRefused(e, t("menu.store.what.save")); }
      cfgStore.busy = false; storeRender();
    }
    // Picks the configuration that readers see. Readers of the database follow at once, and the map file carries it.
    async function storePick(d) {
      if (cfgStore.busy) return;
      cfgStore.busy = true; storeRender();
      try {
        await once(() => picks.db.collection(SETTINGS).doc(READER_DOC).set({ config: d.id, pickedAt: new Date().toISOString() }));
        storeSay(t("menu.store.picked", { name: d.name }));
      } catch (e) { storeRefused(e, t("menu.store.what.pick")); }
      cfgStore.busy = false; storeRender();
    }
    // The button is no submit button, so the forms of the project editor keep the only submit buttons of the page. Enter in
    // the name field still submits the form.
    ui.save.addEventListener("click", () => storeSave(false));
    ui.form.addEventListener("submit", (e) => { e.preventDefault(); storeSave(false); });
    ui.name.addEventListener("input", () => { if (cfgStore.ask) { cfgStore.ask = null; storeRender(); } });
    ui.ask.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      if (b.dataset.act === "overwrite") storeSave(true);
      else { cfgStore.ask = null; storeSay(""); storeRender(); }
    });
    ui.list.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-act]"), li = b && b.closest("li"), d = li && docsNow().find((x) => x.id === li.dataset.id);
      if (!d) return;
      const act = b.dataset.act;
      if (act === "load") {
        // While a layout runs, the menu waits; so does the store.
        if (el("spring-load").disabled) return;
        if (loadConfig(d)) storeSay(t("menu.store.loaded", { name: d.name })); else storeSay(t("menu.store.notLoaded", { name: d.name }), true);
      } else if (act === "reader" && d.id !== picks.pick) storePick(d);
      else if (act === "ask-delete" && d.id !== picks.pick) { cfgStore.deleting = d.id; storeSay(""); storeRender(); }
      else if (act === "keep-delete") { cfgStore.deleting = null; storeRender(); }
      else if (act === "delete" && !cfgStore.busy && d.id !== picks.pick) {
        cfgStore.deleting = null; cfgStore.busy = true; storeRender();
        try { await once(() => picks.db.collection(CONFIGS).doc(d.id).delete()); storeSay(t("menu.store.deleted", { name: d.name })); }
        catch (error) { storeRefused(error, t("menu.store.what.delete")); }
        cfgStore.busy = false; storeRender();
      }
    });
    picks.listener = storeRender;
    storeRender();
  }

  // The dropdown of the languages (selfhost/site/language.js) stays the last of the tools, in the order of the page and of
  // the keyboard, also after the tools that a runtime adds.
  function keepLanguageLast(tools) {
    const picker = tools.querySelector(":scope > [data-language-picker]");
    if (picker) tools.append(picker);
  }
  // The self-hosted site (FEATURES.mapFile): a link to the start page, "Map-Datei öffnen" for every visitor, and
  // "Exportieren" for the owner. The runtime reads and writes the file; the page only asks it.
  const fileTools = FEATURES.mapFile ? setupFileTools() : null;
  function setupFileTools() {
    const tools = document.querySelector("header .tools"), make = (tag, props) => Object.assign(document.createElement(tag), props);
    const home = make("a", { className: "tool-link", href: runtime.home || "index.html", target: "_top", textContent: t("file.home"), title: TEXTS.homeTitle || "" });
    const open = make("button", { type: "button", id: "file-open", textContent: t("file.open") });
    const input = make("input", { type: "file", id: "file-input", accept: ".json,application/json", hidden: true });
    const exp = make("button", { type: "button", id: "file-export", textContent: t("file.export"), hidden: true });
    const message = make("p", { className: "file-message", id: "file-message", hidden: true });
    input.setAttribute("aria-label", t("file.choose"));
    message.setAttribute("role", "alert");
    tools.prepend(home);
    tools.append(open, input, exp);
    keepLanguageLast(tools);
    document.querySelector("header").append(message);
    open.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file || !runtime.openMapFile) return;
      message.hidden = true;
      const error = await runtime.openMapFile(file);
      if (error) { message.textContent = error; message.hidden = false; }
    });
    exp.addEventListener("click", exportMap);
    return { exp, message };
  }
  // Exports the map once every change has landed in the database, at most after three seconds.
  async function exportMap() {
    if (!runtime.exportMap) return;
    store.flushAll();
    for (let i = 0; i < 60 && (catalog.pending || structure.pending || store.status === "pending"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const error = runtime.exportMap();
    if (error && fileTools) { fileTools.message.textContent = error; fileTools.message.hidden = false; }
  }
  // The header of the map of a visitor: its title, and for the owner what he does here. The CV map keeps its header.
  function showHeader() {
    if (!OWN_MAP || mapTitle === null) return;
    document.getElementById("title").textContent = mapTitle;
    document.title = mapTitle + " · Skill-Map";
    document.getElementById("subtitle").textContent = reader ? t("header.reader")
      : t("header.owner") + (TEXTS.ownerHint ? " " + TEXTS.ownerHint : "");
    if (fileTools) fileTools.exp.hidden = reader;
  }
  mapInfoOnce.then((info) => {
    if (!info) return;
    mapTitle = info.title;
    showHeader();
    if (view === "atlas" && rerenderAtlas) rerenderAtlas();
  });
  // Downloads (his wish of 2026-10-18: "Exporte (PDF als SVG Grafik), PNG Datei, SVG Datei"), for every visitor. A file
  // shows the whole map as it is drawn now, with its filters, time range, selection and theme, fitted to the bounds of
  // the map, with every name at its zoomed-in size and the title and the date at the bottom. The SVG resolves every class
  // and CSS variable into plain attributes and embeds the fonts when the page can read their data. The PNG draws that
  // SVG at 2 or 4 times its size. The PDF draws it as vectors with jsPDF and svg2pdf.js, which load on the first click;
  // its text is text in the embedded font Noto Sans (PDF_FONTS), so Ctrl+F finds every name. The page saves each file
  // itself: the browser saves a link with download to the blob address of the file.
  function setupDownloads() {
    const box = document.getElementById("downloads"), state = document.getElementById("download-state");
    const buttons = [...box.querySelectorAll("button[data-file]")];
    // The title of the map in each file: of the map of a visitor once the runtime names it (mapInfo, also after "Titel
    // ändern"), else of the data file.
    const titleOf = () => mapTitle !== null ? mapTitle : MAP_TITLE;
    const NS = "http://www.w3.org/2000/svg";
    // Pixels of the SVG per map unit: the smallest skill name (2.4 units) is 7.2 px, and 14.4 px in the PNG. A PNG
    // larger than MAX_SIDE or MAX_AREA pixels gets a smaller scale, because browsers refuse larger canvases.
    const PX = 3, FOOT = 9, MAX_SIDE = 16384, MAX_AREA = 120e6;
    // jsPDF and svg2pdf.js of the site (vendor/), each with the hash of its published file.
    const PDF_LIBS = [
      ["vendor/jspdf-4.2.1.umd.min.js", "sha512-plOdviVmws4Y3JAvbnpfKb2hVxKM1lCwsi3vmElYRj+tiDLffZ4FVUj5a8vyKJ9pIgl8JCAHEJ4D1iUKBecswg=="],
      ["vendor/svg2pdf.js-2.8.1.umd.min.js", "sha384-7hc/mtl4lyRUMzYFqHxwNbYZwh27MESE5AWa2nEuVChLn8bCQcrn18OgGv9uHgzz"],
    ];
    // The font of the text in the PDF (D4 of the final review): the standard fonts of PDF know only Windows-1252, so a
    // name such as "Łódź", "Ελλάδα" or "Москва" came out as wrong characters. The PDF embeds Noto Sans of the site
    // (vendor/fonts/, build_selfhost.js), regular for the names of weight 400 and bold for the others, each with the
    // hash of its file. jsPDF embeds only the glyphs that the PDF uses, and the text stays text that a reader can search.
    const PDF_FONT = "NotoSans";
    const PDF_FONTS = [
      ["normal", "vendor/fonts/noto-sans-2.015-400-normal.ttf", "sha384-SygOqUEk3r0fOSS46zwcTGBhXMeuMtc0b86LFtUc8wCGELzWsAnfim+LlSgvoRi+"],
      ["bold", "vendor/fonts/noto-sans-2.015-700-normal.ttf", "sha384-k6RsSzsC9UBTwncpz5Izm5DlJg4uIfTW9fQqOWgz6vn1CTTLq+tIHRbPja1YgjJi"],
    ];
    const num = (v) => String(Math.round(Number(v) * 1000) / 1000);
    const create = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); return e; };
    // A computed color as "#rrggbb" with its alpha, from the forms of getComputedStyle: rgb(), rgba() and color(srgb …).
    function color(value) {
      const alphaOf = (a) => a === undefined ? 1 : parseFloat(a) / (a.endsWith("%") ? 100 : 1);
      let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value), rgb;
      if (m) rgb = [m[1], m[2], m[3]].map(Number);
      else if ((m = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(value))) rgb = [m[1], m[2], m[3]].map((x) => Number(x) * 255);
      else return null;
      return { hex: "#" + rgb.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join(""), alpha: alphaOf(m[4]) };
    }
    // A computed paint as an attribute value and the alpha that goes into its opacity. A reference keeps only its #id.
    function paint(value) {
      const ref = /url\(\s*["']?[^#"')]*(#[^"')]+)["']?\s*\)/.exec(value || "");
      if (ref) return [`url(${ref[1]})`, 1];
      const c = color(value || "");
      return !c || c.alpha === 0 ? ["none", 1] : [c.hex, c.alpha];
    }
    // Writes the computed style of a drawn element as plain attributes on its copy, and drops its classes and styles.
    function inline(from, to) {
      const cs = getComputedStyle(from), tag = from.localName;
      [...to.attributes].forEach((a) => { if (a.name === "class" || a.name === "style" || a.name.startsWith("data-")) to.removeAttribute(a.name); });
      ["d", "transform", "x1", "y1", "x2", "y2"].forEach((a) => { if (to.hasAttribute(a)) to.setAttribute(a, to.getAttribute(a).replace(/-?\d*\.\d{4,}(?:e-?\d+)?/g, num)); });
      const put =(name, value, initial) => { if (value === initial) to.removeAttribute(name); else to.setAttribute(name, value); };
      put("opacity", num(cs.opacity), "1");
      if (tag === "stop") {
        const c = color(cs.stopColor) || { hex: "#000000", alpha: 1 };
        put("stop-color", c.hex); put("stop-opacity", num(c.alpha * Number(cs.stopOpacity)), "1");
        return;
      }
      if (!["path", "circle", "rect", "line", "text"].includes(tag)) return;
      const [fill, fillAlpha] = paint(cs.fill), [stroke, strokeAlpha] = paint(cs.stroke);
      put("fill", fill); put("fill-opacity", num(fillAlpha * Number(cs.fillOpacity)), "1");
      put("stroke", stroke); put("stroke-opacity", num(strokeAlpha * Number(cs.strokeOpacity)), "1");
      if (stroke !== "none") {
        put("stroke-width", num(parseFloat(cs.strokeWidth)), "1");
        put("stroke-dasharray", cs.strokeDasharray === "none" ? "none" : cs.strokeDasharray.replace(/px/g, "").replace(/,\s*/g, " "), "none");
        put("stroke-linecap", cs.strokeLinecap, "butt");
        put("stroke-linejoin", cs.strokeLinejoin, "miter");
      } else ["stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "stroke-opacity"].forEach((a) => to.removeAttribute(a));
      if (tag === "text") { put("font-family", cs.fontFamily.replace(/"/g, "'")); put("font-size", num(parseFloat(cs.fontSize))); put("font-weight", cs.fontWeight); }
    }

    // The @font-face rules of the page for the families, weights and characters of the file, with the font data as data
    // URLs. A style sheet that the page cannot read, for example of another origin, is read again with fetch. A font that
    // the page cannot reach stays out, and the file names the fonts of the page with their fallbacks.
    const fontData = new Map();
    const MIME = { woff2: "font/woff2", woff: "font/woff", truetype: "font/ttf", ttf: "font/ttf", opentype: "font/otf", otf: "font/otf" };
    async function fontFaces(wanted, chars) {
      const rules = [];
      for (const sheet of [...document.styleSheets]) {
        let list = null;
        try { list = sheet.cssRules; } catch (error) { list = null; }
        if (!list && sheet.href) {
          try {
            const response = await fetch(sheet.href);
            if (response.ok) { const copy = new CSSStyleSheet(); copy.replaceSync(await response.text()); list = copy.cssRules; }
          } catch (error) { list = null; }
        }
        [...(list || [])].forEach((rule) => { if (rule instanceof CSSFontFaceRule) rules.push([rule.style, sheet.href || document.baseURI]); });
      }
      const covers = (range) => !range || range.split(",").some((part) => {
        const m = /^u\+([0-9a-f?]+)(?:-([0-9a-f]+))?$/i.exec(part.trim());
        if (!m) return true;
        const lo = parseInt(m[1].replace(/\?/g, "0"), 16), hi = parseInt(m[2] || m[1].replace(/\?/g, "f"), 16);
        return [...chars].some((c) => c >= lo && c <= hi);
      });
      // One face per font file: the faces of a variable font share their file, so they become one face with a range.
      const faces = new Map();
      for (const [style, base] of rules) {
        const family = style.getPropertyValue("font-family").replace(/["']/g, "").trim(), want = wanted.get(family.toLowerCase());
        const range = style.getPropertyValue("unicode-range").trim(), src = /url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([\w-]+))?/.exec(style.getPropertyValue("src"));
        if (!want || !src || !["", "normal"].includes(style.getPropertyValue("font-style").trim()) || !covers(range)) continue;
        const [lo, hi = lo] = (style.getPropertyValue("font-weight").trim() || "400").split(/\s+/).map((w) => w === "bold" ? 700 : w === "normal" ? 400 : Number(w));
        const hits = [...want].filter((w) => w >= lo && w <= hi), url = new URL(src[1], base).href;
        if (!hits.length) continue;
        const face = faces.get(url) || { family, range, format: (src[2] || url.split(/[?#]/)[0].split(".").pop()).toLowerCase(), weights: new Set() };
        hits.forEach((w) => face.weights.add(w));
        faces.set(url, face);
      }
      const css = [], embedded = new Set();
      for (const [url, face] of faces) {
        if (!fontData.has(url)) fontData.set(url, fetch(url).then((r) => r.ok ? r.blob() : null).then((blob) => blob && new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).replace(/^data:[^;,]*/, "data:" + (MIME[face.format] || "font/woff2")));
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        })).catch(() => null));
        const data = await fontData.get(url);
        if (!data) continue;
        const weights = [...face.weights].sort((a, b) => a - b);
        css.push(`@font-face { font-family: "${face.family}"; font-style: normal; font-weight: ${weights.length > 1 ? weights[0] + " " + weights.at(-1) : weights[0]}; `
          + `src: url(${data}) format("${face.format === "ttf" ? "truetype" : face.format}");${face.range ? ` unicode-range: ${face.range};` : ""} }`);
        embedded.add(face.family.toLowerCase());
      }
      return { css: css.join("\n"), missing: [...wanted.keys()].filter((f) => !embedded.has(f)) };
    }

    // The map as a standalone SVG: the drawn layers with their computed styles, every label shown at its base size,
    // without the start points of the owner and the hit areas. "plain" is the same drawing without the fonts, for the PDF.
    async function mapSvg(day) {
      const layer = viewport.node(), copy = layer.cloneNode(true);
      const from = [layer, ...layer.querySelectorAll("*")], to = [copy, ...copy.querySelectorAll("*")], drop = [];
      from.forEach((e, i) => {
        if (e.closest(".seed-layer") || e.matches(".hit, title")) { drop.push(to[i]); return; }
        inline(e, to[i]);
        const label = (e.localName === "text" || e.matches("rect.card")) && e.parentNode.matches("g.node");
        if (!label && getComputedStyle(e).display === "none") drop.push(to[i]);
      });
      // Every name at its zoomed-in size, placed as updateLabels places it.
      from.forEach((e, i) => {
        if (!e.matches("g.node")) return;
        const n = e.__data__, size = baseSize(n), height = size * 1.1, top = n.type === "area" ? -n.r - 1.5 - height : n.r + 0.4 + ringRoom(n);
        const text = to[i].querySelector(":scope > text"), card = to[i].querySelector(":scope > rect");
        text.removeAttribute("display"); card.removeAttribute("display");
        Object.entries({ "font-size": size, y: top + size * 0.86 }).forEach(([k, v]) => text.setAttribute(k, num(v)));
        Object.entries({ x: -n.lw / 2 - 0.5, y: top - 0.2, width: n.lw + 1, height: height + 0.4 }).forEach(([k, v]) => card.setAttribute(k, num(v)));
      });
      drop.forEach((e) => e.remove());
      copy.removeAttribute("transform");
      const b = layoutBounds(nodes, 6), w = b.x1 - b.x0, h = b.y1 - b.y0 + FOOT, width = Math.round(w * PX), height = Math.round(h * PX);
      const root = create("svg", { width, height, viewBox: [b.x0, b.y0, w, h].map(num).join(" ") });
      const back = (color(getComputedStyle(svg.node()).backgroundColor) || { hex: "#ffffff" }).hex, muted = (color(getComputedStyle(document.getElementById("downloads-title")).color) || { hex: "#596763" }).hex;
      const foot = create("text", { x: num(b.x0 + 4), y: num(b.y1 + FOOT - 3.4), "font-size": 3, fill: muted, "font-family": getComputedStyle(document.body).fontFamily.replace(/"/g, "'") });
      foot.textContent = [titleOf(), SkillMapI18n.date(day, { day: "2-digit", month: "2-digit", year: "numeric" }), timeRange ? t("download.foot.range", { range: rangeText(timeFrom, timeTo) }) : ""].filter(Boolean).join(" · ");
      root.append(create("rect", { x: num(b.x0), y: num(b.y0), width: num(w), height: num(h), fill: back }), copy, foot);
      const plain = root.cloneNode(true), texts = [...root.querySelectorAll("text")], wanted = new Map();
      texts.forEach((item) => {
        const family = (item.getAttribute("font-family") || "").split(",")[0].replace(/["']/g, "").trim().toLowerCase();
        if (!wanted.has(family)) wanted.set(family, new Set());
        wanted.get(family).add(Number(item.getAttribute("font-weight")) || 400);
      });
      const fonts = await fontFaces(wanted, new Set([...texts.map((item) => item.textContent).join("")].map((c) => c.codePointAt(0))));
      if (fonts.css) { const defs = create("defs"), style = create("style"); style.textContent = fonts.css; defs.append(style); root.prepend(defs); }
      return { svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root), plain, width, height, missing: fonts.missing };
    }
    // The SVG drawn on a canvas at the given scale, or at the largest scale that the browser allows.
    async function pngOf(file, want) {
      const k = Math.min(want, MAX_SIDE / Math.max(file.width, file.height), Math.sqrt(MAX_AREA / (file.width * file.height)));
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error(t("download.drawFailed"))); image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(file.svg); });
      if (image.decode) await image.decode().catch(() => {});
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(file.width * k); canvas.height = Math.round(file.height * k);
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error(t("download.tooLarge"));
      return { blob, scale: k };
    }
    // jsPDF, svg2pdf.js and the font load once, on the first PDF; a failed load tries again on the next click.
    let pdfLoad = null;
    const script = ([src, integrity]) => new Promise((resolve, reject) => {
      const tag = Object.assign(document.createElement("script"), { src, integrity });
      tag.onload = resolve; tag.onerror = () => { tag.remove(); reject(new Error(src)); };
      document.head.appendChild(tag);
    });
    // A font file as the binary text that jsPDF takes (addFileToVFS). fetch checks the hash of the file (integrity).
    const fontFile = ([style, src, integrity]) => fetch(src, { integrity }).then((response) => {
      if (!response.ok) throw new Error(src);
      return response.arrayBuffer();
    }).then((buffer) => {
      const bytes = new Uint8Array(buffer), parts = [];
      for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
      return { style, name: src.split("/").pop(), data: parts.join("") };
    });
    const loadPdf = () => pdfLoad || (pdfLoad = PDF_LIBS.reduce((done, lib) => done.then(() => script(lib)), Promise.resolve()).then(() => {
      if (!window.jspdf || typeof window.jspdf.jsPDF !== "function" || typeof window.jspdf.jsPDF.API.svg !== "function") throw new Error("jsPDF");
      return Promise.all(PDF_FONTS.map(fontFile));
    }).then((fonts) => ({ JsPDF: window.jspdf.jsPDF, fonts })).catch(() => { pdfLoad = null; throw new Error(t("download.pdfFailed")); }));
    // The page size in points is the size of the SVG at 96 pixels per inch. Every text of the PDF takes the font of its
    // weight. A character that the font cannot draw (for example Chinese, Japanese or an emoji) becomes U+FFFD in the
    // PDF, because jsPDF would drop the rest of the name after it. Without anyway, the page draws no PDF then and gives
    // { missing }: the characters, for the warning before the download.
    async function pdfOf(file, anyway) {
      const { JsPDF, fonts } = await loadPdf(), w = file.width * 0.75, h = file.height * 0.75;
      const doc = new JsPDF({ unit: "pt", format: [w, h], orientation: w > h ? "landscape" : "portrait", compress: true });
      fonts.forEach((font) => { doc.addFileToVFS(font.name, font.data); doc.addFont(font.name, PDF_FONT, font.style); });
      // The characters of each style: the Unicode map of the font, as jsPDF reads it. jsPDF writes each UTF-16 unit, so a
      // character above U+FFFF never draws.
      const codes = {};
      for (const font of fonts) {
        const meta = doc.getFont(PDF_FONT, font.style).metadata, map = meta && meta.cmap && meta.cmap.unicode && meta.cmap.unicode.codeMap;
        if (!map) throw new Error(t("download.pdfFailed"));
        codes[font.style] = map;
      }
      const missing = new Set();
      file.plain.querySelectorAll("text").forEach((text) => {
        const style = Number(text.getAttribute("font-weight")) >= 600 ? "bold" : "normal", map = codes[style];
        text.setAttribute("font-family", PDF_FONT);
        text.setAttribute("font-weight", style === "bold" ? "700" : "400");
        text.textContent = [...text.textContent].map((c) => {
          const n = c.codePointAt(0);
          if (n <= 0xffff && map[n]) return c;
          missing.add(c);
          return map[0xfffd] ? String.fromCharCode(0xfffd) : "?";
        }).join("");
      });
      if (missing.size && !anyway) return { missing: [...missing] };
      doc.setProperties({ title: titleOf(), creator: titleOf() });
      await doc.svg(file.plain, { x: 0, y: 0, width: w, height: h });
      return { blob: doc.output("blob") };
    }
    // The warning before a PDF whose names hold characters that its font cannot draw: each character with its code point,
    // and a button that downloads the PDF anyway.
    function warnPdf(missing) {
      const shown = missing.slice(0, 12).map((c) => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")})`).join(", ") + (missing.length > 12 ? ", …" : "");
      say(t("download.pdfMissing", { characters: shown }), true);
      state.append(" ", Object.assign(document.createElement("button"), { type: "button", className: "linkbtn", textContent: t("download.pdfAnyway") }));
      state.lastChild.dataset.file = "pdf";
      state.lastChild.dataset.anyway = "1";
    }
    // Hands a file to the browser, which saves it in its downloads.
    function saveFile(name, blob) {
      const url = URL.createObjectURL(blob), link = Object.assign(document.createElement("a"), { href: url, download: name });
      link.style.display = "none";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    const say = (text, error) => { state.textContent = text; state.classList.toggle("error", !!error); };
    let busy = false;
    box.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-file]");
      if (!button || busy) return;
      const kind = button.dataset.file, want = kind === "png4" ? 4 : 2, label = { svg: "SVG", png: "PNG", png4: "PNG", pdf: "PDF" }[kind];
      busy = true; buttons.forEach((b) => { b.disabled = true; });
      say(kind === "pdf" && !pdfLoad ? t("download.loadingPdf") : t("download.making", { kind: label }));
      try {
        const day = new Date(), file = await mapSvg(day);
        const name = `skill-map-${[day.getFullYear(), day.getMonth() + 1, day.getDate()].map((x) => String(x).padStart(2, "0")).join("-")}${kind === "png4" ? "-4x" : ""}.${kind === "pdf" ? "pdf" : kind === "svg" ? "svg" : "png"}`;
        let blob, note = "";
        if (kind === "svg") blob = new Blob([file.svg], { type: "image/svg+xml" });
        else if (kind === "pdf") {
          const pdf = await pdfOf(file, button.dataset.anyway === "1");
          if (pdf.missing) { warnPdf(pdf.missing); return; }
          blob = pdf.blob;
        }
        else {
          const png = await pngOf(file, want);
          blob = png.blob;
          if (png.scale < want) note += " " + t("download.scaleLimit", { scale: SkillMapI18n.number(Math.round(png.scale * 10) / 10, { useGrouping: false, maximumFractionDigits: 1 }) });
        }
        if (kind !== "pdf" && file.missing.length) note += " " + t("download.fontMissing");
        saveFile(name, blob);
        say(t("download.done", { name }) + note);
      } catch (error) {
        say((error && error.message) || t("download.failed"), true);
      } finally {
        busy = false; buttons.forEach((b) => { b.disabled = false; });
      }
    });
    box.hidden = false;
  }

  renderOverview();
  updateLabels();
  setupDownloads();
  // Everyone reads; only the owner gets the editing controls and the force menu, and the runtime refuses the writes of
  // every other visitor. The owner of a page without mapInfo (the test runtime) keeps the heading of the data file.
  async function detectOwner() {
    if (!(await runtime.isOwner())) return;
    // Each map of a site keeps its own state of the force menu in the browser, under "skill-springs/<map id>". A page
    // without mapInfo, the page of the test runtime, keeps "skill-springs".
    const info = await mapInfoOnce;
    reader = false;
    store.allowWrites();
    setupForces(info && info.id ? "skill-springs/" + info.id : "skill-springs");
    showHeader();
    showStatus();
    refresh();
  }

  showStatus();
  store.connect();
  catalog.connect();
  structure.connect();
  // A self-hosted map starts its configurations after the first snapshot of its areas; without a database right away.
  if (picksStarted) connectPicks();
  else runtime.db().then((db) => { if (!db && !picksStarted) { picksStarted = true; connectPicks(); } });
  detectOwner();
}

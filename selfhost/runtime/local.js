// The runtime of the self-hosted site, stage a: every map lives in the localStorage of this browser, one entry per map.
// The server only serves files and stores nothing. This file is the only code of the site that knows where the data
// lives. Stage b adds a runtime that talks to a backend, with the same interface (selfhost/runtime/server.js).
//
// A map page names its kind on the script tag of this file: data-map="example" (example.html) or data-map="browser"
// (map.html). This file then sets window.SKILL_MAP_RUNTIME, the runtime that the page code reads (skills/page.js),
// before the page code runs. On every other page it sets nothing.
//
// Every page of the site loads this file second, right after assets/i18n.js, which gives it the function t of the
// interface texts (i18n/README.md). On the server, the app names itself in a data block at the top of the page,
// <script type="application/json" id="it-skills-server"> (server/app/pages.py). This file reads it into
// window.IT_SKILLS_SERVER for the scripts after it: the runtime of the server (selfhost/runtime/server.js) and the card
// of the account on the start page (selfhost/site/account.js). On a plain web space the page has no such block, and
// window.IT_SKILLS_SERVER stays null.
//
//   SkillMapRuntime.page({ example })  the runtime of a map page:
//     db()           a promise of the database of the map, or null. db.collection(name) gives
//                    { path, doc(id) -> { id, path, set(data), delete() }, onSnapshot(next, error) -> unsubscribe },
//                    and a snapshot is { docs: [{ id, exists, data() }], size, empty, docChanges(), metadata }.
//     isOwner()      a promise of true for a map that this browser created or imported, false for the example map.
//     features       what the page may offer: editStructure (areas and stations in the database, edited by the owner)
//                    and mapFile (export and import of the map file).
//     home           the start page, as a relative link.
//     texts          the sentences of the page that say where the map lives: ownerHint (below the title of the owner),
//                    mapPlace (after the title of the map in the overview), homeTitle (the link to the start page) and
//                    noDatabase (after the notice that the database does not answer).
//     mapInfo()      a promise of { id, title } of the map, or null for the example map and for a missing map.
//     rename(title)  a promise that sets the title of the map.
//     exportMap()    downloads the map file "<title>.it-skills-map.json".
//     openMapFile(f) reads a map file, stores it as a new map and opens it; the promise gives an error text or null.
//   SkillMapRuntime.store             the maps of this browser, for the start page: list, read, create, remove,
//                                     exportFile, parseFile, importFile and download.
//   SkillMapRuntime.validId(name, id) and store.fileOf({ title, collections }) serve the runtime of stage b too
//                                     (selfhost/runtime/server.js), so both stages keep the same rules and file.
//
// The map file is the format of selfhost/FORMAT.md. A map entry in localStorage has the same shape, with createdAt and
// updatedAt in place of exportedAt, under the key "it-skills-map/<map id>".
//
// Every text of this file comes from the catalogs (i18n/*/site.json) through t, in the language of the page. The build
// also runs this file in Node (runtimeStore in build_selfhost.js). It passes t of the English texts there, so this file
// reads no document while it loads.
(function () {
  "use strict";
  // The data block of the server, or null. The app puts it first in the head, so it is the first element with its id.
  if (typeof document !== "undefined") {
    let server = null;
    try {
      const block = document.getElementById("it-skills-server");
      const value = block && block.type === "application/json" ? JSON.parse(block.textContent) : null;
      server = value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (error) { server = null; }
    window.IT_SKILLS_SERVER = server;
  }
  const FORMAT = "it-skills-map";
  const SCHEMA = 1;
  const KEY_PREFIX = "it-skills-map/";
  // The collections that the page uses, in the order of the file. A file may hold other collections; they stay as they are.
  const COLLECTIONS = ["areas", "stations", "groups", "skills", "projects", "configs", "settings"];
  const COLLECTION_NAME = /^[a-z][a-z0-9_-]{0,40}$/;
  const MAX_FILE_MB = 5, MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
  const RESERVED_STATION = "PRIVAT";
  // Stricter rules for ids that the page writes into class names and attributes.
  // text() names the rule in the error text of a file with a bad id.
  const ID_RULES = {
    areas: { test: (id) => /^[a-z][a-z0-9_-]{0,39}$/.test(id), text: () => t("local.idRuleAreas") },
    stations: { test: (id) => /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id) && !/i$/.test(id) && id !== RESERVED_STATION,
      text: () => t("local.idRuleStations", { code: RESERVED_STATION }) },
    groups: { test: (id) => /^[a-z0-9][a-z0-9_-]{0,119}$/.test(id), text: () => t("local.idRuleGroups") },
  };
  // The rules of a document id, which the server holds too (check_doc_id in server/app/store.py): 1 to 200 characters
  // and no "/" (idSizeOk), no control character, no half of a UTF-16 pair, and not ".", ".." or "__proto__" (idSignsOk).
  // "." and ".." are no path segment of an address: a browser removes them from the address of a write to the server.
  const MAX_ID = 200;
  const RESERVED_IDS = [".", "..", "__proto__"];
  // A control character, or one half of a UTF-16 pair: the server refuses both in an id and in a title.
  const HIDDEN_SIGN = /[\u0000-\u001f\u007f]|\p{Cs}/u;
  const idSizeOk = (id) => typeof id === "string" && [...id].length >= 1 && [...id].length <= MAX_ID && !id.includes("/");
  const idSignsOk = (id) => !HIDDEN_SIGN.test(id) && !RESERVED_IDS.includes(id);
  // The content of a document as _check_value of server/app/store.py checks it, so that no file fails only at the server.
  const MAX_DEPTH = 64;
  function contentProblem(value, depth = 0) {
    if (depth > MAX_DEPTH) return "tooDeep";
    if (typeof value === "string") return value.includes("\u0000") ? "nullCharacter" : /\p{Cs}/u.test(value) ? "halfCharacter" : null;
    if (typeof value === "number") return Number.isFinite(value) ? null : "notFinite";
    if (Array.isArray(value)) {
      for (const item of value) { const problem = contentProblem(item, depth + 1); if (problem) return problem; }
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) { const problem = contentProblem(key, depth + 1) || contentProblem(item, depth + 1); if (problem) return problem; }
    }
    return null;
  }
  const contentText = (problem, values) => problem === "tooDeep" ? t("local.docTooDeep", values)
    : problem === "nullCharacter" ? t("local.docNullCharacter", values)
      : problem === "halfCharacter" ? t("local.docHalfCharacter", values) : t("local.docNotFinite", values);
  const docIdOk = (id) => idSizeOk(id) && idSignsOk(id);
  // A collection name and a document id that a map may hold: the rules of the format and the stricter rules above.
  // A collection name of the map is looked up only as an own key of ID_RULES, so a collection "constructor" is no member of
  // a plain object.
  const ruleOf = (name) => Object.hasOwn(ID_RULES, name) ? ID_RULES[name] : null;
  const validId = (name, id) => COLLECTION_NAME.test(name) && docIdOk(id) && (!ruleOf(name) || ruleOf(name).test(id));
  // MIGRATIONS[n - 1] turns a map of schema n into a map of schema n + 1. Schema 1 is the first version, so the list is
  // empty. A later schema adds its step here, and parseFile runs the steps one by one.
  const MIGRATIONS = [];
  if (MIGRATIONS.length !== SCHEMA - 1) throw new Error("SkillMapRuntime: one migration step per schema version is missing");

  // The message of each code of a StoreError, in the language of the page.
  const MESSAGES = Object.freeze({
    get blocked() { return t("local.blocked"); },
    get quota_exceeded() { return t("local.quotaExceeded"); },
    get not_found() { return t("local.notFound"); },
    get damaged() { return t("local.damaged"); },
  });

  class StoreError extends Error {
    constructor(code, message) { super(message || (Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : code)); this.code = code; }
  }
  const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const nowIso = () => new Date().toISOString();

  // localStorage, or a StoreError "blocked" when the browser refuses it.
  function storage() {
    try {
      const s = window.localStorage;
      if (!s) throw new Error("no storage");
      s.getItem(KEY_PREFIX + "probe");
      return s;
    } catch (error) { throw new StoreError("blocked"); }
  }
  const keyOf = (id) => KEY_PREFIX + id;
  function writeEntry(id, entry) {
    const s = storage();
    try { s.setItem(keyOf(id), JSON.stringify(entry)); } catch (error) {
      const full = error && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22 || error.code === 1014);
      throw new StoreError(full ? "quota_exceeded" : "blocked");
    }
  }
  // The entry of a map, or null when it does not exist. A damaged entry throws.
  function readEntry(id) {
    let raw;
    try { raw = storage().getItem(keyOf(id)); } catch (error) { throw error instanceof StoreError ? error : new StoreError("blocked"); }
    if (raw === null) return null;
    let entry;
    try { entry = JSON.parse(raw); } catch (error) { throw new StoreError("damaged"); }
    if (!isObject(entry) || !isObject(entry.collections)) throw new StoreError("damaged");
    return entry;
  }
  const newId = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const counts = (collections) => Object.fromEntries(COLLECTIONS.map((name) => [name, isObject(collections[name]) ? Object.keys(collections[name]).length : 0]));

  // The maps of this browser, newest change first: { id, title, createdAt, updatedAt, counts } or { id, damaged: true }.
  function list() {
    const s = storage(), maps = [];
    let keys;
    try { keys = Array.from({ length: s.length }, (_, i) => s.key(i)); } catch (error) { throw new StoreError("blocked"); }
    for (const key of keys) {
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const id = key.slice(KEY_PREFIX.length);
      try {
        const entry = readEntry(id);
        if (entry) maps.push({ id, title: typeof entry.title === "string" ? entry.title : "", createdAt: entry.createdAt || "", updatedAt: entry.updatedAt || "", counts: counts(entry.collections) });
      } catch (error) { maps.push({ id, damaged: true, title: "", updatedAt: "", counts: counts({}) }); }
    }
    return maps.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.title.localeCompare(b.title, "de"));
  }
  // Stores a new map and gives its id. The collections are copied.
  function create(title, collections) {
    const id = newId(), at = nowIso();
    writeEntry(id, { format: FORMAT, schema: SCHEMA, title: cleanTitle(title), createdAt: at, updatedAt: at, collections: clone(collections || {}) });
    return id;
  }
  // Deletes a map and the last state of its force menu, which the page keeps under "skill-springs/<map id>"
  // (setupForces in skills/page.js).
  function remove(id) {
    try { storage().removeItem(keyOf(id)); storage().removeItem("skill-springs/" + id); } catch (error) { throw error instanceof StoreError ? error : new StoreError("blocked"); }
  }
  // A title on one line: each run of white space becomes one space, with none at the ends, and a longer title keeps its
  // first MAX_TITLE characters. It counts characters, not halves of UTF-16 pairs, as the server does, so the cut never
  // splits a pair.
  const MAX_TITLE = 120;
  const cleanText = (title) => [...(typeof title === "string" ? title : "").trim().replace(/\s+/g, " ")].slice(0, MAX_TITLE).join("").trim();
  const cleanTitle = (title) => cleanText(title) || t("site.untitled");
  // A file name from the title: no characters that a file system forbids.
  const fileName = (title) => (cleanTitle(title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^[.\s-]+|[.\s-]+$/g, "").slice(0, 100) || "skill-map") + ".it-skills-map.json";
  // The map file of a stored map: the collections in the order of the format, the documents sorted by id.
  function fileOf(entry) {
    const names = [...COLLECTIONS.filter((n) => isObject(entry.collections[n])), ...Object.keys(entry.collections).filter((n) => !COLLECTIONS.includes(n)).sort()];
    const collections = {};
    names.forEach((name) => {
      const docs = entry.collections[name];
      collections[name] = Object.fromEntries(Object.keys(docs).sort().map((id) => [id, docs[id]]));
    });
    return { format: FORMAT, schema: SCHEMA, title: cleanTitle(entry.title), exportedAt: nowIso().replace(/\.\d{3}Z$/, "Z"), collections };
  }
  function exportFile(id) {
    const entry = readEntry(id);
    if (!entry) throw new StoreError("not_found");
    const file = fileOf(entry);
    return { name: fileName(file.title), text: JSON.stringify(file, null, 2) + "\n" };
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Reads the text of a map file: { map } with a map of the current schema, or { error } with a text in the language of
  // the page.
  function parseFile(text) {
    const short = (x) => { const s = String(x); return s.length > 60 ? s.slice(0, 57) + "…" : s; };
    let raw;
    try { raw = JSON.parse(String(text).replace(/^﻿/, "")); } catch (error) { return { error: t("local.fileNotJson") }; }
    if (!isObject(raw)) return { error: t("local.fileNotObject") };
    if (raw.format !== FORMAT) {
      return { error: raw.format === undefined ? t("local.formatMissing", { format: FORMAT })
        : t("local.formatWrong", { value: short(typeof raw.format === "string" ? raw.format : JSON.stringify(raw.format)), format: FORMAT }) };
    }
    if (!Number.isInteger(raw.schema) || raw.schema < 1) return { error: t("local.schemaInvalid") };
    if (raw.schema > SCHEMA) return { error: t("local.schemaNewer", { schema: raw.schema, max: SCHEMA }) };
    if (raw.title !== undefined && typeof raw.title !== "string") return { error: t("local.titleInvalid") };
    // The title as the server reads it too (file_title in server/app/store.py). A file without a title or with an empty
    // one gets the title of an import.
    const title = raw.title === undefined ? "" : cleanText(raw.title);
    if (HIDDEN_SIGN.test(title)) return { error: t("local.titleHidden") };
    if (!isObject(raw.collections)) return { error: t("local.collectionsInvalid") };
    for (const [name, docs] of Object.entries(raw.collections)) {
      if (!COLLECTION_NAME.test(name)) return { error: t("local.collectionNameInvalid", { name: short(name) }) };
      if (!isObject(docs)) return { error: t("local.collectionNotObject", { name }) };
      for (const [id, doc] of Object.entries(docs)) {
        if (!idSizeOk(id)) return { error: t("local.docIdInvalid", { id: short(id), collection: name }) };
        if (!idSignsOk(id)) return { error: t("local.docIdReserved", { id: short(id), collection: name }) };
        if (ruleOf(name) && !ruleOf(name).test(id)) return { error: t("local.docIdAgainstRule", { id: short(id), collection: name, rule: ruleOf(name).text() }) };
        if (!isObject(doc)) return { error: t("local.docNotObject", { id: short(id), collection: name }) };
        const problem = contentProblem(doc);
        if (problem) return { error: contentText(problem, { id: short(id), collection: name, max: MAX_DEPTH }) };
      }
    }
    let map = { format: FORMAT, schema: raw.schema, title: title || t("local.importedTitle"), exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "", collections: clone(raw.collections) };
    for (let n = map.schema; n < SCHEMA; n++) map = { ...MIGRATIONS[n - 1](map), schema: n + 1 };
    return { map };
  }
  // Reads a file that the visitor picked and stores it as a new map: { id } or { error }.
  async function importFile(file) {
    if (!file) return { error: t("site.noFile") };
    if (file.size > MAX_FILE_BYTES) return { error: t("site.fileTooBig", { mb: MAX_FILE_MB }) };
    let text;
    try { text = await file.text(); } catch (error) { return { error: t("site.fileUnreadable") }; }
    const parsed = parseFile(text);
    if (parsed.error) return parsed;
    try { return { id: create(parsed.map.title, parsed.map.collections) }; } catch (error) { return { error: error.message }; }
  }

  // A message at the top of the page, for a full or blocked storage and a missing map. Each text shows once at a time.
  function alert(text) {
    if (typeof document === "undefined" || !document.body) return;
    let box = document.getElementById("runtime-alert");
    if (!box) {
      const style = document.createElement("style");
      style.textContent = "#runtime-alert{position:fixed;z-index:50;left:50%;top:12px;transform:translateX(-50%);width:min(560px,calc(100% - 32px));box-sizing:border-box;display:grid;gap:8px;padding:12px 14px;border:1px solid var(--c-fach,#c0384f);border-radius:8px;background:var(--surface,#fff);color:var(--ink,#17201e);font:14px/1.45 var(--font-ui,system-ui,sans-serif);box-shadow:0 6px 24px rgba(0,0,0,.18)}#runtime-alert p{margin:0}#runtime-alert button{justify-self:start;font:inherit;font-size:13px;color:inherit;background:var(--bg,#f3f6f5);border:1px solid var(--line,#d2dad8);border-radius:6px;padding:4px 10px;cursor:pointer}";
      document.head.appendChild(style);
      box = document.createElement("div");
      box.id = "runtime-alert"; box.setAttribute("role", "alert");
      document.body.appendChild(box);
    }
    if ([...box.querySelectorAll("p")].some((p) => p.textContent === text)) return;
    const p = document.createElement("p");
    p.textContent = text;
    box.prepend(p);
    if (!box.querySelector("button")) {
      const close = document.createElement("button");
      close.type = "button"; close.textContent = t("site.alertClose");
      close.addEventListener("click", () => box.remove());
      box.appendChild(close);
    }
  }
  const alertError = (error) => alert(error && error.message ? error.message : String(error));

  // The database of one map, with the interface that the map page uses (skills/page.js). Every write reads the entry
  // again, so a change in another tab is not lost, and every listener of the collection gets a new snapshot.
  function localDb(id) {
    const listeners = new Set();
    const docsOf = (name) => {
      const entry = readEntry(id);
      if (!entry) throw new StoreError("not_found");
      return isObject(entry.collections[name]) ? entry.collections[name] : {};
    };
    const snapshotOf = (listener) => {
      const docs = docsOf(listener.name), before = listener.last, now = new Map();
      const list = Object.keys(docs).sort().map((docId) => {
        const text = JSON.stringify(docs[docId]);
        now.set(docId, text);
        return { id: docId, exists: true, data: () => JSON.parse(text), metadata: { fromCache: false, hasPendingWrites: false } };
      });
      const changes = [...list.filter((d) => before.get(d.id) !== now.get(d.id)).map((d) => ({ type: before.has(d.id) ? "modified" : "added", doc: d })),
        ...[...before.keys()].filter((docId) => !now.has(docId)).map((docId) => ({ type: "removed", doc: { id: docId, exists: false, data: () => undefined } }))];
      listener.last = now;
      return { docs: list, size: list.length, empty: !list.length, docChanges: () => changes, metadata: { fromCache: false, hasPendingWrites: false } };
    };
    const deliver = (listener) => {
      if (!listeners.has(listener)) return;
      let snap;
      try { snap = snapshotOf(listener); } catch (error) { if (listener.error) listener.error(error); return; }
      listener.next(snap);
    };
    const emit = (name) => listeners.forEach((l) => { if (name === null || l.name === name) setTimeout(() => deliver(l), 0); });
    window.addEventListener("storage", (event) => { if (event.key === keyOf(id) || event.key === null) emit(null); });
    // A write: set stores a copy of data, remove deletes the document. The write lands in localStorage at once, before
    // the promise settles, so a write that the page sends while it goes (pagehide) is not lost. The snapshots follow
    // later. A refused write rejects with a code that the page knows: invalid_argument for a bad name or document,
    // quota_exceeded for a full storage.
    function change(name, docId, data, remove) {
      try {
        if (!validId(name, docId)) throw new StoreError("invalid_argument", t("site.invalidName", { path: name + "/" + docId }));
        if (!remove && !isObject(data)) throw new StoreError("invalid_argument", t("site.docNotObject"));
        const body = remove ? null : clone(data);
        const entry = readEntry(id);
        if (!entry) throw new StoreError("not_found");
        const docs = isObject(entry.collections[name]) ? entry.collections[name] : (entry.collections[name] = {});
        if (remove) delete docs[docId]; else docs[docId] = body;
        entry.updatedAt = nowIso();
        writeEntry(id, entry);
      } catch (error) {
        if (error instanceof StoreError && error.code !== "invalid_argument") alertError(error);
        return Promise.reject(error instanceof StoreError ? error : new StoreError("unknown", String(error)));
      }
      emit(name);
      return Promise.resolve();
    }
    return Object.freeze({
      collection(name) {
        return {
          path: name,
          doc(docId) {
            return { id: docId, path: name + "/" + docId, set: (data) => change(name, docId, data, false), delete: () => change(name, docId, null, true) };
          },
          onSnapshot(next, error) {
            const listener = { name, next, error, last: new Map() };
            listeners.add(listener);
            setTimeout(() => deliver(listener), 0);
            return () => listeners.delete(listener);
          },
        };
      },
    });
  }

  // Opens a map file from the page: stores it as a new map and opens it in the whole window.
  async function openMapFile(file) {
    const result = await importFile(file);
    if (result.error) return result.error;
    window.top.location.href = mapUrl(result.id);
    return null;
  }
  const mapUrl = (id) => "map.html?id=" + encodeURIComponent(id);

  const TEXTS = Object.freeze({
    ownerHint: t("local.ownerHint"),
    mapPlace: t("local.mapPlace"),
    homeTitle: t("local.homeTitle"),
    noDatabase: "",
  });
  function page({ example = false } = {}) {
    const base = { features: { mapFile: true, editStructure: !example }, home: "index.html", texts: TEXTS, openMapFile };
    if (example) return { ...base, db: () => Promise.resolve(null), isOwner: () => Promise.resolve(false) };
    const id = new URLSearchParams(location.search).get("id") || "";
    let entry = null, failure = null;
    try { entry = id ? readEntry(id) : null; if (!entry) failure = new StoreError("not_found"); } catch (error) { failure = error; }
    if (failure) setTimeout(() => alertError(failure), 0);
    const db = entry ? Promise.resolve(localDb(id)) : Promise.resolve(null);
    return {
      ...base,
      db: () => db,
      isOwner: () => Promise.resolve(!!entry),
      mapInfo: () => Promise.resolve(entry ? { id, title: cleanTitle(entry.title) } : null),
      async rename(title) {
        const now = readEntry(id);
        if (!now) throw new StoreError("not_found");
        now.title = cleanTitle(title); now.updatedAt = nowIso();
        try { writeEntry(id, now); } catch (error) { alertError(error); throw error; }
        return now.title;
      },
      exportMap() {
        try { const file = exportFile(id); download(file.name, file.text); return null; } catch (error) { alertError(error); return error.message; }
      },
    };
  }

  window.SkillMapRuntime = Object.freeze({
    FORMAT, SCHEMA, COLLECTIONS, MESSAGES, MAX_FILE_MB, MAX_FILE_BYTES, page, alert, mapUrl, validId,
    store: Object.freeze({ list, read: readEntry, create, remove, exportFile, parseFile, importFile, download, fileName, fileOf }),
  });
  // The runtime of a map page of this browser, from the kind on the script tag.
  const kind = typeof document !== "undefined" && document.currentScript ? document.currentScript.dataset.map : "";
  if (kind === "example" || kind === "browser") window.SKILL_MAP_RUNTIME = Object.freeze(page({ example: kind === "example" }));
})();

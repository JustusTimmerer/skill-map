// The runtime of a map page on the server, stage b: the documents of a map live in PostgreSQL behind the API of
// server/ (server/API.md). The app sends the page with the data block it-skills-server, { mode, api, canWrite, map,
// account } (server/app/pages.py), and assets/runtime-local.js reads it into window.IT_SKILLS_SERVER before this file.
// In mode "owner" (a visitor with a role: the user of a personal map or a member of its team), the object also has role
// and canShare. The runtime reads the rights that the server sends and never derives them from mode or role: write
// access from canWrite, the dialog "Teilen" from canShare. SkillMapServer.page() gives the page the interface of
// selfhost/runtime/local.js, and this file sets it as window.SKILL_MAP_RUNTIME before the page code runs:
//
//   db()           a promise of the database of the map, or null when the map is gone. All documents load once and stay
//                  in memory. db.collection(name) gives { path, doc(id) -> { id, path, set(data), delete() },
//                  onSnapshot(next, error) -> unsubscribe }, with the snapshots of local.js.
//   isOwner()      canWrite of the data block and of the answers of {api}/docs: true for the roles owner and editor. A reader
//                  of a team, of a share link or of a public map gets no write controls.
//   features       editStructure (areas and stations come from the database), mapFile for the owner only.
//   home           the start page of the site.
//   texts          the sentences of the page that say where the map lives: in the account on the server.
//   mapInfo()      { id, title } of the map.
//   rename(title)  sets the title of the map on the server.
//   exportMap()    downloads the map file "<title>.it-skills-map.json" from the documents in memory.
//   openMapFile(f) imports a map file as a new map of the account and opens it; gives an error text or null.
//
// A write sends PUT or DELETE to {api}/docs/<collection>/<id> with the header X-Requested-With: it-skills, with keepalive
// while its body fits the 64 KB of the browser, and with ?base=<version>: the version that this tab knows of the
// document. If somebody changed it after that, the server answers 409 conflict and keeps its state. A second write of a
// document waits until the first one ends. When the page goes (pagehide), the newest waiting write of each document goes
// at once and without base. While the tab is visible, the runtime asks {api}/docs?since=<version> every
// few seconds and hands the changes to the open onSnapshot listeners. A hidden tab does not ask.
//
// A visitor with canWrite also gets a link to the account, and with canShare also "Teilen" (private, by link or public;
// the read link; the public addresses; "Einbetten"). An editor of a team map has no share right, so he gets no "Teilen".
// Every error shows a message at the top of the page: the session ended, a limit of the server, no connection,
// a write conflict, or a map that is gone. The map file functions come from local.js (SkillMapRuntime), so
// both stages read and write the same file.
//
// Every text comes from the catalogs (i18n/*/site.json) through t, in the language of the page. An error answer of the
// server shows SkillMapI18n.errorText(body, fallback): the text of its code in the catalogs, else the message of the
// server, else the fallback of this file (i18n/README.md).
//
// Mode "embed" (/e/<handle>/<slug> and /e/s/<token>, in a frame on another site): features.embed = { theme, panel, open,
// site } from the query string (?theme=light|dark|auto&panel=0|1) and window.IT_SKILLS_SERVER.embed.open, the full map.
// Its language comes from the parameter lang of the query string (assets/i18n.js).
// The page shows its compact reader then (assets/embed.js). The runtime adds no tools to the header, and its requests
// send no cookie (credentials "omit"), so a signed-in owner sees the frame as every reader does.
(function () {
  "use strict";
  const POLL_MS = 3000, POLL_MAX_MS = 30000;
  const CSRF = { "X-Requested-With": "it-skills" };
  const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // The labels of the visibilities of a map, in the order of the dialog "Teilen".
  const VISIBILITY = { private: t("share.private"), link: t("share.link"), public: t("share.public") };

  // The messages of the runtime, in the language of the page.
  const MESSAGES = Object.freeze({
    get session() { return t("server.session"); },
    get offline() { return t("server.offline"); },
    get down() { return t("server.down"); },
    get conflict() { return t("server.conflict"); },
    get goneReader() { return t("server.goneReader"); },
    get goneOwner() { return t("server.goneOwner"); },
    get missingReader() { return t("server.missingReader"); },
    get noConfig() { return t("server.noConfig"); },
  });
  // The text of an error answer of the server (i18n/README.md), else fallback.
  const errorText = (body, fallback) => window.SkillMapI18n.errorText(body, fallback);

  class ServerError extends Error {
    constructor(code, message, kind, status = 0) { super(message); this.code = code; this.kind = kind; this.status = status; }
  }
  // The error of an answer: code for the page, as the database of local.js names it, and kind for the message of the
  // runtime. Only a 403 is permission_denied, which makes the page read-only for the visit. Every other 4xx fails its
  // one request, and the runtime shows its message.
  function errorOf(status, body) {
    const code = body && typeof body.error === "string" ? body.error : "";
    if (status === 401) return new ServerError("unauthenticated", MESSAGES.session, "session", status);
    if (status === 404) return new ServerError("not_found", errorText(body, t("server.notFound")), "gone", status);
    if (status === 409 && code === "conflict") return new ServerError("conflict", MESSAGES.conflict, "conflict", status);
    if (status === 413) return new ServerError("quota_exceeded", t("server.limit", { text: errorText(body, t("server.tooLarge")) }), "limit", status);
    if (status === 429 || code === "too_many_maps") return new ServerError("resource_exhausted", t("server.limit", { text: errorText(body, t("server.tooMany")) }), "limit", status);
    if (status >= 500) return new ServerError("unavailable", MESSAGES.down, "connection", status);
    if (status === 403) return new ServerError("permission_denied", errorText(body, t("server.refused")), "refused", status);
    return new ServerError("invalid_argument", errorText(body, t("server.refusedStatus", { status })), "refused", status);
  }
  // A write with keepalive outlives the page, so a write that the page sends while it goes (pagehide) still reaches the
  // server. The browser allows at most 64 KB of such bodies in flight at once, so a body above what is left goes
  // without keepalive.
  const KEEPALIVE_BYTES = 64 * 1024;
  let keepaliveInFlight = 0;
  // One request to the API of the same origin. Gives { status, data }, 304 with data null; throws a ServerError.
  // The embed view sends no cookie. With keep true, the request goes with keepalive while the budget allows.
  async function call(method, path, body, keep = false) {
    const options = { method, credentials: embedded ? "omit" : "same-origin", cache: "no-store", headers: { ...CSRF } };
    if (body !== undefined) { options.headers["Content-Type"] = "application/json"; options.body = typeof body === "string" ? body : JSON.stringify(body); }
    const bytes = keep ? (options.body === undefined ? 0 : new Blob([options.body]).size) : 0;
    const kept = keep && keepaliveInFlight + bytes <= KEEPALIVE_BYTES;
    if (kept) { options.keepalive = true; keepaliveInFlight += bytes; }
    let response;
    try { response = await fetch(path, options); } catch (error) { throw new ServerError("unavailable", MESSAGES.offline, "connection"); }
    finally { if (kept) keepaliveInFlight -= bytes; }
    if (response.status === 304) return { status: 304, data: null };
    let data = null;
    if (response.status !== 204) { try { data = await response.json(); } catch (error) { data = null; } }
    if (!response.ok) throw errorOf(response.status, data);
    return { status: response.status, data };
  }

  // The messages at the top of the page, one per key. A message with a link (the login) carries it below its text.
  const shown = new Map();
  function notice(key, text, link) {
    if (typeof document === "undefined" || !document.body) return;
    let box = document.getElementById("runtime-alert");
    if (!box) {
      const style = document.createElement("style");
      style.textContent = "#runtime-alert{position:fixed;z-index:50;left:50%;top:12px;transform:translateX(-50%);width:min(560px,calc(100% - 32px));box-sizing:border-box;display:grid;gap:8px;padding:12px 14px;border:1px solid var(--c-fach,#c0384f);border-radius:8px;background:var(--surface,#fff);color:var(--ink,#17201e);font:14px/1.45 var(--font-ui,system-ui,sans-serif);box-shadow:0 6px 24px rgba(0,0,0,.18)}#runtime-alert p{margin:0}#runtime-alert a{color:inherit;font-weight:600}#runtime-alert button{justify-self:start;font:inherit;font-size:13px;color:inherit;background:var(--bg,#f3f6f5);border:1px solid var(--line,#d2dad8);border-radius:6px;padding:4px 10px;cursor:pointer}";
      document.head.appendChild(style);
      box = document.createElement("div");
      box.id = "runtime-alert"; box.setAttribute("role", "alert");
      const close = document.createElement("button");
      close.type = "button"; close.textContent = t("site.alertClose");
      close.addEventListener("click", () => { box.remove(); shown.clear(); });
      box.appendChild(close);
      document.body.appendChild(box);
    }
    if (shown.has(key) && shown.get(key).isConnected) shown.get(key).remove();
    const p = document.createElement("p");
    p.dataset.key = key;
    p.textContent = text;
    if (link) {
      const a = document.createElement("a");
      a.href = link.href; a.textContent = link.text;
      p.append(" ", a);
    }
    box.prepend(p);
    shown.set(key, p);
  }
  function clear(key) {
    const p = shown.get(key);
    if (!p) return;
    p.remove(); shown.delete(key);
    const box = document.getElementById("runtime-alert");
    if (box && !box.querySelector("p")) box.remove();
  }

  const server = window.IT_SKILLS_SERVER;
  const valid = isObject(server) && typeof server.api === "string" && /^\/api\//.test(server.api) && isObject(server.map) && typeof server.account === "string";
  const account = valid ? server.account : "/account";
  const home = (() => { try { return new URL("/", account).href; } catch (error) { return "/"; } })();
  const loginLink = () => ({ href: account + "?next=" + encodeURIComponent(location.pathname + location.search), text: t("server.signInAgain") });
  const mapId = valid && server.mode === "owner" ? server.api.replace(/^\/api\/maps\//, "") : null;
  let owner = valid && server.canWrite === true && !!mapId;
  // Stage b sends no canShare: there the only visitor with write access is the owner, who may share.
  const mayShare = owner && server.canShare !== false;
  const embedded = valid && server.mode === "embed" && isObject(server.embed) && typeof server.embed.open === "string";
  // The options of the embed view from its address: theme=light|dark|auto (default auto), panel=0|1 (default 1).
  function embedOptions() {
    const query = new URLSearchParams(location.search), theme = query.get("theme");
    let site = "";
    try { site = new URL(server.embed.open).hostname; } catch (error) { site = ""; }
    return Object.freeze({ theme: theme === "light" || theme === "dark" ? theme : "auto", panel: query.get("panel") !== "0",
      open: server.embed.open, site: site || t("embed.siteFallback") });
  }
  // Asks the server whether the browser is still signed in, after a 404 or 401 on the page of the owner.
  async function stillSignedIn() {
    try { return !!(await call("GET", "/api/auth/session")).data.signedIn; } catch (error) { return true; }
  }
  // Shows the message of an error; for a missing map of the owner it first asks whether the session ended.
  async function report(error) {
    if (!error || !error.kind) return;
    if (error.kind === "session") notice("session", MESSAGES.session, loginLink());
    else if (error.kind === "connection") notice("connection", error.message);
    else if (error.kind === "conflict") notice("conflict", error.message);
    else if (error.kind === "limit") notice("limit", error.message);
    else if (error.kind === "gone") {
      if (owner && !(await stillSignedIn())) notice("session", MESSAGES.session, loginLink());
      else notice("gone", owner ? MESSAGES.goneOwner : MESSAGES.goneReader);
    } else if (error.kind === "refused") notice("refused", error.message);
  }

  // The database of the map: every document in memory, by collection, as JSON text.
  function serverDb(first) {
    const collections = new Map(), listeners = new Set(), own = new Map(), chains = new Map();
    let synced = 0, newestWrite = 0, timer = null, polling = false, stopped = false, failures = 0;
    const docsOf = (name) => collections.get(name) || new Map();
    // Applies an answer of {api}/docs and gives the names of the collections that changed.
    function apply(result) {
      const changed = new Set();
      const put = (name, id, text) => {
        if (!collections.has(name)) collections.set(name, new Map());
        if (collections.get(name).get(id) !== text) { collections.get(name).set(id, text); changed.add(name); }
      };
      const drop = (name, id) => { if (collections.has(name) && collections.get(name).delete(id)) changed.add(name); };
      if (result.full) {
        const keep = new Set(result.docs.map((d) => d.collection + "/" + d.id));
        collections.forEach((docs, name) => [...docs.keys()].forEach((id) => { if (!keep.has(name + "/" + id)) drop(name, id); }));
      }
      result.docs.forEach((d) => put(d.collection, d.id, JSON.stringify(d.data)));
      (result.deleted || []).forEach((d) => drop(d.collection, d.id));
      synced = result.version;
      return changed;
    }
    const meta = { fromCache: false, hasPendingWrites: false };
    const snapshotOf = (listener) => {
      const docs = docsOf(listener.name), before = listener.last, now = new Map();
      const list = [...docs.keys()].sort().map((id) => {
        const text = docs.get(id);
        now.set(id, text);
        return { id, exists: true, data: () => JSON.parse(text), metadata: meta };
      });
      const changes = [...list.filter((d) => before.get(d.id) !== now.get(d.id)).map((d) => ({ type: before.has(d.id) ? "modified" : "added", doc: d })),
        ...[...before.keys()].filter((id) => !now.has(id)).map((id) => ({ type: "removed", doc: { id, exists: false, data: () => undefined } }))];
      listener.last = now;
      return { docs: list, size: list.length, empty: !list.length, docChanges: () => changes, metadata: meta };
    };
    const deliver = (listener) => { if (listeners.has(listener)) listener.next(snapshotOf(listener)); };
    const emit = (names) => listeners.forEach((l) => { if (names.has(l.name)) setTimeout(() => deliver(l), 0); });

    function schedule(ms) {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(poll, ms);
    }
    async function poll() {
      if (stopped || polling || document.visibilityState === "hidden") return;
      polling = true;
      try {
        const answer = await call("GET", server.api + "/docs?since=" + synced);
        failures = 0;
        clear("connection");
        // An answer older than a write of this tab would undo it on the page until the next answer, so it waits.
        if (answer.status === 200 && answer.data.version >= newestWrite) {
          emit(apply(answer.data));
          if (owner && answer.data.canWrite === false) { owner = false; notice("session", MESSAGES.session, loginLink()); }
        }
        polling = false;
        schedule(POLL_MS);
      } catch (error) {
        polling = false;
        if (error.kind === "gone") { stopped = true; report(error); return; }
        failures++;
        report(error);
        schedule(Math.min(POLL_MS * 2 ** failures, POLL_MAX_MS));
      }
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") clearTimeout(timer); else schedule(0);
    });
    // Back online: ask at once instead of after the longer wait of the failed attempts.
    window.addEventListener("online", () => { failures = 0; schedule(0); });

    // One write at a time per document, so the second write of a document knows the version of the first. The writes
    // that wait behind the write ahead of them are in waiting, by document and in order, until they start.
    const waiting = new Map();
    let leaving = false;
    function change(name, id, data, remove) {
      if (!window.SkillMapRuntime.validId(name, id)) return Promise.reject(new ServerError("invalid_argument", t("site.invalidName", { path: name + "/" + id }), "refused"));
      if (!remove && !isObject(data)) return Promise.reject(new ServerError("invalid_argument", t("site.docNotObject"), "refused"));
      const key = name + "/" + id, text = remove ? null : JSON.stringify(clone(data));
      const ahead = chains.get(key), entry = { name, id, text, sent: null };
      // While the page goes, a write does not wait: the page can be gone before the write ahead ends.
      if (ahead && leaving) entry.sent = send(name, id, text, false);
      else if (ahead) waiting.set(key, [...(waiting.get(key) || []), entry]);
      const run = entry.sent || (ahead || Promise.resolve()).catch(() => null).then(() => {
        if (entry.sent) return entry.sent;
        const rest = (waiting.get(key) || []).filter((e) => e !== entry);
        if (rest.length) waiting.set(key, rest); else waiting.delete(key);
        return send(name, id, text);
      });
      chains.set(key, run);
      run.then(() => null, () => null).then(() => { if (chains.get(key) === run) chains.delete(key); });
      return run;
    }
    // The page goes (the visitor leaves or closes the tab): each document with waiting writes sends its newest one at
    // once, with keepalive while the budget allows. A write holds the whole document, so the newest one replaces the
    // older waiting ones. It goes without base, because the version of the write ahead is not known yet: so the newest
    // write lands, and the write ahead, which carries its base, gets 409 conflict if it ends after it.
    window.addEventListener("pagehide", () => {
      leaving = true;
      waiting.forEach((list) => {
        const newest = list[list.length - 1], sent = send(newest.name, newest.id, newest.text, false);
        list.forEach((e) => { e.sent = sent; });
      });
      waiting.clear();
    });
    window.addEventListener("pageshow", (event) => { if (event.persisted) leaving = false; });
    async function send(name, id, text, withBase = true) {
      if (!owner) throw new ServerError("permission_denied", t("server.readOnly"), "refused");
      const key = name + "/" + id, base = Math.max(synced, own.get(key) || 0);
      const path = server.api + "/docs/" + encodeURIComponent(name) + "/" + encodeURIComponent(id) + (withBase ? "?base=" + base : "");
      try {
        const answer = await call(text === null ? "DELETE" : "PUT", path, text === null ? undefined : text, true);
        const version = answer.data && Number.isInteger(answer.data.version) ? answer.data.version : 0;
        own.set(key, version);
        newestWrite = Math.max(newestWrite, version);
        clear("connection");
        const changed = new Set([name]);
        if (text === null) { if (!collections.has(name) || !collections.get(name).delete(id)) changed.clear(); }
        else { if (!collections.has(name)) collections.set(name, new Map()); collections.get(name).set(id, text); }
        emit(changed);
      } catch (error) {
        report(error);
        if (error.kind === "conflict") schedule(0);
        throw error;
      }
    }

    apply(first);
    schedule(POLL_MS);
    return {
      db: Object.freeze({
        collection(name) {
          return {
            path: name,
            doc(id) { return { id, path: name + "/" + id, set: (data) => change(name, id, data, false), delete: () => change(name, id, null, true) }; },
            onSnapshot(next, error) {
              const listener = { name, next, error, last: new Map() };
              listeners.add(listener);
              setTimeout(() => deliver(listener), 0);
              return () => listeners.delete(listener);
            },
          };
        },
      }),
      // The map file of the documents in memory: the page waits for its pending writes before it asks.
      collections() {
        const result = {};
        collections.forEach((docs, name) => { if (docs.size) result[name] = Object.fromEntries([...docs].map(([id, text]) => [id, JSON.parse(text)])); });
        return result;
      },
    };
  }

  // Loads every document once. A missing connection retries until it works; a missing map gives null.
  function load() {
    return new Promise((resolve) => {
      let failures = 0;
      const attempt = async () => {
        try {
          const answer = await call("GET", server.api + "/docs");
          clear("connection");
          if (owner && answer.data.canWrite === false) { owner = false; notice("session", MESSAGES.session, loginLink()); }
          resolve(serverDb(answer.data));
        } catch (error) {
          if (error.kind === "gone") {
            if (owner && !(await stillSignedIn())) notice("session", MESSAGES.session, loginLink());
            else notice("gone", owner ? MESSAGES.goneOwner : MESSAGES.missingReader);
            owner = false;
            resolve(null);
            return;
          }
          failures++;
          report(error);
          setTimeout(attempt, Math.min(POLL_MS * 2 ** (failures - 1), POLL_MAX_MS));
        }
      };
      attempt();
    });
  }

  // Imports a map file as a new map of the account: { map } or { error } with a text in the language of the page.
  async function importFile(file, R) {
    if (!file) return { error: t("site.noFile") };
    if (file.size > R.MAX_FILE_BYTES) return { error: t("site.fileTooBig", { mb: R.MAX_FILE_MB }) };
    let text;
    try { text = await file.text(); } catch (error) { return { error: t("site.fileUnreadable") }; }
    const parsed = R.store.parseFile(text);
    if (parsed.error) return parsed;
    const { title, collections } = parsed.map;
    try {
      return { map: (await call("POST", "/api/maps/import", { format: R.FORMAT, schema: R.SCHEMA, title, exportedAt: new Date().toISOString(), collections })).data };
    } catch (error) {
      if (error.kind === "session") return { error: t("server.importSignedOut") };
      return { error: error.message };
    }
  }

  // The tools of the runtime in the header: "Teilen" (with canShare) and "Konto" for a visitor with write access, "Start"
  // and the owner's name for readers.
  function addTools(info, asOwner) {
    const tools = document.querySelector("header .tools");
    if (!tools) return;
    const make = (tag, props = {}, ...children) => { const el = Object.assign(document.createElement(tag), props); el.append(...children); return el; };
    if (!asOwner) {
      tools.prepend(make("a", { className: "tool-link", href: home, target: "_top", textContent: t("server.startLink"), title: t("server.startTitle") }));
      tools.append(make("span", { className: "save-state", id: "reader-note", textContent: t("server.readerNote", { owner: server.map.owner }) }));
    } else {
      if (mayShare) {
        const share = make("button", { type: "button", id: "share-open", textContent: t("share.open") });
        share.addEventListener("click", () => openShare(info));
        tools.append(share);
      }
      tools.append(make("a", { className: "tool-link", href: account, id: "account-link", textContent: t("server.accountLink") }));
    }
    // The dropdown of the languages (selfhost/site/language.js) stays the last of the tools, also for the keyboard.
    const picker = tools.querySelector(":scope > [data-language-picker]");
    if (picker) tools.append(picker);
  }

  // The dialog "Teilen": the visibility of the map, its public addresses and its read link.
  const SHARE_STYLE = "#share-dialog{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 48px);box-sizing:border-box;padding:18px 20px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);font:14px/1.45 var(--font-ui,system-ui,sans-serif)}"
    + "#share-dialog::backdrop{background:rgba(0,0,0,.35)}#share-dialog h2{margin:0 0 4px;font-size:18px}#share-dialog h3{margin:16px 0 6px;font-size:14px}"
    + "#share-dialog p{margin:4px 0}#share-dialog .muted{color:var(--muted)}#share-dialog .warn{color:var(--c-fach)}#share-dialog fieldset{border:0;margin:0;padding:0;display:grid;gap:6px}"
    + "#share-dialog label.choice{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;align-items:baseline;padding:8px 10px;border:1px solid var(--line);border-radius:8px;cursor:pointer}"
    + "#share-dialog label.choice span{grid-column:2;color:var(--muted);font-size:12.5px}#share-dialog .row{display:flex;gap:6px;align-items:center;margin:4px 0}"
    + "#share-dialog input[readonly]{flex:1;min-width:0;font:12.5px var(--font-mono,ui-monospace,monospace);padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}"
    + "#share-dialog .ask{margin:6px 0;padding:8px 10px;border:1px solid var(--c-fach);border-radius:8px}#share-dialog .ask p{margin:0 0 6px}"
    + "#share-dialog .end{display:flex;justify-content:flex-end;margin-top:16px}#share-dialog .message{color:var(--c-fach)}"
    + "#share-dialog textarea{box-sizing:border-box;width:100%;min-width:0;font:12.5px/1.4 var(--font-mono,ui-monospace,monospace);padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);resize:vertical}"
    + "#share-dialog .code{display:grid;gap:6px;margin:4px 0}#share-dialog .code button{justify-self:start}#share-dialog .row.wrap{flex-wrap:wrap;gap:6px 16px}"
    + "#share-dialog select{font:inherit;font-size:13px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 6px;margin-left:6px}"
    + "#share-dialog label.check{display:inline-flex;align-items:center;gap:6px}#share-dialog a{color:inherit}"
    + "#share-dialog .help{color:var(--muted);font-size:12.5px}#share-dialog #embed-allow{margin-top:12px}";
  let dialog = null;
  // The choices of the section "Einbetten" stay while the dialog draws itself again.
  const embedChoice = { theme: "auto", panel: true };
  let embedDraft = null;
  async function openShare(info) {
    if (!dialog) {
      const style = document.createElement("style");
      style.textContent = SHARE_STYLE;
      document.head.appendChild(style);
      dialog = document.createElement("dialog");
      dialog.id = "share-dialog";
      dialog.setAttribute("aria-labelledby", "share-title");
      document.body.appendChild(dialog);
    }
    dialog.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t("share.loading") }));
    if (!dialog.open) dialog.showModal();
    await drawShare(info, null, "");
  }
  async function drawShare(info, fresh, message) {
    const make = (tag, props = {}, ...children) => { const el = Object.assign(document.createElement(tag), props); el.append(...children); return el; };
    let map, shares;
    try {
      [map, shares] = await Promise.all([call("GET", "/api/maps/" + mapId), call("GET", "/api/maps/" + mapId + "/shares")]).then((all) => all.map((a) => a.data));
    } catch (error) {
      report(error);
      dialog.replaceChildren(make("h2", { id: "share-title", textContent: t("share.title") }), make("p", { className: "message", textContent: error.message }), closeRow());
      return;
    }
    server.map.visibility = map.visibility;
    const act = async (run) => {
      try { const result = await run(); await drawShare(info, result || null, ""); } catch (error) { report(error); await drawShare(info, null, error.message); }
    };
    const copyRow = (value, id) => {
      const input = make("input", { readOnly: true, value, id });
      input.setAttribute("aria-label", t("share.addressLabel"));
      input.addEventListener("focus", () => input.select());
      const button = make("button", { type: "button", textContent: t("share.copy") });
      button.addEventListener("click", async () => {
        let ok = false;
        try { await navigator.clipboard.writeText(value); ok = true; } catch (error) { try { input.select(); ok = document.execCommand("copy"); } catch (error2) { ok = false; } }
        button.textContent = ok ? t("share.copied") : t("share.copyByHand");
        setTimeout(() => { button.textContent = t("share.copy"); }, 1600);
      });
      return make("div", { className: "row" }, input, button);
    };
    const hints = { private: t("share.privateHint"), link: t("share.linkHint"), public: t("share.publicHint") };
    const choices = make("fieldset", {}, make("legend", { className: "muted", textContent: t("share.visibilityLegend") }),
      ...Object.entries(VISIBILITY).map(([value, text]) => {
        const input = make("input", { type: "radio", name: "share-visibility", value, checked: map.visibility === value });
        input.addEventListener("change", () => act(async () => { await call("PATCH", "/api/maps/" + mapId, { visibility: value }); return null; }));
        return make("label", { className: "choice" }, input, text, make("span", { textContent: hints[value] }));
      }));
    // The address on the subdomain of the owner of the map: the user, or the team of a team map. The API names it.
    const subdomain = typeof map.subdomainUrl === "string" && map.subdomainUrl ? map.subdomainUrl : null;
    const addresses = [make("h3", { textContent: t("share.addressTitle") }), copyRow(map.pageUrl, "share-page-url")];
    if (subdomain) addresses.push(copyRow(subdomain, "share-subdomain-url"));
    addresses.push(make("p", { className: "muted", textContent: map.visibility === "public" ? t("share.addressPublic") : t("share.addressNotPublic") }));
    // The start map: the address of the owner (ownerUrl, <BASE_URL>/<handle>) shows this map while it is public, and else
    // the list of the public maps. An owner has one start map, so a new pick replaces the one before. A map that is not
    // public can be the start map already, and the note says what the address shows until then.
    if (typeof map.ownerUrl === "string" && map.ownerUrl) {
      const start = make("input", { type: "checkbox", id: "share-start", checked: map.start === true });
      start.addEventListener("change", () => act(async () => { await call("PATCH", "/api/maps/" + mapId, { start: start.checked }); return null; }));
      const note = map.start !== true ? t("share.startHelp") : map.visibility === "public" ? t("share.startShown", { address: map.ownerUrl })
        : t("share.startNotPublic", { address: map.ownerUrl });
      addresses.push(make("label", { className: "check", id: "share-start-label" }, start, t("share.startLabel", { address: map.ownerUrl })),
        make("p", { className: "help", id: "share-start-note" }, note));
    }
    // The read link: a map has at most one (his decision of 2026-10-19). The server keeps it, so the dialog shows it
    // every time to copy again. A new link revokes the old one, so the button asks first, in a second step of the
    // dialog: the old link stops working at once, also in frames on other websites.
    const link = (shares.shares || []).find((s) => s.mode === "read" && typeof s.url === "string") || null;
    const links = [make("h3", { textContent: t("share.linksTitle") })];
    if (link) {
      const created = window.SkillMapI18n.date(new Date(link.created), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
      if (fresh && fresh.renewed) links.push(make("p", { id: "share-renewed", role: "status", textContent: t("share.renewed") }));
      links.push(copyRow(link.url, "share-link-url"), make("p", { className: "muted", id: "share-link-created", textContent: t("share.linkFrom", { date: created }) }));
      if (map.visibility === "private") links.push(make("p", { className: "warn", id: "share-link-paused", textContent: t("share.linkPaused") }));
      const renew = make("button", { type: "button", id: "share-renew", textContent: t("share.renew") });
      const yes = make("button", { type: "button", id: "share-renew-yes", textContent: t("share.renewConfirm") });
      const no = make("button", { type: "button", id: "share-renew-cancel", textContent: t("share.renewCancel") });
      const ask = make("div", { id: "share-renew-ask", className: "ask", hidden: true },
        make("p", { className: "warn", role: "alert", textContent: t("share.renewWarning") }), make("div", { className: "row" }, yes, no));
      renew.addEventListener("click", () => { ask.hidden = false; renew.hidden = true; no.focus(); });
      no.addEventListener("click", () => { ask.hidden = true; renew.hidden = false; renew.focus(); });
      // Only this button sends replace: a POST without it gives the link that the map has (server/API.md).
      yes.addEventListener("click", () => { yes.disabled = true; act(async () => ({ ...(await call("POST", "/api/maps/" + mapId + "/shares", { replace: true })).data, renewed: true })); });
      links.push(make("div", { className: "row" }, renew), ask);
    } else {
      const create = make("button", { type: "button", id: "share-create", textContent: t("share.create") });
      create.addEventListener("click", () => act(async () => (await call("POST", "/api/maps/" + mapId + "/shares")).data));
      links.push(make("p", { className: "muted", textContent: t("share.noLink") }), make("div", { className: "row" }, create));
    }
    dialog.replaceChildren(make("h2", { id: "share-title", textContent: t("share.title") }),
      make("p", { className: "muted", textContent: t("share.subtitle", { title: info.title, owner: server.map.owner }) }),
      ...(message ? [make("p", { className: "message", role: "alert", textContent: message })] : []),
      choices, ...addresses, ...links, embedSection(info, map, link, act, make), closeRow());
  }

  // The section "Einbetten": the code of a frame for another site, its two options, and who may embed the map.
  // A public map embeds by its address, a map shared by link by its read link. A private map cannot.
  // The code names the language of this page (lang), because a frame on another site has no choice of its own.
  const attr = (text) => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const embedSrc = (url) => {
    const query = [];
    if (embedChoice.theme !== "auto") query.push("theme=" + embedChoice.theme);
    if (!embedChoice.panel) query.push("panel=0");
    query.push("lang=" + encodeURIComponent(window.SkillMapI18n ? window.SkillMapI18n.language : "en"));
    return url + "?" + query.join("&");
  };
  // min-height keeps the map readable in the narrow column of a phone, where 16:10 would leave a strip.
  const snippetOf = (url, title) => `<iframe src="${attr(embedSrc(url))}" title="${attr("Skill-Map: " + title)}" loading="lazy" style="width:100%;aspect-ratio:16/10;min-height:400px;border:0"></iframe>`;
  // An origin from what the owner types: "example.org" becomes https://example.org, a path goes away. undefined: no
  // website. As on the server, a host name needs a dot, except localhost.
  function originOf(text) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : "https://" + text);
      const host = url.hostname.includes(".") || url.hostname === "localhost";
      return (url.protocol === "https:" || url.protocol === "http:") && host && !url.hostname.startsWith("[") ? url.origin : undefined;
    } catch (error) { return undefined; }
  }
  function embedSection(info, map, link, act, make) {
    const embed = isObject(map.embed) ? map.embed : { allow: "all", origins: [], url: null };
    const section = make("section", { id: "embed-section" }, make("h3", { textContent: t("share.embedTitle") }));
    const add = (...nodes) => section.append(...nodes);
    const publish = make("button", { type: "button", id: "embed-public", textContent: t("share.embedPublish") });
    publish.addEventListener("click", () => act(async () => { await call("PATCH", "/api/maps/" + mapId, { visibility: "public" }); return null; }));
    // Without a link, the button makes the read link. With a paused link of a private map, it shares the map by link
    // again, because a new link would revoke the one that the owner has given out.
    const linkButton = make("button", { type: "button", id: "embed-link", textContent: link ? t("share.embedUseLink") : t("share.embedCreateLink") });
    linkButton.addEventListener("click", () => act(async () => {
      if (!link) return (await call("POST", "/api/maps/" + mapId + "/shares")).data;
      await call("PATCH", "/api/maps/" + mapId, { visibility: "link" });
      return null;
    }));
    // A private map pauses its link, so it has no code, also with a link.
    const source = map.visibility === "public" ? embed.url : map.visibility === "link" && link ? link.embedUrl : null;
    if (map.visibility === "private") {
      add(make("p", { className: "warn", id: "embed-private", textContent: t("share.embedPrivate") }),
        make("div", { className: "row" }, publish, linkButton));
    } else if (!source) {
      add(make("p", { textContent: t("share.embedNeedsLink") }),
        make("div", { className: "row" }, linkButton, publish));
    }
    if (source) {
      const code = make("textarea", { readOnly: true, rows: 4, id: "embed-code", value: snippetOf(source, info.title) });
      code.setAttribute("aria-label", t("share.embedCodeLabel"));
      code.addEventListener("focus", () => code.select());
      const preview = make("a", { id: "embed-preview", href: embedSrc(source), target: "_blank", rel: "noopener", textContent: t("share.embedPreview") });
      const update = () => { code.value = snippetOf(source, info.title); preview.href = embedSrc(source); };
      const theme = make("select", { id: "embed-theme" }, ...[["auto", t("share.embedThemeAuto")], ["light", t("share.embedThemeLight")], ["dark", t("share.embedThemeDark")]]
        .map(([value, text]) => make("option", { value, textContent: text, selected: embedChoice.theme === value })));
      theme.addEventListener("change", () => { embedChoice.theme = theme.value; update(); });
      const panel = make("input", { type: "checkbox", id: "embed-panel", checked: embedChoice.panel });
      panel.addEventListener("change", () => { embedChoice.panel = panel.checked; update(); });
      const copy = make("button", { type: "button", id: "embed-copy", textContent: t("share.copy") });
      copy.addEventListener("click", async () => {
        let ok = false;
        try { await navigator.clipboard.writeText(code.value); ok = true; } catch (error) { try { code.select(); ok = document.execCommand("copy"); } catch (error2) { ok = false; } }
        copy.textContent = ok ? t("share.copied") : t("share.copyByHand");
        setTimeout(() => { copy.textContent = t("share.copy"); }, 1600);
      });
      add(make("p", { className: "help", id: "embed-help", textContent: t("share.embedHelp") }),
        make("div", { className: "row wrap" }, make("label", {}, t("share.embedColors"), theme), make("label", { className: "check" }, panel, t("share.embedPanel"))),
        make("div", { className: "code" }, code, make("div", { className: "row" }, copy, preview)),
        make("p", { className: "help", textContent: t("share.embedOptionsHelp") }));
      if (source !== embed.url) add(make("p", { className: "help", id: "embed-link-note", textContent: t("share.embedLinkNote") }));
    }

    // Who may embed the map: every website, or only the websites of the list.
    const allow = make("fieldset", { id: "embed-allow" }, make("legend", { className: "muted", textContent: t("share.embedAllowLegend") }),
      ...[["all", t("share.embedAllowAll"), t("share.embedAllowAllHint")], ["origins", t("share.embedAllowOrigins"), t("share.embedAllowOriginsHint")]]
        .map(([value, text, hint]) => {
          const input = make("input", { type: "radio", name: "embed-allow", value, checked: embed.allow === value });
          input.addEventListener("change", () => act(async () => { await call("PATCH", "/api/maps/" + mapId, { embed: { allow: value } }); return null; }));
          return make("label", { className: "choice" }, input, text, make("span", { textContent: hint }));
        }));
    add(allow);
    if (embed.allow === "origins") {
      const list = make("textarea", { id: "embed-origins", rows: 3, value: embedDraft !== null ? embedDraft : embed.origins.join("\n"), placeholder: "https://example.org" });
      list.setAttribute("aria-label", t("share.embedOriginsLabel"));
      list.addEventListener("input", () => { embedDraft = list.value; });
      const said = make("p", { className: "message", id: "embed-origins-message", role: "alert", hidden: true });
      const save = make("button", { type: "button", id: "embed-save", textContent: t("share.embedSave") });
      save.addEventListener("click", () => {
        const entries = list.value.split(/[\s,]+/).filter(Boolean), origins = [];
        for (const entry of entries) {
          const origin = originOf(entry);
          if (!origin) { said.textContent = t("share.embedBadOrigin", { entry }); said.hidden = false; return; }
          if (!origins.includes(origin)) origins.push(origin);
        }
        embedDraft = null;
        act(async () => { await call("PATCH", "/api/maps/" + mapId, { embed: { allow: "origins", origins } }); return null; });
      });
      add(make("p", { className: "help", textContent: t("share.embedOriginsHelp") }),
        list, said, make("div", { className: "row" }, save));
      if (!embed.origins.length) add(make("p", { className: "warn", id: "embed-origins-empty", textContent: t("share.embedOriginsEmpty") }));
    }
    return section;
  }
  const closeRow = () => {
    const close = Object.assign(document.createElement("button"), { type: "button", textContent: t("share.close"), id: "share-close" });
    close.addEventListener("click", () => dialog.close());
    const row = document.createElement("div");
    row.className = "end";
    row.append(close);
    return row;
  };

  // As cleanTitle of selfhost/runtime/local.js: the cut counts characters, so it never splits a UTF-16 pair.
  const cleanTitle = (title) => [...(typeof title === "string" ? title : "").trim().replace(/\s+/g, " ")].slice(0, 120).join("").trim() || t("site.untitled");
  const TEXTS = Object.freeze({
    ownerHint: t("server.ownerHint"),
    mapPlace: t("server.mapPlace"),
    homeTitle: t("server.homeTitle"),
    noDatabase: t("server.noDatabase"),
  });
  function page() {
    const R = window.SkillMapRuntime;
    if (!valid || !R) {
      setTimeout(() => notice("config", MESSAGES.noConfig, { href: home, text: t("server.noConfigLink") }), 0);
      return { features: { editStructure: true }, home, texts: TEXTS, db: () => Promise.resolve(null), isOwner: () => Promise.resolve(false), mapInfo: () => Promise.resolve(null) };
    }
    const info = { id: mapId || server.map.slug, title: cleanTitle(server.map.title) };
    let current = null;
    const loaded = load().then((x) => { current = x; return x; });
    const db = loaded.then((x) => x && x.db);
    const ownerNow = owner;
    const ready = () => (document.readyState === "loading" ? new Promise((done) => document.addEventListener("DOMContentLoaded", done, { once: true })) : Promise.resolve());
    // After the page script: its own tools stand in the header then. The embed view gets none.
    if (!embedded) ready().then(() => setTimeout(() => addTools(info, ownerNow), 0));
    return {
      features: embedded ? { editStructure: true, mapFile: false, embed: embedOptions() } : { editStructure: true, mapFile: ownerNow },
      home,
      texts: TEXTS,
      db: () => db,
      isOwner: () => (ownerNow ? loaded.then((x) => !!x && owner) : Promise.resolve(false)),
      mapInfo: () => Promise.resolve(info),
      async rename(title) {
        try {
          const answer = await call("PATCH", "/api/maps/" + mapId, { title: cleanTitle(title) });
          info.title = server.map.title = answer.data.title;
          return info.title;
        } catch (error) { report(error); throw error; }
      },
      exportMap() {
        if (!current) return t("server.notLoaded");
        const file = R.store.fileOf({ title: info.title, collections: current.collections() });
        R.store.download(R.store.fileName(file.title), JSON.stringify(file, null, 2) + "\n");
        return null;
      },
      async openMapFile(file) {
        const result = await importFile(file, R);
        if (result.error) return result.error;
        window.top.location.href = result.map.pageUrl;
        return null;
      },
    };
  }

  window.SkillMapServer = Object.freeze({ page, MESSAGES, importFile: (file) => importFile(file, window.SkillMapRuntime), call });
  // The runtime of the map page of the server: this file is loaded only there (server-map.html).
  window.SKILL_MAP_RUNTIME = Object.freeze(page());
})();

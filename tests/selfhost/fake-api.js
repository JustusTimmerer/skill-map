// A stand-in for the API of the server (server/API.md) with one map, so the browser tests of the site can test the runtime
// of the server (selfhost/runtime/server.js) without the compose stack. It serves the folder of the site like
// tests/selfhost/server.js, and the pages of the server with the data block of the app right after <head>, as
// server/app/pages.py adds it (<base href="/"> and <script type="application/json" id="it-skills-server">):
//
//   /anna/<slug>    the map page of the owner: server-map.html in mode "owner". The visitor is the owner of the map, anna.
//   /e/anna/<slug>  the embed view of the map: server-map.html in mode "embed", which reads /api/public/anna/<slug>/docs
//   /            the start page in mode "site", with the user while the account is signed in
//   /account     the account page of the server (server/app/static/account.html), with its script and style, in mode
//                "account". Its data block comes without <base>, as on the server.
// Each data block names the language of the account while it is signed in, else null (the field language).
//
//   docs     { "<collection>/<id>": data }, the documents at the start
//   refuse   { "<collection>/<id>": [status, error, message] }: every write of that document gets this answer; a test
//            can change it later. The key "account" refuses PATCH /api/account.
//   slow     { "<collection>/<id>": ms }: the next write of that document waits ms before the server handles it, as a
//            slow server does; the entry is gone after that write
//   writes   every PUT and DELETE that reached the server: { method, key, body (text), csrf (X-Requested-With), base }
//   visibility  the visibility of the map: "private" (the default), "link" or "public", which embeds at /e/anna/<slug>
//   start    true: the map is the start map of anna at the start. PATCH /api/maps/m1 sets start and visibility.
//   patches  every PATCH /api/maps/m1: its body as an object
//   link     true: the map has its read link at the start. A map has one read link at most, as on the server: GET
//            .../shares gives it. POST .../shares gives it too, with 200, and makes a link only for a map without one or
//            with the body {"replace": true}, which puts a new link in its place (shares counts each new link). The
//            pages of the link (/s/<token>, /e/s/<token>) are not served.
//   sharePosts  the body of every POST .../shares, as text
//   account  { handle, email, language, signedIn }: the account of the visitor. signedIn false answers the session and
//            /api/account as for a visitor without a session. PATCH /api/account sets its language, and a login signs it in.
//   calls    every request to /api/account and /api/auth/: { method, path, body (text), csrf }
//   strength the answer of POST /api/auth/password-check, the verdict of the server on a new password. Its default is
//            the verdict on a strong password.
//   imports  every POST /api/maps/import: { team, body (the map file as an object) }. Each new map opens at /anna/<slug>.
// As the server does, a write with ?base=<version> gets 409 conflict when the document changed after that version.
const fs = require("fs"), path = require("path");
const { serve } = require("./server");
const STATIC = path.join(__dirname, "..", "..", "server", "app", "static");

async function fakeApi(root, { docs = {}, title = "Servertest", slug = "servertest", account = {}, visibility = "private", link = false, start = false } = {}) {
  const state = { version: 1, docs: new Map(Object.entries(docs)), writes: [], refuse: {}, slow: {}, calls: [], imports: [], visibility, start, patches: [],
    account: { handle: "anna", email: "anna@example.org", language: null, signedIn: true, ...account }, link: null, shares: 0, sharePosts: [],
    strength: { ok: true, problem: null, score: 4, warning: null, tips: [], min: 12, max: 1024 } };
  // The addresses of the server: <origin>/<handle> and <origin>/<handle>/<slug> (server/API.md).
  const PAGE = "/anna/" + slug, EMBED = "/e/anna/" + slug;
  // The read link of the map, as GET /api/maps/{id}/shares gives it.
  const linkOf = (origin, n) => { const token = "fake-read-link-token-" + n; return { id: "share-" + n, mode: "read", created: "2026-10-19T08:00:00Z", token, url: origin + "/s/" + token, embedUrl: origin + "/e/s/" + token }; };
  // The version of the map at the last write of each document. The documents of the start have version 1.
  const versions = new Map();
  const API = "/api/maps/m1", PUBLIC = "/api/public/anna/" + slug;
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const language = () => state.account.signedIn ? state.account.language : null;
  const withBlock = (html, config, base = true) => html.replace(/<head>/, (head) => head + (base ? '<base href="/">' : "") + '<script type="application/json" id="it-skills-server">'
    + JSON.stringify(config).replace(/</g, "\\u003c") + "</script>");
  const sendHtml = (res, html) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(html); };
  function page(req, res, mode) {
    const origin = "http://" + req.headers.host;
    const config = mode === "embed"
      ? { mode: "embed", api: PUBLIC, canWrite: false, map: { title, slug, owner: "anna", visibility: "public" }, account: origin + "/account", embed: { open: origin + PAGE }, language: null }
      : { mode: "owner", api: API, canWrite: true, map: { title, slug, owner: "anna", visibility: state.visibility }, account: origin + "/account", role: "owner", canShare: true, language: language() };
    sendHtml(res, withBlock(fs.readFileSync(path.join(root, "server-map.html"), "utf8"), config));
  }
  function docsAnswer(res, url) {
    const since = url.searchParams.get("since");
    if (since !== null && Number(since) === state.version) { res.writeHead(304).end(); return; }
    json(res, 200, { canWrite: url.pathname.startsWith(API), version: state.version, full: true, deleted: [],
      docs: [...state.docs.keys()].sort().map((key) => ({ collection: key.split("/")[0], id: key.slice(key.indexOf("/") + 1), data: state.docs.get(key) })) });
  }
  const accountView = (origin) => ({ handle: state.account.handle, email: state.account.email, language: state.account.language, created: "2026-10-19T08:00:00Z",
    maps: 1, teams: 0, profileUrl: origin + "/" + state.account.handle, siteUrl: null });
  const mapView = (origin) => ({ id: "m1", title, slug, visibility: state.visibility, version: state.version, shares: state.link ? 1 : 0, ownerType: "user", updated: "2026-10-19T08:00:00Z",
    pageUrl: origin + PAGE, subdomainUrl: null, embed: { allow: "all", origins: [], url: state.visibility === "public" ? origin + EMBED : null },
    ownerUrl: origin + "/anna", start: state.start });
  function body(req, then) {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => then(text));
  }
  function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1"), origin = "http://" + req.headers.host;
    if (url.pathname === PAGE) { page(req, res, "owner"); return true; }
    if (url.pathname === EMBED) { page(req, res, "embed"); return true; }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      sendHtml(res, withBlock(fs.readFileSync(path.join(root, "index.html"), "utf8"), { mode: "site", account: origin + "/account",
        user: state.account.signedIn ? { handle: state.account.handle } : null, language: language() }));
      return true;
    }
    // The account page gets no <base>: its policy has base-uri 'none', and its addresses start at the root.
    if (url.pathname === "/account") {
      sendHtml(res, withBlock(fs.readFileSync(path.join(STATIC, "account.html"), "utf8"), { mode: "account", user: state.account.signedIn ? { handle: state.account.handle } : null,
        language: language() }, false));
      return true;
    }
    if (url.pathname === "/account/account.js" || url.pathname === "/account/account.css") {
      res.writeHead(200, { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(fs.readFileSync(path.join(STATIC, path.basename(url.pathname))));
      return true;
    }
    if (!url.pathname.startsWith("/api/")) return false;
    if (url.pathname === "/api/account" || url.pathname.startsWith("/api/auth/")) {
      body(req, (text) => {
        state.calls.push({ method: req.method, path: url.pathname, body: text, csrf: req.headers["x-requested-with"] || "" });
        const signedIn = state.account.signedIn;
        if (url.pathname === "/api/auth/session") { json(res, 200, signedIn ? { signedIn: true, handle: state.account.handle, email: state.account.email, language: state.account.language } : { signedIn: false }); return; }
        if (url.pathname === "/api/auth/login" && req.method === "POST") {
          state.account.signedIn = true;
          json(res, 200, { handle: state.account.handle, email: state.account.email, language: state.account.language });
          return;
        }
        if (url.pathname === "/api/auth/password-check" && req.method === "POST") { json(res, 200, state.strength); return; }
        if (url.pathname === "/api/auth/register" && req.method === "POST") { json(res, 202, { status: "check_mail", message: "Bitte prüfe deine E-Mail." }); return; }
        if (url.pathname === "/api/auth/logout" && req.method === "POST") { state.account.signedIn = false; res.writeHead(204).end(); return; }
        if (url.pathname === "/api/account" && !signedIn) { json(res, 401, { error: "not_logged_in", message: "Nicht angemeldet." }); return; }
        if (url.pathname === "/api/account" && req.method === "GET") { json(res, 200, accountView(origin)); return; }
        if (url.pathname === "/api/account" && req.method === "PATCH") {
          // A refusal without a code answers without a body.
          const refused = state.refuse.account;
          if (refused && refused[1] === null) { res.writeHead(refused[0]).end(); return; }
          if (refused) { json(res, refused[0], { error: refused[1], message: refused[2], params: refused[3] || {} }); return; }
          if (req.headers["x-requested-with"] !== "it-skills") { json(res, 403, { error: "csrf", message: "Anfrage ohne Kopfzeile abgelehnt." }); return; }
          const change = JSON.parse(text || "{}");
          if (typeof change.language === "string") state.account.language = change.language;
          json(res, 200, accountView(origin));
          return;
        }
        json(res, 404, { error: "not_found", message: "Nicht gefunden." });
      });
      return true;
    }
    if (url.pathname === "/api/maps" && req.method === "GET") { json(res, 200, { maps: [mapView(origin)] }); return true; }
    if (url.pathname === "/api/maps/import" && req.method === "POST") {
      body(req, (text) => {
        const file = JSON.parse(text);
        state.imports.push({ team: url.searchParams.get("team"), body: file });
        json(res, 201, { ...mapView(origin), id: "m" + (state.imports.length + 1), title: file.title });
      });
      return true;
    }
    if (url.pathname === "/api/teams" && req.method === "GET") { json(res, 200, { teams: [] }); return true; }
    if (url.pathname === API && req.method === "GET") { json(res, 200, mapView(origin)); return true; }
    if (url.pathname === API && req.method === "PATCH") {
      body(req, (text) => {
        if (req.headers["x-requested-with"] !== "it-skills") { json(res, 403, { error: "csrf", message: "Anfrage ohne Kopfzeile abgelehnt." }); return; }
        const change = JSON.parse(text || "{}");
        state.patches.push(change);
        if (typeof change.start === "boolean") state.start = change.start;
        if (["private", "link", "public"].includes(change.visibility)) state.visibility = change.visibility;
        state.version++;
        json(res, 200, mapView(origin));
      });
      return true;
    }
    if (url.pathname === API + "/shares" && req.method === "GET") { json(res, 200, { shares: state.link ? [state.link] : [], visibility: state.visibility }); return true; }
    if (url.pathname === API + "/shares" && req.method === "POST") {
      body(req, (text) => {
        state.sharePosts.push(text);
        if (req.headers["x-requested-with"] !== "it-skills") { json(res, 403, { error: "csrf", message: "Anfrage ohne Kopfzeile abgelehnt." }); return; }
        let replace = false;
        try { replace = text ? JSON.parse(text).replace === true : false; } catch (error) { json(res, 422, { error: "invalid_request", message: "Ungültige Anfrage." }); return; }
        const fresh = !state.link || replace;
        if (fresh) { state.shares++; state.link = linkOf(origin, state.shares); }
        if (state.visibility === "private") state.visibility = "link";
        json(res, fresh ? 201 : 200, { ...state.link, visibility: state.visibility });
      });
      return true;
    }
    const docPath = url.pathname.slice(API.length).match(/^\/docs\/([^/]+)\/([^/]+)$/);
    if ((url.pathname === API + "/docs" || url.pathname === PUBLIC + "/docs") && req.method === "GET") { docsAnswer(res, url); return true; }
    if (url.pathname.startsWith(API) && docPath && (req.method === "PUT" || req.method === "DELETE")) {
      body(req, (text) => {
        const key = decodeURIComponent(docPath[1]) + "/" + decodeURIComponent(docPath[2]);
        const base = url.searchParams.has("base") ? Number(url.searchParams.get("base")) : null;
        state.writes.push({ method: req.method, key, body: text, csrf: req.headers["x-requested-with"] || "", base });
        const wait = state.slow[key] || 0;
        delete state.slow[key];
        setTimeout(() => {
          const refused = state.refuse[key];
          if (refused) { json(res, refused[0], { error: refused[1], message: refused[2] }); return; }
          if (req.headers["x-requested-with"] !== "it-skills") { json(res, 403, { error: "csrf", message: "Anfrage ohne Kopfzeile abgelehnt." }); return; }
          if (base !== null && (versions.get(key) || 1) > base) { json(res, 409, { error: "conflict", message: "Das Dokument wurde inzwischen geändert." }); return; }
          if (req.method === "PUT") state.docs.set(key, JSON.parse(text)); else state.docs.delete(key);
          state.version++;
          versions.set(key, state.version);
          json(res, 200, { version: state.version });
        }, wait);
      });
      return true;
    }
    json(res, 404, { error: "not_found", message: "Nicht gefunden." });
    return true;
  }
  const server = await serve(root, 0, handle);
  if (link) state.link = linkOf(server.origin, 0);
  return { ...server, state, pageUrl: server.origin + PAGE, embedUrl: server.origin + EMBED };
}

module.exports = { fakeApi };

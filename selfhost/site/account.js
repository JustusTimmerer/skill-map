// The start page on the server (stage b): the card "Mit Konto speichern". The server sends the start page with the
// data block it-skills-server, { mode: "site", account, user } (server/app/pages.py), and assets/runtime-local.js reads
// it into window.IT_SKILLS_SERVER. A plain web space sends nothing, so this script does nothing there, and the page stays
// the page of stage a.
//
// Signed out, the card links to the account page to sign in or register. Signed in, it lists the maps of the account
// ("Deine Maps im Konto"), creates a map from the default set or an empty one and opens it, imports a map file of
// stage a as a new map of the account, and exports a map as the same file as stage a. The card "Ohne Konto im Browser"
// keeps working beside it (assets/start.js), and a map of this browser can move into the account.
//
// Every text comes from the catalogs (i18n/*/site.json) through t. An error answer of the server shows
// SkillMapI18n.errorText(body, fallback): the text of its code in the catalogs, else its message, else the fallback.
(function () {
  "use strict";
  const server = window.IT_SKILLS_SERVER, R = window.SkillMapRuntime, T = window.SkillMapTemplates;
  if (!server || server.mode !== "site" || typeof server.account !== "string" || !R || !T) return;
  const user = server.user && typeof server.user.handle === "string" ? server.user : null;
  const VISIBILITY = { private: t("accountCard.private"), link: t("accountCard.link"), public: t("accountCard.public") };
  const make = (tag, props = {}, ...children) => { const el = Object.assign(document.createElement(tag), props); el.append(...children); return el; };
  const when = (iso) => { const d = new Date(iso); return iso && !isNaN(d) ? window.SkillMapI18n.date(d, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : t("site.noDate"); };
  // The nodes of a text with one element in it: t(key, { name: MARK }) gives the text, and node takes the place of MARK.
  const MARK = "\u0000";
  const around = (text, node) => {
    const [before, after = ""] = text.split(MARK);
    return [before, node, after].filter((part) => part !== "");
  };

  async function call(method, path, body) {
    const options = { method, credentials: "same-origin", cache: "no-store", headers: { "X-Requested-With": "it-skills" } };
    if (body !== undefined) { options.headers["Content-Type"] = "application/json"; options.body = typeof body === "string" ? body : JSON.stringify(body); }
    let response;
    try { response = await fetch(path, options); } catch (error) { throw new Error(t("accountCard.offline")); }
    let data = null;
    if (response.status !== 204) { try { data = await response.json(); } catch (error) { data = null; } }
    if (response.status === 401) throw new Error(t("accountCard.signedOut"));
    if (!response.ok) throw new Error(window.SkillMapI18n.errorText(data, t("accountCard.refused", { status: response.status })));
    return data;
  }

  // The words of the page for both ways: in the browser without an account, or on the server with one.
  document.getElementById("intro-label").textContent = t("accountCard.introLabel");
  document.getElementById("intro-store").textContent = t("accountCard.introStore");
  document.getElementById("foot-note").textContent = t("accountCard.footNote");

  const card = make("section", { className: "card account", id: "account-card" });
  card.setAttribute("aria-labelledby", "account-title");
  document.querySelector("main.wrap").prepend(card);
  const message = make("p", { className: "message", id: "account-message", hidden: true });
  message.setAttribute("role", "alert");
  const say = (text) => { message.textContent = text || ""; message.hidden = !text; };

  if (!user) {
    card.append(make("span", { className: "label", textContent: t("accountCard.label") }),
      make("h2", { id: "account-title", textContent: t("accountCard.signedOutTitle") }),
      make("p", { className: "lead", textContent: t("accountCard.signedOutLead") }),
      make("div", { className: "actions" },
        make("a", { className: "button-link primary-link", id: "account-login", href: server.account, textContent: t("accountCard.signIn") }),
        make("a", { className: "button-link", id: "account-register", href: server.account + "#register", textContent: t("accountCard.register") })),
      make("p", { className: "muted", textContent: t("accountCard.signedOutNote") }));
    window.SkillMapAccount = Object.freeze({ signedIn: false });
    return;
  }

  const list = make("ul", { className: "map-list", id: "account-list" });
  list.setAttribute("aria-label", t("accountCard.listLabel"));
  const empty = make("p", { className: "muted", id: "account-empty", hidden: true, textContent: t("accountCard.empty") });
  const input = make("input", { type: "file", id: "account-file-input", accept: ".json,application/json", hidden: true });
  input.setAttribute("aria-label", t("accountCard.fileInputLabel"));
  const logout = make("button", { type: "button", className: "small-button", id: "account-logout", textContent: t("accountCard.signOut") });
  card.append(make("span", { className: "label", textContent: t("accountCard.label") }),
    make("div", { className: "account-head" },
      make("h2", { id: "account-title", textContent: t("accountCard.signedInTitle") }),
      make("span", { className: "muted", id: "account-who" }, ...around(t("accountCard.signedInAs", { handle: MARK }), make("strong", { textContent: user.handle })), " · ",
        make("a", { href: server.account, textContent: t("accountCard.accountLink") }), " · ", logout)),
    make("p", { textContent: t("accountCard.signedInLead") }),
    make("div", { className: "actions" },
      make("button", { type: "button", className: "primary", id: "account-new-default", textContent: t("accountCard.newDefault") }),
      make("button", { type: "button", id: "account-new-empty", textContent: t("accountCard.newEmpty") }),
      make("button", { type: "button", id: "account-open-file", textContent: t("accountCard.importFile") }), input),
    message, list, empty);

  // A new map of the account, as an import of a map file: a template, with the names in the language of the page, or a
  // file of stage a.
  const fileBody = (title, collections) => ({ format: R.FORMAT, schema: R.SCHEMA, title, exportedAt: new Date().toISOString(), collections });
  async function create(kind) {
    say("");
    const map = T.map(kind);
    try { location.href = (await call("POST", "/api/maps/import", fileBody(map.title, map.collections))).pageUrl; } catch (error) { say(error.message); }
  }
  card.querySelector("#account-new-default").addEventListener("click", () => create("default"));
  card.querySelector("#account-new-empty").addEventListener("click", () => create("empty"));
  card.querySelector("#account-open-file").addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    say("");
    if (file.size > R.MAX_FILE_BYTES) { say(t("site.fileTooBig", { mb: R.MAX_FILE_MB })); return; }
    const parsed = R.store.parseFile(await file.text());
    if (parsed.error) { say(parsed.error); return; }
    try { location.href = (await call("POST", "/api/maps/import", fileBody(parsed.map.title, parsed.map.collections))).pageUrl; } catch (error) { say(error.message); }
  });
  logout.addEventListener("click", async () => {
    try { await call("POST", "/api/auth/logout"); } catch (error) { say(error.message); return; }
    location.reload();
  });

  async function render() {
    let maps;
    try { maps = (await call("GET", "/api/maps")).maps; } catch (error) { say(error.message); return; }
    empty.hidden = maps.length > 0;
    list.replaceChildren(...maps.map((m) => {
      const shown = Object.hasOwn(VISIBILITY, m.visibility) ? VISIBILITY[m.visibility] : m.visibility;
      // A map has one read link at most, and a private map pauses it.
      const link = !m.shares ? [] : [m.visibility === "private" ? t("accountCard.linkPaused") : t("accountCard.linkOn")];
      const meta = [shown, ...link, t("site.changed", { when: when(m.updated) })].join(" · ");
      const item = make("li", {}, make("div", {}, make("a", { className: "map-title", href: m.pageUrl, textContent: m.title }), make("span", { className: "map-meta", textContent: meta })),
        make("div", { className: "actions" }, make("a", { className: "button-link small-button", href: m.pageUrl, textContent: t("site.mapOpen") }),
          make("button", { type: "button", className: "small-button", textContent: t("site.mapExport"), value: "export" })));
      item.dataset.id = m.id;
      item.dataset.title = m.title;
      return item;
    }));
  }
  // The same file as "Exportieren" in stage a: the collections in the order of the format, the name from the title.
  list.addEventListener("click", async (event) => {
    const button = event.target.closest("button[value=export]"), item = button && button.closest("li");
    if (!item) return;
    say("");
    try {
      const data = await call("GET", "/api/maps/" + encodeURIComponent(item.dataset.id) + "/export");
      const file = R.store.fileOf({ title: data.title, collections: data.collections || {} });
      R.store.download(R.store.fileName(file.title), JSON.stringify(file, null, 2) + "\n");
    } catch (error) { say(error.message); }
  });
  // A map of this browser becomes a new map of the account; the copy in the browser stays.
  async function upload(text) {
    say("");
    const parsed = R.store.parseFile(text);
    if (parsed.error) { say(parsed.error); return; }
    try {
      const map = await call("POST", "/api/maps/import", fileBody(parsed.map.title, parsed.map.collections));
      say(t("accountCard.uploaded", { title: map.title }));
      await render();
    } catch (error) { say(error.message); }
  }
  window.SkillMapAccount = Object.freeze({ signedIn: true, upload });
  window.addEventListener("pageshow", (event) => { if (event.persisted) render(); });
  render();
})();

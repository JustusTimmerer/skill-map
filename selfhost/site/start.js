// The start page of the self-hosted site: new maps from the default set or empty (assets/templates.js), "Map-Datei
// öffnen", and the maps of this browser with open, export and delete. A new map takes the names of the default set in the
// language of the page. The maps live where the runtime keeps them (assets/runtime-local.js). On the server,
// a signed-in visitor can also copy a map of this browser into the account (assets/account.js). Every text comes from
// the catalogs (i18n/*/site.json) through t; the static texts of index.html carry data-i18n.
(function () {
  "use strict";
  const R = window.SkillMapRuntime, T = window.SkillMapTemplates, A = window.SkillMapAccount;
  const $ = (id) => document.getElementById(id);
  const message = $("message"), list = $("map-list"), empty = $("map-empty"), input = $("file-input");
  const say = (text) => { message.textContent = text || ""; message.hidden = !text; };
  if (!R || !T) { say(t("start.scriptsMissing")); return; }
  const open = (id) => { location.href = R.mapUrl(id); };
  const when = (iso) => { const d = new Date(iso); return iso && !isNaN(d) ? window.SkillMapI18n.date(d, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : t("site.noDate"); };
  const make = (tag, props = {}, ...children) => { const el = Object.assign(document.createElement(tag), props); el.append(...children); return el; };

  function create(kind) {
    say("");
    const map = T.map(kind);
    try { open(R.store.create(map.title, map.collections)); } catch (error) { say(error.message); }
  }
  $("new-default").addEventListener("click", () => create("default"));
  $("new-empty").addEventListener("click", () => create("empty"));
  $("open-file").addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    say("");
    const result = await R.store.importFile(file);
    if (result.error) say(result.error); else open(result.id);
  });

  // The id of the map whose delete waits for an answer.
  let asking = null;
  function render() {
    let maps;
    try { maps = R.store.list(); } catch (error) { list.replaceChildren(); empty.hidden = true; say(error.message); return; }
    if (asking && !maps.some((m) => m.id === asking)) asking = null;
    empty.hidden = maps.length > 0;
    list.replaceChildren(...maps.map((m) => {
      const title = m.damaged ? t("start.damagedTitle") : m.title || t("site.untitled"), c = m.counts;
      const meta = m.damaged ? t("start.damagedMeta")
        : [t("start.countAreas", { count: c.areas }), t("start.countGroups", { count: c.groups }), t("start.countSkills", { count: c.skills }),
          t("start.countStations", { count: c.stations }), t("start.countProjects", { count: c.projects }), t("site.changed", { when: when(m.updatedAt) })].join(" · ");
      const head = make("div", {}, m.damaged ? make("span", { className: "map-title", textContent: title }) : make("a", { className: "map-title", href: R.mapUrl(m.id), textContent: title }),
        make("span", { className: "map-meta", textContent: meta }));
      const item = make("li", {}, head);
      item.dataset.id = m.id;
      if (asking === m.id) {
        item.append(make("div", { className: "confirm" },
          make("p", { textContent: t("start.deleteAsk", { title }) }),
          make("div", { className: "actions" }, make("button", { type: "button", className: "danger small-button", textContent: t("start.deleteConfirm"), value: "delete" }),
            make("button", { type: "button", className: "small-button", textContent: t("start.deleteCancel"), value: "keep" }))));
        item.lastChild.setAttribute("role", "alert");
      } else {
        item.append(make("div", { className: "actions" },
          ...(m.damaged ? [] : [make("a", { className: "button-link small-button", href: R.mapUrl(m.id), textContent: t("site.mapOpen") }),
            make("button", { type: "button", className: "small-button", textContent: t("site.mapExport"), value: "export" }),
            ...(A && A.signedIn ? [make("button", { type: "button", className: "small-button", textContent: t("start.upload"), value: "upload" })] : [])]),
          make("button", { type: "button", className: "small-button", textContent: t("start.delete"), value: "ask-delete" })));
      }
      return item;
    }));
  }
  list.addEventListener("click", (event) => {
    const button = event.target.closest("button[value]"), item = button && button.closest("li");
    if (!item) return;
    const id = item.dataset.id;
    say("");
    try {
      if (button.value === "export") { const file = R.store.exportFile(id); R.store.download(file.name, file.text); }
      else if (button.value === "upload") { A.upload(R.store.exportFile(id).text); return; }
      else if (button.value === "ask-delete") asking = id;
      else if (button.value === "keep") asking = null;
      else if (button.value === "delete") { asking = null; R.store.remove(id); }
    } catch (error) { say(error.message); }
    render();
    if (button.value === "ask-delete") { const first = list.querySelector('li[data-id="' + CSS.escape(id) + '"] .confirm button'); if (first) first.focus(); }
  });
  // A change in another tab, or the way back from a map, shows the list as it is now.
  window.addEventListener("storage", render);
  window.addEventListener("pageshow", render);
  render();
})();

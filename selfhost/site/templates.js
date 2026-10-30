// The templates for a new map: the default set and an empty map. build_selfhost.js writes the default set of
// selfhost/site/default-set.js in front of this file into assets/templates.js: window.SKILL_MAP_DEFAULT_SET = { title,
// empty, collections }, in the shape of a map file, whose names are keys of the catalogs (i18n/<language>/default.json).
// The start page (assets/start.js), its account card (assets/account.js) and the account page of the server
// (server/app/static/account.js) load it after assets/i18n.js.
//
//   SkillMapTemplates.map(kind)  { title, collections } of a new map, or null for another kind. "default" gives the
//                                default set, "empty" a map without collections. Each name and the title take the text of
//                                the language of the page at the moment of the call. Each call gives a new copy.
//   SkillMapTemplates.kinds      the kinds of templates: "default" and "empty"
(function () {
  "use strict";
  const SET = window.SKILL_MAP_DEFAULT_SET;
  const KINDS = Object.freeze(["default", "empty"]);
  const text = (key) => window.t(key);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  function map(kind) {
    if (!SET || !KINDS.includes(kind)) return null;
    if (kind === "empty") return { title: text(SET.empty), collections: {} };
    const collections = {};
    for (const [name, docs] of Object.entries(SET.collections)) {
      collections[name] = Object.fromEntries(Object.entries(docs).map(([id, doc]) => [id, { ...copy(doc), name: text(doc.name) }]));
    }
    return { title: text(SET.title), collections };
  }
  window.SkillMapTemplates = Object.freeze({ kinds: KINDS, map });
})();

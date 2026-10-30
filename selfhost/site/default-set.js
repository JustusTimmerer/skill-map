// The default set: the content of a new map from "Default set" (selfhost/FORMAT.md, "The default set"). It is the
// collections of a map file without words: each name is the key of its text in i18n/<language>/default.json, written as
// t("<key>"), so that npm run check:texts finds every key. Three areas with two categories each and two skills in each
// category, without stations or projects. The colors are colors of the example map, and the start points sit on a
// triangle, so that the three clouds keep apart.
//
// This file is no script of a page. build_selfhost.js reads it with a t that gives the key itself, checks the map with
// the rules of an import, and writes it into assets/templates.js. The page then gives each name the text of the language
// of the page at the moment that the visitor makes a new map (SkillMapTemplates.map in selfhost/site/templates.js).
({
  title: t("default.title"),
  empty: t("default.emptyTitle"),
  collections: {
    areas: {
      software: { name: t("default.area.software"), color: "#2c5fc4", at: [-150, -70], order: 0 },
      data: { name: t("default.area.data"), color: "#a96a06", at: [150, -70], order: 1 },
      work: { name: t("default.area.work"), color: "#0a8573", at: [0, 120], order: 2 },
    },
    groups: {
      "software-languages": { name: t("default.category.languages"), area: "software", order: 0 },
      "software-tools": { name: t("default.category.tools"), area: "software", order: 1 },
      "data-databases": { name: t("default.category.databases"), area: "data", order: 2 },
      "data-analysis": { name: t("default.category.analysis"), area: "data", order: 3 },
      "work-methods": { name: t("default.category.methods"), area: "work", order: 4 },
      "work-communication": { name: t("default.category.communication"), area: "work", order: 5 },
    },
    // Rating 1 (basic skills) is the rating that the skill form gives a new skill.
    skills: {
      python: { name: t("default.skill.python"), group: "software-languages", rating: 1, places: [], order: 0 },
      javascript: { name: t("default.skill.javascript"), group: "software-languages", rating: 1, places: [], order: 1 },
      git: { name: t("default.skill.git"), group: "software-tools", rating: 1, places: [], order: 2 },
      docker: { name: t("default.skill.docker"), group: "software-tools", rating: 1, places: [], order: 3 },
      sql: { name: t("default.skill.sql"), group: "data-databases", rating: 1, places: [], order: 4 },
      postgresql: { name: t("default.skill.postgresql"), group: "data-databases", rating: 1, places: [], order: 5 },
      excel: { name: t("default.skill.excel"), group: "data-analysis", rating: 1, places: [], order: 6 },
      pandas: { name: t("default.skill.pandas"), group: "data-analysis", rating: 1, places: [], order: 7 },
      scrum: { name: t("default.skill.scrum"), group: "work-methods", rating: 1, places: [], order: 8 },
      "code-review": { name: t("default.skill.codeReview"), group: "work-methods", rating: 1, places: [], order: 9 },
      documentation: { name: t("default.skill.documentation"), group: "work-communication", rating: 1, places: [], order: 10 },
      presentations: { name: t("default.skill.presentations"), group: "work-communication", rating: 1, places: [], order: 11 },
    },
  },
})

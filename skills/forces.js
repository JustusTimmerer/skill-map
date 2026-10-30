// The force menu of the editor page, for the owner only (the plan of 2026-10-18 for one editor page). This module holds
// SPEC, the one list of every setting of the menu, and turns the layout constants of skills/layout.js that the menu
// changes into variables. It also writes the versioned format of the values: springApply, springCurrent, SPRING_SCHEMA,
// the migration steps and the first favourite. build_selfhost.js writes the result as assets/layout.js of the site. The
// menu itself is in skills/page.js (setupForces).
const path = require("path");

// Every setting of the menu: the key in the stored values, the constant in layout.js, the label and the steps.
// The keys are the format of saved configurations: a new, renamed or removed key needs a new SPRING_SCHEMA, a step in
// SPRING_STEPS and a new entry in tests/settings/schema.json.
// Each text field holds the key of its text in i18n/<language>/menu.json (i18n/README.md): menu.<key>.label, .tip and
// .hint of a setting, menu.<key>.<value> of a choice, and menu.group.<name>.title and .note of a group. This file also
// runs in Node at build time, so it never calls t: setupForces in skills/page.js reads the text of each key.
const x = "×";
const SCALE_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SPEC = [
  { title: "menu.group.areas.title", note: "menu.group.areas.note", items: [
    { key: "fixed", name: "AREA_FIXED", label: "menu.fixed.label", bool: true },
    { key: "seed", name: "SEED_PULL", label: "menu.seed.label", steps: [0, 0.25, 0.5, 1, 2, 4, 8], unit: x },
    { key: "ball", name: "AREA_BALL", label: "menu.ball.label", steps: [0, 0.25, 0.5, 0.75, 1], unit: "%" },
    { key: "areaCharge", name: "AREA_CHARGE", label: "menu.areaCharge.label", steps: [0, 20, 40, 80, 160, 320, 640] },
    { key: "likeArea", name: "AREA_LIKE", label: "menu.likeArea.label", steps: [0, 0.25, 0.5, 1, 2, 4, 8], unit: x },
  ] },
  { title: "menu.group.categories.title", note: "menu.group.categories.note", items: [
    { key: "hold", name: "AREA_HOLD", label: "menu.hold.label", steps: [0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2] },
    { key: "room", name: "AREA_ROOM", label: "menu.room.label", steps: [0, 5, 10, 15, 20, 25, 30, 40, 50, 60] },
    { key: "roomEdge", name: "AREA_ROOM_EDGE", label: "menu.roomEdge.label", bool: true },
    { key: "categoryPull", name: "CATEGORY_PULL", label: "menu.categoryPull.label", steps: [0, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8] },
    { key: "categoryRest", name: "CATEGORY_DISTANCE", label: "menu.categoryRest.label", steps: [0, 20, 40, 60, 80, 120, 160] },
    { key: "groupCharge", name: "GROUP_CHARGE", label: "menu.groupCharge.label", steps: [0, 15, 30, 60, 120, 240, 480] },
    { key: "likeGroup", name: "GROUP_LIKE", label: "menu.likeGroup.label", steps: [0, 0.25, 0.5, 1, 2, 4, 8, 16], unit: x },
    { key: "likeGroupCross", name: "GROUP_CROSS_LIKE", label: "menu.likeGroupCross.label", steps: [0, 0.25, 0.5, 1, 2, 4, 8, 16], unit: x },
    { key: "separation", name: "SEPARATION", label: "menu.separation.label", steps: [0, 0.5, 1, 2, 4, 8] },
    { key: "clusterGap", name: "CLUSTER_GAP", label: "menu.clusterGap.label", steps: [0, 2, 5, 10, 20, 40] },
    { key: "reachCap", name: "CLUSTER_REACH_CAP", label: "menu.reachCap.label", steps: [20, 40, 60, 80, 120, 1000], none: 1000 },
  ] },
  { title: "menu.group.skills.title", note: "menu.group.skills.note", items: [
    // The concept of standard skills as a whole (his wish of 2026-10-17). One value for all line modes, so it stays out of
    // the line values of each mode ("lines").
    { key: "standardSkills", name: "STANDARD_SKILLS", label: "menu.standardSkills.label", bool: true,
      tip: "menu.standardSkills.tip" },
    { key: "skillHold", name: "SKILL_HOLD", label: "menu.skillHold.label", steps: [0.25, 0.5, 1, 2, 4, 8, 16, 32] },
    { key: "skillRest", name: "SKILL_REST", label: "menu.skillRest.label", steps: [0, 5, 10, 15, 20, 30, 40] },
    { key: "skillRestLabel", name: "SKILL_REST_LABEL", label: "menu.skillRestLabel.label", steps: [0, 0.1, 0.2, 0.3, 0.5, 0.8] },
    { key: "cohesion", name: "COHESION", label: "menu.cohesion.label", steps: [0, 0.025, 0.05, 0.1, 0.2, 0.4] },
    { key: "skillCharge", name: "SKILL_CHARGE", label: "menu.skillCharge.label", steps: [0, 8, 16, 30, 60, 120] },
    { key: "likeSkill", name: "SKILL_LIKE", label: "menu.likeSkill.label", steps: [0, 0.25, 0.5, 1, 2, 4, 8], unit: x },
    { key: "likeSkillCross", name: "SKILL_CROSS_LIKE", label: "menu.likeSkillCross.label", steps: [0, 0.25, 0.5, 1, 2, 4, 8], unit: x },
  ] },
  { title: "menu.group.lineForces.title", note: "menu.group.lineForces.note", items: [
    { key: "pull", name: "LINE_PULL", label: "menu.pull.label", steps: [0, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6] },
    { key: "rest", name: "LINE_REST", label: "menu.rest.label", steps: [0, 10, 20, 30, 40, 50, 60, 80, 100, 150] },
  ] },
  { title: "menu.group.size.title", note: "menu.group.size.note", items: [
    { key: "areaScale", name: "AREA_SCALE", label: "menu.areaScale.label", steps: SCALE_STEPS, unit: "%" },
    { key: "groupScale", name: "GROUP_SCALE", label: "menu.groupScale.label", steps: SCALE_STEPS, unit: "%" },
    { key: "skillScale", name: "SKILL_SCALE", label: "menu.skillScale.label", steps: SCALE_STEPS, unit: "%" },
  ] },
  { title: "menu.group.lineLook.title", note: "menu.group.lineLook.note", items: [
    { key: "showBridges", name: "SHOW_LINES", label: "menu.showBridges.label", bool: true },
    { key: "lineMode", name: "LINE_MODE", label: "menu.lineMode.label", choice: [["category", "menu.lineMode.category"], ["skill", "menu.lineMode.skill"], ["mixed", "menu.lineMode.mixed"]], needs: "showBridges" },
    // The controls below take their defaults from LINE_DEFAULTS in layout.js, one set per mode (the build marks them "look").
    { key: "drawnBridges", name: "LINE_COUNT", label: "menu.drawnBridges.label", count: true, needs: "showBridges", hint: "menu.drawnBridges.hint" },
    { key: "crossAreaOnly", name: "LINE_CROSS_AREA", label: "menu.crossAreaOnly.label", bool: true, needs: "showBridges",
      tip: "menu.crossAreaOnly.tip" },
    // In mode Skill-Kategorie a line has the color of its skill's area, so the two line colors have no effect there.
    // With the gradient on, the area colors replace the two line colors too.
    { key: "bridgeColorLight", name: "LINE_COLOR_LIGHT", label: "menu.bridgeColorLight.label", color: true, needs: "showBridges", offIn: [["lineMode", "mixed"], ["lineGradient", true]] },
    { key: "bridgeColorDark", name: "LINE_COLOR_DARK", label: "menu.bridgeColorDark.label", color: true, needs: "showBridges", offIn: [["lineMode", "mixed"], ["lineGradient", true]] },
    { key: "lineGradient", name: "LINE_GRADIENT", label: "menu.lineGradient.label", bool: true, needs: "showBridges", offIn: ["lineMode", "mixed"],
      tip: "menu.lineGradient.tip" },
    { key: "widthExp", name: "LINE_WIDTH_EXP", label: "menu.widthExp.label", steps: [0.25, 0.33, 0.5, 0.75, 1], needs: "showBridges" },
    { key: "bridgeWidthMin", name: "LINE_WIDTH_MIN", label: "menu.bridgeWidthMin.label", steps: [0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1, 1.2, 1.6, 2, 3], needs: "showBridges" },
    { key: "bridgeWidthMax", name: "LINE_WIDTH_MAX", label: "menu.bridgeWidthMax.label", steps: [0.5, 1, 1.5, 2, 2.6, 3, 3.5, 4, 5, 6, 8, 10], needs: "showBridges" },
    { key: "bridgeOpacityMin", name: "LINE_OPACITY_MIN", label: "menu.bridgeOpacityMin.label", steps: [0.05, 0.1, 0.16, 0.25, 0.4, 0.6, 0.8, 1], unit: "%", needs: "showBridges" },
    { key: "bridgeOpacityMax", name: "LINE_OPACITY_MAX", label: "menu.bridgeOpacityMax.label", steps: [0.25, 0.35, 0.46, 0.6, 0.8, 1], unit: "%", needs: "showBridges" },
    { key: "bridgeBend", name: "LINE_BEND", label: "menu.bridgeBend.label", steps: [-0.35, -0.25, -0.15, -0.05, 0, 0.05, 0.1, 0.15, 0.25, 0.35, 0.5], needs: "showBridges" },
  ] },
  { title: "menu.group.experience.title", note: "menu.group.experience.note", items: [
    { key: "showExperience", name: "SHOW_EXPERIENCE", label: "menu.showExperience.label", bool: true },
    { key: "experienceYears", name: "EXPERIENCE_FULL_YEARS", label: "menu.experienceYears.label", steps: [3, 5, 8, 10, 12, 15, 20], needs: "showExperience" },
    { key: "ageingStep", name: "AGEING_STEP_YEARS", label: "menu.ageingStep.label", steps: [1, 2, 3, 4, 5], needs: "showExperience" },
    { key: "ageingPerStep", name: "AGEING_PER_STEP", label: "menu.ageingPerStep.label", steps: [0.1, 0.2, 0.25, 0.33, 0.5], unit: "%", needs: "showExperience" },
  ] },
  { title: "menu.group.collision.title", note: "menu.group.collision.note", items: [
    { key: "collide", name: "COLLIDE_STRENGTH", label: "menu.collide.label", steps: [0, 0.2, 0.4, 0.6, 0.8, 1] },
    { key: "collideLabel", name: "COLLIDE_LABEL", label: "menu.collideLabel.label", steps: [0, 0.1, 0.2, 0.32, 0.5] },
  ] },
  { title: "menu.group.simulation.title", note: "menu.group.simulation.note", items: [
    { key: "ticks", name: "TICKS", label: "menu.ticks.label", steps: [100, 200, 300, 500, 1000, 1500] },
    { key: "friction", name: "FRICTION", label: "menu.friction.label", steps: [0.1, 0.2, 0.3, 0.4, 0.6, 0.8] },
    { key: "range", name: "CHARGE_RANGE", label: "menu.range.label", steps: [40, 80, 120, 160, 240, 320] },
  ] },
  { title: "menu.group.post.title", note: "menu.group.post.note", items: [
    { key: "stepLabels", name: "STEP_LABELS", label: "menu.stepLabels.label", bool: true },
    { key: "stepUntangle", name: "STEP_UNTANGLE", label: "menu.stepUntangle.label", bool: true },
    { key: "lopsided", name: "LOPSIDED", label: "menu.lopsided.label", steps: [2, 3, 4, 6, 1000], none: 1000 },
    { key: "clearance", name: "SKILL_CLEARANCE", label: "menu.clearance.label", steps: [0, 7, 14, 21, 28] },
    { key: "stepSidestep", name: "STEP_SIDESTEP", label: "menu.stepSidestep.label", bool: true },
  ] },
];

// The layout with the constants of the menu as variables, and the code of the values format after it. A constant keeps
// its <NAME>_OVERRIDE, so a test page can still set it. The SPEC of the page marks each line constant with the name of
// its field in LINE_DEFAULTS ("look"): it has one value for each line mode.
function forcesLayout(source) {
  let layout = source.split("\r").join("");
  const spec = JSON.parse(JSON.stringify(SPEC)), items = spec.flatMap((g) => g.items);
  for (const it of items) {
    const { name } = it;
    const pattern = new RegExp("const (" + name + " = typeof " + name + "_OVERRIDE === \"(?:number|boolean|string)\" \\? " + name + "_OVERRIDE : ([0-9.]+|true|false|\"[^\"]*\"|LINE_LOOK\\.(\\w+));)");
    const found = layout.match(pattern);
    if (!found) throw new Error("constant not found in layout.js: " + name);
    if (found[3]) it.look = found[3];
    layout = layout.replace(pattern, "let $1");
  }
  const LOOK = items.filter((it) => it.look), PLAIN = items.filter((it) => !it.look);
  // The state of the page holds the plain values, the line values of every mode under "lines", and the start points ("at").
  return layout + `
// The force menu of the owner (skills/forces.js): every setting of the menu.
const SPEC = ${JSON.stringify(spec)};
// Each line mode keeps its own values (his wish of 2026-10-17). The menu shows and changes the values of the active mode.
// The active mode starts with the values of its variables, so a <NAME>_OVERRIDE of a test page counts as a default.
const SPRING_MODES = Object.keys(LINE_DEFAULTS);
const SPRING_LOOK = ${JSON.stringify(LOOK.map((it) => it.key))};
const springLines = Object.fromEntries(SPRING_MODES.map((m) => [m, { ${LOOK.map((it) => `${it.key}: m === LINE_MODE ? ${it.name} : LINE_DEFAULTS[m].${it.look}`).join(", ")} }]));
function springApply(v) {
${PLAIN.map(({ key, name }) => `  if (v.${key} !== undefined) ${name} = v.${key};`).join("\n")}
  if (v.lines) SPRING_MODES.forEach((m) => SPRING_LOOK.forEach((key) => { if (v.lines[m] && v.lines[m][key] !== undefined) springLines[m][key] = v.lines[m][key]; }));
  // A line value outside "lines", from one control or from an old line, belongs to the active mode.
  SPRING_LOOK.forEach((key) => { if (v[key] !== undefined) springLines[LINE_MODE][key] = v[key]; });
${LOOK.map(({ key, name }) => `  ${name} = springLines[LINE_MODE].${key};`).join("\n")}
  CLUSTERS.forEach((c) => { if (v.at && Object.hasOwn(v.at, c.id)) c.at = v.at[c.id].slice(); });
}
function springCurrent() {
  return { ${PLAIN.map(({ key, name }) => `${key}: ${name}`).join(", ")},
    lines: Object.fromEntries(SPRING_MODES.map((m) => [m, { ...springLines[m] }])), at: Object.fromEntries(CLUSTERS.map((c) => [c.id, c.at.slice()])) };
}
// The values of layout.js ("Werte aus layout.js"), taken before any configuration applies.
const SPRING_DEFAULTS = springCurrent();
// The range of each slider of the menu, from its smallest to its largest step, and of each count, from 0. Every path
// that reads a configuration (a line, a saved configuration, the configuration for readers and the state of this
// browser) puts a number outside the range of its control at the nearer end, so no configuration can ask for a billion
// steps and freeze the page. A count has no upper end: the map draws at most all of its lines.
const SPRING_RANGE = Object.fromEntries(SPEC.flatMap((g) => g.items).filter((it) => it.steps || it.count)
  .map((it) => [it.key, it.count ? [0, Infinity] : [Math.min(...it.steps), Math.max(...it.steps)]]));
function springClamp(key, x) {
  if (typeof x !== "number" || !Number.isFinite(x) || !Object.hasOwn(SPRING_RANGE, key)) return x;
  return Math.min(SPRING_RANGE[key][1], Math.max(SPRING_RANGE[key][0], x));
}
// The one check of a value against its control (C1 of the final review), for the menu of the owner (readValues in
// skills/page.js) and for the configuration for readers (springConfigState): a switch takes true or false, a color
// "#rrggbb", a choice one of its values, a count a whole number from 0, and every other control a finite number. A color
// goes into the CSS variables --shared-light and --shared-dark of the map, so no other text passes.
const SPRING_ITEMS = new Map(SPEC.flatMap((g) => g.items).map((it) => [it.key, it]));
function springFits(it, x) {
  if (!it) return false;
  return it.bool ? typeof x === "boolean" : it.color ? typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x)
    : it.choice ? it.choice.some(([value]) => value === x) : it.count ? Number.isInteger(x) && x >= 0 : Number.isFinite(x);
}
// The format of the values, versioned so that saved configurations still load after the menu changes (his wish of
// 2026-10-17). Version 1: the flat line before merge request !13, with the line values at the top level. Version 2:
// the line values of each mode under "lines" (!13). Version 3: version 2 plus "standardLinks" at the top level (!14)
// and "lineGradient" in each mode (!15). Version 4: "standardSkills" in place of "standardLinks" (the switch
// "Standard-Skills", 2026-10-17). tests/settings/schema.json lists the keys of each version, and the settings tests stop
// when the keys of SPEC differ from the entry of SPRING_SCHEMA.
const SPRING_SCHEMA = 4;
// Settings that left the menu in version 1. A line that still carries them loads without them.
const SPRING_RETIRED = ["showAreaLinks", "areaLinkWidth", "showSkillLinks", "skillLinkWidth", "treeBend", "bridgePerCategory",
  "showUseLines", "useLines", "useColorLight", "useColorDark", "useOpacity", "useLineWidth", "useBend"];
// The labels of settings that a later step replaced, for the page message of the steps that still name them.
const SPRING_OLD_LABELS = { standardLinks: "menu.standardLinks.label" };
// One step per version, from n to n + 1. A step that adds a setting gives it the value that keeps the old look, never
// the current default. Each step returns the values and what it did, for the page message.
const SPRING_STEPS = [
  // 1 to 2: the flat line values go to the mode that the line names, or to the active mode, and they win over "lines"
  // for that mode. The other modes take the values of layout.js. Retired settings drop out. A line from before the split
  // of the repulsion keeps its layout: the factor between areas is the factor inside an area.
  (v) => {
    const out = { ...v }, mode = v.lineMode !== undefined ? v.lineMode : LINE_MODE;
    const retired = SPRING_RETIRED.filter((key) => key in out), flat = SPRING_LOOK.filter((key) => out[key] !== undefined), split = [];
    retired.forEach((key) => { delete out[key]; });
    if (flat.length) out.lines = { ...(out.lines || {}), [mode]: { ...((out.lines || {})[mode] || {}), ...Object.fromEntries(flat.map((key) => [key, out[key]])) } };
    SPRING_LOOK.forEach((key) => { delete out[key]; });
    [["likeSkill", "likeSkillCross"], ["likeGroup", "likeGroupCross"]].forEach(([inside, cross]) => {
      if (out[inside] !== undefined && out[cross] === undefined) { out[cross] = out[inside]; split.push(cross); }
    });
    return { values: out, flatMode: flat.length ? mode : null, retired, split, added: [] };
  },
  // 2 to 3: the standard skills count for no line, and no line has a gradient, as before these two settings.
  (v) => {
    const out = { ...v, lines: { ...(v.lines || {}) } }, added = [];
    if (out.standardLinks === undefined) { out.standardLinks = false; added.push("standardLinks"); }
    SPRING_MODES.forEach((m) => {
      if (out.lines[m] && out.lines[m].lineGradient !== undefined) return;
      out.lines[m] = { ...(out.lines[m] || {}), lineGradient: false };
      if (!added.includes("lineGradient")) added.push("lineGradient");
    });
    return { values: out, flatMode: null, retired: [], split: [], added };
  },
  // 3 to 4: "Standard-Skills" (standardSkills) replaces "Standard-Skills zählen mit" (standardLinks) and is its opposite.
  // With standardLinks on, a standard skill had lines and springs like every other skill: that is standardSkills off.
  // A value without standardLinks counts as off, so standardSkills is on. A standardLinks that is no switch stays and is
  // named as unknown. Values that already name standardSkills keep it.
  (v) => {
    const out = { ...v }, old = out.standardLinks;
    if (old !== undefined && typeof old !== "boolean") return { values: out, flatMode: null, retired: [], split: [], added: [], standard: null };
    delete out.standardLinks;
    if (out.standardSkills !== undefined) return { values: out, flatMode: null, retired: [], split: [], added: [], standard: null };
    out.standardSkills = old !== true;
    return { values: out, flatMode: null, retired: [], split: [], added: [], standard: { links: old === true, skills: out.standardSkills } };
  },
];
// The version of values without "schema", from their shape: flat line values, retired settings or no "lines" mean
// version 1; "lines" with "standardSkills" means version 4; "lines" with "standardLinks" or a "lineGradient" means
// version 3, else version 2.
function springShape(v) {
  if (!v.lines || SPRING_LOOK.some((key) => v[key] !== undefined) || SPRING_RETIRED.some((key) => key in v)) return 1;
  if (v.standardSkills !== undefined) return 4;
  return v.standardLinks !== undefined || Object.values(v.lines).some((set) => set && set.lineGradient !== undefined) ? 3 : 2;
}
// Brings values of any version to SPRING_SCHEMA. Values of a newer page stay as they are, and the menu loads the keys
// that it knows. One path for a line, a saved configuration, the configuration for readers and the state of this browser.
function springMigrate(raw) {
  const from = Number.isInteger(raw.schema) && raw.schema >= 1 ? raw.schema : springShape(raw), notes = [];
  let values = { ...raw };
  delete values.schema;
  for (let n = from; n < SPRING_SCHEMA; n++) {
    const step = SPRING_STEPS[n - 1](values);
    values = step.values;
    notes.push({ from: n, ...step });
  }
  return { values, from, newer: from > SPRING_SCHEMA, notes };
}
// A full state from values of the current version. A value that they do not name takes the value of layout.js.
// Values without a mode keep the active mode.
function springMerge(v) {
  const base = JSON.parse(JSON.stringify(SPRING_DEFAULTS)), mode = v.lineMode !== undefined ? v.lineMode : LINE_MODE;
  const state = { ...base, ...v, lineMode: mode, lines: base.lines, at: { ...base.at, ...(v.at || {}) } };
  SPRING_MODES.forEach((m) => SPRING_LOOK.forEach((key) => { if (v.lines && v.lines[m] && v.lines[m][key] !== undefined) state.lines[m][key] = v.lines[m][key]; }));
  return state;
}
// The full state of a saved configuration ({ name, schema, values, savedAt }), through the same steps as a line, or null
// when it has no values. This is the path of the configuration for readers. A value that does not fit, for example from
// a newer page, keeps the value of layout.js, so a configuration never breaks the map of a reader. A number outside the
// range of its control takes the nearer end (springClamp).
function springConfigState(config) {
  const values = config && config.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  const state = springMerge(springMigrate(Number.isInteger(config.schema) ? { ...values, schema: config.schema } : values).values);
  const fits = (k, x) => springFits(SPRING_ITEMS.get(k), x);
  Object.keys(SPRING_DEFAULTS).forEach((k) => { if (k !== "lines" && k !== "at") state[k] = fits(k, state[k]) ? springClamp(k, state[k]) : SPRING_DEFAULTS[k]; });
  if (!SPRING_MODES.includes(state.lineMode)) state.lineMode = SPRING_DEFAULTS.lineMode;
  SPRING_MODES.forEach((m) => SPRING_LOOK.forEach((k) => { state.lines[m][k] = fits(k, state.lines[m][k]) ? springClamp(k, state.lines[m][k]) : SPRING_DEFAULTS.lines[m][k]; }));
  // A start point that does not fit keeps the start point of layout.js, and one of an area that the map does not have goes.
  Object.keys(state.at).forEach((id) => {
    const p = state.at[id];
    if (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) return;
    if (Object.hasOwn(SPRING_DEFAULTS.at, id)) state.at[id] = SPRING_DEFAULTS.at[id]; else delete state.at[id];
  });
  return state;
}
// The keys that the first favourite does not name keep the defaults of commit a8d3317, so the button gives the same
// map as before his values of 2026-10-17 became the defaults. It is a flat line of version 1, so its line values are
// for Kategorie-Kategorie.
const SPRING_FIRST = springMerge(springMigrate({ areaCharge: 160, roomEdge: false, categoryPull: 0.05, categoryRest: 60, groupCharge: 60,
  separation: 1, clusterGap: 2, reachCap: 40, skillRest: 10, skillRestLabel: 0.2, skillCharge: 30, lineMode: "category", drawnBridges: 8,
  crossAreaOnly: true, bridgeColorLight: "#596763", bridgeColorDark: "#93a3a0", widthExp: 0.5, bridgeWidthMin: 0.4, bridgeWidthMax: 2.6, bridgeOpacityMin: 0.16,
  bridgeOpacityMax: 0.46, bridgeBend: 0.15, ticks: 1500, friction: 0.4, range: 160, lopsided: 4, clearance: 14, stepSidestep: true,
  fixed: false, pull: 0.05, rest: 20, hold: 6.4, room: 0, ball: 1, seed: 4, skillHold: 1, likeSkill: 1, likeSkillCross: 1, likeGroup: 1, likeGroupCross: 1, likeArea: 1,
  at: { sd: [20, -107], data: [-374, -181], ai: [352, 94], infra: [-332, 106], fach: [-32, 154], lead: [363, -184] } }).values);
`;
}

// The line measure of the defaults ("Linienlänge × Stärke"), shown in the menu next to the current one. It runs the
// layout once at build time, with the local copy of d3.
function lineReference(data, layout) {
  const d3 = require(path.join(__dirname, "..", "selfhost", "vendor", "d3-7.9.0.min.js"));
  return Math.round(new Function("d3", [data, layout, "const R = computeLayout(), L = categoryLinks(R.nodes, R.links);",
    "return L.reduce((t, l) => t + Math.hypot(l.source.x - l.target.x, l.source.y - l.target.y) * l.pull, 0);"].join("\n"))(d3));
}

module.exports = { SPEC, forcesLayout, lineReference };

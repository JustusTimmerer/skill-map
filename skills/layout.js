const SKILL_PT = { 3: 2.7, 2: 2.5, 1: 2.4, 0: 2.4, "-1": 2.4 };
const GROUP_PT = 4, AREA_PT = 9, CHAR = 0.5;
// Size of each level as a factor of its text, dot and lines; 1 is the size of editor version 22.
// The layout makes room for the larger names, so a factor other than 1 also moves the nodes.
const AREA_SCALE = typeof AREA_SCALE_OVERRIDE === "number" ? AREA_SCALE_OVERRIDE : 1;
const GROUP_SCALE = typeof GROUP_SCALE_OVERRIDE === "number" ? GROUP_SCALE_OVERRIDE : 1;
const SKILL_SCALE = typeof SKILL_SCALE_OVERRIDE === "number" ? SKILL_SCALE_OVERRIDE : 1;
// Spring between two categories of the same area that share places: strength and rest length.
const CATEGORY_PULL = typeof CATEGORY_PULL_OVERRIDE === "number" ? CATEGORY_PULL_OVERRIDE : 0.2;
const CATEGORY_DISTANCE = typeof CATEGORY_DISTANCE_OVERRIDE === "number" ? CATEGORY_DISTANCE_OVERRIDE : 40;
const AREA_HOLD = typeof AREA_HOLD_OVERRIDE === "number" ? AREA_HOLD_OVERRIDE : 12.8;
const COHESION = typeof COHESION_OVERRIDE === "number" ? COHESION_OVERRIDE : 0.05;
// Pull of every node toward the start point of its area (CLUSTERS.at), as a factor.
const SEED_PULL = typeof SEED_PULL_OVERRIDE === "number" ? SEED_PULL_OVERRIDE : 4;
// With fixed areas, every area hub stays on its start point; only its categories and skills move.
const AREA_FIXED = typeof AREA_FIXED_OVERRIDE === "boolean" ? AREA_FIXED_OVERRIDE : false;
// Categories push apart while their skill clouds overlap; the cap stops the push from feeding on the spread it causes.
const SEPARATION = typeof SEPARATION_OVERRIDE === "number" ? SEPARATION_OVERRIDE : 8;
const CLUSTER_GAP = typeof CLUSTER_GAP_OVERRIDE === "number" ? CLUSTER_GAP_OVERRIDE : 20;
const CLUSTER_REACH_CAP = typeof CLUSTER_REACH_CAP_OVERRIDE === "number" ? CLUSTER_REACH_CAP_OVERRIDE : 80;
// Charge of each kind of node, and how far a charge reaches.
const AREA_CHARGE = typeof AREA_CHARGE_OVERRIDE === "number" ? AREA_CHARGE_OVERRIDE : 20;
const GROUP_CHARGE = typeof GROUP_CHARGE_OVERRIDE === "number" ? GROUP_CHARGE_OVERRIDE : 240;
const SKILL_CHARGE = typeof SKILL_CHARGE_OVERRIDE === "number" ? SKILL_CHARGE_OVERRIDE : 0;
const CHARGE_RANGE = typeof CHARGE_RANGE_OVERRIDE === "number" ? CHARGE_RANGE_OVERRIDE : 120;
// Like elements push each other by their own factor: skills among skills, categories among categories, areas among
// areas. Skills and categories have one factor inside their own area and one between areas.
const SKILL_LIKE = typeof SKILL_LIKE_OVERRIDE === "number" ? SKILL_LIKE_OVERRIDE : 0;
const SKILL_CROSS_LIKE = typeof SKILL_CROSS_LIKE_OVERRIDE === "number" ? SKILL_CROSS_LIKE_OVERRIDE : 4;
const GROUP_LIKE = typeof GROUP_LIKE_OVERRIDE === "number" ? GROUP_LIKE_OVERRIDE : 2;
const GROUP_CROSS_LIKE = typeof GROUP_CROSS_LIKE_OVERRIDE === "number" ? GROUP_CROSS_LIKE_OVERRIDE : 8;
const AREA_LIKE = typeof AREA_LIKE_OVERRIDE === "number" ? AREA_LIKE_OVERRIDE : 0.25;
// Spring from a category to each of its skills: strength, and rest length plus a share of the skill name's width.
const SKILL_HOLD = typeof SKILL_HOLD_OVERRIDE === "number" ? SKILL_HOLD_OVERRIDE : 4;
const SKILL_REST = typeof SKILL_REST_OVERRIDE === "number" ? SKILL_REST_OVERRIDE : 15;
const SKILL_REST_LABEL = typeof SKILL_REST_LABEL_OVERRIDE === "number" ? SKILL_REST_LABEL_OVERRIDE : 0.8;
// The spring from an area to its category leaves room for the area's ball and the category's cloud.
const AREA_ROOM = typeof AREA_ROOM_OVERRIDE === "number" ? AREA_ROOM_OVERRIDE : 5;
// When true, that rest length runs from the area ball to the edge of the cloud instead of to the category.
const AREA_ROOM_EDGE = typeof AREA_ROOM_EDGE_OVERRIDE === "boolean" ? AREA_ROOM_EDGE_OVERRIDE : true;
// Share of the room around an area hub that its ball keeps free for the area name.
const AREA_BALL = typeof AREA_BALL_OVERRIDE === "number" ? AREA_BALL_OVERRIDE : 1;
// Collision: strength, and the share of the name's width that a node's circle covers.
const COLLIDE_STRENGTH = typeof COLLIDE_STRENGTH_OVERRIDE === "number" ? COLLIDE_STRENGTH_OVERRIDE : 0.8;
const COLLIDE_LABEL = typeof COLLIDE_LABEL_OVERRIDE === "number" ? COLLIDE_LABEL_OVERRIDE : 0.32;
const ballOf = (d) => d.r + 2 + d.lw * COLLIDE_LABEL * (d.type === "area" ? AREA_BALL : 1);
// Simulation: steps and friction (the share of speed lost per step).
const TICKS = typeof TICKS_OVERRIDE === "number" ? TICKS_OVERRIDE : 300;
const FRICTION = typeof FRICTION_OVERRIDE === "number" ? FRICTION_OVERRIDE : 0.3;
// Steps after the simulation: label pass, untangling of colliding clouds, sidestep of far-pushed skills.
const STEP_LABELS = typeof STEP_LABELS_OVERRIDE === "boolean" ? STEP_LABELS_OVERRIDE : true;
const STEP_UNTANGLE = typeof STEP_UNTANGLE_OVERRIDE === "boolean" ? STEP_UNTANGLE_OVERRIDE : true;
const STEP_SIDESTEP = typeof STEP_SIDESTEP_OVERRIDE === "boolean" ? STEP_SIDESTEP_OVERRIDE : false;
// Every pair of categories in different areas is a spring, drawn or not: its pull grows with its connections and its stretch.
const LINE_PULL = typeof LINE_PULL_OVERRIDE === "number" ? LINE_PULL_OVERRIDE : 0;
const LINE_REST = typeof LINE_REST_OVERRIDE === "number" ? LINE_REST_OVERRIDE : 20;
// The concept "Standard-Skills", on or off (his wish of 2026-10-17). On: a standard skill (STANDARD) counts for every
// place from its "since" on, in the station views and the time range filter. It gets no shared-use links, so no lines
// and no springs, and the panel shows its note. Off: it is a normal skill and counts only at its own places.
const STANDARD_SKILLS = typeof STANDARD_SKILLS_OVERRIDE === "boolean" ? STANDARD_SKILLS_OVERRIDE : true;
// Lines from area to category and from category to skill.
const SHOW_AREA_LINKS = typeof SHOW_AREA_LINKS_OVERRIDE === "boolean" ? SHOW_AREA_LINKS_OVERRIDE : true;
const AREA_LINK_WIDTH = typeof AREA_LINK_WIDTH_OVERRIDE === "number" ? AREA_LINK_WIDTH_OVERRIDE : 0.8;
const SHOW_SKILL_LINKS = typeof SHOW_SKILL_LINKS_OVERRIDE === "boolean" ? SHOW_SKILL_LINKS_OVERRIDE : true;
const SKILL_LINK_WIDTH = typeof SKILL_LINK_WIDTH_OVERRIDE === "number" ? SKILL_LINK_WIDTH_OVERRIDE : 0.4;
const TREE_BEND = typeof TREE_BEND_OVERRIDE === "number" ? TREE_BEND_OVERRIDE : 0.08;
// Lines of shared use. A line counts once, and its strength is the number of connections it stands for, without months.
// Mode "category": one line for each pair of categories, the shared places of all their skill pairs.
// Mode "skill": one line for each pair of skills in different categories, their shared places.
// Mode "mixed": one line from a skill to each other category it shares places with, the shared places of its skill pairs
// with that category; it runs from the skill to the category hub and takes the area color of the skill.
// The map draws exactly LINE_COUNT lines, strongest first. Drawing changes no force: the springs are categoryLinks.
// A count at or above the number of lines draws all of them.
const LINE_MODE = typeof LINE_MODE_OVERRIDE === "string" ? LINE_MODE_OVERRIDE : "skill";
// The look of the lines, one set for each mode (his wish of 2026-10-17). Skill-Skill draws 1000 lines, very thin and
// faint, because more lines can slow the map. Kategorie-Kategorie draws few, thicker lines for the main relations.
// Skill-Kategorie takes the values of Skill-Skill. A <NAME>_OVERRIDE of a constant below wins over this table.
//   count: lines drawn (LINE_COUNT). crossArea: only pairs in different areas; when false, the map also draws pairs inside
//   an area (LINE_CROSS_AREA). colorLight, colorDark: color in the light and the dark theme; mode "mixed" uses the area
//   colors instead. widthExp: width and opacity follow the strength to this power, relative to the strongest drawn line.
//   widthMin, widthMax, opacityMin, opacityMax: from the weakest to the strongest drawn line. bend: the bend of a line.
//   gradient: each line runs from the area color of one end to the area color of the other, in place of the two colors
//   (LINE_GRADIENT, his wish of 2026-10-17, off by default). Mode "mixed" draws in the area color of the skill, so it has
//   no effect there.
const LINE_DEFAULTS = {
  category: { count: 8, crossArea: true, colorLight: "#596763", colorDark: "#93a3a0", widthExp: 0.5,
    widthMin: 0.4, widthMax: 2.6, opacityMin: 0.16, opacityMax: 0.46, bend: 0.15, gradient: false },
  skill: { count: 1000, crossArea: false, colorLight: "#596763", colorDark: "#858585", widthExp: 1,
    widthMin: 0.1, widthMax: 0.5, opacityMin: 0.1, opacityMax: 0.35, bend: 0.1, gradient: false },
};
LINE_DEFAULTS.mixed = { ...LINE_DEFAULTS.skill };
// The values of the active mode. Any other mode name draws the category lines (see modeLines), so it takes their look.
const LINE_LOOK = LINE_DEFAULTS[LINE_MODE] || LINE_DEFAULTS.category;
const LINE_COUNT = typeof LINE_COUNT_OVERRIDE === "number" ? LINE_COUNT_OVERRIDE : LINE_LOOK.count;
const LINE_CROSS_AREA = typeof LINE_CROSS_AREA_OVERRIDE === "boolean" ? LINE_CROSS_AREA_OVERRIDE : LINE_LOOK.crossArea;
// Shown or not: one switch for all modes.
const SHOW_LINES = typeof SHOW_LINES_OVERRIDE === "boolean" ? SHOW_LINES_OVERRIDE : true;
const LINE_COLOR_LIGHT = typeof LINE_COLOR_LIGHT_OVERRIDE === "string" ? LINE_COLOR_LIGHT_OVERRIDE : LINE_LOOK.colorLight;
const LINE_COLOR_DARK = typeof LINE_COLOR_DARK_OVERRIDE === "string" ? LINE_COLOR_DARK_OVERRIDE : LINE_LOOK.colorDark;
const LINE_WIDTH_MIN = typeof LINE_WIDTH_MIN_OVERRIDE === "number" ? LINE_WIDTH_MIN_OVERRIDE : LINE_LOOK.widthMin;
const LINE_WIDTH_MAX = typeof LINE_WIDTH_MAX_OVERRIDE === "number" ? LINE_WIDTH_MAX_OVERRIDE : LINE_LOOK.widthMax;
const LINE_OPACITY_MIN = typeof LINE_OPACITY_MIN_OVERRIDE === "number" ? LINE_OPACITY_MIN_OVERRIDE : LINE_LOOK.opacityMin;
const LINE_OPACITY_MAX = typeof LINE_OPACITY_MAX_OVERRIDE === "number" ? LINE_OPACITY_MAX_OVERRIDE : LINE_LOOK.opacityMax;
const LINE_BEND = typeof LINE_BEND_OVERRIDE === "number" ? LINE_BEND_OVERRIDE : LINE_LOOK.bend;
const LINE_WIDTH_EXP = typeof LINE_WIDTH_EXP_OVERRIDE === "number" ? LINE_WIDTH_EXP_OVERRIDE : LINE_LOOK.widthExp;
const LINE_GRADIENT = typeof LINE_GRADIENT_OVERRIDE === "boolean" ? LINE_GRADIENT_OVERRIDE : LINE_LOOK.gradient;
// Pairs of categories with shared places, strongest first. The springs use the pairs in different areas.
function categoryLinks(nodes, links, crossAreaOnly = true) {
  const sums = new Map();
  links.filter((l) => l.kind === "use" && (!crossAreaOnly || l.source.cluster !== l.target.cluster)).forEach((l) => {
    const key = [l.source.group, l.target.group].sort().join("|");
    sums.set(key, (sums.get(key) || 0) + l.w);
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const all = [...sums].map(([key, strength]) => {
    const [a, b] = key.split("|");
    return { key, source: byId.get("g:" + a), target: byId.get("g:" + b), kind: "bridge", strength };
  }).sort((x, y) => y.strength - x.strength || x.key.localeCompare(y.key));
  const top = all.length ? all[0].strength : 1;
  all.forEach((b) => { b.pull = b.strength / top; b.share = Math.pow(b.pull, LINE_WIDTH_EXP); });
  return all;
}
// Pairs of skills in different categories with shared places, strongest first. On equal counts the similarity of the
// two place profiles decides, then the names. The similarity is rounded, because equal profiles differ in the last digit.
function skillLinks(links, crossAreaOnly = true) {
  const rank = (l) => Math.round(l.similarity * 1e9);
  return links.filter((l) => l.kind === "use" && (!crossAreaOnly || l.source.cluster !== l.target.cluster))
    .map((l) => ({ key: l.source.id + "|" + l.target.id, source: l.source, target: l.target, kind: "skill-line", strength: l.w, rank: rank(l) }))
    .sort((x, y) => y.strength - x.strength || y.rank - x.rank || x.key.localeCompare(y.key));
}
// Lines from a skill to another category, strongest first. A use link of skills a and b counts for the line from a to the
// category of b and for the line from b to the category of a. On equal counts the summed similarity of the skill pairs
// decides, then the names. The rounded similarities add up as whole numbers, so the order of the links does not matter.
function mixedLinks(nodes, links, crossAreaOnly = true) {
  const rank = (l) => Math.round(l.similarity * 1e9), hubOf = new Map(nodes.filter((n) => n.type === "group").map((n) => [n.group, n]));
  const lines = new Map();
  const add = (skill, other, l) => {
    const key = skill.id + ">" + other.group;
    const line = lines.get(key) || lines.set(key, { key, source: skill, target: hubOf.get(other.group), kind: "mixed-line", strength: 0, rank: 0 }).get(key);
    line.strength += l.w; line.rank += rank(l);
  };
  links.filter((l) => l.kind === "use" && (!crossAreaOnly || l.source.cluster !== l.target.cluster)).forEach((l) => {
    add(l.source, l.target, l); add(l.target, l.source, l);
  });
  return [...lines.values()].sort((x, y) => y.strength - x.strength || y.rank - x.rank || x.key.localeCompare(y.key));
}
// All lines of the current mode and area setting, strongest first. With a set of active places (the time range
// filter), a line counts only the connections through these places.
function modeLines(nodes, links, active = null) {
  const use = activeUseLinks(links, active);
  return LINE_MODE === "skill" ? skillLinks(use, LINE_CROSS_AREA) : LINE_MODE === "mixed" ? mixedLinks(nodes, use, LINE_CROSS_AREA)
    : categoryLinks(nodes, use, LINE_CROSS_AREA);
}
// The number of lines in the current mode and area setting: the most the map can draw.
function lineTotal(nodes, links) {
  return modeLines(nodes, links).length;
}
// The lines that touch a selected skill, category or area. In mode "category" a skill selects the lines of its category.
// In mode "mixed" a skill selects the lines it starts, because the other end of a line is always a category hub.
function lineTouches(selected) {
  const hit = selected.type === "area" ? (end) => end.cluster === selected.cluster
    : selected.type === "group" || (LINE_MODE !== "skill" && LINE_MODE !== "mixed") ? (end) => end.group === selected.group : (end) => end.id === selected.id;
  return (l) => hit(l.source) || hit(l.target);
}
// The lines the map draws: exactly LINE_COUNT, strongest first, of all lines or of the lines that touch a selection.
// With a set of active places, only the connections through these places count.
function drawnLines(nodes, links, selected, active = null) {
  const all = modeLines(nodes, links, active);
  const drawn = (selected ? all.filter(lineTouches(selected)) : all).slice(0, LINE_COUNT);
  const top = drawn.length ? drawn[0].strength : 1;
  drawn.forEach((l) => { l.share = Math.pow(l.strength / top, LINE_WIDTH_EXP); });
  return drawn;
}
// Category lines between areas for the print map and the old atlas. They draw with fixed widths, so they keep
// the 8 strongest lines that they drew before the editor map drew 1000 lines.
const PRINT_LINE_COUNT = 8;
function categoryBridges(nodes, links) {
  return categoryLinks(nodes, links).slice(0, PRINT_LINE_COUNT);
}
const USE_DISTANCE = 30;
// A place counts by the square root of its months, scaled so the average place weighs 1. When no place has months,
// every place weighs 1.
// No d3 here: this runs when the script loads, and the page must still reach its message when d3 failed to load.
// A page whose stations come from its database computes the weights again when they change (placeWeights).
function placeWeights() {
  const raw = Object.fromEntries(Object.entries(PROJECTS).map(([k, p]) => [k, Math.sqrt(Math.max(0, Number(p.months) || 0))]));
  const values = Object.values(raw), mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, mean > 0 ? v / mean : 1]));
}
const PLACE_WEIGHT = placeWeights();
// Experience ring around each skill with places: the years of use fill it, and the ageing greys a share of the filled part.
// A skill without a place has no ring.
// The ageing grows by AGEING_PER_STEP for every AGEING_STEP_YEARS since the last use, up to 100 %. Experience never shrinks.
const SHOW_EXPERIENCE = typeof SHOW_EXPERIENCE_OVERRIDE === "boolean" ? SHOW_EXPERIENCE_OVERRIDE : true;
const EXPERIENCE_FULL_YEARS = typeof EXPERIENCE_FULL_YEARS_OVERRIDE === "number" ? EXPERIENCE_FULL_YEARS_OVERRIDE : 10;
const AGEING_STEP_YEARS = typeof AGEING_STEP_YEARS_OVERRIDE === "number" ? AGEING_STEP_YEARS_OVERRIDE : 3;
const AGEING_PER_STEP = typeof AGEING_PER_STEP_OVERRIDE === "number" ? AGEING_PER_STEP_OVERRIDE : 0.25;
// With the ring on, a skill name sits this much lower, so the ring stays free.
const hasRing = (n) => SHOW_EXPERIENCE && n.type === "skill" && n.xpYears > 0;
const ringRoom = (n) => hasRing(n) ? 1.4 : 0;
// Today as a fractional year; the tests fix it so the ageing does not change with the calendar.
const EXPERIENCE_NOW = typeof EXPERIENCE_NOW_OVERRIDE === "number" ? EXPERIENCE_NOW_OVERRIDE : new Date().getFullYear() + new Date().getMonth() / 12;
// The dates of a place text in their order: "MM.YYYY" or "MM/YYYY" names a month, "YYYY" alone a whole year (month null).
function whenDates(when) {
  return (String(when).match(/(\d{1,2}[./])?\d{4}/g) || []).map((t) => {
    const [month, year] = t.split(/[./]/);
    return year === undefined ? { month: null, year: Number(month) } : { month: Number(month), year: Number(year) };
  });
}
// The words of a place that still runs, the same in every language of the page: "seit 05.2026" or "since 05.2026", and
// "05.2026 – heute", "05.2026 – today" or "05.2026 – present".
const WHEN_RUNNING = /\b(?:seit|since|heute|today|present)\b/i;
// True when the forms of a station and a project may store a place text: one date, two dates with a dash between them,
// "seit" or "since" before a date, or a date and a dash before "heute", "today" or "present". A date is MM.YYYY, MM/YYYY
// or YYYY, with a month from 1 to 12. Any other word is refused, so the functions above read every text that the forms
// store in full.
function whenValid(when) {
  const date = "(?:(?:0?[1-9]|1[0-2])[./])?\\d{4}", dash = "\\s*[-–—]\\s*", end = "(?:heute|today|present)";
  return new RegExp(`^\\s*(?:(?:seit|since)\\s+${date}(?:${dash}${end})?|${date}(?:${dash}(?:${date}|${end}))?)\\s*$`, "i").test(String(when));
}
// End of a place as a fractional year: a running place still runs, "MM.YYYY" ends after that month, "YYYY" after that year.
function placeEnd(when) {
  const last = whenDates(when).pop();
  if (WHEN_RUNNING.test(when) || !last) return EXPERIENCE_NOW;
  return last.year + (last.month || 12) / 12;
}
// Time range filter (his wish of 2026-10-17). A month is a whole number, year * 12 + month - 1.
// NOW_MONTH is the month of EXPERIENCE_NOW: the last month of a place that still runs.
const NOW_MONTH = Math.floor(EXPERIENCE_NOW * 12 + 1e-6);
// The first and the last month of a place text, or null without a date. "YYYY" alone runs from January to December,
// one date alone is one month or one year, and a running place runs to NOW_MONTH. A fixed end agrees with placeEnd: it is
// (to + 1) / 12.
function placeMonths(when) {
  const dates = whenDates(when);
  if (!dates.length) return null;
  const first = dates[0], last = dates[dates.length - 1];
  return { from: first.year * 12 + (first.month || 1) - 1, to: WHEN_RUNNING.test(when) ? NOW_MONTH : last.year * 12 + (last.month || 12) - 1 };
}
// The station of a place key, or null. A name of the map is looked up only among the own keys of a table, so a place
// such as "constructor" or "toString" is no member of a plain object (the same holds for STANDARD and PLACE_WEIGHT).
const placeOf = (key) => Object.hasOwn(PROJECTS, key) ? PROJECTS[key] : null;
// A project of the database runs in its own months, or else in the months of its station; null when it has neither.
const projectMonths = (p) => placeMonths(p.when) || (placeOf(p.station) ? placeMonths(placeOf(p.station).when) : null);
// True when months { from, to } overlap the range of months from `from` to `to`, by month.
const inMonths = (months, from, to) => !!months && months.from <= to && months.to >= from;
// The places (keys of PROJECTS) that are active in the range of months.
const activePlaces = (from, to) => new Set(Object.keys(PROJECTS).filter((k) => inMonths(placeMonths(PROJECTS[k].when), from, to)));
// The note of a standard skill while STANDARD_SKILLS is on, else "". Every decision about the concept asks this helper:
// the shared-use links, standardSince and the panel. The standard field of the data stays either way.
const standardNote = (n) => STANDARD_SKILLS && n.standard ? n.standard : "";
// The station from which a standard skill counts for every station (STANDARD[...].since), or null for a normal skill
// and for every skill while STANDARD_SKILLS is off. A skill with null counts only for its own stations. The time filter
// and the station views ask this helper alone.
const standardSince = (n) => standardNote(n) ? n.standardSince : null;
// True when a standard skill counts for the place `key`: every place from its `since` on, in the order of PROJECTS.
function standardAt(n, key) {
  const since = standardSince(n), keys = Object.keys(PROJECTS);
  return since !== null && keys.indexOf(key) >= keys.indexOf(since);
}
// A skill is in the range when one of its places is active, an active project holds it (`projectSkills`, the names of
// the skills of the active projects), or it is a standard skill and an active place counts for it.
const inTime = (n, active, projectSkills) => n.places.some((p) => active.has(p)) || projectSkills.has(n.label) || [...active].some((k) => standardAt(n, k));
// The shared places of a use link.
const sharedPlaces = (l) => l.source.places.filter((p) => l.target.places.includes(p));
// The use links as far as the active places carry them: each link counts only its shared places in `active`, and a link
// without one drops out. Without a set of active places, the links stay as they are. The springs do not use this.
function activeUseLinks(links, active) {
  if (!active) return links;
  return links.filter((l) => l.kind === "use").map((l) => ({ ...l, w: sharedPlaces(l).filter((p) => active.has(p)).length })).filter((l) => l.w > 0);
}
// A place counts with all its months until projects have their own dates.
// The time range filter (his rule of 2026-10-17): when the range ends before NOW_MONTH, the ageing counts up to the end of
// its last month (endMonth) instead of up to EXPERIENCE_NOW. Only the places that start by then count, each one up to that
// end, so a place that still runs then counts as used then. The years of experience stay the total. A skill without a
// place by then keeps the ring of today. xpAsOf is the end month that the ageing counts to, or null for today.
function experienceOf(places, endMonth = null) {
  const known = places.filter((p) => placeOf(p));
  const byEnd = endMonth !== null && endMonth < NOW_MONTH ? known.filter((p) => { const m = placeMonths(PROJECTS[p].when); return m && m.from <= endMonth; }) : [];
  const now = byEnd.length ? (endMonth + 1) / 12 : EXPERIENCE_NOW;
  const last = byEnd.length ? Math.max(...byEnd.map((p) => Math.min(placeEnd(PROJECTS[p].when), now)))
    : known.length ? Math.max(...known.map((p) => placeEnd(PROJECTS[p].when))) : EXPERIENCE_NOW;
  return {
    xpYears: known.reduce((sum, p) => sum + PROJECTS[p].months, 0) / 12,
    xpLastYear: Math.floor(last - 1e-6),
    xpAgeing: Math.min(1, Math.floor(Math.max(0, now - last) / AGEING_STEP_YEARS) * AGEING_PER_STEP),
    xpAsOf: byEnd.length ? endMonth : null,
  };
}

function starPath(outer, inner) {
  let d = "";
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / 5;
    const radius = i % 2 ? inner : outer;
    d += (i ? "L" : "M") + (Math.cos(angle) * radius).toFixed(3) + "," + (Math.sin(angle) * radius).toFixed(3);
  }
  return d + "Z";
}

// Areas, categories and skills as one force-directed network; positions are deterministic.
function computeLayout() {
  const areaOfGroup = new Map(GROUPS.map(([id, cluster]) => [id, cluster]));
  // A place that is no station weighs nothing, and a skill without an own entry in STANDARD is no standard skill.
  const weightOf = (p) => Object.hasOwn(PLACE_WEIGHT, p) ? PLACE_WEIGHT[p] : 0;
  const standardOf = (label) => Object.hasOwn(STANDARD, label) ? STANDARD[label] : null;
  const seedOf = (cluster) => { const at = CLUSTERS.find((c) => c.id === cluster).at; return [at[0] * 0.5, at[1] * 0.5]; };
  const nodes = [], links = [];
  CLUSTERS.forEach((c) => {
    const [x, y] = seedOf(c.id);
    nodes.push({ id: "c:" + c.id, type: "area", cluster: c.id, label: c.name, r: 7 * AREA_SCALE, x, y, lw: c.name.length * AREA_PT * AREA_SCALE * 0.52, lh: AREA_PT * AREA_SCALE * 1.1, ...(AREA_FIXED ? { fx: x, fy: y } : {}) });
  });
  GROUPS.forEach(([id, cluster, name]) => {
    const label = name.toUpperCase();
    nodes.push({ id: "g:" + id, type: "group", cluster, group: id, name, label, r: 3.6 * GROUP_SCALE, lw: label.length * GROUP_PT * GROUP_SCALE * 0.62, lh: GROUP_PT * GROUP_SCALE * 1.15 });
    links.push({ source: "c:" + cluster, target: "g:" + id, kind: "area" });
  });
  SKILLS.forEach(([label, group, rating, where]) => {
    const fs = SKILL_PT[rating] * SKILL_SCALE;
    const tags = where ? where.split(" ") : [];
    const note = standardOf(label);
    nodes.push({ id: "s:" + label, type: "skill", cluster: areaOfGroup.get(group), group, label, rating, fs, tags,
      places: [...new Set(tags.map((k) => k.replace(/i$/, "")))], ...experienceOf([...new Set(tags.map((k) => k.replace(/i$/, "")))]),
      standard: note ? note.text : "", standardSince: note ? note.since : "",
      r: (rating === 3 ? 3 : rating === 2 ? 2.4 : 1.8) * SKILL_SCALE, lw: label.length * fs * CHAR, lh: fs * 1.1 });
    links.push({ source: "g:" + group, target: "s:" + label, kind: "group" });
  });
  // Shared-use links between skills of different categories. The lines and the springs between categories come from them.
  // Standard skills are left out while STANDARD_SKILLS is on. Off, they count with their own places like every other skill.
  const skills = nodes.filter((n) => n.type === "skill" && !standardNote(n));
  for (let i = 0; i < skills.length; i++) for (let j = i + 1; j < skills.length; j++) {
    const a = skills[i], b = skills[j];
    if (a.group === b.group) continue;
    const shared = a.places.filter((p) => b.places.includes(p)).length;
    if (shared) links.push({ source: a.id, target: b.id, kind: "use", w: shared,
      weight: a.places.filter((p) => b.places.includes(p)).reduce((sum, p) => sum + weightOf(p), 0) });
  }
  const useLinks = links.filter((l) => l.kind === "use");
  // Cosine similarity of the two place profiles: high when two skills share mainly the same places.
  const profile = (n) => Math.sqrt(d3.sum(n.places, (p) => weightOf(p) ** 2));
  useLinks.forEach((l) => {
    const a = nodes.find((n) => n.id === l.source), b = nodes.find((n) => n.id === l.target);
    const shared = a.places.filter((p) => b.places.includes(p));
    l.similarity = d3.sum(shared, (p) => weightOf(p) ** 2) / (profile(a) * profile(b));
  });
  // Categories attract each other by their shared use; single skills stay with their own category.
  const groupOfSkill = new Map(nodes.filter((n) => n.type === "skill").map((n) => [n.id, n.group]));
  const groupSums = new Map();
  useLinks.forEach((l) => {
    const key = [groupOfSkill.get(l.source), groupOfSkill.get(l.target)].sort().join("|");
    groupSums.set(key, (groupSums.get(key) || 0) + l.weight);
  });
  const maxSum = d3.max([...groupSums.values()]) || 1;
  groupSums.forEach((sum, key) => {
    const [a, b] = key.split("|");
    links.push({ source: "g:" + a, target: "g:" + b, kind: "category", share: sum / maxSum });
  });
  nodes.forEach((n, i) => {
    if (n.type === "area") return;
    const a = i * 2.399, [sx, sy] = seedOf(n.cluster);
    n.x = sx + Math.cos(a) * 20; n.y = sy + Math.sin(a) * 20;
  });
  const hubOf = new Map(nodes.filter((n) => n.type === "group").map((n) => [n.group, n]));
  const hubs = [...hubOf.values()];
  const membersOf = new Map(hubs.map((g) => [g.group, nodes.filter((n) => n.type === "skill" && n.group === g.group)]));
  const clouds = hubs.map((g) => [g, ...membersOf.get(g.group)]);
  const chargeOf = (d) => d.type === "area" ? -AREA_CHARGE : d.type === "group" ? -GROUP_CHARGE : -SKILL_CHARGE;
  const manyBody = d3.forceManyBody().strength(chargeOf).distanceMax(CHARGE_RANGE);
  // A cloud takes the charge from outside as one body: its hub and its skills all get the mean outside push.
  // Pushes inside a cloud cancel in sum, so an uneven push from outside was what crowded skills on one side.
  const likeOf = (a, b) => a.type !== b.type ? 1 : a.type === "area" ? AREA_LIKE : a.cluster === b.cluster
    ? (a.type === "skill" ? SKILL_LIKE : GROUP_LIKE) : (a.type === "skill" ? SKILL_CROSS_LIKE : GROUP_CROSS_LIKE);
  const sameType = ["skill", "group", "area"].map((type) => nodes.filter((n) => n.type === type));
  const charge = (alpha) => {
    const before = new Map(nodes.map((n) => [n, [n.vx, n.vy]]));
    manyBody(alpha);
    // manyBody gave like pairs the plain charge; here they get the difference to their own factor.
    sameType.forEach((same) => {
      for (let i = 0; i < same.length; i++) for (let j = i + 1; j < same.length; j++) {
        const a = same[i], b = same[j], x = b.x - a.x, y = b.y - a.y, l = x * x + y * y, extra = likeOf(a, b) - 1;
        if (!extra || l === 0 || l >= CHARGE_RANGE * CHARGE_RANGE) continue;
        const w = extra * alpha / (l < 1 ? Math.sqrt(l) : l);
        a.vx += x * chargeOf(b) * w; a.vy += y * chargeOf(b) * w; b.vx -= x * chargeOf(a) * w; b.vy -= y * chargeOf(a) * w;
      }
    });
    clouds.forEach((cloud) => {
      const inner = cloud.map((a) => cloud.reduce(([px, py], b) => {
        const x = b.x - a.x, y = b.y - a.y, l = x * x + y * y;
        if (a === b || l === 0 || l >= CHARGE_RANGE * CHARGE_RANGE) return [px, py];
        const w = chargeOf(b) * likeOf(a, b) * alpha / (l < 1 ? Math.sqrt(l) : l);
        return [px + x * w, py + y * w];
      }, [0, 0]));
      const outer = cloud.map((n, i) => [n.vx - before.get(n)[0] - inner[i][0], n.vy - before.get(n)[1] - inner[i][1]]);
      const mx = d3.mean(outer, (o) => o[0]), my = d3.mean(outer, (o) => o[1]);
      cloud.forEach((n, i) => { n.vx = before.get(n)[0] + inner[i][0] + mx; n.vy = before.get(n)[1] + inner[i][1] + my; });
    });
  };
  charge.initialize = (all, random) => manyBody.initialize(all, random);
  // Everything between a cloud and the world outside it moves the cloud as one body: its hub and all its skills get
  // the same push. Only the springs from the hub to its skills and the push among its own skills shape the cloud.
  const cloudOf = new Map(clouds.map((c) => [c[0], c])), byNode = new Map(nodes.map((n) => [n.id, n]));
  links.forEach((l) => { l.source = byNode.get(l.source) || l.source; l.target = byNode.get(l.target) || l.target; });
  const moveCloud = (hub, dx, dy) => cloudOf.get(hub).forEach((n) => { n.vx += dx; n.vy += dy; });
  // A spring between two hubs moves both clouds; they share the move in inverse proportion to their size.
  const pullClouds = (a, b, k) => {
    const ca = cloudOf.get(a), cb = cloudOf.get(b), dx = b.x - a.x, dy = b.y - a.y, ta = cb.length / (ca.length + cb.length);
    moveCloud(a, dx * k * ta, dy * k * ta); moveCloud(b, -dx * k * (1 - ta), -dy * k * (1 - ta));
  };
  const areaLinks = links.filter((l) => l.kind === "area"), areaCount = d3.rollup(areaLinks, (v) => v.length, (l) => l.source);
  const sameAreaLinks = links.filter((l) => l.kind === "category" && l.source.cluster === l.target.cluster);
  const lines = categoryLinks(nodes, links);
  // A spring stronger than 1 overshoots, so a strong spring runs as several weaker passes per step.
  const areaPasses = Math.max(1, Math.ceil(AREA_HOLD)), skillPasses = Math.max(1, Math.ceil(SKILL_HOLD));
  const sim = d3.forceSimulation(nodes).velocityDecay(FRICTION)
    .force("link", d3.forceLink(links.filter((l) => l.kind === "group")).id((d) => d.id)
      .distance((l) => SKILL_REST + l.target.lw * SKILL_REST_LABEL).strength(SKILL_HOLD / skillPasses).iterations(skillPasses))
    // Like a d3 link, but the category end moves its whole cloud; the area hub takes the smaller share.
    .force("area", (alpha) => {
      const edge = new Map(clouds.map((c) => [c[0], AREA_ROOM_EDGE && c.length > 1 ? d3.mean(c.slice(1), (n) => Math.hypot(n.x - c[0].x, n.y - c[0].y)) : 0]));
      for (let pass = 0; pass < areaPasses; pass++) areaLinks.forEach((l) => {
        const area = l.source, g = l.target, x = g.x + g.vx - area.x - area.vx, y = g.y + g.vy - area.y - area.vy;
        const len = Math.hypot(x, y) || 1e-6, k = (len - ballOf(area) - AREA_ROOM - edge.get(g)) / len * alpha * AREA_HOLD / areaPasses;
        const share = areaCount.get(area) / (areaCount.get(area) + 1);
        moveCloud(g, -x * k * share, -y * k * share);
        area.vx += x * k * (1 - share); area.vy += y * k * (1 - share);
      });
    })
    .force("charge", charge)
    .force("collide", d3.forceCollide(ballOf).strength(COLLIDE_STRENGTH))
    .force("cohesion", (alpha) => {
      // Every skill drifts toward its own category center, so no skill ends up among a foreign category.
      nodes.forEach((n) => {
        if (n.type !== "skill") return;
        const g = hubOf.get(n.group);
        n.vx += (g.x - n.x) * COHESION * alpha; n.vy += (g.y - n.y) * COHESION * alpha;
      });
    })
    .force("categories", (alpha) => sameAreaLinks.forEach((l) => {
      const len = Math.hypot(l.target.x - l.source.x, l.target.y - l.source.y) || 1;
      pullClouds(l.source, l.target, CATEGORY_PULL * l.share * alpha * (len - CATEGORY_DISTANCE) / len);
    }))
    .force("lines", (alpha) => lines.forEach((l) => {
      const len = Math.hypot(l.target.x - l.source.x, l.target.y - l.source.y) || 1;
      pullClouds(l.source, l.target, LINE_PULL * l.pull * alpha * Math.max(0, len - LINE_REST) / len);
    }))
    .force("separate", (alpha) => {
      const reach = new Map(hubs.map((g) => {
        const spread = membersOf.get(g.group).map((n) => Math.hypot(n.x - g.x, n.y - g.y) + n.lw * 0.3);
        return [g.group, spread.length ? Math.min(d3.mean(spread) * 1.4, CLUSTER_REACH_CAP) : 4];
      }));
      for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++) {
        const a = hubs[i], b = hubs[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const overlap = reach.get(a.group) + reach.get(b.group) + CLUSTER_GAP - d;
        if (overlap <= 0) continue;
        const push = overlap / d * alpha * SEPARATION * 0.5;
        moveCloud(a, -dx * push, -dy * push); moveCloud(b, dx * push, dy * push);
      }
    })
    // The pull toward the start point acts on each area hub alone, and on each cloud by the mean over its nodes.
    .force("seed", (alpha) => {
      const kx = 0.035 * SEED_PULL * alpha, ky = 0.05 * SEED_PULL * alpha;
      nodes.filter((n) => n.type === "area").forEach((a) => { const [sx, sy] = seedOf(a.cluster); a.vx += (sx - a.x) * kx; a.vy += (sy - a.y) * ky; });
      clouds.forEach((cloud) => {
        const [sx, sy] = seedOf(cloud[0].cluster);
        moveCloud(cloud[0], d3.mean(cloud, (n) => sx - n.x) * kx, d3.mean(cloud, (n) => sy - n.y) * ky);
      });
    })
    .stop();
  for (let i = 0; i < TICKS; i++) sim.tick();
  const settled = new Map(nodes.filter((n) => n.type === "skill").map((n) => [n, Math.hypot(n.x - hubOf.get(n.group).x, n.y - hubOf.get(n.group).y)]));
  if (STEP_LABELS) resolveLabels(nodes, AREA_FIXED ? (n) => n.type !== "area" : undefined);
  const changed = STEP_UNTANGLE ? untangle(nodes, hubs, membersOf) : new Set();
  const movable = (n) => n.type === "skill" && changed.has(n.group);
  for (let round = 0; round < 5; round++) {
    keepApart(nodes, movable);
    if (STEP_LABELS) resolveLabels(nodes, movable);
  }
  if (STEP_SIDESTEP) sidestep(nodes, hubs, settled);
  return { nodes, links };
}
// Area and category names grow in the overview to stay readable; their boxes reserve that room.
const AREA_LABEL_ROOM = 1.6, GROUP_LABEL_ROOM = 1.25;
function labelBox(n) {
  if (n.type === "area") {
    const w = n.lw * AREA_LABEL_ROOM, h = n.lh * AREA_LABEL_ROOM;
    return { x0: n.x - w / 2, x1: n.x + w / 2, y0: n.y - n.r - 1.5 - h, y1: n.y + n.r };
  }
  const grow = n.type === "group" ? GROUP_LABEL_ROOM : 1, half = Math.max(n.lw * grow / 2, n.r);
  return { x0: n.x - half, x1: n.x + half, y0: n.y - n.r, y1: n.y + n.r + 0.8 + ringRoom(n) + n.lh * grow };
}
function layoutBounds(nodes, margin) {
  const boxes = nodes.map(labelBox);
  return { x0: d3.min(boxes, (b) => b.x0) - margin, x1: d3.max(boxes, (b) => b.x1) + margin,
    y0: d3.min(boxes, (b) => b.y0) - margin, y1: d3.max(boxes, (b) => b.y1) + margin };
}
function linkPath(l) {
  const x1 = l.source.x, y1 = l.source.y, x2 = l.target.x, y2 = l.target.y;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, bend = TREE_BEND;
  return `M${x1},${y1}Q${mx - (y2 - y1) * bend},${my + (x2 - x1) * bend} ${x2},${y2}`;
}

// Labels never overlap each other or a node; nodes move only as far as needed.
// With a movable test, only those nodes give way, and a fixed node keeps its place.
function resolveLabels(nodes, movable = () => true) {
  for (let round = 0; round < 600; round++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j], ma = movable(a), mb = movable(b);
      if (!ma && !mb) continue;
      const A = labelBox(a), B = labelBox(b), pad = 0.8;
      const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) + pad, oy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + pad;
      if (ox <= 0 || oy <= 0) continue;
      moved = true;
      const dx = (B.x0 + B.x1 - A.x0 - A.x1) / 2, dy = (B.y0 + B.y1 - A.y0 - A.y1) / 2;
      const share = ma && mb ? 0.5 : 1, fa = ma ? share : 0, fb = mb ? share : 0;
      if (ox < oy * 1.6) { const s = ox * (dx < 0 ? -1 : 1); a.x -= s * fa; b.x += s * fb; } else { const s = oy * (dy < 0 ? -1 : 1); a.y -= s * fa; b.y += s * fb; }
    }
    if (!moved) break;
  }
}

// A far-off skill moves back into its own cloud; then each colliding category moves straight away
// from its area hub, 2 % at a time and at most 20 %. All other categories stay where they are.
const UNTANGLE_STEP = 0.02, UNTANGLE_MAX = 0.2, STRAY_FACTOR = 1.4;
const SKILL_CLEARANCE = typeof SKILL_CLEARANCE_OVERRIDE === "number" ? SKILL_CLEARANCE_OVERRIDE : 7;
function untangle(nodes, hubs, membersOf) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const hubOf = new Map(hubs.map((g) => [g.group, g]));
  const areaHubOf = new Map(nodes.filter((n) => n.type === "area").map((a) => [a.cluster, a]));
  const foreignHub = (s) => hubs.find((h) => h.group !== s.group && dist(s, h) < dist(s, hubOf.get(s.group)));
  const skills = nodes.filter((n) => n.type === "skill");
  // Two categories collide where a skill lies nearer to the other hub, or two of their skills come closer than SKILL_CLEARANCE.
  const pairs = () => {
    const found = new Set();
    skills.forEach((s) => { const f = foreignHub(s); if (f) found.add([s.group, f.group].sort().join("|")); });
    for (let i = 0; i < skills.length; i++) for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i], b = skills[j];
      if (a.group !== b.group && dist(a, b) < SKILL_CLEARANCE) found.add([a.group, b.group].sort().join("|"));
    }
    return found;
  };
  const strayGroups = new Set();
  // A far-off skill goes back into its own cloud, to the free direction farthest from foreign categories.
  membersOf.forEach((members, group) => {
    const g = hubOf.get(group), median = d3.median(members, (n) => dist(n, g));
    members.filter((s) => foreignHub(s) && dist(s, g) > STRAY_FACTOR * median).forEach((s) => {
      const angles = members.filter((n) => n !== s).map((n) => Math.atan2(n.y - g.y, n.x - g.x)).sort((a, b) => a - b);
      let best = null, bestScore = -Infinity;
      angles.forEach((angle, i) => {
        const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
        if (next - angle < 0.35) return;
        const mid = angle + (next - angle) / 2, x = g.x + Math.cos(mid) * median, y = g.y + Math.sin(mid) * median;
        const score = Math.min(...hubs.filter((h) => h !== g).map((h) => Math.hypot(h.x - x, h.y - y)));
        if (score > bestScore) { bestScore = score; best = mid; }
      });
      if (best === null) return;
      s.x = g.x + Math.cos(best) * median; s.y = g.y + Math.sin(best) * median;
      strayGroups.add(group);
    });
  });
  const evened = evenOut(nodes, hubs, membersOf);
  const initial = pairs(), start = new Map(hubs.map((g) => [g.group, { x: g.x, y: g.y }])), frozen = new Set();
  const place = (group, scale) => {
    const g = hubOf.get(group), area = areaHubOf.get(g.cluster), from = start.get(group);
    const dx = area.x + (from.x - area.x) * scale - g.x, dy = area.y + (from.y - area.y) * scale - g.y;
    g.x += dx; g.y += dy;
    membersOf.get(group).forEach((n) => { n.x += dx; n.y += dy; });
  };
  const changed = new Set([...evened, ...strayGroups]);
  for (let step = 1; step <= Math.round(UNTANGLE_MAX / UNTANGLE_STEP); step++) {
    const now = pairs();
    if (!now.size) break;
    const moving = new Set([...now].flatMap((pair) => pair.split("|")).filter((group) => !frozen.has(group)));
    if (!moving.size) break;
    moving.forEach((group) => { place(group, 1 + step * UNTANGLE_STEP); changed.add(group); });
    // A step that creates a collision with a category that was not involved before is taken back, and that category stops.
    const fresh = [...pairs()].filter((pair) => !initial.has(pair));
    moving.forEach((group) => {
      if (!fresh.some((pair) => pair.split("|").includes(group))) return;
      place(group, 1 + (step - 1) * UNTANGLE_STEP);
      frozen.add(group);
    });
  }
  return changed;
}

// A cloud that leaves more than LOPSIDED times its even spacing empty gets its skills spread evenly around
// the hub; each skill keeps its order around the hub and its distance from it.
const LOPSIDED = typeof LOPSIDED_OVERRIDE === "number" ? LOPSIDED_OVERRIDE : 3;
function evenOut(nodes, hubs, membersOf) {
  const turn = 2 * Math.PI, evened = new Set();
  hubs.forEach((g) => {
    const members = membersOf.get(g.group);
    if (members.length < 3) return;
    const around = members.map((n) => ({ n, angle: Math.atan2(n.y - g.y, n.x - g.x), radius: Math.hypot(n.x - g.x, n.y - g.y) }))
      .sort((a, b) => a.angle - b.angle);
    const step = turn / around.length;
    const widest = Math.max(...around.map((m, i) => (i + 1 < around.length ? around[i + 1].angle : around[0].angle + turn) - m.angle));
    if (widest <= LOPSIDED * step) return;
    // The even fan is turned so that the skills move as little as possible in total.
    const offset = Math.atan2(d3.sum(around, (m, i) => Math.sin(m.angle - i * step)), d3.sum(around, (m, i) => Math.cos(m.angle - i * step)));
    around.forEach((m, i) => {
      const angle = offset + i * step;
      m.n.x = g.x + Math.cos(angle) * m.radius; m.n.y = g.y + Math.sin(angle) * m.radius;
    });
    evened.add(g.group);
  });
  return evened;
}

// A skill that the label pass pushed far out of its cloud first looks for a free spot beside it, around its
// own hub at its old distance, the smallest turn first. Only if no spot is free does it move outward, one unit
// at a time. No other node moves.
const SIDESTEP_PUSH = 1.25, SIDESTEP_FAR = 1.3, SIDESTEP_STEP = Math.PI / 36;
function sidestep(nodes, hubs, settled) {
  const hubOf = new Map(hubs.map((g) => [g.group, g]));
  const centers = nodes.filter((n) => n.type !== "skill"), skills = nodes.filter((n) => n.type === "skill");
  const free = (s, g) => {
    const own = Math.hypot(s.x - g.x, s.y - g.y);
    if (centers.some((c) => c !== g && Math.hypot(s.x - c.x, s.y - c.y) < own)) return false;
    if (skills.some((o) => o.group !== s.group && Math.hypot(s.x - o.x, s.y - o.y) < SKILL_CLEARANCE)) return false;
    const A = labelBox(s);
    return nodes.every((o) => {
      if (o === s) return true;
      const B = labelBox(o);
      return Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) + 0.8 <= 0 || Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + 0.8 <= 0;
    });
  };
  const radius = (n) => Math.hypot(n.x - hubOf.get(n.group).x, n.y - hubOf.get(n.group).y);
  const median = new Map(hubs.map((g) => [g.group, d3.median(skills.filter((n) => n.group === g.group), radius)]));
  skills.filter((s) => radius(s) > SIDESTEP_PUSH * settled.get(s) && radius(s) > SIDESTEP_FAR * median.get(s.group)).forEach((s) => {
    const g = hubOf.get(s.group), from = settled.get(s), now = radius(s);
    const base = Math.atan2(s.y - g.y, s.x - g.x), home = { x: s.x, y: s.y };
    const siblings = skills.filter((o) => o.group === s.group && o !== s).map((o) => Math.atan2(o.y - g.y, o.x - g.x));
    const room = (angle) => Math.min(Math.PI, ...siblings.map((o) => Math.abs(((angle - o + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)));
    // On the smallest free distance, the spot farthest from its siblings wins; on a tie, the smaller turn.
    for (let r = from; r < now; r += 1) {
      let best = null;
      for (let k = 0; k * SIDESTEP_STEP <= Math.PI; k++) for (const side of k ? [1, -1] : [1]) {
        const angle = base + side * k * SIDESTEP_STEP;
        s.x = g.x + Math.cos(angle) * r; s.y = g.y + Math.sin(angle) * r;
        if (free(s, g) && (best === null || room(angle) > room(best) + 1e-9)) best = angle;
      }
      if (best !== null) { s.x = g.x + Math.cos(best) * r; s.y = g.y + Math.sin(best) * r; return; }
    }
    s.x = home.x; s.y = home.y;
  });
}

// Skills of two categories keep SKILL_CLEARANCE apart; only movable skills give way, along the line between the two.
function keepApart(nodes, movable) {
  const skills = nodes.filter((n) => n.type === "skill");
  for (let round = 0; round < 30; round++) {
    let moved = false;
    for (let i = 0; i < skills.length; i++) for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i], b = skills[j], ma = movable(a), mb = movable(b);
      if (a.group === b.group || (!ma && !mb)) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, missing = SKILL_CLEARANCE - d;
      if (missing <= 0) continue;
      moved = true;
      const share = ma && mb ? 0.5 : 1, ux = dx / d * missing * share, uy = dy / d * missing * share;
      if (ma) { a.x -= ux; a.y -= uy; }
      if (mb) { b.x += ux; b.y += uy; }
    }
    if (!moved) break;
  }
}

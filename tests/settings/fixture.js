// Test data for the settings tests: two areas, five categories and three stations.
// A1 and B1 share station P1, so they get the strongest line between categories and 64 skill pairs.
// A2 and B2 share P2 through one skill of B2, so they get a weak line. A1 and A2 share P2 inside area A,
// so the spring between them has a third of the strength of the strongest pair.
// B3 shares P1 with A1 and P2 with A1 and A2, so five lines between categories exist.
// Java in B2 has ten years at P4 until 2020 and no shared station, so it adds no line.
// "Ohne Station" in B2 has no place, so it gets no experience ring.
// In the mode Skill-Kategorie, 49 lines run from a skill to a category of the other area, and 26 more stay inside an area.
// The strongest runs from "B3 eins" to A1: two shared stations with each of the 8 skills of A1, so 16.
const COLORS = { sd: "#2c5fc4", ai: "#0a8573" };
const CLUSTERS = [
  { id: "sd", name: "Bereich A", at: [-400, 0] },
  { id: "ai", name: "Bereich B", at: [400, 0] },
];
const GROUPS = [
  ["sd-a1", "sd", "Kategorie A1"], ["sd-a2", "sd", "Kategorie A2"],
  ["ai-b1", "ai", "Kategorie B1"], ["ai-b2", "ai", "Kategorie B2"], ["ai-b3", "ai", "Kategorie B3"],
];
const WHERE = { P1: "Station 1", P2: "Station 2", P3: "Station 3", P4: "Station 4" };
const KI = -1;
const SKILLS = [
  ["Go", "sd-a1", 3, "P1 P2"], ["Rust", "sd-a1", 2, "P1 P2"], ["Kotlin", "sd-a1", 2, "P1 P2"], ["Zig", "sd-a1", 1, "P1 P2"],
  ["Ein sehr langer Skillname", "sd-a1", 1, "P1 P2"], ["Noch ein langer Skillname", "sd-a1", 1, "P1 P2"],
  ["Elm", "sd-a1", 1, "P1 P2"], ["Haskell", "sd-a1", 1, "P1 P2"],
  ["A2 eins", "sd-a2", 2, "P2"], ["A2 zwei", "sd-a2", 1, "P2"], ["A2 drei", "sd-a2", 1, "P2"], ["A2 vier", "sd-a2", 1, "P2"], ["A2 fünf", "sd-a2", 1, "P2"],
  ["B1 eins", "ai-b1", 3, "P1"], ["B1 zwei", "ai-b1", 2, "P1"], ["B1 drei", "ai-b1", 2, "P1"], ["B1 vier", "ai-b1", 1, "P1"],
  ["B1 fünf", "ai-b1", 1, "P1"], ["B1 sechs", "ai-b1", 1, "P1"], ["B1 sieben", "ai-b1", 1, "P1"], ["B1 acht", "ai-b1", 1, "P1"],
  ["B2 eins", "ai-b2", 2, "P3"], ["B2 zwei", "ai-b2", 1, "P3"], ["B2 drei", "ai-b2", 1, "P3"], ["B2 vier", "ai-b2", 1, "P3"], ["B2 fünf", "ai-b2", 1, "P2 P3"], ["Java", "ai-b2", 2, "P4"], ["Ohne Station", "ai-b2", 1, ""],
  ["B3 eins", "ai-b3", 2, "P1 P2"], ["B3 zwei", "ai-b3", 1, "P1"], ["B3 drei", "ai-b3", 1, "P2"],
];
const STANDARD = {};
const PROJECTS = {
  P1: { months: 36, name: "Station 1", when: "2020", kind: "Arbeitgeber", note: "Testdaten." },
  P2: { months: 12, name: "Station 2", when: "2021", kind: "Arbeitgeber", note: "Testdaten." },
  P3: { months: 24, name: "Station 3", when: "2022", kind: "Privates Projekt", note: "Testdaten." },
  P4: { months: 120, name: "Station 4", when: "2011 – 2020", kind: "Arbeitgeber", note: "Testdaten: zehn Jahre Java, danach nicht mehr." },
};

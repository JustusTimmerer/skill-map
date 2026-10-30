// Test data for the end-to-end tests of the map page: three areas, four categories, nine skills and three stations.
// It holds one skill of every rating, a standard skill (C#), an indirect station (Prompting at NEUi) and a skill
// without stations (CSS), so each branch of the skill panel has a case.
const COLORS = { sd: "#2c5fc4", ai: "#0a8573", data: "#a96a06" };
const CLUSTERS = [
  { id: "sd", name: "Entwicklung", at: [-300, 0] },
  { id: "ai", name: "Künstliche Intelligenz", at: [300, 0] },
  { id: "data", name: "Daten", at: [0, 260] },
];
const GROUPS = [
  ["sd-lang", "sd", "Sprachen"], ["sd-web", "sd", "Web"],
  ["ai-tools", "ai", "Werkzeuge"],
  ["data-db", "data", "Datenbanken"],
];
const WHERE = { ALT: "Altfirma GmbH", NEU: "Neufirma AG", NEUi: "Neufirma AG (indirekt)", PRIV: "Hobbyprojekt" };
const KI = -1;
const SKILLS = [
  ["C#", "sd-lang", 3, "ALT NEU"], ["Python", "sd-lang", 2, "NEU PRIV"], ["Go", "sd-lang", 1, "PRIV"],
  ["React", "sd-web", 2, "NEU"], ["CSS", "sd-web", 0, ""],
  ["Claude Code", "ai-tools", KI, "PRIV"], ["Prompting", "ai-tools", 1, "NEUi PRIV"],
  ["SQL Server", "data-db", 3, "ALT NEU"], ["SQLite", "data-db", 1, "PRIV"],
];
const STANDARD = {
  "C#": { text: "Standard seit Altfirma in allen Stationen", since: "ALT" },
};
const PROJECTS = {
  ALT: { months: 48, name: "Altfirma GmbH", when: "2015 – 2019", kind: "Arbeitgeber", note: "Erste Station der Testdaten." },
  NEU: { months: 60, name: "Neufirma AG", when: "2019 – 2024", kind: "Arbeitgeber", note: "Zweite Station der Testdaten." },
  PRIV: { months: 6, name: "Hobbyprojekt", when: "seit 2025", kind: "Privates Projekt", note: "Privates Projekt der Testdaten." },
};

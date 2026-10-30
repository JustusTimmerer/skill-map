// Finds the keys of the interface texts that the code uses, and the error codes of the server (i18n/README.md).
//
//   t("<key>") and has("<key>")         in the scripts of the product, with the key as one literal string, and
//   textIn(<language>, "<key>")         the text of a key in another language (i18n/i18n.js)
//   data-i18n="<key>"                    in the markup, and data-i18n-attr="<attribute>:<key>; …", also in the HTML that
//                                        the server makes (server/app/*.py)
//   "menu.<…>"                           the keys in SPEC of skills/forces.js, which the force menu reads
//   text(<language>, "<key>")            the texts of the server (server/app/*.py): its mails and its content
//   error.<code> and error.<code>.<…>    the texts of the error codes of the server: each ApiError(<status>, "<code>") and
//                                        bad("<code>") of server/app/*.py, with its variant as the next literal string,
//                                        ApiError(<status>, "<code>", "<variant>"). errorText of i18n/i18n.js builds these
//                                        keys at run time from the answer of the server.
//   language.name, language.locale      read by i18n/i18n.js itself
const fs = require("fs"), path = require("path");

const REPO = path.join(__dirname, "..", "..");
// The files of the product with interface texts, relative to the repository. A folder takes its files of one type.
const SOURCES = [
  "skills/page.js", "skills/forces.js", "skills/editor_template.html", "build_selfhost.js",
  "selfhost/runtime/local.js", "selfhost/runtime/server.js",
  ["selfhost/site", /\.(js|html)$/], ["server/app/static", /\.(js|html)$/], ["server/app", /\.py$/],
];
const SERVER = "server/app";
// The module that defines ApiError and bad: its calls name the code of their caller, not a code of their own.
const ERRORS_MODULE = "server/app/errors.py";
const OWN = ["language.name", "language.locale"];
const KEY = /^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)+$/;
const plain = (file) => fs.readFileSync(file, "utf8").split("\r").join("");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
// True when the match at index is the head of a definition (def or class), not a call.
const definition = (text, index) => /^\s*(?:async\s+)?(?:class|def)\b/.test(text.slice(text.lastIndexOf("\n", index) + 1, index));

function sourceFiles(repo = REPO) {
  return SOURCES.flatMap((entry) => {
    if (typeof entry === "string") return fs.existsSync(path.join(repo, entry)) ? [entry] : [];
    const [dir, pattern] = entry;
    return fs.readdirSync(path.join(repo, dir)).filter((f) => pattern.test(f)).sort().map((f) => dir + "/" + f);
  });
}
const serverFiles = (repo = REPO) => fs.readdirSync(path.join(repo, SERVER)).filter((f) => f.endsWith(".py")).sort().map((f) => SERVER + "/" + f);

// An error of the server: ApiError(<status>, "<code>"[, "<variant>"]) or bad("<code>"[, "<variant>"]).
const ERROR_CALL = /\b(?:ApiError\(\s*[^,()]+?\s*,|bad\()\s*("([a-z][a-z0-9_]*)"(?:\s*,\s*"([a-z][A-Za-z0-9]*)")?)?/g;

// The errors of the server: { keys: Map(error key -> Set(files)), codes: Map(code -> Set(files)), dynamic: [where] }.
// A key is error.<code> for a call without a variant and error.<code>.<variant> for a call with one. dynamic lists each
// call whose code is no literal string, because the check cannot know its key.
function serverErrors(repo = REPO) {
  const keys = new Map(), codes = new Map(), dynamic = [];
  const add = (map, key, file) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(file); };
  for (const file of serverFiles(repo)) {
    const text = plain(path.join(repo, file));
    for (const m of text.matchAll(ERROR_CALL)) {
      if (!m[1]) {
        if (file !== ERRORS_MODULE && !definition(text, m.index)) dynamic.push(`${file}:${lineOf(text, m.index)}: ${m[0].trim()}…`);
        continue;
      }
      add(codes, m[2], file);
      add(keys, "error." + m[2] + (m[3] ? "." + m[3] : ""), file);
    }
  }
  return { keys, codes, dynamic };
}
// The error codes of the server: Map(code -> Set(files)).
const serverCodes = (repo = REPO) => serverErrors(repo).codes;

// { used: Map(key -> Set(files)) of every literal key in the sources and of every error of the server, dynamic: the
// calls of the pages with a key that is no literal string, serverDynamic: the same for the server, whose keys and codes
// are always literal strings, so that the check knows each one }.
function usedKeys(repo = REPO) {
  const used = new Map(), dynamic = [], serverDynamic = [];
  // A key that the code writes with a placeholder, as in data-i18n="${key}", is no literal key, so the scan skips it.
  const add = (key, file) => { if (!KEY.test(key)) return; if (!used.has(key)) used.set(key, new Set()); used.get(key).add(file); };
  for (const file of sourceFiles(repo)) {
    const text = plain(path.join(repo, file));
    if (/\.py$/.test(file)) {
      for (const m of text.matchAll(/\btext\(\s*[^,()]*,\s*(?:"([^"\\]+)"|([^\s,)][^,)]{0,60}))/g)) {
        if (m[1]) add(m[1], file);
        else if (file !== ERRORS_MODULE && !definition(text, m.index)) serverDynamic.push(`${file}:${lineOf(text, m.index)}: text(…, ${m[2].trim()}`);
      }
    } else {
      for (const m of text.matchAll(/(?<![\w$])(?:t|has)\(\s*"([^"\\]+)"/g)) add(m[1], file);
      for (const m of text.matchAll(/\btextIn\(\s*[^,()]+?,\s*"([^"\\]+)"/g)) add(m[1], file);
      for (const m of text.matchAll(/(?<![\w$.])t\(\s*(?!["\s)])([^,)]{0,60})/g)) {
        if (!/\.js$/.test(file)) continue;
        dynamic.push(`${file}:${lineOf(text, m.index)}: t(${m[1].trim()}`);
      }
    }
    for (const m of text.matchAll(/data-i18n="([^"]+)"/g)) add(m[1], file);
    for (const m of text.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(/[;\s]+/).filter(Boolean)) add(pair.slice(pair.indexOf(":") + 1), file);
    }
    if (file === "skills/forces.js") for (const m of text.matchAll(/"(menu\.[A-Za-z0-9_.]+)"/g)) add(m[1], file);
  }
  const errors = serverErrors(repo);
  for (const [key, files] of errors.keys) for (const file of files) add(key, file);
  OWN.forEach((key) => add(key, "i18n/i18n.js"));
  return { used, dynamic, serverDynamic: [...serverDynamic, ...errors.dynamic.map((where) => where + " (an error whose code is no literal string)")] };
}

// True when a key of the catalogs is the text of an error code of the server: error.<code> or error.<code>.<variant>.
const errorKeyOf = (key, codes) => {
  const m = key.match(/^error\.([a-z][a-z0-9_]*)(\.[a-z][A-Za-z0-9]*)?$/);
  return !!m && codes.has(m[1]);
};

module.exports = { REPO, sourceFiles, serverFiles, serverErrors, serverCodes, usedKeys, errorKeyOf };

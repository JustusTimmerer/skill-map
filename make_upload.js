// Makes the folder for an FTP upload of the demo: the site with the fictional demo map, your legal details and the
// links of llms.txt, plus the .htaccess for Apache. It deletes the files that an older build left in the folder.
// Usage: node make_upload.js <folder> [--legal legal.json] [--site https://www.it-skills.net] [--example map.json]
// Defaults: the demo map of selfhost/site/demo.it-skills-map.json, no legal file (the pages keep their placeholders),
// and relative links in llms.txt.
const fs = require("fs"), path = require("path");

const args = process.argv.slice(2);
const folder = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
const option = (name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : undefined; };
if (!folder) { console.error("Usage: node make_upload.js <folder> [--legal legal.json] [--site https://example.org] [--example map.json]"); process.exit(1); }

const site = path.join(__dirname, "selfhost", "site");
process.env.SKILLMAP_EXAMPLE = path.resolve(option("example") || path.join(site, "demo.it-skills-map.json"));
if (option("legal")) process.env.SKILLMAP_LEGAL = path.resolve(option("legal"));
if (option("site")) process.env.SKILLMAP_SITE_URL = option("site");

const { build } = require("./build_selfhost.js");
build(folder);
fs.copyFileSync(path.join(site, "apache.htaccess"), path.join(folder, ".htaccess"));
console.log("wrote " + path.join(folder, ".htaccess"));

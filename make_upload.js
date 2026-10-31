// Makes the folder for an FTP upload of the demo: the site with the fictional demo map, your legal details and the
// links of llms.txt, plus the .htaccess for Apache. It deletes the files that an older build left in the folder.
// Usage: node make_upload.js <folder> [--legal legal.json] [--site https://it-skills.net] [--example map.json]
// Defaults: the demo map of selfhost/site/demo.it-skills-map.json, no legal file (the pages keep their placeholders),
// and relative links in llms.txt. With --site, the folder also has robots.txt and sitemap.xml, and its .htaccess
// redirects every other address of the site to the one of --site.
const fs = require("fs"), path = require("path");

const args = process.argv.slice(2);
const folder = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
const option = (name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : undefined; };
if (!folder) { console.error("Usage: node make_upload.js <folder> [--legal legal.json] [--site https://example.org] [--example map.json]"); process.exit(1); }
const siteAddress = option("site");
if (siteAddress && !/^https:\/\/[^/]+\/?$/.test(siteAddress)) { console.error("--site takes an https address without a path, for example https://example.org"); process.exit(1); }

const site = path.join(__dirname, "selfhost", "site");
process.env.SKILLMAP_EXAMPLE = path.resolve(option("example") || path.join(site, "demo.it-skills-map.json"));
if (option("legal")) process.env.SKILLMAP_LEGAL = path.resolve(option("legal"));
if (siteAddress) process.env.SKILLMAP_SITE_URL = siteAddress;

// A browser keeps the maps of a visitor per scheme and host, so every other address of the site would show other maps.
// A request counts as plain HTTP only when all three signs agree, so that a proxy of the host cannot cause a redirect
// loop. The folder .well-known stays reachable for the certificate of the host.
function redirectLines(address) {
  const { host, origin } = new URL(address);
  return `
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^\\.well-known/ - [L]
  RewriteCond %{HTTP_HOST} !=${host} [NC]
  RewriteRule ^ ${origin}%{REQUEST_URI} [R=301,L]
  RewriteCond %{HTTPS} !=on
  RewriteCond %{SERVER_PORT} !=443
  RewriteCond %{HTTP:X-Forwarded-Proto} !=https
  RewriteRule ^ ${origin}%{REQUEST_URI} [R=301,L]
</IfModule>
`;
}

const { build } = require("./build_selfhost.js");
build(folder);
const lines = fs.readFileSync(path.join(site, "apache.htaccess"), "utf8").replace(/\r/g, "");
fs.writeFileSync(path.join(folder, ".htaccess"), lines + (siteAddress ? redirectLines(siteAddress) : ""));
console.log("wrote " + path.join(folder, ".htaccess"));

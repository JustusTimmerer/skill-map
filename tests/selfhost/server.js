// A small static web server for the tests and for a local look at the self-hosted site. It serves one folder on
// 127.0.0.1 with the content types of selfhost/DEPLOY.md, and nothing outside that folder.
// Usage: node tests/selfhost/server.js [folder] [port]    (default: dist/selfhost on port 8080)
const http = require("http"), fs = require("fs"), path = require("path");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
};

// Starts the server; port 0 takes a free port. Gives { url, origin, port, close, unref }. After unref the server does not
// keep the process alive. handle(req, res) answers a request before the folder does, when it gives true (a test stand-in
// for the API of the server, tests/selfhost/fake-api.js).
function serve(root, port = 0, handle = null) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    if (handle && handle(req, res)) return;
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname); } catch (error) { res.writeHead(400).end(); return; }
    let file = path.join(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Nicht gefunden"); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": /\.html$/.test(file) ? "no-cache" : "max-age=3600", "X-Content-Type-Options": "nosniff" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = server.address(), origin = `http://127.0.0.1:${actual}`;
      resolve({ url: origin + "/", origin, port: actual, close: () => new Promise((done) => server.close(done)), unref: () => server.unref() });
    });
  });
}

if (require.main === module) {
  const root = process.argv[2] || path.join(__dirname, "..", "..", "dist", "selfhost");
  serve(root, Number(process.argv[3] || 8080)).then((s) => console.log(`serving ${path.resolve(root)} at ${s.url} (Ctrl+C stops)`));
}

module.exports = { serve };

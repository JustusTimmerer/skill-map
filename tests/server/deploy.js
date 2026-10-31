// Host-side tests of the deploy (server/README.md, "Deploy"). They run Docker on this computer:
//
//   compose    the configuration of compose.yaml and compose.ipv6.yaml (no container): the rights of each container, the
//              ports of HTTP/3, the start order and the password of the app
//   stack      a fresh stack: the rights in the running containers, the password that db-setup makes for the app, HTTP/3,
//              the option WWW_REDIRECT of the proxy, the files of the site during a new build, and the files of the
//              site while the app fails
//   backup     server/backup.sh on that stack, its loud failures, and the steps of "Restore" in server/README.md, run
//              as they stand into a new project: the map comes back, and the proxy starts only with its old data
//   upgrade    a stack of the version before these rights (commit 626ac3b) with data, then the stack of this checkout on
//              its volumes: the proxy takes over the files of root, and the app gets a password of its own
//   snippets   the web server lines of selfhost/DEPLOY.md in real nginx and Apache containers
//
// Each part uses its own project names and ports, and it removes its containers at the end. The volumes of the test
// projects stay: docker compose down runs without -v. The run needs the built site (node build_selfhost.js), Docker with
// Compose, sh and git. It reads server/.env through Compose, as the stack does, and it never prints a secret.
// Usage: node tests/server/deploy.js [part ...]        E2E_VERBOSE=1 prints every check.
//   DEPLOY_HTTP_PORT, DEPLOY_HTTPS_PORT, DEPLOY_MAILPIT_PORT: the ports of the test stacks (default 49180, 49543, 49125).
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), https = require("https"), crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const repo = path.join(__dirname, "..", "..");
const SITE = path.join(repo, "dist", "selfhost");
const OUT = path.join(__dirname, "out", "deploy");
const VERBOSE = !!process.env.E2E_VERBOSE;
const COMPOSE = path.join(repo, "server", "compose.yaml"), IPV6 = path.join(repo, "server", "compose.ipv6.yaml");
const README = path.join(repo, "server", "README.md"), DEPLOY = path.join(repo, "selfhost", "DEPLOY.md");
const NGINX = "nginx:1.29.3-alpine@sha256:b3c656d55d7ad751196f21b7fd2e8d4da9cb430e32f646adcf92441b72f82b14";
const HTTPD = "httpd:2.4.65-alpine@sha256:07b2fabb7029a0b8aeb2e0fd02651c28fe22c21c5b5a59d6ff5b022791fcd89e";
const BEFORE = "626ac3b";  // the release branch before the rights of the containers
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; "
  + "connect-src 'self'; frame-src 'self'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

const PORTS = { http: process.env.DEPLOY_HTTP_PORT || "49180", https: process.env.DEPLOY_HTTPS_PORT || "49543", mailpit: process.env.DEPLOY_MAILPIT_PORT || "49125" };
const SITE_HOST = "it-skills.localhost", BASE = `https://${SITE_HOST}:${PORTS.https}`;
const RUN = String(Date.now()).slice(-7);
const PROJECT = `skillmap-deploy-${RUN}`, RESTORED = `skillmap-deploy-${RUN}-restore`, UPGRADED = `skillmap-deploy-${RUN}-upgrade`;
// The stack of this test: its own ports and network, and no POSTGRES_APP_PASSWORD, so that db-setup makes one. The values
// of the shell win over server/.env.
const STACK_ENV = {
  ...process.env, HTTP_PORT: PORTS.http, HTTPS_PORT: PORTS.https, MAILPIT_PORT: PORTS.mailpit, NETWORK_SUBNET: "10.213.99.0/24",
  PROXY_IP: "10.213.99.10", BASE_URL: BASE, POSTGRES_APP_PASSWORD: "", COMPOSE_PROFILES: "local",
  // Git Bash turns an argument such as /data into a Windows path before it reaches docker.exe. Linux has no such step.
  MSYS2_ARG_CONV_EXCL: "/data",
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const short = (text, n = 300) => { const t = String(text).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, { env = STACK_ENV, input, cwd = repo, timeout = 600000 } = {}) {
  const r = spawnSync(command, args, { env, input, cwd, timeout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? String(r.error) : "") };
}
const compose = (project, args, options = {}) => run("docker", ["compose", "-p", project, "-f", options.file || COMPOSE, ...(options.files || []), ...args], options);
// A shell line of a document, run with sh in the root of the repository.
const shell = (line, options = {}) => run("sh", ["-c", line], options);
// The output of the containers of a project, before it stops: the evidence of a failed check.
const keepLogs = (project, options = {}) => log(path.join(OUT, "logs"), project + ".log", compose(project, ["logs", "--no-color", "--timestamps"], options));
const log = (dir, name, r) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), `exit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`); return r; };

// A request to a stack or a web server on 127.0.0.1, with the host name in SNI and in the Host header.
function request(url, { method = "GET", headers = {} } = {}) {
  const u = new URL(url), secure = u.protocol === "https:";
  return new Promise((resolve, reject) => {
    const r = (secure ? https : http).request({ host: "127.0.0.1", port: u.port || (secure ? 443 : 80), method, path: u.pathname + u.search,
      servername: secure ? u.hostname : undefined, rejectUnauthorized: false, headers: { Host: u.host, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => { const body = Buffer.concat(chunks); resolve({ status: response.statusCode, headers: response.headers, body, text: body.toString("utf8") }); });
    });
    r.on("error", reject);
    r.setTimeout(15000, () => r.destroy(new Error("no answer within 15 s: " + url)));
    r.end();
  });
}
const answer = (url, options) => request(url, options).catch((error) => ({ status: 0, headers: {}, text: "", error: error.message }));
async function until(what, fn, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms / 1000} s`);
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
const tests = [];
const test = (part, name, fn) => tests.push({ part, name, fn });
class NotRun extends Error {}

// The configuration as Compose resolves it. It holds the secrets of server/.env, so the run keeps it in memory only.
function config(files = [], env = STACK_ENV) {
  const r = run("docker", ["compose", "-f", COMPOSE, ...files.flatMap((f) => ["-f", f]), "--profile", "local", "--profile", "test", "config", "--format", "json"], { env });
  if (r.status !== 0) throw new Error("docker compose config: " + short(r.stderr));
  return JSON.parse(r.stdout);
}
// The capabilities that a service adds, and why. Every other service adds none.
const CAPS = { "db-setup": ["CHOWN"], "proxy-setup": ["CHOWN", "DAC_READ_SEARCH"], proxy: ["NET_BIND_SERVICE"], tests: ["DAC_READ_SEARCH"] };
// The user of each service: a user of the image, or a number. Only the one-shot jobs and the tests run as root.
const USERS = { db: "postgres", "db-setup": "0:0", app: undefined, "proxy-setup": "0:0", proxy: "10002:10002", mailpit: "65534:65534", tests: undefined };

test("compose", "every service of compose.yaml has no-new-privileges, drops every capability, adds only its own, and has a read-only root file system", async ({ check }) => {
  const c = config();
  check(same(Object.keys(c.services).sort(), Object.keys(USERS).sort()), "the services: " + Object.keys(c.services).sort().join(", "));
  for (const [name, s] of Object.entries(c.services)) {
    check((s.security_opt || []).includes("no-new-privileges:true"), `${name}: security_opt no-new-privileges:true`);
    check(same(s.cap_drop, ["ALL"]), `${name}: cap_drop ALL`);
    check(same((s.cap_add || []).slice().sort(), (CAPS[name] || []).slice().sort()), `${name}: cap_add ${(s.cap_add || []).join(", ") || "none"}`);
    check(s.read_only === true, `${name}: read_only`);
    check(s.user === USERS[name], `${name}: user ${s.user || "of the image"}`);
  }
  const sysctls = c.services.proxy.sysctls || {};
  check(Object.keys(sysctls).length === 1 && String(sysctls["net.ipv4.ip_unprivileged_port_start"]) === "0", "proxy: every user of the container can bind 80 and 443: " + JSON.stringify(sysctls));
});

test("compose", "the proxy publishes HTTPS on TCP and on UDP at the port on which Caddy listens, also with compose.ipv6.yaml", async ({ check }) => {
  for (const [label, files] of [["compose.yaml", []], ["with compose.ipv6.yaml", [IPV6]]]) {
    const proxy = config(files).services.proxy;
    const ports = proxy.ports.map((p) => `${p.host_ip}:${p.published}:${p.target}/${p.protocol}`).sort();
    const want = [`127.0.0.1:${PORTS.http}:${PORTS.http}/tcp`, `127.0.0.1:${PORTS.https}:${PORTS.https}/tcp`, `127.0.0.1:${PORTS.https}:${PORTS.https}/udp`];
    if (files.length) want.push(`:::${PORTS.http}:${PORTS.http}/tcp`, `:::${PORTS.https}:${PORTS.https}/tcp`, `:::${PORTS.https}:${PORTS.https}/udp`);
    check(same(ports, want.sort()), `${label}: ${ports.join(", ")}`);
    check(proxy.environment.HTTP_PORT === PORTS.http && proxy.environment.HTTPS_PORT === PORTS.https, `${label}: Caddy gets the ports of the host as HTTP_PORT and HTTPS_PORT`);
  }
  const caddyfile = fs.readFileSync(path.join(repo, "server", "proxy", "Caddyfile"), "utf8");
  check(/^\thttp_port \{\$HTTP_PORT:80\}$/m.test(caddyfile) && /^\thttps_port \{\$HTTPS_PORT:443\}$/m.test(caddyfile), "the Caddyfile listens on HTTP_PORT and HTTPS_PORT");
});

test("compose", "the proxy starts without a healthy app, the tests wait for one, and the app gets only its own password file", async ({ check }) => {
  const c = config();
  const deps = c.services.proxy.depends_on;
  check(deps.app && deps.app.condition === "service_started" && deps.app.required === false, "proxy: depends on app only with service_started and required false: " + JSON.stringify(deps.app));
  check(deps["proxy-setup"] && deps["proxy-setup"].condition === "service_completed_successfully", "proxy: starts after proxy-setup");
  check(c.services.tests.depends_on.app && c.services.tests.depends_on.app.condition === "service_healthy", "tests: wait for a healthy app");
  const app = c.services.app.environment;
  check(!("PGPASSWORD" in app) && app.PGPASSFILE === "/run/app-db/pgpass", "app: no PGPASSWORD, and PGPASSFILE /run/app-db/pgpass");
  check(c.services.app.volumes.some((v) => v.source === "db_app_password" && v.target === "/run/app-db" && v.read_only), "app: the volume db_app_password, read-only");
  check(c.services["db-setup"].environment.POSTGRES_APP_PASSWORD === "", "db-setup: an empty POSTGRES_APP_PASSWORD stays empty and takes no fallback");
});

// ---------------------------------------------------------------------------------------------------------------------
// The stack of the parts stack and backup: started once.
let stackUp = null;
const dc = (args, options = {}) => compose(PROJECT, args, options);
async function stack() {
  if (stackUp) return stackUp;
  stackUp = (async () => {
    if (!fs.existsSync(path.join(SITE, "map.html"))) throw new NotRun("dist/selfhost is missing: run node build_selfhost.js first");
    const r = log(OUT, "stack-up.log", dc(["up", "-d", "--build", "--wait"]));
    if (r.status !== 0) throw new NotRun("the stack did not start: " + short(r.stderr, 600));
    await until("the app through the proxy", async () => (await answer(BASE + "/api/health")).status === 200);
    return true;
  })();
  return stackUp;
}
const execIn = (service, line, options = {}) => dc(["exec", "-T", ...(options.envNames || []).flatMap((n) => ["-e", n]), service, "sh", "-c", line], options);
const containerOf = (project, service) => run("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`,
  "--filter", "label=com.docker.compose.oneoff=False"]).stdout.trim().split(/\s+/).filter(Boolean);
const inspect = (id) => JSON.parse(run("docker", ["inspect", id]).stdout)[0];

test("stack", "the stack starts, and each container runs with the rights of compose.yaml", async ({ check }) => {
  await stack();
  const RUNNING = { db: "70", app: "10001", proxy: "10002", mailpit: "65534" };
  for (const service of ["db", "db-setup", "app", "proxy-setup", "proxy", "mailpit"]) {
    const [id] = containerOf(PROJECT, service);
    if (!id) { check(false, `${service}: no container`); continue; }
    const i = inspect(id), h = i.HostConfig, added = (h.CapAdd || []).map((c) => c.replace(/^CAP_/, "")).sort();
    check(h.ReadonlyRootfs === true && same(h.CapDrop, ["ALL"]) && same(added, (CAPS[service] || []).slice().sort())
      && (h.SecurityOpt || []).includes("no-new-privileges:true"), `${service}: Docker has read-only, cap_drop ALL, cap_add ${added.join(", ") || "none"} and no-new-privileges`);
    if (service.endsWith("-setup")) { check(i.State.Status === "exited" && i.State.ExitCode === 0, `${service}: ended with exit code ${i.State.ExitCode}`); continue; }
    check(i.State.Running, `${service}: runs`);
    // The image of mailpit has no shell. A helper container in its process namespace reads the status of its process.
    const status = service === "mailpit"
      ? run("docker", ["run", "--rm", "--pid", `container:${id}`, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        config().services.proxy.image, "cat", "/proc/1/status"]).stdout
      : execIn(service, "cat /proc/1/status").stdout;
    const field = (name) => (status.match(new RegExp("^" + name + ":\\s*(\\S+)", "m")) || [])[1];
    check(field("Uid") === RUNNING[service], `${service}: the main process runs as ${field("Uid")}`);
    // The proxy keeps NET_BIND_SERVICE (bit 10), the file capability of the Caddy binary. Every other process has none.
    const caps = service === "proxy" ? "0000000000000400" : "0000000000000000";
    check(field("CapEff") === caps && field("CapPrm") === caps && field("CapBnd") === caps, `${service}: the main process has the capabilities ${caps}: CapEff ${field("CapEff")}, CapBnd ${field("CapBnd")}`);
    check(field("NoNewPrivs") === "1", `${service}: NoNewPrivs ${field("NoNewPrivs")}`);
    if (service === "mailpit") continue;
    const write = execIn(service, "touch /deploy-test-probe");
    check(write.status !== 0 && /read-only/i.test(write.stderr), `${service}: the root file system is read-only: ${short(write.stderr, 120)}`);
  }
  const map = await answer(BASE + "/map.html"), health = await answer(BASE + "/api/health");
  check(map.status === 200 && health.status === 200, `the site and the app answer through the proxy: ${map.status}, ${health.status}`);
});

test("stack", "without POSTGRES_APP_PASSWORD, db-setup makes a password of its own for the app, which only the app can read", async ({ check }) => {
  await stack();
  const appHash = execIn("app", "cut -d: -f5- /run/app-db/pgpass | tr -d '\\n' | sha256sum").stdout.split(" ")[0];
  const adminHash = execIn("db", 'printf %s "$POSTGRES_PASSWORD" | sha256sum').stdout.split(" ")[0];
  check(/^[0-9a-f]{64}$/.test(appHash) && /^[0-9a-f]{64}$/.test(adminHash) && appHash !== adminHash, "the password of the app differs from the password of the admin role (compared by SHA-256)");
  check(execIn("app", "printenv PGPASSWORD").status !== 0, "the app has no PGPASSWORD in its environment");
  const files = execIn("app", "stat -c '%n %u %a' /run/app-db/pgpass /run/app-db/password").stdout.trim().split("\n");
  check(same(files, ["/run/app-db/pgpass 10001 600", "/run/app-db/password 0 600"]), "the password file of the app belongs to the app, and the kept password to root: " + files.join(", "));
  check(execIn("app", "cat /run/app-db/password").status !== 0, "the app cannot read the file that db-setup keeps");
  check(/made a new password for the role of the app/.test(dc(["logs", "db-setup"]).stdout), "db-setup says that it made a new password");
  // The next run of db-setup keeps the password.
  const again = dc(["run", "--rm", "db-setup"]);
  const after = execIn("app", "cut -d: -f5- /run/app-db/pgpass | tr -d '\\n' | sha256sum").stdout.split(" ")[0];
  check(again.status === 0 && after === appHash && !/made a new password/.test(again.stdout), "a second run of db-setup keeps the password");
});

test("stack", "a set POSTGRES_APP_PASSWORD wins, and the password of the admin role there stops db-setup", async ({ check }) => {
  await stack();
  const user = config().services.app.environment.PGUSER, database = config().services.app.environment.PGDATABASE;
  const chosen = "chosen:pass\\word-" + crypto.randomBytes(9).toString("hex");
  const set = dc(["run", "--rm", "-e", "POSTGRES_APP_PASSWORD", "db-setup"], { env: { ...STACK_ENV, POSTGRES_APP_PASSWORD: chosen } });
  check(set.status === 0, "db-setup with a set password ends with 0: " + short(set.stderr, 200));
  const login = dc(["exec", "-T", "-e", "PGPASSWORD", "db", "psql", "-h", "127.0.0.1", "-U", user, "-d", database, "-tAc", "SELECT current_user"], { env: { ...STACK_ENV, PGPASSWORD: chosen } });
  check(login.status === 0 && login.stdout.trim() === user, `the role ${user} takes the set password, also with a colon and a backslash in it`);
  check(execIn("app", "cut -d: -f5- /run/app-db/pgpass").stdout.trim() === chosen.replace(/[\\:]/g, "\\$&"), "the password file of the app holds the set password with the escapes of libpq");
  check((await answer(BASE + "/api/health")).status === 200 && (await answer(BASE + "/nobody-here")).status === 404, "the app keeps working with the new password file");
  const admin = execIn("db", 'printf %s "$POSTGRES_PASSWORD"').stdout;
  const equal = dc(["run", "--rm", "-e", "POSTGRES_APP_PASSWORD", "db-setup"], { env: { ...STACK_ENV, POSTGRES_APP_PASSWORD: admin } });
  check(equal.status !== 0 && /POSTGRES_APP_PASSWORD is the password of the admin role/.test(equal.stdout + equal.stderr), "the password of the admin role stops db-setup with a message");
  const back = dc(["run", "--rm", "db-setup"]);
  check(back.status === 0, "without the variable, db-setup takes its kept password again");
});

test("stack", "HTTP/3: Caddy announces the UDP port that the host publishes, and it listens on that port", async ({ check }) => {
  await stack();
  const a = await answer(BASE + "/map.html");
  const announced = ((a.headers["alt-svc"] || "").match(/h3=":(\d+)"/) || [])[1];
  check(announced === PORTS.https, `Alt-Svc ${a.headers["alt-svc"]}: HTTP/3 on port ${announced}`);
  const published = dc(["port", "--protocol", "udp", "proxy", PORTS.https]).stdout.trim();
  check(published === `127.0.0.1:${PORTS.https}`, `the host publishes UDP ${published}`);
  const listening = execIn("proxy", "netstat -uln").stdout;
  check(new RegExp(`:${PORTS.https}\\s`).test(listening), "Caddy listens on UDP " + PORTS.https);
  // Caddy leaves its own HTTPS port out of this address, so a stack on other ports than 80 and 443 needs the port in it.
  const redirect = await answer(`http://${SITE_HOST}:${PORTS.http}/map.html`);
  check(redirect.status === 308 && (redirect.headers.location || "").startsWith(`https://${SITE_HOST}`), `Caddy listens on HTTP_PORT and sends HTTP to HTTPS: ${redirect.status} ${redirect.headers.location}`);
});

// The routes of an adapted Caddyfile that match a host name.
const hostsOf = (json) => JSON.stringify(json).match(/"host":\[[^\]]*\]/g) || [];
function adapt(env) {
  const r = dc(["exec", "-T", ...Object.keys(env).flatMap((k) => ["-e", `${k}=${env[k]}`]), "proxy", "caddy", "adapt", "--config", "/etc/caddy/Caddyfile"]);
  return { status: r.status, json: r.status === 0 ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}
test("stack", "the Caddyfile adapts with WWW_REDIRECT on and off, and only on sends www to the main domain with 308", async ({ check }) => {
  await stack();
  const www = `www.${SITE_HOST}`;
  const on = adapt({ USER_SITES: "none.caddy", WWW_REDIRECT: "on" }), off = adapt({ USER_SITES: "none.caddy", WWW_REDIRECT: "off" });
  const users = adapt({ USER_SITES: "users.caddy", WWW_REDIRECT: "off" }), wrong = adapt({ USER_SITES: "none.caddy", WWW_REDIRECT: "yes" });
  check(on.status === 0 && off.status === 0 && users.status === 0, "the Caddyfile adapts with on, with off and with the subdomains: " + short(on.stderr + off.stderr + users.stderr, 300));
  const redirect = on.json && JSON.stringify(on.json).includes(`"Location":["${BASE}{http.request.uri}"]`) && /"status_code":"?308"?/.test(JSON.stringify(on.json));
  check(on.json && hostsOf(on.json).some((h) => h.includes(`"${www}"`)) && redirect, `on: a route for ${www} that answers 308 with Location ${BASE}{uri}`);
  check(off.json && !hostsOf(off.json).some((h) => h.includes(`"${www}"`)), `off: no route for ${www}: ` + hostsOf(off.json || {}).join(" "));
  check(users.json && hostsOf(users.json).some((h) => h.includes(`"*.${SITE_HOST}"`)) && !hostsOf(users.json).some((h) => h.includes(`"${www}"`)), "with the subdomains: the wildcard, and no route of its own for www");
  check(wrong.status !== 0, "another value than on or off stops Caddy: " + short(wrong.stderr, 160));
  // The running proxy with the option on, then off, then as before.
  const proxyWith = async (env) => {
    const r = dc(["up", "-d", "--no-deps", "--force-recreate", "proxy"], { env: { ...STACK_ENV, ...env } });
    await until("the proxy after its new start", async () => (await answer(BASE + "/map.html")).status === 200, 60000);
    return r.status;
  };
  try {
    check((await proxyWith({ USER_SITES: "none.caddy", WWW_REDIRECT: "on" })) === 0, "the proxy starts with USER_SITES=none.caddy and WWW_REDIRECT=on");
    const moved = await until(`an answer of ${www}`, async () => { const a = await answer(`https://${www}:${PORTS.https}/example.html?x=1&y=%C3%A4`); return a.status ? a : null; }, 30000).catch(() => ({ status: 0, headers: {} }));
    check(moved.status === 308 && moved.headers.location === `${BASE}/example.html?x=1&y=%C3%A4`, `on: ${www} answers ${moved.status} ${moved.headers.location || ""}`);
    check((await proxyWith({ USER_SITES: "none.caddy", WWW_REDIRECT: "off" })) === 0, "the proxy starts with WWW_REDIRECT=off");
    const none = await answer(`https://${www}:${PORTS.https}/example.html`);
    check(none.status === 0 || none.status >= 400, `off: ${www} serves no page: ${none.status || short(none.error, 100)}`);
  } finally {
    check((await proxyWith({})) === 0, "the proxy starts again with the values of server/.env");
  }
});

test("stack", "a new build of the site keeps every file at its address: no 404 and no error during the build", async ({ check }) => {
  await stack();
  const page = fs.readFileSync(path.join(SITE, "map.html"), "utf8");
  const versioned = [...new Set([...page.matchAll(/(?:src|href)="((?:assets|vendor)\/[^"?]+\?v=[0-9a-f]+)"/g)].map((m) => m[1]))];
  const addresses = ["/map.html", "/example.html", "/server-map.html", ...versioned.slice(0, 4).map((a) => "/" + a)];
  const sizes = Object.fromEntries(addresses.map((a) => [a, fs.statSync(path.join(SITE, a.slice(1).split("?")[0])).size]));
  const child = spawn(process.execPath, [path.join(repo, "build_selfhost.js")], { cwd: repo, stdio: "ignore" });
  let exited = null;
  child.on("exit", (code) => { exited = code; });
  let count = 0;
  const problems = new Set();
  while (exited === null) {
    await Promise.all(addresses.map(async (a) => {
      const r = await answer(BASE + a);
      count++;
      if (r.status !== 200 || r.body.length !== sizes[a]) problems.add(`${a}: ${r.status} ${r.headers["cache-control"] || ""} ${r.body ? r.body.length : 0} bytes`);
    }));
  }
  check(exited === 0, "the build ends with exit code 0");
  check(count >= addresses.length * 3 && problems.size === 0, `${count} requests to ${addresses.length} addresses during the build: each answered 200 with the whole file` + (problems.size ? ": " + [...problems].slice(0, 6).join(", ") : ""));
  const missing = await answer(BASE + "/vendor/no-such-file.js?v=0123456789ab");
  check(missing.status === 404 && missing.headers["cache-control"] === "no-store", `a missing file with a version: ${missing.status} ${missing.headers["cache-control"]}`);
});

test("stack", "the files of the site work while the app fails at its start, and the routes of the app answer 502 without a cache", async ({ check }) => {
  await stack();
  const override = path.join(OUT, "app-fails.yaml");
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(override, 'services:\n  app:\n    command: ["python", "-c", "raise SystemExit(\'deploy test: a migration fails\')"]\n');
  try {
    check(dc(["stop", "proxy"]).status === 0, "the proxy stops");
    const up = log(OUT, "app-fails-up.log", dc(["up", "-d"], { files: ["-f", override] }));
    const proxy = inspect(containerOf(PROJECT, "proxy")[0]);
    check(proxy.State.Running, `the proxy starts although the app fails (up ended with ${up.status})`);
    await sleep(3000);
    const files = await Promise.all(["/map.html", "/example.html", "/assets/site.css"].map(async (p) => `${p} ${(await answer(BASE + p)).status}`));
    check(files.every((f) => f.endsWith(" 200")), "stage a works: " + files.join(", "));
    const api = await answer(BASE + "/api/health"), start = await answer(BASE + "/");
    check(api.status === 502 && start.status === 502, `the routes of the app answer 502: /api/health ${api.status}, / ${start.status}`);
    check(api.headers["cache-control"] === "no-store", "a 502 has Cache-Control " + api.headers["cache-control"]);
    const wait = log(OUT, "app-fails-wait.log", dc(["up", "-d", "--wait", "--wait-timeout", "60"], { files: ["-f", override], timeout: 180000 }));
    check(wait.status !== 0, `up --wait ends with an error when the app does not become healthy: exit ${wait.status}`);
  } finally {
    const back = dc(["up", "-d", "--wait"]);
    check(back.status === 0 && (await until("the app again", async () => (await answer(BASE + "/api/health")).status === 200, 60000).catch(() => false)),
      "the stack works again without the failure");
  }
});

// ---------------------------------------------------------------------------------------------------------------------
const BACKUP = path.join(OUT, "backup");
const shPath = (p) => p.split(path.sep).join("/");
const SAMPLE = { handle: "restore-anna", slug: "restored-map", title: "Restored map", skill: "Restore check" };
const SAMPLE_SQL = `
INSERT INTO owners (kind, handle) VALUES ('user', '${SAMPLE.handle}');
INSERT INTO users (id, email, password_hash, confirmed_at)
  SELECT id, '${SAMPLE.handle}@example.org', 'not-a-real-hash', now() FROM owners WHERE handle = '${SAMPLE.handle}';
INSERT INTO maps (owner_id, created_by, title, slug, visibility)
  SELECT id, id, '${SAMPLE.title}', '${SAMPLE.slug}', 'public' FROM owners WHERE handle = '${SAMPLE.handle}';
INSERT INTO documents (map_id, collection, doc_id, data, size_bytes, version)
  SELECT id, 'skills', 'restore-check', '{"name": "${SAMPLE.skill}", "group": "g1", "rating": 2, "places": [], "order": 0}', 80, 1
    FROM maps WHERE slug = '${SAMPLE.slug}';
`;
const adminSql = (project, sqlText) => compose(project, ["exec", "-T", "db", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -X -q'], { input: sqlText });
async function sampleOf(base = BASE) {
  const page = await answer(`${base}/${SAMPLE.handle}/${SAMPLE.slug}`);
  const docs = await answer(`${base}/api/public/${SAMPLE.handle}/${SAMPLE.slug}/docs`);
  let names = [];
  try { names = JSON.parse(docs.text).docs.map((d) => d.data && d.data.name); } catch (error) { names = ["no JSON: " + short(docs.text, 80)]; }
  return { page: page.status, names };
}
const caOf = (project) => compose(project, ["exec", "-T", "proxy", "sha256sum", "/data/caddy/pki/authorities/local/root.crt"]).stdout.split(" ")[0];
let backupFiles = null, caBefore = null;

test("backup", "backup.sh writes the database, server/.env and the data of the proxy of the running stack", async ({ check }) => {
  await stack();
  const insert = adminSql(PROJECT, SAMPLE_SQL);
  check(insert.status === 0, "the test map goes into the database: " + short(insert.stderr, 200));
  const before = await sampleOf();
  check(before.page === 200 && same(before.names, [SAMPLE.skill]), `the map is public before the backup: ${before.page} ${before.names.join(", ")}`);
  caBefore = caOf(PROJECT);
  fs.rmSync(BACKUP, { recursive: true, force: true });
  const r = log(OUT, "backup.log", shell(`sh server/backup.sh "${shPath(BACKUP)}"`, { env: { ...STACK_ENV, COMPOSE_PROJECT_NAME: PROJECT } }));
  check(r.status === 0 && /^backup \S+ in /m.test(r.stdout), "backup.sh ends with 0 and names the backup: " + short(r.stdout + r.stderr, 200));
  const names = fs.existsSync(BACKUP) ? fs.readdirSync(BACKUP).sort() : [];
  const find = (re) => names.find((n) => re.test(n));
  backupFiles = { dump: find(/^db-.*\.dump$/), env: find(/^env-/), caddy: find(/^caddy_data-.*\.tgz$/) };
  check(names.length === 3 && backupFiles.dump && backupFiles.env && backupFiles.caddy, "three files: " + names.join(", "));
  const read = (name) => name ? fs.readFileSync(path.join(BACKUP, name)) : Buffer.alloc(0);
  check(read(backupFiles.dump).subarray(0, 5).toString() === "PGDMP", "the dump has the custom format of pg_dump");
  check(read(backupFiles.env).equals(fs.readFileSync(path.join(repo, "server", ".env"))), "env-<time> is server/.env byte for byte");
  check(read(backupFiles.caddy).subarray(0, 2).toString("hex") === "1f8b" && read(backupFiles.caddy).length > 1000, "caddy_data-<time>.tgz is a gzip archive");
});

test("backup", "backup.sh fails loudly when it cannot write its folder or when the stack does not run", async ({ check }) => {
  await stack();
  const file = path.join(OUT, "a-file");
  fs.writeFileSync(file, "not a folder");
  const blocked = shell(`sh server/backup.sh "${shPath(file)}/backups"`, { env: { ...STACK_ENV, COMPOSE_PROJECT_NAME: PROJECT } });
  check(blocked.status === 1 && /^backup\.sh: FAILED: cannot create the folder /m.test(blocked.stderr), "a folder that it cannot create: exit 1 and " + short(blocked.stderr, 160));
  const empty = path.join(OUT, "backup-no-stack");
  fs.rmSync(empty, { recursive: true, force: true });
  const noStack = shell(`sh server/backup.sh "${shPath(empty)}"`, { env: { ...STACK_ENV, COMPOSE_PROJECT_NAME: PROJECT + "-none" } });
  check(noStack.status === 1 && /backup\.sh: FAILED: a step ended with exit code/.test(noStack.stderr), "a stack that does not run: exit 1 and " + short(noStack.stderr.split("\n").filter((l) => /FAILED/.test(l)).join(" "), 200));
  check(fs.existsSync(empty) && fs.readdirSync(empty).length === 0, "the failed run leaves no file: " + (fs.existsSync(empty) ? fs.readdirSync(empty).join(", ") : "no folder"));
});

// The steps of "Restore" in server/README.md: every line of its code blocks, in order. The names of the backup files
// become the files of the backup of this run. The text of step 1 copies env-<time> to server/.env: the test only checks
// that the backup holds server/.env as it is, so that it never writes server/.env.
function restoreLines() {
  const text = fs.readFileSync(README, "utf8").replace(/\r/g, "");
  const section = text.slice(text.indexOf("\n### Restore\n"), text.indexOf("\n### ", text.indexOf("\n### Restore\n") + 5));
  const lines = [];
  for (const block of section.matchAll(/^```\n([\s\S]*?)^```$/gm)) for (const line of block[1].split("\n")) if (line.trim()) lines.push(line);
  return lines;
}
test("backup", "the steps of the README restore the backup into a new project: the map comes back, and the proxy starts only with its old data", async ({ check }) => {
  if (!backupFiles || !backupFiles.dump) throw new NotRun("no backup of the check before");
  const lines = restoreLines();
  check(lines.length >= 6 && lines.every((l) => l.startsWith("docker compose -f server/compose.yaml ")), `${lines.length} commands, each a docker compose command of the stack`);
  const ups = lines.filter((l) => / up /.test(l));
  check(ups.length >= 2 && ups.every((l) => / up -d (--build )?--wait\b/.test(l)), "each up waits for its services: " + ups.map((l) => l.slice(36)).join(" | "));
  // The first stack stops, so that the new project gets its ports. Its volumes stay.
  keepLogs(PROJECT);
  check(dc(["down"]).status === 0, "the first stack stops");
  stackUp = null;
  const env = { ...STACK_ENV, COMPOSE_PROJECT_NAME: RESTORED };
  const files = { "db-<time>.dump": backupFiles.dump, "caddy_data-<time>.tgz": backupFiles.caddy, "env-<time>": backupFiles.env };
  try {
    let n = 0;
    for (const line of lines) {
      n++;
      let command = line;
      for (const [name, file] of Object.entries(files)) command = command.split(name).join(`"${shPath(path.join(BACKUP, file))}"`);
      if (/<[a-z]+>/.test(command)) { check(false, `step ${n} keeps a placeholder: ${line}`); break; }
      if (/\btar\b/.test(command)) check(containerOf(RESTORED, "proxy").length === 0, `before the data of the proxy is back, the proxy was never created (no certificate order): step ${n}`);
      const r = log(path.join(OUT, "restore"), `${String(n).padStart(2, "0")}.log`, shell(command, { env, timeout: 900000 }));
      check(r.status === 0, `step ${n} ends with 0: ${short(line.slice(36), 90)}` + (r.status ? ": " + short(r.stderr, 300) : ""));
      if (r.status !== 0) break;
    }
    await until("the restored app", async () => (await answer(BASE + "/api/health")).status === 200, 60000).catch(() => false);
    const after = await sampleOf();
    check(after.page === 200 && same(after.names, [SAMPLE.skill]), `the map comes back: ${after.page} ${after.names.join(", ")}`);
    check(caOf(RESTORED) === caBefore && /^[0-9a-f]{64}$/.test(caBefore), "the proxy has the local CA of the backup");
    const setup = compose(RESTORED, ["logs", "db-setup"]).stdout;
    check(/made a new password for the role of the app/.test(setup), "the new project has no password volume, so db-setup makes a new password, and the app works with it");
  } finally {
    keepLogs(RESTORED, { env });
    check(compose(RESTORED, ["down"], { env }).status === 0, "the restored stack stops");
  }
});

// ---------------------------------------------------------------------------------------------------------------------
test("upgrade", "a stack of the version before keeps its data: the proxy takes over the files of root, and the app gets a password of its own", async ({ check }) => {
  if (!fs.existsSync(path.join(SITE, "map.html"))) throw new NotRun("dist/selfhost is missing: run node build_selfhost.js first");
  if (stackUp) { keepLogs(PROJECT); dc(["down"]); stackUp = null; }
  // The folder server/ of the commit before, beside the out folder, with the site of this checkout.
  const old = path.join(OUT, "before");
  fs.rmSync(old, { recursive: true, force: true });
  fs.mkdirSync(old, { recursive: true });
  const listed = run("git", ["ls-tree", "-r", "--name-only", BEFORE, "server"]);
  for (const rel of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const content = spawnSync("git", ["show", `${BEFORE}:${rel}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }).stdout;
    fs.mkdirSync(path.dirname(path.join(old, rel)), { recursive: true });
    fs.writeFileSync(path.join(old, rel), content);
  }
  check(listed.status === 0 && fs.existsSync(path.join(old, "server", "compose.yaml")), `the folder server of ${BEFORE}`);
  fs.copyFileSync(path.join(repo, "server", ".env"), path.join(old, "server", ".env"));
  const env = { ...STACK_ENV, SITE_ROOT: SITE };
  const oldCompose = (args) => compose(UPGRADED, args, { env, file: path.join(old, "server", "compose.yaml") });
  try {
    const up = log(OUT, "upgrade-old-up.log", oldCompose(["up", "-d", "--build"]));
    check(up.status === 0, "the stack of the version before starts: " + short(up.stderr, 200));
    await until("the old app", async () => (await answer(BASE + "/api/health")).status === 200, 120000);
    check(adminSql(UPGRADED, SAMPLE_SQL).status === 0 && (await sampleOf()).page === 200, "its map is public");
    const owners = compose(UPGRADED, ["exec", "-T", "proxy", "sh", "-c", "stat -c %u /data/caddy /config/caddy"], { env }).stdout.trim().split(/\s+/);
    check(same(owners, ["0", "0"]), "the old proxy keeps its files as root: " + owners.join(" "));
    const ca = caOf(UPGRADED);
    const next = log(OUT, "upgrade-new-up.log", compose(UPGRADED, ["up", "-d", "--build", "--wait"], { env }));
    check(next.status === 0, "the stack of this checkout starts on the same volumes: " + short(next.stderr, 300));
    await until("the new app", async () => (await answer(BASE + "/api/health")).status === 200, 60000).catch(() => false);
    const after = await sampleOf();
    check(after.page === 200 && same(after.names, [SAMPLE.skill]), `the map is still there: ${after.page} ${after.names.join(", ")}`);
    const newOwners = compose(UPGRADED, ["exec", "-T", "proxy", "sh", "-c", "stat -c %u /data/caddy /config/caddy; id -u"], { env }).stdout.trim().split(/\s+/);
    check(same(newOwners, ["10002", "10002", "10002"]), "the proxy runs as 10002 and owns its files: " + newOwners.join(" "));
    check(caOf(UPGRADED) === ca, "the proxy keeps its local CA");
    const appHash = compose(UPGRADED, ["exec", "-T", "app", "sh", "-c", "cut -d: -f5- /run/app-db/pgpass | tr -d '\\n' | sha256sum"], { env }).stdout.split(" ")[0];
    const adminHash = compose(UPGRADED, ["exec", "-T", "db", "sh", "-c", 'printf %s "$POSTGRES_PASSWORD" | sha256sum'], { env }).stdout.split(" ")[0];
    check(/^[0-9a-f]{64}$/.test(appHash) && appHash !== adminHash, "the app role had the password of the admin role before, and now has a password of its own");
  } finally {
    keepLogs(UPGRADED, { env });
    check(compose(UPGRADED, ["down"], { env }).status === 0, "the upgraded stack stops");
    // The copy of server/.env holds secrets.
    fs.rmSync(old, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The code block of selfhost/DEPLOY.md that follows the line that starts with start.
function deployBlock(start) {
  const text = fs.readFileSync(DEPLOY, "utf8").replace(/\r/g, "");
  const from = text.indexOf("\n" + start);
  if (from < 0) return null;
  const block = text.slice(from).match(/^```\n([\s\S]*?)^```$/m);
  return block ? block[1] : null;
}
function siteCopy() {
  const copy = path.join(OUT, "snippets", "site");
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(SITE, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, "probe.json"), '{"probe": true}\n');
  return copy;
}
// What a static web server must send for each kind of file (selfhost/DEPLOY.md, "Content types" and "Cache headers").
async function probeServer(port, check, label) {
  const page = fs.readFileSync(path.join(SITE, "map.html"), "utf8");
  const versioned = page.match(/src="(assets\/page\.js\?v=[0-9a-f]+)"/)[1];
  const font = fs.readdirSync(path.join(SITE, "vendor", "fonts")).find((n) => n.endsWith(".woff2"));
  const want = [
    ["/", "text/html; charset=utf-8", "no-cache"], ["/index.html", "text/html; charset=utf-8", "no-cache"],
    ["/assets/page.js", /^(text|application)\/javascript; charset=utf-8$/, "no-cache"], ["/assets/site.css", "text/css; charset=utf-8", "no-cache"],
    ["/assets/icon.svg", "image/svg+xml", "no-cache"], [`/vendor/fonts/${font}`, "font/woff2", "no-cache"], ["/probe.json", "application/json", "no-cache"],
    ["/vendor/licenses/d3-ISC.txt", "text/plain; charset=utf-8", "no-cache"], ["/" + versioned, /^(text|application)\/javascript; charset=utf-8$/, "public, max-age=31536000, immutable"],
  ];
  for (const [address, type, cache] of want) {
    const a = await answer(`http://127.0.0.1:${port}${address}`);
    const typeOk = typeof type === "string" ? a.headers["content-type"] === type : type.test(a.headers["content-type"] || "");
    check(a.status === 200 && typeOk && a.headers["cache-control"] === cache, `${label} ${address.split("?")[0]}${address.includes("?") ? "?v=…" : ""}: ${a.status}, ${a.headers["content-type"]}, ${a.headers["cache-control"]}`);
    check(a.headers["content-security-policy"] === POLICY && a.headers["x-frame-options"] === "SAMEORIGIN" && a.headers["x-content-type-options"] === "nosniff"
      && a.headers["referrer-policy"] === "no-referrer", `${label} ${address.split("?")[0]}: the policy of the site with frame-ancestors, X-Frame-Options, nosniff and no-referrer`);
  }
  for (const address of ["/assets/no-such-file.js?v=0123456789ab", "/no-such-page.html"]) {
    const a = await answer(`http://127.0.0.1:${port}${address}`);
    check(a.status === 404 && a.headers["cache-control"] === "no-store", `${label} ${address}: ${a.status} ${a.headers["cache-control"]}`);
  }
}

test("snippets", "nginx with the lines of DEPLOY.md: content types with UTF-8, the policy of the site, X-Frame-Options and the cache rules", async ({ check }) => {
  const block = deployBlock("For nginx");
  check(!!block && block.includes("  # ...\n"), "DEPLOY.md has the nginx lines with the placeholder # ...");
  if (!block) return;
  const conf = path.join(OUT, "snippets", "nginx");
  fs.rmSync(conf, { recursive: true, force: true });
  fs.mkdirSync(conf, { recursive: true });
  fs.writeFileSync(path.join(conf, "site.conf"), block.replace("  # ...\n", "  listen 80;\n  root /srv/site;\n"));
  const site = siteCopy(), name = `skillmap-deploy-nginx-${RUN}`, port = 49231;
  const start = run("docker", ["run", "--rm", "-d", "--name", name, "-p", `127.0.0.1:${port}:80`, "-v", `${site}:/srv/site:ro`, "-v", `${conf}:/etc/nginx/conf.d:ro`, NGINX]);
  try {
    check(start.status === 0, "nginx starts: " + short(start.stderr, 200));
    await until("nginx", async () => (await answer(`http://127.0.0.1:${port}/`)).status === 200, 30000);
    const syntax = run("docker", ["exec", name, "nginx", "-t"]);
    check(syntax.status === 0, "nginx -t accepts the lines: " + short(syntax.stderr.split("\n").filter((l) => /warn|emerg|error/.test(l)).join(" "), 200));
    await probeServer(port, check, "nginx");
  } finally { run("docker", ["stop", name]); }
});

test("snippets", "Apache with the .htaccess of DEPLOY.md: the same headers", async ({ check }) => {
  const block = deployBlock("For Apache 2.4");
  check(!!block, "DEPLOY.md has the lines for Apache");
  if (!block) return;
  const site = siteCopy();
  fs.writeFileSync(path.join(site, ".htaccess"), block);
  const name = `skillmap-deploy-httpd-${RUN}`, port = 49233;
  // The stock configuration loads no mod_headers and allows no .htaccess. These two changes are what DEPLOY.md asks of the
  // web space.
  const setup = 'c=/usr/local/apache2/conf/httpd.conf; sed -i "s/^#LoadModule headers_module/LoadModule headers_module/" $c; '
    + 'sed -i "/<Directory \\"\\/usr\\/local\\/apache2\\/htdocs\\">/,/<\\/Directory>/ s/AllowOverride None/AllowOverride All/" $c; exec httpd-foreground';
  const start = run("docker", ["run", "--rm", "-d", "--name", name, "-p", `127.0.0.1:${port}:80`, "-v", `${site}:/usr/local/apache2/htdocs:ro`, HTTPD, "sh", "-c", setup]);
  try {
    check(start.status === 0, "Apache starts: " + short(start.stderr, 200));
    await until("Apache", async () => (await answer(`http://127.0.0.1:${port}/`)).status === 200, 30000);
    await probeServer(port, check, "Apache");
  } finally { run("docker", ["stop", name]); }
});

test("snippets", "Apache with the upload of make_upload.js: one address for the site, over real TLS, and robots.txt and sitemap.xml", async ({ check }) => {
  const host = "skillmap.test", other = "www.skillmap.test", address = `https://${host}`;
  const folder = path.join(OUT, "snippets", "upload");
  fs.rmSync(folder, { recursive: true, force: true });
  const made = run(process.execPath, [path.join(repo, "make_upload.js"), folder, "--site", address]);
  check(made.status === 0, "make_upload.js runs: " + short(made.stderr, 200));
  fs.mkdirSync(path.join(folder, ".well-known"));
  fs.writeFileSync(path.join(folder, ".well-known", "probe.txt"), "probe\n");
  fs.mkdirSync(path.join(folder, "my-page"));
  fs.writeFileSync(path.join(folder, "my-page", "index.html"), "<script>document.title = \"own\";</script>\n");

  const name = `skillmap-deploy-upload-${RUN}`, plainPort = 49235, tlsPort = 49236;
  const setup = 'c=/usr/local/apache2/conf/httpd.conf; for m in headers rewrite ssl socache_shmcb; do sed -i "s/^#LoadModule ${m}_module/LoadModule ${m}_module/" $c; done; '
    + 'sed -i "/<Directory \\"\\/usr\\/local\\/apache2\\/htdocs\\">/,/<\\/Directory>/ s/AllowOverride None/AllowOverride All/" $c; '
    + 'apk add --no-cache openssl >/dev/null; openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=skillmap.test -keyout /usr/local/apache2/conf/server.key -out /usr/local/apache2/conf/server.crt 2>/dev/null; '
    + 'echo "Include conf/extra/httpd-ssl.conf" >> $c; exec httpd-foreground';
  const start = run("docker", ["run", "--rm", "-d", "--name", name, "-p", `127.0.0.1:${plainPort}:80`, "-p", `127.0.0.1:${tlsPort}:443`, "-v", `${folder}:/usr/local/apache2/htdocs:ro`, HTTPD, "sh", "-c", setup]);
  // TLS needs the name of the host in the header and no check of the certificate of this test. Node sends no redirect itself.
  const ask = (scheme, hostName, target) => new Promise((done) => {
    const options = { hostname: "127.0.0.1", port: scheme === "https" ? tlsPort : plainPort, path: target, headers: { host: hostName }, rejectUnauthorized: false, servername: host };
    (scheme === "https" ? https : http).get(options, (response) => {
      let text = "";
      response.on("data", (part) => { text += part; });
      response.on("end", () => done({ status: response.statusCode, location: response.headers.location, type: response.headers["content-type"], policy: response.headers["content-security-policy"], text }));
    }).on("error", (error) => done({ status: 0, error: error.message }));
  });
  try {
    check(start.status === 0, "Apache starts: " + short(start.stderr, 200));
    await until("Apache with TLS", async () => (await ask("https", host, "/")).status === 200, 60000);
    for (const [scheme, hostName] of [["http", host], ["http", other], ["https", other]]) {
      const a = await ask(scheme, hostName, "/example.html?x=1");
      check(a.status === 301 && a.location === `${address}/example.html?x=1`, `${scheme}://${hostName} goes to the one address, with path and query: ${a.status} ${a.location}`);
      check(a.policy === POLICY, `${scheme}://${hostName}: the redirect carries the policy of the site`);
    }
    const page = await ask("https", host, "/example.html?x=1");
    check(page.status === 200 && page.policy === POLICY, `the one address answers without a redirect: ${page.status} ${page.location || ""}`);
    const upper = await ask("https", host.toUpperCase(), "/");
    check(upper.status === 200, `the host in capitals needs no redirect: ${upper.status}`);
    const proxied = await new Promise((done) => http.get({ hostname: "127.0.0.1", port: plainPort, path: "/", headers: { host, "x-forwarded-proto": "https" } }, (r) => { r.resume(); done(r.statusCode); }));
    check(proxied === 200, `a proxy that ends TLS causes no redirect loop: ${proxied}`);
    const own = await ask("https", host, "/my-page/index.html");
    check(own.status === 200 && own.policy === undefined, `a folder of its own keeps its inline script, so it gets no policy: ${own.status} ${own.policy}`);
    const moved = await ask("http", other, "/my-page/");
    check(moved.status === 301 && moved.location === `${address}/my-page/`, `the redirect also covers such a folder: ${moved.status} ${moved.location}`);
    for (const target of ["/ai/format.txt", "/assets/site.css", "/index.html", "/"]) {
      const a = await ask("https", host, target);
      check(a.status === 200 && a.policy === POLICY, `the files of the site keep the policy: ${target} ${a.status}`);
    }
    const known = await ask("http", other, "/.well-known/probe.txt");
    check(known.status === 200 && known.text === "probe\n", `the folder .well-known has no redirect: ${known.status}`);
    const robots = await ask("https", host, "/robots.txt"), sitemap = await ask("https", host, "/sitemap.xml");
    check(robots.status === 200 && robots.type === "text/plain; charset=utf-8" && robots.text.includes(`Sitemap: ${address}/sitemap.xml\n`), `robots.txt: ${robots.status} ${robots.type}`);
    check(sitemap.status === 200 && /xml/.test(sitemap.type || "") && sitemap.text.includes(`<loc>${address}/example.html</loc>`), `sitemap.xml: ${sitemap.status} ${sitemap.type}`);
  } finally { run("docker", ["stop", name]); }
});

// ---------------------------------------------------------------------------------------------------------------------
(async () => {
  const parts = process.argv.slice(2);
  const chosen = tests.filter((t) => !parts.length || parts.includes(t.part));
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`deploy checks: ${chosen.length}, projects ${PROJECT}(-restore, -upgrade), ports ${PORTS.http}, ${PORTS.https}, ${PORTS.mailpit}`);
  let passed = 0;
  try {
    for (const t of chosen) {
      const lines = [], failures = [], t0 = Date.now();
      const check = (ok, text) => { lines.push((ok ? "ok   " : "FAIL ") + text); if (!ok) failures.push(short(text, 400)); };
      try { await t.fn({ check }); } catch (error) { check(false, (error instanceof NotRun ? "not run: " : "threw: ") + String(error && error.message || error).split("\n")[0]); }
      const seconds = ((Date.now() - t0) / 1000).toFixed(1) + " s";
      if (failures.length) console.log(`FAIL ${t.name}: ${failures.join(" | ")}`);
      else { passed++; console.log(`PASS ${t.name} (${seconds})`); }
      if (VERBOSE) lines.forEach((line) => console.log("      " + line));
    }
  } finally {
    if (stackUp) { keepLogs(PROJECT); dc(["down"]); }
  }
  console.log(`\n${passed} of ${chosen.length} checks passed`);
  process.exitCode = passed === chosen.length ? 0 : 1;
})();

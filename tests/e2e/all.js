// Runs every browser test of the map tool and prints one summary: the check of the interface texts (npm run
// check:texts), the end-to-end suite of the map page, the four project and catalog editor suites, the settings suite of
// the force menu and its configuration store.
// Each suite opens map pages of the site build with the test runtime, served over HTTP from its own test site
// (tests/e2e/site.js). The editor suites run in a row (they share the test page of tests/prepare.js); the other three
// run beside them. With --site, the run then builds the site (build_selfhost.js) and runs the suite of the site
// (tests/selfhost/run.js) on its own, after the others, so that its time checks run on a quiet computer. That is every
// browser suite that needs no compose stack (npm run test:browser).
// Usage: node tests/e2e/all.js [--verbose] [--site]   (--verbose prints the output of every suite, not only of failed ones)
const path = require("path"), { spawn } = require("child_process");
const repo = path.join(__dirname, "..", "..");
const verbose = process.argv.includes("--verbose"), withSite = process.argv.includes("--site");
const node = (file) => [process.execPath, [path.join(repo, file)]];

function runSuite(name, [cmd, args], count) {
  return new Promise((resolve) => {
    const t0 = Date.now(), child = spawn(cmd, args, { cwd: repo });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ name, code, out, seconds: (Date.now() - t0) / 1000, ...count(out) }));
  });
}
// Each suite reports in its own words; these read the number of passed and run checks from the output.
const okLines = (out) => ({ passed: (out.match(/^ok {3}/gm) || []).length, total: (out.match(/^(ok {3}|FAIL )/gm) || []).length });
const ofLine = (re) => (out) => { const m = out.match(re); return m ? { passed: Number(m[1]), total: Number(m[2]) } : { passed: 0, total: 0 }; };

(async () => {
  const started = Date.now();
  const editorChain = Promise.resolve([]);
  const others = Promise.all([
    runSuite("texts", node("i18n/tools/check.js"), okLines),
    runSuite("map end to end", node("tests/e2e/map.js"), ofLine(/^(\d+) of (\d+) tests passed/m)),
    runSuite("force menu settings", node("tests/settings/run.js"), ofLine(/^(\d+) of (\d+) passed/m)),
    runSuite("force menu store", node("tests/settings/store.js"), ofLine(/^(\d+) of (\d+) tests passed/m)),
  ]);
  const results = [...(await others), ...(await editorChain)];
  if (withSite) {
    const build = await runSuite("build of the site", node("build_selfhost.js"), () => ({ passed: 0, total: 0 }));
    results.push(build);
    if (build.code === 0) results.push(await runSuite("site", node("tests/selfhost/run.js"), ofLine(/^(\d+) of (\d+) tests passed/m)));
  }
  let failed = 0;
  console.log("");
  for (const r of results) {
    const ok = r.code === 0;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${r.name.padEnd(24)} ${r.total ? `${r.passed} of ${r.total}`.padEnd(12) : "".padEnd(12)} ${r.seconds.toFixed(1).padStart(6)} s`);
    if (!ok || verbose) console.log(r.out.split("\n").map((l) => "      " + l).join("\n"));
  }
  const checks = results.reduce((t, r) => t + r.total, 0), passed = results.reduce((t, r) => t + r.passed, 0);
  console.log(`\n${failed ? failed + " of " + results.length + " suites failed" : "all " + results.length + " suites passed"}: ${passed} of ${checks} checks and cases, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  process.exitCode = failed ? 1 : 0;
})();

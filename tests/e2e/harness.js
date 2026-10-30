// Shared harness for the end-to-end tests: the test pages of a test site (tests/e2e/site.js), built like the map pages of
// the site from any data file, opened over HTTP with the test runtime (tests/e2e/test-runtime.js), and named tests in a
// small pool of browser contexts.
const path = require("path");
const { chromium } = require("playwright");
const { TestSite, openPage, pageOf, withInit, withData, withLayout, repo } = require("./site");
// The libraries of the PDF download by their paths in the page, from vendor/ of the site (selfhost/vendor).
const PDF_LIBS = { "vendor/jspdf-4.2.1.umd.min.js": "jspdf-4.2.1.umd.min.js", "vendor/svg2pdf.js-2.8.1.umd.min.js": "svg2pdf.js-2.8.1.umd.min.js" };
// The fonts of the text in the PDF, by their paths in the page, from vendor/fonts/ of the site.
const PDF_FONTS = { "vendor/fonts/noto-sans-2.015-400-normal.ttf": "fonts/noto-sans-2.015-400-normal.ttf", "vendor/fonts/noto-sans-2.015-700-normal.ttf": "fonts/noto-sans-2.015-700-normal.ttf" };

// The test page for any data, projects and configurations file. Without a configurations file the page has no
// configurations, so every viewer starts with the values of layout.js.
function buildPage(dataFile, projectsFile, configsFile = null) {
  return pageOf(dataFile, projectsFile, configsFile);
}
// The test site of the end-to-end tests, in tests/e2e/out/site. It starts with the first page that a test opens.
let site = null;
const siteOf = () => site || (site = new TestSite(path.join(__dirname, "out", "site")).start());

const projectDocs = (projects) => Object.fromEntries(projects.map(({ id, ...p }) => ["projects/" + id, p]));

// Modes: signedOut (db() and isOwner() resolve null and false), viewer (db, not the owner), owner, noRuntime (the page
// without its runtime) and noD3 (no runtime, and d3 does not load). seed: the documents that the database starts with.
// hasTouch gives the page a touch screen, for page.touchscreen. storage holds entries of localStorage that the page finds
// at its first load, for example a state that the owner stored on an earlier visit. init is a script that runs before
// the page. fonts serves the fonts of the site; without it the names keep the fonts of the system.
async function open(browser, page, { mode = "signedOut", seed = null, colorScheme = "light", viewport = { width: 1400, height: 900 }, hasTouch = false, storage = null, init = null, fonts = false } = {}) {
  const scripts = [];
  if (storage) scripts.push([(entries) => {
    if (sessionStorage.getItem("e2e-storage")) return;
    Object.entries(entries).forEach(([k, v]) => localStorage.setItem(k, v));
    sessionStorage.setItem("e2e-storage", "1");
  }, storage]);
  if (init) scripts.push(init);
  const runtime = { mode: mode === "noD3" ? "noRuntime" : mode, seed };
  const opened = await openPage(browser, await siteOf(), page, { runtime, contextOptions: { colorScheme, viewport, reducedMotion: "reduce", hasTouch },
    fonts, noD3: mode === "noD3", init: scripts, ignore: /Failed to load resource/ });
  await opened.page.waitForFunction(() => document.querySelector("#panel h2"), null, { timeout: 10000 });
  await opened.page.waitForTimeout(mode === "viewer" || mode === "owner" ? 400 : 250);
  return opened;
}

// Page helpers. Node ids: "c:<area>", "g:<category>", "s:<skill>".
const h = {
  panel: (page) => page.locator("#panel").innerText(),
  // Headings in the DOM spelling; innerText would apply the CSS capitals of the panel headings.
  h3s: (page) => page.locator("#panel h3").allTextContents().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim())),
  h2: (page) => page.locator("#panel h2").first().innerText(),
  k: (page) => page.evaluate(() => d3.zoomTransform(document.getElementById("map")).k),
  transform: (page) => page.evaluate(() => { const t = d3.zoomTransform(document.getElementById("map")); return { k: t.k, x: t.x, y: t.y }; }),
  onIds: (page) => page.evaluate(() => [...document.querySelectorAll("#map g.node.on")].map((g) => g.__data__.id).sort()),
  classed: (page, cls) => page.evaluate((c) => [...document.querySelectorAll("#map g.node." + c)].map((g) => g.__data__.id).sort(), cls),
  focused: (page) => page.evaluate(() => document.getElementById("map").classList.contains("focus")),
  opacity: (page, id) => page.evaluate((i) => { const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__.id === i); return Number(getComputedStyle(g).opacity); }, id),
  labelShown: (page, id) => page.evaluate((i) => { const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__.id === i); return g.querySelector("text").getAttribute("display") !== "none"; }, id),
  fontSize: (page, id) => page.evaluate((i) => { const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__.id === i); return Number(g.querySelector("text").getAttribute("font-size")); }, id),
  chips: (page, scope = "#panel") => page.locator(scope + " .chip").allInnerTexts().then((all) => all.map((t) => t.replace(/×/g, "").trim())),
  pressed: (page, selector) => page.locator(selector).getAttribute("aria-pressed"),
  // The screen point at the centre of a node, after making sure no other element covers it.
  async nodePoint(page, id) {
    return page.evaluate((i) => {
      const g = [...document.querySelectorAll("#map g.node")].find((e) => e.__data__.id === i);
      const box = g.querySelector("circle.hit").getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
      const top = document.elementFromPoint(x, y), hit = top && top.closest("g.node");
      return { x, y, onTarget: !!hit && hit.__data__.id === i };
    }, id);
  },
  async clickNode(page, id) {
    const p = await h.nodePoint(page, id);
    if (!p.onTarget) throw new Error("node " + id + " is covered at its centre");
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(80);
  },
  // A point on the map that no node covers.
  async emptyPoint(page) {
    return page.evaluate(() => {
      const box = document.getElementById("map").getBoundingClientRect();
      for (let fy = 0.1; fy < 0.95; fy += 0.05) for (let fx = 0.05; fx < 0.95; fx += 0.05) {
        const x = box.x + box.width * fx, y = box.y + box.height * fy, el = document.elementFromPoint(x, y);
        if (el && el.closest("#map") && !el.closest("g.node") && !el.closest(".hint")) return { x, y };
      }
      return null;
    });
  },
  // Zooms with the mouse wheel to the scale k; d3 scales by 2^(-deltaY * 0.002) per wheel event.
  async wheelTo(page, k) {
    const box = await page.locator("#map").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const now = await h.k(page);
    await page.mouse.wheel(0, -Math.log2(k / now) / 0.002);
    await page.waitForTimeout(80);
  },
  async click(page, selector) { await page.locator(selector).first().click(); await page.waitForTimeout(80); },
  async search(page, text) { await page.fill("#q", text); await page.waitForTimeout(60); },
};

// The limit of one test: a test that has not ended after it fails with its name, and the run goes on with the next one.
// So a wait without a limit of its own, such as page.evaluate or download.path(), cannot hold a run for ever.
// E2E_TEST_LIMIT_S changes it; 6 minutes by default, as the downloads of a map can take minutes on a slow computer.
const TEST_LIMIT_MS = (Number(process.env.E2E_TEST_LIMIT_S) || 360) * 1000;
// Runs one test fn(args) with its limit: "ended", or "late" when it did not end within limit ms. An error of the test
// throws. A late test goes on in the background, and the run does not wait for it.
async function runOne(fn, args, limit) {
  let timer;
  const over = new Promise((resolve) => { timer = setTimeout(() => resolve("late"), limit); });
  try { return await Promise.race([Promise.resolve().then(() => fn(args)).then(() => "ended"), over]); } finally { clearTimeout(timer); }
}
// Runs tests in a pool of contexts. A test is { name, fn, known }: a known issue runs and reports, but stays out of the pass count.
// limit: the limit of one test in ms. late(test): called when a test passes its limit, for a suite whose tests build on
// each other (tests/server/run.js).
async function run(tests, { pool = 4, only = [], limit = TEST_LIMIT_MS, late = () => {} } = {}) {
  const browser = await chromium.launch();
  const chosen = only.length ? tests.filter((t) => only.some((o) => t.name.includes(o))) : tests;
  const results = [];
  let next = 0;
  const started = Date.now();
  async function worker() {
    while (next < chosen.length) {
      const t = chosen[next++], lines = [], t0 = Date.now();
      let failed = 0;
      const check = (ok, text) => { lines.push((ok ? "ok   " : "FAIL ") + text); if (!ok) failed++; };
      try {
        if (await runOne(t.fn, { browser, check }, limit) === "late") {
          check(false, `did not end within ${limit / 1000} s: one of its waits has no answer`);
          late(t);
        }
      } catch (error) { check(false, "threw: " + error.message.split("\n")[0]); }
      results.push({ name: t.name, known: t.known, failed, lines, seconds: (Date.now() - t0) / 1000 });
      console.log(`${failed ? (t.known ? "KNOWN" : "FAIL ") : "PASS "} ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      if (failed || process.env.E2E_VERBOSE) lines.forEach((l) => console.log("      " + l));
    }
  }
  await Promise.all(Array.from({ length: pool }, worker));
  await browser.close();
  if (site) await (await site).close();
  const counted = results.filter((r) => !r.known), passed = counted.filter((r) => !r.failed).length;
  const known = results.filter((r) => r.known);
  console.log(`\n${passed} of ${counted.length} tests passed` + (known.length ? `, ${known.length} known issue${known.length > 1 ? "s" : ""} not counted: ${known.map((r) => r.name + (r.known === true ? "" : " (" + r.known + ")")).join("; ")}` : "")
    + ` in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return passed === counted.length;
}

module.exports = { buildPage, open, h, run, runOne, projectDocs, repo, PDF_LIBS, PDF_FONTS, withInit, withData, withLayout };

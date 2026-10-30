// The runtime of the test pages. It sets window.SKILL_MAP_RUNTIME, the global of the runtimes of the site
// (selfhost/runtime/local.js and server.js), with a database that keeps its documents in localStorage under "stub-db",
// so a reload keeps them. The browser tests load it in place of the runtime of the site, and an init script of the
// test sets its configuration in window.__testRuntime before the page loads:
//
//   mode         signedOut  db() and isOwner() resolve null and false, as for a visitor without an account
//                viewer     the database, but isOwner() resolves false: a reader with access to the data
//                owner      the database, and isOwner() resolves true
//                noRuntime  the runtime sets no global, so the page uses its fallback: a saved copy of the page
//                (noD3 is a mode of the test, not of the runtime: the test refuses the request for d3.)
//   db           false: an owner without a database, for example a page whose database does not answer
//   seed         the documents { "<collection>/<id>": data } that the database starts with, when localStorage holds none
//   delays       { use, write, snapshot, emit } in milliseconds: until db() and isOwner() resolve, until a write lands,
//                until the first snapshot of a collection, and until the snapshot after a write
//   emit         "all": a write sends a new snapshot to every listener (the default); "collection": only to the
//                listeners of its collection
//   refuse       a code: every write rejects with it, after it waited (window.__refuse changes it later)
//   failSnapshot the collections whose subscription the database refuses with permission_denied
//
// For the checks it records every write in window.__writes ({ op, full }), two writes of one document at the same time
// in window.__violations, and each collection that the page opens in window.__paths. window.__docs() gives the
// documents.
(function () {
  "use strict";
  const config = window.__testRuntime || {};
  const mode = config.mode || "signedOut";
  if (mode === "noRuntime") return;
  const delays = { use: 60, write: 40, snapshot: 50, emit: 30, ...(config.delays || {}) };
  const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const KEY = "stub-db";
  window.__writes = []; window.__violations = []; window.__paths = [];
  window.__refuse = config.refuse || null;

  function makeDb() {
    if (config.seed && localStorage.getItem(KEY) === null) localStorage.setItem(KEY, JSON.stringify(config.seed));
    const read = () => JSON.parse(localStorage.getItem(KEY) || "{}");
    const write = (all) => localStorage.setItem(KEY, JSON.stringify(all));
    window.__docs = read;
    const listeners = [], inflight = new Set(), meta = { fromCache: false, hasPendingWrites: false };
    const snapshot = (prefix) => {
      const all = read();
      const docs = Object.keys(all).filter((k) => k.startsWith(prefix + "/") && !k.slice(prefix.length + 1).includes("/")).sort().map((k) => {
        const body = Object.freeze(JSON.parse(JSON.stringify(all[k])));
        return { id: k.slice(prefix.length + 1), exists: true, data: () => body, metadata: meta };
      });
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta };
    };
    const emit = (full) => listeners.forEach(({ prefix, next }) => {
      if (config.emit === "collection" && !full.startsWith(prefix + "/")) return;
      setTimeout(() => next(snapshot(prefix)), delays.emit);
    });
    async function change(full, op, apply) {
      if (inflight.has(full)) window.__violations.push(full);
      inflight.add(full);
      await later(delays.write);
      inflight.delete(full);
      window.__writes.push({ op, full });
      if (window.__refuse) throw { code: window.__refuse, message: "refused by the test" };
      const all = read();
      apply(all);
      write(all);
      emit(full);
    }
    return Object.freeze({
      collection(prefix) {
        window.__paths.push(prefix);
        return {
          path: prefix,
          doc(id) {
            const full = prefix + "/" + id;
            return {
              id, path: full,
              set(data) {
                if (!data || typeof data !== "object" || Array.isArray(data)) return Promise.reject({ code: "invalid_argument", message: "body" });
                const body = JSON.parse(JSON.stringify(data));
                return change(full, "set", (all) => { all[full] = body; });
              },
              delete: () => change(full, "delete", (all) => { delete all[full]; }),
            };
          },
          onSnapshot(next, error) {
            if ((config.failSnapshot || []).includes(prefix)) { setTimeout(() => error({ code: "permission_denied" }), delays.snapshot); return () => {}; }
            listeners.push({ prefix, next });
            setTimeout(() => next(snapshot(prefix)), delays.snapshot);
            return () => {};
          },
        };
      },
    });
  }

  const db = mode === "signedOut" || config.db === false ? null : makeDb();
  // Each answer waits from the first question on, and every later question gets the same promise.
  let dbAnswer = null, ownerAnswer = null;
  window.SKILL_MAP_RUNTIME = Object.freeze({
    db: () => dbAnswer || (dbAnswer = later(delays.use, db)),
    isOwner: () => ownerAnswer || (ownerAnswer = later(delays.use, mode === "owner")),
  });
})();

// The dropdown of the languages in the header of every page of the site. build_selfhost.js writes this file at the end of
// assets/i18n.js, after the function t (i18n/i18n.js), so every page that loads its texts gets the dropdown too: the map
// pages, the start page, the legal pages and the account page of the server.
//
// It fills each element with data-language-picker with a select of SkillMapI18n.languages(), each language in its own
// name. A choice keeps the language in this browser at once (SkillMapI18n.choose). For a signed-in user it first sets the
// language of the account with PATCH /api/account { "language": "<code>" }, so that every page and every mail of the
// server follows it. If that write fails, the page keeps its language, and the error text shows next to the dropdown.
// The page does not load again by itself, so that a half-filled form stays: a note next to the dropdown, in the chosen
// language, says to reload the page to show it, with a button that reloads it. The embed view has no dropdown: its
// language comes from its address. Nor has a page in a frame, such as the example map on the start page: it follows the
// dropdown of the page around it.
//
// A page without the session (a static page of the server) cannot reach the account. Its choice is newer than the
// account (i18n/i18n.js), and the next page with the session of the signed-in account sends it to the account on its load
// (SkillMapI18n.newer). If that write fails, the error text shows next to the dropdown, and the next page tries again.
//
//   SkillMapLanguage.signIn(flag)  tells the dropdown whether a user is signed in, for a page that signs in or out
//                                  without a new load (the account page). The data block of the server tells it on a load.
(function () {
  "use strict";
  const I = window.SkillMapI18n;
  if (!I || typeof document === "undefined" || !document || !document.documentElement) return;
  let signedIn = I.signedIn;
  // The language that this browser keeps: the language of the page until a choice changes it.
  let kept = I.language;
  // Each dropdown of the page: its select, its error message and its note to reload.
  const views = [];

  async function saveForAccount(code) {
    let response;
    try {
      response = await fetch("/api/account", { method: "PATCH", credentials: "same-origin", cache: "no-store",
        headers: { "X-Requested-With": "it-skills", "Content-Type": "application/json" }, body: JSON.stringify({ language: code }) });
    } catch (error) { return t("language.offline"); }
    if (response.ok) return null;
    let body = null;
    try { body = await response.json(); } catch (error) { body = null; }
    return I.errorText(body, t("language.refused", { status: response.status }));
  }

  // Every dropdown shows the kept language, and the note to reload while the page shows another one.
  function show() {
    for (const view of views) {
      view.select.value = kept;
      view.note.hidden = kept === I.language;
      if (view.note.hidden) continue;
      view.note.lang = kept;
      view.text.textContent = I.textIn(kept, "language.reloadNote");
      view.reload.textContent = I.textIn(kept, "language.reload");
    }
  }
  const say = (text) => views.forEach((view) => { view.message.textContent = text; view.message.hidden = !text; });

  function fill(holder) {
    const select = document.createElement("select");
    select.className = "language-select";
    select.setAttribute("aria-label", t("language.label"));
    for (const { code, name } of I.languages()) {
      const option = document.createElement("option");
      option.value = code;
      option.lang = code;
      option.textContent = name;
      option.selected = code === kept;
      select.append(option);
    }
    const message = document.createElement("span");
    message.className = "language-message";
    message.setAttribute("role", "alert");
    message.hidden = true;
    const note = document.createElement("span"), text = document.createElement("span"), reload = document.createElement("button");
    note.className = "language-note";
    note.setAttribute("role", "status");
    note.hidden = true;
    reload.type = "button";
    reload.className = "language-reload";
    reload.addEventListener("click", () => location.reload());
    note.append(text, " ", reload);
    const fail = (error) => { select.disabled = false; show(); say(error); };
    select.addEventListener("change", async () => {
      const code = select.value;
      if (code === kept) return;
      say("");
      select.disabled = true;
      if (signedIn) {
        const error = await saveForAccount(code);
        if (error) { fail(error); return; }
        I.choose(code);
        I.saved();
      } else if (!I.choose(code)) { fail(t("language.noStorage")); return; }
      kept = code;
      select.disabled = false;
      show();
    });
    views.push({ select, message, note, text, reload });
    holder.replaceChildren(select, message, note);
  }

  const framed = () => { try { return window.self !== window.top; } catch (error) { return true; } };
  const done = new WeakSet();
  function fillAll() {
    for (const holder of document.querySelectorAll("[data-language-picker]")) {
      if (done.has(holder)) continue;
      done.add(holder);
      if (I.embedded || framed()) holder.hidden = true; else fill(holder);
    }
  }
  // A choice of a page without the session goes to the account on the first page with the session. Its error shows once
  // the dropdowns are there.
  async function sendNewer(ready) {
    const error = await saveForAccount(I.language);
    await ready;
    if (error) say(error); else I.saved();
  }
  window.SkillMapLanguage = Object.freeze({ signIn(flag) { signedIn = !!flag; I.account(signedIn); } });
  fillAll();
  const ready = document.readyState === "loading" ? new Promise((resolve) => document.addEventListener("DOMContentLoaded", () => { fillAll(); resolve(); }, { once: true })) : Promise.resolve();
  if (I.newer && signedIn) sendNewer(ready);
})();

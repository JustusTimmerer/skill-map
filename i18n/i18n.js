// The interface texts of the site (i18n/README.md). build_selfhost.js writes the catalogs of i18n/<language>/ in front of
// this file into assets/i18n.js: window.SKILL_MAP_TEXTS = { <language>: { <key>: <text> } }, without the notes and the
// sources, and the dropdown of the languages (selfhost/site/language.js) after it. Every page of the site loads
// assets/i18n.js as its first script, before the runtime and the page code.
//
// It picks the language of the page, from the first of these sources that names a language of the build:
//   1. the embed view only: the parameter lang of its address (/e/...?lang=de), because a frame on another site has no
//      storage of its own. The code of the share dialog names it.
//   2. the language of the signed-in account: the field language of the data block of the server
//      (<script type="application/json" id="it-skills-server">, server/app/pages.py), which the app puts first in the
//      head. This file keeps it as the choice of this browser too, so that the static pages follow the account.
//      One exception: a choice on a page without the session that is newer than the account (below).
//   3. the choice that this browser keeps in localStorage under "skill-map-language".
//   4. English.
// The static pages of the server (the legal pages, example.html and map.html) have no data block, and stage a has no API,
// so a choice there cannot reach the account at once. This browser keeps under "skill-map-language-account" what the last
// page with the session said: "signed-in" for a signed-in account, and no entry without one. A choice on a page without
// the session (choose) turns "signed-in" into "newer". The next page with the session of a signed-in account then shows
// that choice instead of the language of the account (newer), and the dropdown sends it to the account
// (selfhost/site/language.js), which turns the entry back into "signed-in" (saved). A page with the session of nobody
// removes the entry, so a choice without an account never reaches an account that signs in later.
// It sets <html lang> to that language. Then it fills the static texts of the page: an element with data-i18n="<key>"
// gets the text of the key, and data-i18n-attr="title:<key>; aria-label:<key>" sets attributes. An element with
// data-versions shows the one of its children whose lang is the language of the page, else its English child, and hides
// the others: the German and the English text of a legal page.
//
//   t(key, values)          the text of a key in the language of the page, with each {name} replaced by values.name.
//                           A text with a plural is an object of the forms of Intl.PluralRules ({ one, other }), and
//                           values.count picks the form. A key that the language lacks takes the English text and logs
//                           a warning, because a translation can wait (i18n/README.md). A key that English lacks gives
//                           the key itself and logs an error, and so does a missing value: the tests catch both.
//                           t never escapes: a caller that puts a text into HTML escapes the values it passes. A text
//                           holds no <, >, & or ", so the text itself is safe in HTML and in an attribute.
//   SkillMapI18n            { language, source, embedded, signedIn, session, newer, locale, t, textIn, has, errorText,
//                             number, date, apply, languages, choose, saved, account }
//     source                where the language came from: "address", "account", "browser" or "default" (the list above)
//     embedded              true in the embed view (the mode "embed" of the data block)
//     signedIn              true when the data block names a signed-in user: the language of the account, or the user
//                           of the start page
//     session               true on a page whose data block reads the session: every page of the app but the embed view
//     newer                 true when the page shows a choice of this browser that is newer than the language of the
//                           signed-in account. The dropdown sends it to the account and then calls saved().
//     textIn(code, key, values)  the text of a key in another language of the build, as t gives it in its own language
//     has(key)              true when English or the language of the page has the key
//     errorText(body, alt)  the text of an error answer of the server, { error, message, params } (errorText below)
//     number(x, options)    Intl.NumberFormat in the language of the page; date(d, options) Intl.DateTimeFormat
//     apply(root)           fills the static texts below root, for markup that a script adds later
//     languages()           [{ code, name }] of every catalog of the build; choose(code) keeps the choice of a language
//                           for the next load of a page, and gives false when this browser cannot keep it. On a page
//                           without the session, while this browser knows a signed-in account, the choice is newer than
//                           the account (the list above).
//     saved()               the account has the choice of this browser now, so the choice is no longer newer
//     account(signedIn)     a page that signs in or out without a new load (the account page) tells it here: true keeps
//                           that an account is signed in, false forgets the account and a newer choice
(function () {
  "use strict";
  const CATALOGS = window.SKILL_MAP_TEXTS || { en: {} };
  const STORE = "skill-map-language", ACCOUNT = "skill-map-language-account";
  const known = (code) => typeof code === "string" && Object.hasOwn(CATALOGS, code);
  const stored = () => { try { return localStorage.getItem(STORE); } catch (error) { return null; } };
  const keep = (code) => { try { localStorage.setItem(STORE, code); return true; } catch (error) { return false; } };
  // What the last page with the session said about the account: "signed-in", "newer" or null (the head of this file).
  const accountState = () => { try { return localStorage.getItem(ACCOUNT); } catch (error) { return null; } };
  const keepAccount = (state) => { try { if (state) localStorage.setItem(ACCOUNT, state); else localStorage.removeItem(ACCOUNT); } catch (error) { /* no storage */ } };
  // The data block of the server, or null on a plain web space.
  const server = (() => {
    if (typeof document === "undefined" || !document || typeof document.getElementById !== "function") return null;
    try {
      const block = document.getElementById("it-skills-server");
      const value = block && block.type === "application/json" ? JSON.parse(block.textContent) : null;
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (error) { return null; }
  })();
  const embedded = !!server && server.mode === "embed";
  const fromAddress = () => { try { return new URLSearchParams(location.search).get("lang"); } catch (error) { return null; } };
  const account = server && typeof server.language === "string" ? server.language : null;
  const signedIn = !!server && (account !== null || (!!server.user && typeof server.user === "object"));
  // A page of the app with the session: every data block but the one of the embed view, which never reads the session.
  const session = !!server && !embedded;
  // A choice on a page without the session, after the last page with the session of a signed-in account.
  const newer = session && signedIn && accountState() === "newer" && known(stored()) && stored() !== account;
  // The language of the page. Each source in order, the first one with a catalog of the build wins.
  const sources = [["address", embedded ? fromAddress() : null], ["account", newer ? null : account], ["browser", stored()], ["default", "en"]];
  const [source, language] = sources.find(([, code]) => known(code)) || ["default", "en"];
  if (!newer && known(account) && stored() !== account) keep(account);
  if (session && !newer) keepAccount(signedIn ? "signed-in" : null);
  const english = CATALOGS.en || {};
  const report = (text) => { if (typeof console !== "undefined") console.error(text); };
  const warn = (text) => { if (typeof console !== "undefined") console.warn(text); };

  const lookupIn = (code, key) => { const own = CATALOGS[code] || {}; return Object.hasOwn(own, key) ? own[key] : Object.hasOwn(english, key) ? english[key] : undefined; };
  const lookup = (key) => lookupIn(language, key);
  const has = (key) => lookup(key) !== undefined;
  const localeOf = (code) => typeof lookupIn(code, "language.locale") === "string" ? lookupIn(code, "language.locale") : code;
  const locale = localeOf(language);
  const rules = new Map();
  const pluralOf = (code, count) => {
    try {
      if (!rules.has(code)) rules.set(code, new Intl.PluralRules(localeOf(code)));
      return rules.get(code).select(count);
    } catch (error) { return count === 1 ? "one" : "other"; }
  };
  const placeholders = (text) => [...new Set((typeof text === "string" ? [text] : Object.values(text)).flatMap((form) => [...String(form).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))];

  // The text of a key in the language code, as t gives it in the language of the page.
  function textIn(code, key, values) {
    const found = lookupIn(code, key), given = values || {};
    if (found === undefined) { report("missing text: " + key); return key; }
    if (!Object.hasOwn(CATALOGS[code] || {}, key) && code !== "en") warn("no " + code + " text yet, English instead: " + key);
    const text = typeof found === "string" ? found : found[pluralOf(code, Number(given.count))] ?? found.other;
    return text.replace(/\{(\w+)\}/g, (all, name) => {
      if (Object.hasOwn(given, name) && given[name] !== undefined && given[name] !== null) return String(given[name]);
      report("missing value {" + name + "} of the text " + key);
      return all;
    });
  }
  const t = (key, values) => textIn(language, key, values);

  // The text of an error answer of the server: error.<code>.<params.variant>, else error.<code>, with the values of
  // params. A code with several texts names its text in params.variant. The answer of a server without a text in the
  // catalogs, or without a value that the text needs, keeps the message of the server, then alt.
  function errorText(body, alt = "") {
    const fallback = body && typeof body.message === "string" && body.message ? body.message : alt;
    if (!body || typeof body !== "object" || typeof body.error !== "string" || !/^[a-z][a-z0-9_]*$/.test(body.error)) return fallback;
    const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
    const variant = typeof params.variant === "string" && /^[a-z][A-Za-z0-9]*$/.test(params.variant) ? "error." + body.error + "." + params.variant : null;
    const key = [variant, "error." + body.error].find((k) => k && has(k));
    if (!key || !placeholders(lookup(key)).every((name) => Object.hasOwn(params, name))) return fallback;
    return t(key, params);
  }

  const number = (x, options) => new Intl.NumberFormat(locale, options).format(x);
  const date = (d, options) => new Intl.DateTimeFormat(locale, options).format(d);

  // An element that holds other elements keeps them: the text replaces only its first text with words, and keeps the
  // spaces around it, as in <label><input …>automatisch</label>.
  function setText(element, text) {
    if (!element.firstElementChild) { element.textContent = text; return; }
    const node = [...element.childNodes].find((n) => n.nodeType === 3 && n.data.trim());
    if (!node) { element.append(text); return; }
    const [, before, after] = node.data.match(/^(\s*)[\s\S]*?(\s*)$/);
    node.data = before + text + after;
  }
  // The versions of a text in several languages: each child of the element carries its lang.
  function versions(holder) {
    const children = [...holder.children].filter((child) => child.hasAttribute("lang"));
    const shown = children.find((child) => child.lang === language) || children.find((child) => child.lang === "en") || children[0];
    children.forEach((child) => { child.hidden = child !== shown; });
  }
  const done = new WeakSet();
  function apply(root) {
    const scope = root || document;
    const all = (selector) => [...(scope.matches && scope.matches(selector) ? [scope] : []), ...scope.querySelectorAll(selector)];
    for (const element of all("[data-i18n], [data-i18n-attr], [data-versions]")) {
      if (done.has(element)) continue;
      done.add(element);
      if (element.hasAttribute("data-versions")) versions(element);
      if (element.hasAttribute("data-i18n")) setText(element, t(element.getAttribute("data-i18n")));
      for (const pair of (element.getAttribute("data-i18n-attr") || "").split(/[;\s]+/).filter(Boolean)) {
        const at = pair.indexOf(":");
        if (at > 0) element.setAttribute(pair.slice(0, at), t(pair.slice(at + 1)));
        else report("bad data-i18n-attr: " + pair);
      }
    }
  }

  const languages = () => Object.keys(CATALOGS).map((code) => ({ code, name: typeof CATALOGS[code]["language.name"] === "string" ? CATALOGS[code]["language.name"] : code }));
  function choose(code) {
    if (!known(code) || !keep(code)) return false;
    if (!session && accountState()) keepAccount("newer");
    return true;
  }
  const saved = () => { if (accountState()) keepAccount("signed-in"); };
  const followAccount = (flag) => { if (!flag) keepAccount(null); else if (accountState() !== "newer") keepAccount("signed-in"); };

  window.SkillMapI18n = Object.freeze({ language, source, embedded, signedIn, session, newer, locale, t, textIn, has, errorText, number, date, apply,
    languages, choose, saved, account: followAccount });
  window.t = t;
  if (typeof document !== "undefined" && document && document.documentElement) {
    document.documentElement.lang = language;
    // The elements before this script are there now; the rest follow when the page is read to its end.
    apply(document);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply(document), { once: true });
  }
})();

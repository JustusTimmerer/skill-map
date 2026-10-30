// The account page: register, confirm, sign in, reset the password, manage the own maps, the teams and the
// account. It talks only to /api of the same origin. Every write sends the header X-Requested-With: it-skills;
// the browser adds the Origin header itself. Its texts come from the catalogs (i18n/README.md): assets/i18n.js runs
// first and gives t, and the text of an error answer of the server comes from SkillMapI18n.errorText.
//
// The language: a registration sends the language of the page, so the account starts with it. The account keeps its
// language, and the dropdown of the header changes it (assets/i18n.js). After a login into an account with another
// language than the page, the page keeps the language of the account in this browser and loads again in it.
"use strict";

const $ = (selector) => document.querySelector(selector);
const VISIBILITY = { private: t("account.visibility.private"), link: t("account.visibility.link"), public: t("account.visibility.public") };
const ROLE = { owner: t("account.role.owner"), editor: t("account.role.editor"), reader: t("account.role.reader") };
// A date with the time, as toLocaleString gives it, and a date, as toLocaleDateString gives it, in the language of the
// page.
const DATE_TIME = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" };
const DATE = { year: "numeric", month: "numeric", day: "numeric" };
const INVITE_KEY = "it-skills-invite";
// The strength meter: the texts of a score from 0 to 4, and of the warnings and tips of POST /api/auth/password-check.
const PASSWORD_MIN = 12;
const STRENGTH = [t("account.strength.score0"), t("account.strength.score1"), t("account.strength.score2"),
  t("account.strength.score3"), t("account.strength.score4")];
const WARNING = {
  common: t("account.strength.warn.common"), similar: t("account.strength.warn.similar"), word: t("account.strength.warn.word"),
  names: t("account.strength.warn.names"), personal: t("account.strength.warn.personal"),
  keyboard: t("account.strength.warn.keyboard"), repeat: t("account.strength.warn.repeat"),
  sequence: t("account.strength.warn.sequence"), dates: t("account.strength.warn.dates"),
};
const TIP = {
  moreWords: t("account.strength.tip.moreWords"), capitals: t("account.strength.tip.capitals"),
  substitutions: t("account.strength.tip.substitutions"), reversed: t("account.strength.tip.reversed"),
};

let me = null;       // the account of the signed-in user
let myTeams = [];    // the teams of the user, from GET /api/teams
let resetToken = "";
let confirmToken = "";
let inviteToken = "";

async function api(method, path, body) {
  const options = { method, credentials: "same-origin", headers: { "X-Requested-With": "it-skills" } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let data = null;
  if (response.status !== 204) {
    try { data = await response.json(); } catch (error) { data = null; }
  }
  if (!response.ok) {
    const error = new Error(SkillMapI18n.errorText(data, t("account.error.status", { status: response.status })));
    error.status = response.status;
    error.code = data && data.error;
    throw error;
  }
  return data;
}

function say(text, isError = false) {
  const box = $("#message");
  box.textContent = text;
  box.classList.toggle("error", isError);
  box.hidden = !text;
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([key, value]) => {
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  });
  children.forEach((child) => node.append(child));
  return node;
}

function button(text, onclick, className = "quiet") {
  return element("button", { type: "button", class: className, text, onclick });
}

function select(label, options, current, onchange) {
  const node = element("select", { "aria-label": label }, ...Object.entries(options).map(([value, text]) => {
    const option = element("option", { value, text });
    if (value === current) option.selected = true;
    return option;
  }));
  node.addEventListener("change", () => onchange(node.value));
  return node;
}

// The strength meter below the hint of a field that sets a password. Below PASSWORD_MIN characters it counts on its own.
// From there it asks the server after a pause in the typing, because the server applies its rule: the same check as for
// the new password itself, so the meter and the answer of the form always agree. personal gives the e-mail address and
// the handle of the form; without them, the server takes those of the signed-in user.
function strengthMeter(input, hint, personal = () => ({})) {
  const bar = element("span", { class: "strength-bar", "aria-hidden": "true" }, ...STRENGTH.map(() => element("span")));
  const label = element("span", { class: "strength-label" });
  const warning = element("span", { class: "strength-warning" });
  const tips = element("ul", { class: "strength-tips" });
  const box = element("div", { class: "strength", "aria-live": "polite" }, bar, label, warning, tips);
  box.hidden = true;
  hint.after(box);
  let timer = 0;
  let asked = 0;
  const show = (verdict) => {
    const missing = PASSWORD_MIN - verdict.length;
    box.dataset.score = String(verdict.score);
    box.classList.toggle("ok", !!verdict.ok);
    [...bar.children].forEach((part, index) => part.classList.toggle("on", index <= verdict.score));
    label.textContent = verdict.problem === "short" ? t("account.strength.short", { count: missing })
      : verdict.problem === "long" ? t("account.strength.long", { max: verdict.max }) : STRENGTH[verdict.score];
    warning.textContent = WARNING[verdict.warning] || "";
    tips.replaceChildren(...(verdict.tips || []).filter((id) => TIP[id]).map((id) => element("li", { text: TIP[id] })));
    box.hidden = false;
  };
  const check = () => {
    clearTimeout(timer);
    const ask = ++asked;
    const password = input.value;
    const length = [...password.normalize("NFKC")].length;
    if (!password) { box.hidden = true; return; }
    if (length < PASSWORD_MIN) { show({ problem: "short", score: 0, length }); return; }
    timer = setTimeout(async () => {
      try {
        const verdict = await api("POST", "/api/auth/password-check", { password, ...personal() });
        if (ask === asked) show({ ...verdict, length });
      } catch (error) {
        if (ask === asked) box.hidden = true;
      }
    }, 300);
  };
  input.form.addEventListener("input", check);
  input.form.addEventListener("reset", () => { clearTimeout(timer); asked += 1; box.hidden = true; });
}

// The language of the account, when this build has it and the page shows another one: the page keeps it as the choice
// of this browser and loads again. On a load, a page whose language came from the account (the data block of the server)
// already shows it, and so does a page that shows a newer choice of this browser, which goes to the account
// (SkillMapI18n.newer); afterLogin follows the account that just signed in.
function followAccount(language, afterLogin) {
  const known = typeof language === "string" && SkillMapI18n.languages().some((item) => item.code === language);
  if (!known || language === SkillMapI18n.language || (!afterLogin && (SkillMapI18n.source === "account" || SkillMapI18n.newer))) return false;
  if (!SkillMapI18n.choose(language)) return false;
  location.reload();
  return true;
}

// Runs an action, shows its message or its error.
async function act(run) {
  try {
    const text = await run();
    if (text) say(text);
  } catch (error) {
    say(error.message, true);
  }
}

// Runs a form handler, shows its message and keeps the button disabled while it runs.
function handle(form, run) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const text = await run(new FormData(form));
      if (text) say(text);
    } catch (error) {
      say(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
}

function showTab(name) {
  document.querySelectorAll("[data-tab]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.tab === name)));
  document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
}

function fromHash() {
  const match = location.hash.match(/^#(confirm|reset|forgot|register|login|invite)(?:=([A-Za-z0-9_-]+))?$/);
  return match ? { kind: match[1], token: match[2] || "" } : null;
}

// The page to go back to after the login: ?next=/<handle>/<slug> from a map whose session ended. Only a path of
// this site, so that no link sends the user elsewhere.
function nextPath() {
  const next = new URLSearchParams(location.search).get("next") || "";
  return /^\/(?![/\\])[^\s]*$/.test(next) ? next : "";
}

function remember(token) {
  inviteToken = token;
  try {
    if (token) localStorage.setItem(INVITE_KEY, token); else localStorage.removeItem(INVITE_KEY);
  } catch (error) { /* the page works without storage */ }
}

function remembered() {
  try { return localStorage.getItem(INVITE_KEY) || ""; } catch (error) { return ""; }
}

// The links in the mails: #confirm=<token>, #reset=<token>, #invite=<token> and #forgot. The start page links to
// #register and #login. The token never reaches the server as part of an address, so it stays out of its logs. An
// invitation token waits in the browser while the person signs in or registers. A confirm link opens the form that
// asks for the password of the registration, because only the link and the password together confirm an account.
async function followLink() {
  const link = fromHash();
  if (!link) return;
  if (link.kind === "confirm" && link.token) {
    confirmToken = link.token;
    $("#confirm").hidden = false;
    $("#confirm-form input[name=password]").focus();
  }
  if (link.kind === "reset" && link.token) {
    resetToken = link.token;
    $("#reset").hidden = false;
  }
  if (link.kind === "invite" && link.token) {
    history.replaceState(null, "", location.pathname);
    remember(link.token);
  }
  if (link.kind === "forgot" || link.kind === "register" || link.kind === "login") showTab(link.kind);
}

async function start() {
  document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
  inviteToken = remembered();
  wireSignedOut();
  wireSignedIn();
  wireInvitation();
  strengthMeter($("#register input[name=password]"), $("#password-hint"),
    () => ({ email: $("#register input[name=email]").value, handle: $("#register input[name=handle]").value }));
  strengthMeter($("#reset-form input[name=password]"), $("#reset-password-hint"));
  strengthMeter($("#password-form input[name=new]"), $("#new-password-hint"));
  handle($("#confirm-form"), async (data) => {
    try {
      await api("POST", "/api/auth/confirm", { token: confirmToken, password: data.get("password") });
      endConfirm();
      showTab("login");
      return t("account.confirm.done");
    } catch (error) {
      // A wrong password leaves the link valid, so the form stays. A used or old link ends it.
      if (error.code === "invalid_token") endConfirm();
      throw error;
    }
  });
  handle($("#reset-form"), async (data) => {
    await api("POST", "/api/auth/reset", { token: resetToken, password: data.get("password") });
    history.replaceState(null, "", location.pathname);
    $("#reset").hidden = true;
    $("#reset-form").reset();
    await refresh();
    return t("account.reset.done");
  });
  window.addEventListener("hashchange", () => followLink().then(refresh));
  await followLink();
  await refresh();
}

function endConfirm() {
  confirmToken = "";
  history.replaceState(null, "", location.pathname + location.search);
  $("#confirm").hidden = true;
  $("#confirm-form").reset();
}

async function refresh() {
  let account = null;
  try {
    if ((await api("GET", "/api/auth/session")).signedIn) account = await api("GET", "/api/account");
  } catch (error) {
    if (error.status !== 401) say(error.message, true);
  }
  me = account;
  if (window.SkillMapLanguage) SkillMapLanguage.signIn(!!account);
  if (account && followAccount(account.language, false)) return;
  $("#signed-out").hidden = !!account;
  $("#signed-in").hidden = !account;
  $("#who").hidden = !account;
  await showInvitation();
  if (!account) return;
  $("#who").textContent = t("account.who", { handle: account.handle, email: account.email });
  // The path address leads. The subdomain is an option of the host, so it shows only as a second address.
  $("#profile").href = account.profileUrl;
  $("#profile").textContent = t("account.profile.linkTo", { address: account.profileUrl });
  $("#profile-site").hidden = !account.siteUrl;
  if (account.siteUrl) {
    $("#profile-site").href = account.siteUrl;
    $("#profile-site").textContent = t("account.profile.alsoAt", { address: account.siteUrl });
  }
  await loadTeams();
  await loadMaps();
}

function wireSignedOut() {
  handle($("#login"), async (data) => {
    const session = await api("POST", "/api/auth/login", { email: data.get("email"), password: data.get("password") });
    $("#login").reset();
    const language = session && session.language;
    if (nextPath()) {
      if (typeof language === "string" && language !== SkillMapI18n.language) SkillMapI18n.choose(language);
      location.href = nextPath();
      return t("account.login.doneOpening");
    }
    if (followAccount(language, true)) return t("account.login.done");
    await refresh();
    return t("account.login.done");
  });
  handle($("#register"), async (data) => {
    await api("POST", "/api/auth/register", {
      email: data.get("email"), handle: data.get("handle"), password: data.get("password"), language: SkillMapI18n.language,
    });
    $("#register").reset();
    return t("account.checkMail");
  });
  handle($("#forgot"), async (data) => {
    await api("POST", "/api/auth/reset-request", { email: data.get("email") });
    return t("account.checkMail");
  });
}

function wireSignedIn() {
  $("#logout").addEventListener("click", async () => {
    await api("POST", "/api/auth/logout").catch(() => null);
    await refresh();
    say(t("account.logout.done"));
  });
  handle($("#new-map"), async (data) => {
    const map = await newMap(data.get("title"), data.get("template"), null);
    $("#new-map").reset();
    await loadMaps();
    return t("account.newMap.done", { title: map.title });
  });
  handle($("#import"), async (data) => {
    const map = await api("POST", "/api/maps/import", await data.get("file").text());
    $("#import").reset();
    await loadMaps();
    return t("account.import.done", { title: map.title });
  });
  handle($("#new-team"), async (data) => {
    const team = await api("POST", "/api/teams", { name: data.get("name"), handle: data.get("handle") });
    $("#new-team").reset();
    await loadTeams();
    await loadMaps();
    return t("account.newTeam.done", { name: team.name });
  });
  handle($("#password-form"), async (data) => {
    await api("POST", "/api/account/password", { current: data.get("current"), new: data.get("new") });
    $("#password-form").reset();
    return t("account.password.done");
  });
  handle($("#delete-form"), async (data) => {
    if (!confirm(t("account.delete.confirm"))) return "";
    await api("POST", "/api/account/delete", { password: data.get("password") });
    $("#delete-form").reset();
    await refresh();
    return t("account.delete.done");
  });
}

// A new map of the user, or of a team with its handle: with a template of the start page (/assets/templates.js), such
// as the default set with its names in the language of the page, it is an import of a map file. Without the templates
// it is empty.
async function newMap(title, templateName, team) {
  const template = window.SkillMapTemplates && window.SkillMapTemplates.map(templateName);
  if (!template) return api("POST", "/api/maps", team ? { title, team } : { title });
  const file = { format: "it-skills-map", schema: 1, title, exportedAt: new Date().toISOString(), collections: template.collections };
  return api("POST", "/api/maps/import" + (team ? "?team=" + encodeURIComponent(team) : ""), file);
}

// The choice of a template, the same in the form of a personal map and of a team map.
function templateChoice() {
  return $("#new-map select[name=template]").cloneNode(true);
}

// --- Invitations ---------------------------------------------------------------------------------------

function wireInvitation() {
  $("#accept-invitation").addEventListener("click", () => act(async () => {
    const team = await api("POST", "/api/invitations/accept", { token: inviteToken });
    remember("");
    await refresh();
    return t("account.invitation.joined", { team: team.name, role: ROLE[team.role] });
  }));
  $("#dismiss-invitation").addEventListener("click", () => {
    remember("");
    $("#invitation").hidden = true;
  });
}

// Shows the team and the role of a waiting invitation first. Accepting needs a session.
async function showInvitation() {
  const box = $("#invitation");
  if (!inviteToken) { box.hidden = true; return; }
  try {
    const invitation = await api("POST", "/api/invitations/lookup", { token: inviteToken });
    const values = { team: invitation.team.name, handle: invitation.team.handle, role: ROLE[invitation.role],
      expires: SkillMapI18n.date(new Date(invitation.expires), DATE_TIME) };
    let text = invitation.invitedBy
      ? t("account.invitation.fromInviter", { ...values, inviter: invitation.invitedBy })
      : t("account.invitation.fromNobody", values);
    if (invitation.memberRole) text += " " + t("account.invitation.alreadyMember", { role: ROLE[invitation.memberRole] });
    $("#invitation-text").textContent = text;
    $("#accept-invitation").hidden = !me || !!invitation.memberRole;
    $("#invitation-login").hidden = !!me;
    box.hidden = false;
  } catch (error) {
    remember("");
    box.hidden = true;
    say(error.message, true);
  }
}

// --- Maps ----------------------------------------------------------------------------------------------

async function loadMaps() {
  const { maps } = await api("GET", "/api/maps");
  $("#maps").replaceChildren(...maps.map((map) => mapItem(map, { canEdit: true, canShare: true, reload: loadMaps })));
  $("#no-maps").hidden = maps.length > 0;
}

// A change of a dropdown that did not save: the dropdown shows the saved value again, also when the reload of the list
// fails too, and the error of the change shows (act).
async function notSaved(node, value, reload, error) {
  node.value = value;
  await reload().catch(() => {});
  throw error;
}

// One map with the actions that the role allows: canEdit (rename, delete), canShare (visibility, links).
// A personal map can also move into a team in which the user is owner or editor.
function mapItem(map, { canEdit, canShare, reload }) {
  const shares = element("div", { class: "shares", hidden: "" });
  if (canShare && openShares.has(map.id)) { shares.hidden = false; drawShares(map, shares, reload); }
  const actions = element("div", { class: "actions" });
  if (canShare) {
    const visibility = select(t("account.map.visibilityLabel"), VISIBILITY, map.visibility, (value) => act(async () => {
      try { await api("PATCH", "/api/maps/" + map.id, { visibility: value }); } catch (error) { return notSaved(visibility, map.visibility, reload, error); }
      await reload();
      return t("account.map.visibilityDone", { visibility: VISIBILITY[value] });
    }));
    actions.append(visibility);
  }
  if (canEdit) {
    actions.append(button(t("account.map.rename"), () => act(async () => {
      const title = prompt(t("account.map.renamePrompt"), map.title);
      if (!title || title === map.title) return "";
      await api("PATCH", "/api/maps/" + map.id, { title });
      await reload();
      return "";
    })));
  }
  if (canShare) actions.append(button(t("account.map.links"), () => toggleShares(map, shares, reload)));
  actions.append(element("a", { href: "/api/maps/" + map.id + "/export", download: map.slug + ".json", text: t("account.map.export") }));
  if (canEdit) {
    actions.append(button(t("account.map.delete"), () => act(async () => {
      if (!confirm(t("account.map.deleteConfirm", { title: map.title }))) return "";
      await api("DELETE", "/api/maps/" + map.id);
      await reload();
      return t("account.map.deleted");
    })));
  }
  const targets = map.ownerType === "user" ? myTeams.filter((team) => team.canEdit) : [];
  if (targets.length) {
    const choices = { "": t("account.map.moveChoice") };
    targets.forEach((team) => { choices[team.handle] = team.name + " (" + team.handle + ")"; });
    const mover = select(t("account.map.moveLabel"), choices, "", (handle) => act(async () => {
      if (!handle) return "";
      const team = targets.find((item) => item.handle === handle);
      // Every move makes the map private, with embedding off, and ends its links (his decision "Always arrive private").
      if (!confirm(t("account.map.moveConfirm", { title: map.title, team: team.name }))) { await reload(); return ""; }
      try { await api("POST", "/api/maps/" + map.id + "/move", { team: handle }); } catch (error) { return notSaved(mover, "", reload, error); }
      await loadMaps();
      await loadTeams();
      return t("account.map.moved", { title: map.title, team: team.name });
    }));
    actions.append(mover);
  }
  // The path address leads, also for a public map: the subdomain is an option of the host (the dialog "Share" names it).
  const address = map.pageUrl;
  const details = [VISIBILITY[map.visibility], t("account.map.version", { version: map.version })];
  // The start map shows at the address of its owner (the dialog "Share" sets it).
  if (map.start) details.push(t("account.map.start"));
  // A map has one read link at most, and a private map pauses it.
  if (canShare && map.shares) details.push(map.visibility === "private" ? t("account.map.linkPaused") : t("account.map.linkOn"));
  return element("li", {},
    element("a", { class: "title", href: address, text: map.title }),
    element("span", { class: "meta", text: details.join(" · ") }),
    actions, shares);
}

// The maps whose box of the read link is open, so that it stays open when the list draws itself again, and the maps
// whose link was just renewed, for the note above the new link.
const openShares = new Set();
const renewedShares = new Set();

async function toggleShares(map, box, reload) {
  if (!box.hidden) { box.hidden = true; openShares.delete(map.id); return; }
  box.hidden = false;
  openShares.add(map.id);
  await drawShares(map, box, reload);
}

// The read link of a map: a map has at most one (his decision of 2026-10-19). The server keeps it, so the box shows it
// every time to copy again, with its date. A new link revokes the old one, so the button asks first, in a second step
// inside the box: the old link stops working at once, also in frames on other websites. After a new link the list
// draws itself again, because a private map becomes "link".
async function drawShares(map, box, reload) {
  const renewed = renewedShares.delete(map.id);
  try {
    const { shares, visibility } = await api("GET", "/api/maps/" + map.id + "/shares");
    const link = shares.find((share) => share.mode === "read") || null;
    // A POST gives the link that the map has. Only "Revoke and generate new link" sends replace (server/API.md).
    const make = async () => {
      await api("POST", "/api/maps/" + map.id + "/shares", link ? { replace: true } : undefined);
      if (link) renewedShares.add(map.id);
      await reload();
      return "";
    };
    if (!link) {
      box.replaceChildren(element("span", { text: t("account.shares.none") }),
        element("div", {}, button(t("account.shares.create"), () => act(make), "")));
      return;
    }
    const field = element("input", { readonly: "", value: link.url, "aria-label": t("account.shares.label"), onfocus: (event) => event.target.select() });
    const copy = button(t("account.shares.copy"), async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(link.url); ok = true; } catch (error) { try { field.select(); ok = document.execCommand("copy"); } catch (error2) { ok = false; } }
      copy.textContent = ok ? t("account.shares.copied") : t("account.shares.copyByHand");
      setTimeout(() => { copy.textContent = t("account.shares.copy"); }, 1600);
    });
    const renew = button(t("account.shares.renew"), () => { ask.hidden = false; renew.hidden = true; no.focus(); });
    const yes = button(t("account.shares.renewConfirm"), () => {
      yes.disabled = true;
      return act(async () => { try { return await make(); } finally { yes.disabled = false; } });
    }, "danger");
    const no = button(t("account.shares.renewCancel"), () => { ask.hidden = true; renew.hidden = false; renew.focus(); });
    const ask = element("div", { class: "ask", hidden: "" },
      element("span", { role: "alert", text: t("account.shares.renewWarning") }), element("div", { class: "row" }, yes, no));
    box.replaceChildren(...[
      renewed ? element("span", { role: "status", text: t("account.shares.renewed") }) : null,
      element("div", { class: "row" }, field, copy),
      element("span", { class: "muted", text: t("account.shares.created", { date: SkillMapI18n.date(new Date(link.created), DATE_TIME) }) }),
      visibility === "private" ? element("span", { text: t("account.shares.private") }) : null,
      element("div", {}, renew), ask,
    ].filter(Boolean));
  } catch (error) {
    say(error.message, true);
  }
}

// --- Teams ---------------------------------------------------------------------------------------------

const openTeams = new Set();

async function loadTeams() {
  ({ teams: myTeams } = await api("GET", "/api/teams"));
  $("#team-list").replaceChildren(...myTeams.map(teamItem));
  $("#no-teams").hidden = myTeams.length > 0;
}

function teamItem(team) {
  const box = element("div", { class: "team", hidden: "" });
  const item = element("li", {},
    element("span", { class: "title", text: team.name + " (" + team.handle + ")" }),
    element("span", { class: "meta", text: [t("account.team.yourRole", { role: ROLE[team.role] }),
      t("account.team.memberCount", { count: team.members }), t("account.team.mapCount", { count: team.maps })].join(" · ") }),
    element("div", { class: "actions" }, button(openTeams.has(team.handle) ? t("account.team.close") : t("account.team.open"), (event) => {
      const open = box.hidden;
      box.hidden = !open;
      event.target.textContent = open ? t("account.team.close") : t("account.team.open");
      if (open) { openTeams.add(team.handle); drawTeam(team, box); } else openTeams.delete(team.handle);
    })),
    box);
  if (openTeams.has(team.handle)) { box.hidden = false; drawTeam(team, box); }
  return item;
}

async function reloadTeam(team, box) {
  await loadTeams();
  const fresh = myTeams.find((item) => item.handle === team.handle);
  if (!fresh) openTeams.delete(team.handle);
  return fresh;
}

async function drawTeam(team, box) {
  try {
    const path = "/api/teams/" + encodeURIComponent(team.handle);
    const [view, { maps }] = await Promise.all([api("GET", path), api("GET", path + "/maps")]);
    const invitations = view.canManage ? (await api("GET", path + "/invitations")).invitations : [];
    const reload = () => reloadTeam(team, box);
    const children = [
      element("p", {}, element("a", { href: view.profileUrl, text: t("account.team.publicPage") }),
        ...(view.siteUrl ? [" · ", element("a", { href: view.siteUrl, text: t("account.profile.alsoAt", { address: view.siteUrl }) })] : [])),
      element("h3", { text: t("account.team.membersHeading") }),
      element("ul", { class: "plain" }, ...view.members.map((member) => memberItem(view, member, reload))),
      element("h3", { text: t("account.team.mapsHeading") }),
    ];
    children.push(maps.length
      ? element("ul", { class: "maps" }, ...maps.map((map) => mapItem(map, { canEdit: view.canEdit, canShare: view.canManage, reload })))
      : element("p", { text: t("account.team.noMaps") }));
    if (view.canEdit) children.push(newTeamMapForms(view, reload));
    if (view.canManage) children.push(...inviteParts(view, invitations, reload), ...manageParts(view, reload));
    box.replaceChildren(...children);
  } catch (error) {
    say(error.message, true);
  }
}

function memberItem(team, member, reload) {
  const path = "/api/teams/" + encodeURIComponent(team.handle) + "/members/" + encodeURIComponent(member.handle);
  const isMe = me && member.handle === me.handle;
  const parts = [element("span", { text: member.handle + (isMe ? " " + t("account.member.you") : "") + " · " })];
  if (team.canManage) {
    const roles = select(t("account.member.roleLabel", { handle: member.handle }), ROLE, member.role, (role) => act(async () => {
      try { await api("PATCH", path, { role }); } catch (error) { return notSaved(roles, member.role, reload, error); }
      await reload();
      return t("account.member.roleDone", { handle: member.handle, role: ROLE[role] });
    }));
    parts.push(roles);
  } else {
    parts.push(element("span", { text: ROLE[member.role] }));
  }
  if (isMe) {
    parts.push(button(t("account.member.leave"), () => act(async () => {
      if (!confirm(t("account.member.leaveConfirm", { team: team.name }))) return "";
      await api("DELETE", path);
      openTeams.delete(team.handle);
      await refresh();
      return t("account.member.left", { team: team.name });
    })));
  } else if (team.canManage) {
    parts.push(button(t("account.member.remove"), () => act(async () => {
      if (!confirm(t("account.member.removeConfirm", { handle: member.handle }))) return "";
      await api("DELETE", path);
      await reload();
      return t("account.member.removed", { handle: member.handle });
    })));
  }
  return element("li", {}, ...parts);
}

function newTeamMapForms(team, reload) {
  const handleParam = encodeURIComponent(team.handle);
  const create = element("form", { class: "row" },
    element("label", { class: "grow" }, t("account.teamMap.label") + " ", element("input", { name: "title", required: "", maxlength: "120", placeholder: t("account.newMap.titlePlaceholder") })),
    element("label", {}, t("account.newMap.template") + " ", templateChoice()),
    element("button", { type: "submit", text: t("account.newMap.create") }));
  handle(create, async (data) => {
    const map = await newMap(data.get("title"), data.get("template"), team.handle);
    await reload();
    return t("account.teamMap.done", { title: map.title });
  });
  const upload = element("form", { class: "row" },
    element("label", { class: "grow" }, t("account.teamImport.label") + " ", element("input", { name: "file", type: "file", accept: ".json,application/json", required: "" })),
    element("button", { type: "submit", text: t("account.import.submit") }));
  handle(upload, async (data) => {
    const map = await api("POST", "/api/maps/import?team=" + handleParam, await data.get("file").text());
    await reload();
    return t("account.teamImport.done", { title: map.title });
  });
  return element("div", {}, create, upload);
}

function inviteParts(team, invitations, reload) {
  const path = "/api/teams/" + encodeURIComponent(team.handle) + "/invitations";
  const form = element("form", {},
    element("h3", { text: t("account.invite.heading") }),
    element("label", {}, t("account.field.email") + " ", element("input", { name: "email", type: "email", required: "" })),
    element("label", {}, t("account.invite.role") + " ", select(t("account.invite.role"), ROLE, "reader", () => null)),
    element("small", { text: t("account.invite.hint") }),
    element("button", { type: "submit", text: t("account.invite.submit") }));
  form.querySelector("select").name = "role";
  handle(form, async (data) => {
    await api("POST", path, { email: data.get("email"), role: data.get("role") });
    await reload();
    return t("account.invite.sent");
  });
  const list = invitations.length
    ? element("ul", { class: "plain" }, ...invitations.map((invitation) => element("li", {},
      invitation.email + " · " + ROLE[invitation.role] + " · " + t("account.invitations.until", { date: SkillMapI18n.date(new Date(invitation.expires), DATE) }) + " ",
      button(t("account.invitations.withdraw"), () => act(async () => {
        await api("DELETE", path + "/" + invitation.id);
        await reload();
        return t("account.invitations.withdrawn", { email: invitation.email });
      })))))
    : element("p", { text: t("account.invitations.none") });
  return [form, element("h3", { text: t("account.invitations.heading") }), list];
}

function manageParts(team, reload) {
  const path = "/api/teams/" + encodeURIComponent(team.handle);
  const rename = element("form", {},
    element("h3", { text: t("account.manage.renameHeading") }),
    element("label", {}, t("account.team.name") + " ", element("input", { name: "name", required: "", maxlength: "100", value: team.name })),
    element("label", {}, t("account.manage.handle") + " ", element("input", { name: "handle", required: "", minlength: "3", maxlength: "30", value: team.handle })),
    element("button", { type: "submit", text: t("account.manage.save") }));
  handle(rename, async (data) => {
    const changed = await api("PATCH", path, { name: data.get("name"), handle: data.get("handle") });
    if (changed.handle !== team.handle) { openTeams.delete(team.handle); openTeams.add(changed.handle); }
    await loadTeams();
    // The own maps offer the teams as targets of a move, so they need the new name and handle too.
    await loadMaps();
    return t("account.manage.saved");
  });
  const remove = element("form", {},
    element("h3", { text: t("account.manage.deleteHeading") }),
    element("p", { text: t("account.manage.deleteText") }),
    element("label", {}, t("account.manage.password") + " ", element("input", { name: "password", type: "password", autocomplete: "current-password", required: "" })),
    element("button", { type: "submit", class: "danger", text: t("account.manage.deleteSubmit") }));
  handle(remove, async (data) => {
    if (!confirm(t("account.manage.deleteConfirm", { team: team.name }))) return "";
    await api("POST", path + "/delete", { password: data.get("password") });
    openTeams.delete(team.handle);
    await refresh();
    return t("account.manage.deleted", { team: team.name });
  });
  return [rename, remove];
}

start();

// The embed view of a map: a compact reader for a frame on another site, for example a CV page or the page of a team.
// The server sends the map page at /e/<handle>/<slug> (a public map) and at /e/s/<token> (a share link), see
// server/README.md. Its runtime (assets/runtime-server.js) then offers features.embed = { theme, panel, open, site } in
// window.SKILL_MAP_RUNTIME. The runtime of stage a never offers it, so on its pages this file does nothing.
//
// The view keeps the map, the search, the area filter, zoom and the details of a clicked skill. It hides the subtitle,
// the button "Projekte", the time range, the save state, the dropdown of the languages and the hint below the map. Its
// language comes from the parameter lang of its address (assets/i18n.js). It adds one link, "Auf <site>
// öffnen", which opens the full map in a new tab. The runtime adds no other link and no write control.
//
//   theme  "light" or "dark" fixes the colors, "auto" follows the system of the reader.
//   panel  true shows the panel beside the map. false, and every frame up to 760 px wide, shows the details of a
//          clicked skill over the map instead, with a button that closes them.
//
// A frame sits in a longer page, so a turn of the mouse wheel over the map scrolls that page and the map says how to
// zoom. Ctrl or ⌘ with the wheel zooms the map at the step of its own page, and so do a pinch on a touchpad and the
// buttons + and −.
//
// Every text comes from the catalogs (i18n/*/site.json) through t.
(function () {
  "use strict";
  const STYLE = [
    ".embed header{padding:8px 12px;gap:6px 10px}",
    ".embed .brand{flex:1 1 120px}",
    ".embed .brand h1{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".embed #subtitle,.embed #projects-btn,.embed #save-state,.embed #timebar,.embed .hint,.embed #cfg,.embed #cfg-show,.embed #editbar,.embed .language{display:none!important}",
    ".embed .search input{width:170px}",
    ".embed-open{position:absolute;z-index:2;left:8px;bottom:8px;font:12px/1.3 var(--font-ui,system-ui,sans-serif);color:var(--muted);text-decoration:none;"
      + "background:color-mix(in srgb,var(--surface) 90%,transparent);border:1px solid var(--line);border-radius:6px;padding:3px 8px}",
    ".embed-open:hover,.embed-open:focus-visible{color:var(--ink);border-color:var(--muted)}",
    ".embed-open:focus-visible{outline:2px solid var(--c-sd);outline-offset:2px}",
    ".embed-wheel{position:absolute;z-index:2;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;font:13px/1.3 var(--font-ui,system-ui,sans-serif);"
      + "color:var(--surface);background:color-mix(in srgb,var(--ink) 84%,transparent);border-radius:8px;padding:8px 12px;opacity:0;transition:opacity .2s}",
    ".embed-wheel.on{opacity:1}",
    ".embed-close{display:none}",
    // The details over the map.
    ".embed-over main{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);position:relative}",
    ".embed-over .side{position:absolute;z-index:4;top:8px;right:8px;bottom:8px;width:min(340px,calc(100% - 16px));display:none;"
      + "border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.18)}",
    ".embed-over.embed-detail .side{display:grid}",
    ".embed-over aside{border:0;padding-right:44px}",
    ".embed-over .embed-close{display:block;position:absolute;z-index:1;top:8px;right:8px;padding:0 9px;font-size:18px;line-height:1.5}",
  ].join("\n");

  function start() {
    let options = null;
    const runtime = window.SKILL_MAP_RUNTIME;
    options = runtime && runtime.features ? runtime.features.embed : null;
    const root = document.documentElement, map = document.getElementById("map"), panel = document.getElementById("panel");
    if (!options || typeof options !== "object" || !map || !panel) return;
    const make = (tag, props) => Object.assign(document.createElement(tag), props);
    root.classList.add("embed");
    if (options.theme === "light" || options.theme === "dark") root.dataset.theme = options.theme;
    document.head.appendChild(make("style", { textContent: STYLE }));

    // The only link: the full map in a new tab, so the page around the frame stays.
    const area = map.parentElement;
    area.appendChild(make("a", { className: "embed-open", id: "embed-open", href: options.open, target: "_blank", rel: "noopener",
      textContent: t("embed.openOn", { site: options.site }) }));

    // The details over the map, while the panel shows a skill, a category, an area, a station or a project.
    const narrow = matchMedia("(max-width: 760px)");
    const over = () => root.classList.toggle("embed-over", options.panel === false || narrow.matches);
    narrow.addEventListener("change", over);
    over();
    const close = make("button", { type: "button", className: "embed-close", id: "embed-close", textContent: "×" });
    close.setAttribute("aria-label", t("embed.closeDetails"));
    close.addEventListener("click", () => { const back = panel.querySelector(".back"); if (back) back.click(); });
    panel.parentElement.prepend(close);
    const detail = () => root.classList.toggle("embed-detail", !!panel.querySelector(".back"));
    new MutationObserver(detail).observe(panel, { childList: true });
    detail();

    // The mouse wheel scrolls the page around the frame. With Ctrl or ⌘ it zooms the map, at the step of a wheel
    // without a key: d3 zooms ten times faster with Ctrl, because it takes that for a pinch.
    const hint = make("div", { className: "embed-wheel", id: "embed-wheel",
      textContent: t("embed.wheelHint", { key: /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : t("embed.ctrlKey") }) });
    hint.setAttribute("aria-hidden", "true");
    area.appendChild(hint);
    let hintTimer = 0;
    window.addEventListener("wheel", (event) => {
      if (!event.isTrusted || !(event.target instanceof Element) || !map.contains(event.target)) return;
      // A pinch on a touchpad comes as Ctrl with small steps: the map zooms with it as on its own page.
      if (event.ctrlKey && event.deltaMode === 0 && Math.abs(event.deltaY) < 50) return;
      event.stopPropagation();
      if (!event.ctrlKey && !event.metaKey) {
        hint.classList.add("on");
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => hint.classList.remove("on"), 1500);
        return;
      }
      event.preventDefault();
      hint.classList.remove("on");
      event.target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY,
        deltaZ: event.deltaZ, deltaMode: event.deltaMode, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY }));
    }, { capture: true, passive: false });
  }

  // The runtime file sets window.SKILL_MAP_RUNTIME before the document is parsed to its end.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

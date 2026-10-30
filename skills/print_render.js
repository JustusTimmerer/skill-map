function symbolMarkup(kind, color, r) {
  if (kind === 3) return `<path d="${starPath(r, r * 0.45)}" fill="${color}" stroke="#ffffff" stroke-width="${r * 0.1}" stroke-linejoin="round"/>`;
  if (kind === 2) return `<circle r="${r}" fill="#ffffff" stroke="${color}" stroke-width="${r * 0.2}"/><path d="${starPath(r * 0.72, r * 0.32)}" fill="${color}"/>`;
  if (kind === 1) return `<circle r="${r}" fill="${color}" stroke="#ffffff" stroke-width="${r * 0.12}"/>`;
  if (kind === KI) return `<circle r="${r}" fill="#ffffff" stroke="${color}" stroke-width="${r * 0.28}" stroke-dasharray="${r * 0.62} ${r * 0.42}"/>`;
  return `<circle r="${r}" fill="#ffffff" stroke="${color}" stroke-width="${r * 0.3}"/>`;
}

const { nodes, links } = computeLayout();
const svg = d3.select("#map");
const color = (n) => COLORS[n.cluster];
const useLinks = categoryBridges(nodes, links);
const bridgeGradient = svg.append("defs");
svg.append("g").selectAll("path").data(useLinks).join("path")
  .attr("d", (l) => { const x1 = l.source.x, y1 = l.source.y, x2 = l.target.x, y2 = l.target.y, mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    return `M${x1},${y1}Q${mx - (y2 - y1) * 0.15},${my + (x2 - x1) * 0.15} ${x2},${y2}`; })
  .attr("fill", "none").attr("stroke", "#5d6a67").attr("stroke-linecap", "round")
  .attr("stroke-width", (l) => 0.4 + 2.2 * l.share).attr("stroke-opacity", (l) => 0.18 + 0.32 * l.share);
svg.append("g").selectAll("path").data(links.filter((l) => l.kind === "group" || l.kind === "area")).join("path")
  .attr("d", linkPath).attr("fill", "none").attr("stroke", (l) => color(l.source))
  .attr("stroke-width", (l) => l.kind === "area" ? 0.7 : 0.35).attr("stroke-opacity", 0.55);

const node = svg.append("g").selectAll("g").data(nodes).join("g").attr("transform", (n) => `translate(${n.x},${n.y})`);
node.each(function (n) {
  const g = d3.select(this);
  if (n.type === "area") g.append("circle").attr("r", n.r).attr("fill", color(n)).attr("stroke", "#ffffff").attr("stroke-width", 0.8);
  else if (n.type === "group") g.append("circle").attr("r", n.r).attr("fill", color(n)).attr("fill-opacity", 0.85).attr("stroke", "#ffffff").attr("stroke-width", 0.5);
  else this.insertAdjacentHTML("beforeend", symbolMarkup(n.rating, color(n), n.r));
});
// Labels sit on a white card instead of a text outline, so the PDF text layer holds every word once.
node.each(function (n) {
  const g = d3.select(this), b = labelBox({ ...n, x: 0, y: 0 });
  const top = n.type === "area" ? b.y0 : n.r + 0.4;
  g.append("rect").attr("x", -n.lw / 2 - 0.5).attr("y", top - 0.2).attr("width", n.lw + 1).attr("height", n.lh + 0.4)
    .attr("rx", 0.8).attr("fill", "#ffffff").attr("fill-opacity", 0.82);
  const size = n.type === "area" ? AREA_PT : n.type === "group" ? GROUP_PT : n.fs;
  g.append("text").attr("text-anchor", "middle").attr("y", top + size * 0.86).attr("font-size", size)
    .attr("font-weight", n.type !== "skill" || n.rating === 3 ? 700 : 400)
    .attr("fill", n.type === "skill" ? "#17201e" : color(n)).text(n.label);
});

const b = layoutBounds(nodes, 4);
svg.attr("viewBox", `${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}`).attr("preserveAspectRatio", "xMidYMid meet");
const INK = "#17201e";
document.getElementById("legend").innerHTML = [
  [3, "sehr gute Kenntnisse"], [2, "gute Kenntnisse"], [1, "Grundkenntnisse"], [KI, "mit KI eingesetzt, ohne eigene Routine"], [0, "eingesetzt, noch nicht bewertet"],
].filter(([rating]) => SKILLS.some((s) => s[2] === rating)).map(([rating, text]) => `<span><svg width="10" height="10" viewBox="-5 -5 10 10">${symbolMarkup(rating, INK, rating === 3 ? 4.6 : rating === 2 ? 3.6 : 2.6)}</svg>${text}</span>`).join("")
  + `<span><svg width="16" height="6" viewBox="0 0 16 6"><path d="M0 5Q8 -1 16 5" fill="none" stroke="#5d6a67" stroke-width="1.6" stroke-opacity="0.5"/></svg>Kategorien gemeinsam eingesetzt (Stärke nach Dauer)</span>`;
const mapWidthPt = 180 / 25.4 * 72, mapHeightPt = 129 / 25.4 * 72;
const scale = Math.min(mapWidthPt / (b.x1 - b.x0), mapHeightPt / (b.y1 - b.y0));
document.body.setAttribute("data-info", JSON.stringify({ scale, skillPt: SKILL_PT[0] * scale, w: b.x1 - b.x0, h: b.y1 - b.y0,
  useAll: links.filter((l) => l.kind === "use").length, useDrawn: useLinks.length,
  lineLength: Math.round(d3.sum(links.filter((l) => l.kind === "use" && l.w >= 2), (l) => l.weight * Math.hypot(l.source.x - l.target.x, l.source.y - l.target.y)) / (b.x1 - b.x0) * 100),
  claudeToKi: (() => { const a = nodes.find((n) => n.id === "s:Claude Code"), k = nodes.find((n) => n.id === "c:ai"), s = nodes.find((n) => n.id === "c:sd"); return Math.round(Math.hypot(a.x - k.x, a.y - k.y) / Math.hypot(a.x - s.x, a.y - s.y) * 100) / 100; })(),
  groupSpread: Math.round(d3.mean(nodes.filter((n) => n.type === "skill"), (n) => { const g = nodes.find((m) => m.id === "g:" + n.group); return Math.hypot(n.x - g.x, n.y - g.y); }) / (b.x1 - b.x0) * 1000) / 10,
  torn: (() => { const hubs = nodes.filter((n) => n.type === "group"); return nodes.filter((n) => n.type === "skill").filter((n) => hubs.reduce((best, h) => Math.hypot(n.x - h.x, n.y - h.y) < Math.hypot(n.x - best.x, n.y - best.y) ? h : best).group !== n.group).map((n) => n.label); })(),
  areaSpread: Math.round(d3.mean(nodes.filter((n) => n.type === "group"), (g) => { const a = nodes.find((m) => m.id === "c:" + g.cluster); return Math.hypot(g.x - a.x, g.y - a.y); }) / (b.x1 - b.x0) * 1000) / 10,
  areaMix: (() => { const hubs = nodes.filter((n) => n.type === "group"); let wrong = 0; nodes.filter((n) => n.type === "skill").forEach((n) => { const near = hubs.reduce((best, h) => Math.hypot(n.x - h.x, n.y - h.y) < Math.hypot(n.x - best.x, n.y - best.y) ? h : best); if (near.cluster !== n.cluster) wrong++; }); return wrong; })(),
  tsqlToDb: Math.round(Math.hypot(...(() => { const a = nodes.find((n) => n.id === "s:T-SQL"), d = nodes.find((n) => n.id === "s:MS SQL Server"); return [a.x - d.x, a.y - d.y]; })()) / (b.x1 - b.x0) * 1000) / 10 }));

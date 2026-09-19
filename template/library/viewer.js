/**
 * Library viewer runtime. Polls manifest.json + progress.json (written by
 * the import — or the fake-import driver, same contract) and renders the
 * inventory as it lands. No framework, no build step.
 *
 * Layout transcribed from the host app's Design system page: UI primitives,
 * Composite components, Typography, Design tokens — labeled preview blocks
 * on a flat white surface.
 */
const POLL_MS = 1200;
const $ = (id) => document.getElementById(id);

let lastManifest = "";
let lastProgress = "";

async function fetchJson(name) {
  const res = await fetch(`${name}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return { text: await res.text() };
}

function componentBlock(c) {
  const status =
    c.status === "extracting"
      ? `<span class="block-status">extracting…</span>`
      : c.status === "found"
        ? `<span class="block-status">queued</span>`
        : c.status === "skipped"
          ? `<span class="block-status">skipped</span>`
          : "";
  const body =
    c.status === "done" && c.file
      ? `<iframe src="${c.file}?t=${Date.now()}" style="height:${c.height ?? 160}px" loading="lazy" title="${c.name}"></iframe>`
      : c.status === "skipped"
        ? `<p class="skip-reason">${c.reason ?? ""}</p>`
        : `<div class="placeholder" style="height:${c.height ?? 160}px"></div>`;
  return `<div class="block">
    <div class="block-label"><span>${c.name}</span>${status}</div>
    ${body}
  </div>`;
}

function renderComponents(components) {
  const primitives = components.filter((c) => c.category !== "composite");
  const composites = components.filter((c) => c.category === "composite");
  $("primitives-section").hidden = primitives.length === 0;
  $("composites-section").hidden = composites.length === 0;
  $("primitives").innerHTML = primitives.map(componentBlock).join("");
  $("composites").innerHTML = composites.map(componentBlock).join("");
}

function renderType(styles) {
  $("type-section").hidden = styles.length === 0;
  $("type").innerHTML = styles
    .map(
      (s) => `<div class="type-row">
        <div class="sample" style="font-family:'${s.family}',ui-sans-serif,sans-serif;font-size:${s.size};font-weight:${s.weight};line-height:${s.lineHeight}">${s.sample ?? s.name}</div>
        <div class="specs">${s.name} · ${s.family} · ${s.size}/${s.lineHeight} · ${s.weight}</div>
      </div>`,
    )
    .join("");
}

function renderTokens(tokens) {
  $("tokens-section").hidden = tokens.length === 0;
  $("tokens").innerHTML = tokens
    .map(
      (t) => `<div class="token">
        <div class="swatch" style="background:${t.value}"></div>
        <div class="name">${t.name}</div>
        <div class="value">${t.value}</div>
      </div>`,
    )
    .join("");
}

function renderStatus(m, progress) {
  const comps = m.components ?? [];
  const doneC = comps.filter((c) => c.status === "done").length;
  const skipped = comps.filter((c) => c.status === "skipped").length;
  const parts = [];
  if ((m.tokens ?? []).length) parts.push(`Colors ✓ ${m.tokens.length}`);
  if ((m.type ?? []).length) parts.push(`Type ✓ ${m.type.length}`);
  if (comps.length) parts.push(`Components ${doneC} of ${comps.length}`);
  $("inventory").textContent = parts.join(" · ");

  const complete = Boolean(m.completedAt) || progress?.status === "complete";
  if (complete) {
    $("import-strip").setAttribute("data-done", "");
    $("done-banner").hidden = false;
    $("done-summary").textContent =
      ` ${(m.tokens ?? []).length} colors, ${(m.type ?? []).length} type styles, ` +
      `${doneC} components extracted from ${m.source ?? "your product"}` +
      `${skipped ? ` (${skipped} skipped)` : ""}.`;
  } else {
    $("import-strip").removeAttribute("data-done");
    $("activity-text").textContent = progress?.activity ?? "Working…";
  }
}

async function tick() {
  try {
    const [manifest, progress] = await Promise.all([
      fetchJson("manifest.json"),
      fetchJson("progress.json").catch(() => null),
    ]);
    const changed =
      manifest.text !== lastManifest || (progress && progress.text !== lastProgress);
    if (changed) {
      lastManifest = manifest.text;
      if (progress) lastProgress = progress.text;
      const m = JSON.parse(manifest.text);
      const p = progress ? JSON.parse(progress.text) : null;
      renderComponents(m.components ?? []);
      renderType(m.type ?? []);
      renderTokens(m.tokens ?? []);
      renderStatus(m, p);
      if (m.project) document.title = `Design system — ${m.project}`;
    }
  } catch {
    $("activity-text").textContent = "Waiting for import…";
  }
}

$("done-prompt").addEventListener("click", () => {
  navigator.clipboard?.writeText($("done-prompt").textContent ?? "");
});

tick();
setInterval(tick, POLL_MS);

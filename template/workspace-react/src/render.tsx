import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";

/**
 * One part alone, for the build's checks: `#/render/<slug>/<state>?x=&y=&w=`
 * mounts src/parts/<slug>/ in the state component.json names, at those
 * coordinates on its backdrop, the way the library's render route does
 * (docs/library-contract.md). tools/replicate.mjs renders this headlessly
 * and diffs the clip against the live page. Only the dev server reaches
 * it: main.tsx imports this module under import.meta.env.DEV, so a
 * published build carries none of it.
 */

type PartState = { name: string; props: Record<string, unknown> };
type Unit = { states: PartState[]; backdrop?: string };

const MODULES = import.meta.glob<{ default: ComponentType<Record<string, unknown>> }>("/src/parts/*/[A-Z]*.tsx");
const UNITS = import.meta.glob<{ default: Unit }>("/src/parts/*/component.json");

function parse(hash: string) {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [, slug, state] = path.split("/");
  const q = new URLSearchParams(query);
  const number = (name: string) => {
    const value = Number(q.get(name));
    return q.get(name) === null || !Number.isFinite(value) ? null : value;
  };
  return { slug: decodeURIComponent(slug ?? ""), state: decodeURIComponent(state ?? ""), x: number("x") ?? 0, y: number("y") ?? 0, width: number("w") };
}

function missing(root: HTMLElement, why: string) {
  root.innerHTML = "";
  const p = document.createElement("p");
  p.dataset.render = why;
  p.textContent = why;
  root.appendChild(p);
}

export async function renderPart(root: HTMLElement) {
  const { slug, state, x, y, width } = parse(window.location.hash);
  // The baseline route mounts nothing: the check reads the app's own
  // base styles from it.
  if (slug === "__baseline__") {
    root.dataset.render = "ok";
    return;
  }
  const moduleKey = Object.keys(MODULES).find((key) => key.startsWith(`/src/parts/${slug}/`));
  const unitLoad = UNITS[`/src/parts/${slug}/component.json`];
  if (!moduleKey || !unitLoad) return missing(root, `no part in src/parts/${slug}/`);
  const [{ default: Part }, { default: unit }] = await Promise.all([MODULES[moduleKey](), unitLoad()]);
  const look = unit.states.find((s) => s.name === state);
  if (!look) return missing(root, `no state "${state}" in src/parts/${slug}/component.json`);
  createRoot(root).render(
    <StrictMode>
      <div
        data-render="ok"
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: width ?? undefined,
          background: unit.backdrop ?? undefined,
          // A grid cell, not a line: an inline-level root would otherwise
          // sit on the page's own line height, a few pixels low, and the
          // cell stretches the root to the width it had in the product.
          display: "grid",
          alignItems: "start",
        }}
      >
        <Part {...look.props} />
      </div>
    </StrictMode>,
  );
}

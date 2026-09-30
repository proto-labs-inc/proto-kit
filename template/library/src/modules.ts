import type { ComponentType } from "react";
import type { ComponentState } from "@/library";

/**
 * The imported components on disk: src/components/<slug>/<Slug>.tsx and
 * the unit's own component.json beside it, found by globs so a new
 * component needs no registry edit. Modules are imported lazily, so
 * only the components a page shows are loaded and a half-authored one
 * never breaks the page.
 *
 * This module accepts its own hot updates. An import writes a
 * component's files while the dev server runs, and every file that
 * matches a glob is an update of the module holding it; a module that
 * does not accept the update passes it up to the app's root, which
 * reloads the page, in every open tab. The import checks components in
 * a dozen tabs at once, so a reload there aborts a dozen reads. Here
 * the update lands in place: the globs' entries are swapped for the
 * new ones, and the objects every importer holds stay the same.
 */

// Imported modules are the PascalCase files; the app's own components
// under ui/ and ai-elements/ are lowercase and never match.
export type Unit = { states: ComponentState[]; backdrop?: string };

export const MODULES = import.meta.glob<{ default: ComponentType<Record<string, unknown>> }>("/src/components/*/[A-Z]*.tsx");
export const UNITS = import.meta.glob<{ default: Unit }>("/src/components/*/component.json");

/** The module path of the component in src/components/<slug>/, whether or not the manifest names it yet. */
export function moduleOf(slug: string): string | null {
  const key = Object.keys(MODULES).find((k) => k.startsWith(`/src/components/${slug}/`));
  if (!key) return null;
  return key.slice(1);
}

/** The unit's own component.json: its states, and the colour it sat on in the product. */
export async function unitOf(slug: string): Promise<Unit | null> {
  const load = UNITS[`/src/components/${slug}/component.json`];
  if (!load) return null;
  return (await load()).default;
}

function replace<T>(into: Record<string, T>, from: Record<string, T>) {
  for (const key of Object.keys(into)) if (!(key in from)) delete into[key];
  Object.assign(into, from);
}

if (import.meta.hot) {
  import.meta.hot.accept((next) => {
    if (!next) return;
    replace(MODULES, next.MODULES as typeof MODULES);
    replace(UNITS, next.UNITS as typeof UNITS);
  });
}

import type { ComponentType } from "react";
import type { ComponentState } from "@/library";

/**
 * The imported components on disk: src/components/<slug>/<Slug>.tsx,
 * found by a glob so a new component needs no registry edit. Modules
 * are imported lazily, so only the components a page shows are loaded
 * and a half-authored one never breaks the page.
 *
 * This module accepts its own hot updates. An import writes a
 * component's files while the dev server runs, and every file that
 * matches the glob is an update of the module holding it; a module that
 * does not accept the update passes it up to the app's root, which
 * reloads the page, in every open tab. The import checks components in
 * a dozen tabs at once, so a reload there aborts a dozen reads. Here
 * the update lands in place: the glob's entries are swapped for the
 * new ones, and the object every importer holds stays the same.
 *
 * The unit's own component.json beside the module is fetched as a
 * file, not imported: the import rewrites it while render tabs are
 * open (the writer fits sizes in rounds), and the dev server's watcher
 * leaves it alone (vite.config.ts), so an import of it would go stale.
 */

// Imported modules are the PascalCase files; the app's own components
// under ui/ and ai-elements/ are lowercase and never match.
export const MODULES = import.meta.glob<{ default: ComponentType<Record<string, unknown>> }>("/src/components/*/[A-Z]*.tsx");

/**
 * The unit's own component.json: its states, each with the colour it
 * sat on in the product where that differs from the component's own
 * (a look read from another part of the page), and that backdrop, when
 * the product painted one. Read from the folder, not the manifest, so
 * a unit verifies before anything is landed.
 */
export type Unit = { states: ComponentState[]; backdrop?: string };

/** The module path of the component in src/components/<slug>/, whether or not the manifest names it yet. */
export function moduleOf(slug: string): string | null {
  const key = Object.keys(MODULES).find((k) => k.startsWith(`/src/components/${slug}/`));
  if (!key) return null;
  return key.slice(1);
}

export async function unitOf(slug: string): Promise<Unit | null> {
  const response = await fetch(`/src/components/${encodeURIComponent(slug)}/component.json?t=${Date.now()}`);
  if (!response.ok) return null;
  try {
    return (await response.json()) as Unit;
  } catch {
    return null;
  }
}

function replace<T>(into: Record<string, T>, from: Record<string, T>) {
  for (const key of Object.keys(into)) if (!(key in from)) delete into[key];
  Object.assign(into, from);
}

if (import.meta.hot) {
  import.meta.hot.accept((next) => {
    if (!next) return;
    replace(MODULES, next.MODULES as typeof MODULES);
  });
}

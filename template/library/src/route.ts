/**
 * Hash routes, so a published build under a path still opens every
 * page: "#/" is the overview, "#/c/<slug>" a component's page,
 * "#/c/<slug>/<state>" that page on one of its states (the state's
 * name URL-encoded, so a state can be sent), and
 * "#/render/<slug>/<state>?x=&y=&w=" one component in one state, alone
 * on the surface at those coordinates: what the import's fidelity
 * check renders headlessly and diffs against the product.
 */
import { useEffect, useState } from "react";

export type Placement = { x: number; y: number; width: number | null };

export type Route =
  | { page: "overview" }
  | { page: "component"; slug: string; state: string | null }
  | { page: "render"; slug: string; state: string; placement: Placement };

export function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter((p) => p !== "");
  if (parts[0] === "c" && parts[1]) {
    let state: string | null = null;
    if (parts[2]) state = decodeURIComponent(parts[2]);
    return { page: "component", slug: decodeURIComponent(parts[1]), state };
  }
  if (parts[0] === "render" && parts[1] && parts[2]) {
    const q = new URLSearchParams(query);
    const number = (name: string, fallback: number | null) => {
      const value = Number(q.get(name));
      if (q.get(name) === null || !Number.isFinite(value)) return fallback;
      return value;
    };
    return {
      page: "render",
      slug: decodeURIComponent(parts[1]),
      state: decodeURIComponent(parts[2]),
      placement: { x: number("x", 0) ?? 0, y: number("y", 0) ?? 0, width: number("w", null) },
    };
  }
  return { page: "overview" };
}

export const href = {
  overview: () => "#/",
  component: (slug: string, state?: string) => {
    const base = `#/c/${encodeURIComponent(slug)}`;
    if (state === undefined) return base;
    return `${base}/${encodeURIComponent(state)}`;
  },
  render: (slug: string, state: string) => `#/render/${encodeURIComponent(slug)}/${encodeURIComponent(state)}`,
};

/** Which page a route is on, and of what: the part a navigation changes, not a state tab. */
export function placeOf(route: Route): string {
  if (route.page === "overview") return "overview";
  return `${route.page}:${route.slug}`;
}

/**
 * The site's gallery, when the site opened the library with its
 * address in the query (?gallery=…); null when it did not, and then the
 * page shows no link rather than guessing one.
 */
export function galleryUrl(search: string = window.location.search): string | null {
  const value = new URLSearchParams(search).get("gallery");
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Which copy of the library this is, as the site says in the address it
 * framed (?serving=live|published): the live one can take requests, the
 * published copy has no import behind it, so the page never offers to ask.
 * A library opened on its own is the live one.
 */
export type Serving = "live" | "published";

export function servingCopy(search: string = window.location.search): Serving {
  if (new URLSearchParams(search).get("serving") === "published") return "published";
  return "live";
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

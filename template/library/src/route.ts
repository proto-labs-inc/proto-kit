/**
 * Hash routes, so a published build under a path still opens every
 * page: "#/" is the overview, "#/c/<slug>" a component's page, and
 * "#/render/<slug>/<state>?x=&y=&w=" one component in one state, alone
 * on the surface at those coordinates: what the import's fidelity
 * check renders headlessly and diffs against the product.
 */
import { useEffect, useState } from "react";

export type Placement = { x: number; y: number; width: number | null };

export type Route =
  | { page: "overview" }
  | { page: "component"; slug: string }
  | { page: "render"; slug: string; state: string; placement: Placement };

export function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter((p) => p !== "");
  if (parts[0] === "c" && parts[1]) return { page: "component", slug: decodeURIComponent(parts[1]) };
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
  component: (slug: string) => `#/c/${encodeURIComponent(slug)}`,
  render: (slug: string, state: string) => `#/render/${encodeURIComponent(slug)}/${encodeURIComponent(state)}`,
};

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

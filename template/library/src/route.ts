/**
 * Hash routes, so a published build under a path still opens every
 * page: "#/" is the overview, "#/c/<slug>" a component's states,
 * "#/c/<slug>/history" its hidden history.
 */
import { useEffect, useState } from "react";

export type Route =
  | { page: "overview" }
  | { page: "component"; slug: string; view: "states" | "history" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((p) => p !== "");
  if (parts[0] === "c" && parts[1]) {
    const slug = decodeURIComponent(parts[1]);
    if (parts[2] === "history") return { page: "component", slug, view: "history" };
    return { page: "component", slug, view: "states" };
  }
  return { page: "overview" };
}

export const href = {
  overview: () => "#/",
  component: (slug: string) => `#/c/${encodeURIComponent(slug)}`,
  history: (slug: string) => `#/c/${encodeURIComponent(slug)}/history`,
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

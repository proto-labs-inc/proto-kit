/**
 * Hash routes, so a published build under a path still opens every
 * page: "#/" is the overview, "#/c/<slug>" a component's page.
 */
import { useEffect, useState } from "react";

export type Route = { page: "overview" } | { page: "component"; slug: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((p) => p !== "");
  if (parts[0] === "c" && parts[1]) return { page: "component", slug: decodeURIComponent(parts[1]) };
  return { page: "overview" };
}

export const href = {
  overview: () => "#/",
  component: (slug: string) => `#/c/${encodeURIComponent(slug)}`,
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

import { useEffect, useLayoutEffect, useRef } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { tokensFor, useLibrary, type Library } from "./library";
import { usePreviewTheme } from "./theme";
import { placeOf, useRoute, type Route } from "./route";
import { paintSurface, surfaceFromTokens } from "./surface";
import { Overview } from "./pages/Overview";
import { ComponentPage } from "./pages/ComponentPage";
import { RenderPage } from "./pages/RenderPage";

export function App() {
  const load = useLibrary();
  const route = useRoute();
  const theme = usePreviewTheme();

  const tokens = load.phase === "ready" ? tokensFor(load.library.manifest, theme) : [];
  useLayoutEffect(() => {
    paintSurface(document.documentElement, surfaceFromTokens(tokens, theme), tokens);
  }, [theme, tokens]);

  // A new page starts at the top; a state tab on the same page does not
  // move, and neither does a reload (the dev server reloads the page
  // when a component's files land): the browser keeps the reading
  // position then, and this must not undo it.
  const place = placeOf(route);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) window.scrollTo(0, 0);
    opened.current = true;
  }, [place]);

  const library = load.phase === "ready" ? load.library : null;
  useEffect(() => {
    document.title = titleFor(route, library);
  }, [route, library]);

  // The tab wears the product's own icon, the one the import read from
  // the page, so the library sits among the product's tabs as one of them.
  const favicon = library?.manifest.product?.favicon ?? null;
  useEffect(() => {
    if (favicon === null) return;
    const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']") ?? document.createElement("link");
    link.rel = "icon";
    link.href = favicon;
    if (!link.parentNode) document.head.append(link);
  }, [favicon]);

  if (load.phase === "loading") {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <Shimmer className="text-sm">Opening the library</Shimmer>
      </main>
    );
  }
  if (load.phase === "unreachable") {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16 text-sm text-muted-foreground">
        The library has no manifest yet. Run the design-system import to fill it.
      </main>
    );
  }
  if (route.page === "component") {
    return <ComponentPage slug={route.slug} state={route.state} library={load.library} courier={load.courier} />;
  }
  if (route.page === "render") {
    return <RenderPage slug={route.slug} state={route.state} placement={route.placement} library={load.library} />;
  }
  return <Overview library={load.library} courier={load.courier} />;
}

/**
 * The document's title: the product's name and "Design system" on the
 * overview, and the product, the component and the state on a
 * component's page, so a state opened in a new tab is a titled page.
 */
export function titleFor(route: Route, library: Library | null): string {
  const product = library?.manifest.product?.name ?? null;
  const parts: string[] = [];
  if (product !== null) parts.push(product);
  if (route.page === "overview") {
    parts.push("Design system");
    return parts.join(" · ");
  }
  const component = library?.manifest.components.find((c) => c.slug === route.slug);
  parts.push(component?.name ?? route.slug);
  const state = route.state ?? component?.states[0]?.name ?? null;
  if (state !== null) parts.push(state);
  return parts.join(" · ");
}

import { useEffect } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useLibrary } from "./library";
import { useRoute } from "./route";
import { paintSurface, surfaceFromTokens } from "./surface";
import { Overview } from "./pages/Overview";
import { ComponentPage } from "./pages/ComponentPage";

export function App() {
  const load = useLibrary();
  const route = useRoute();

  const tokens = load.phase === "ready" ? load.library.manifest.tokens : [];
  useEffect(() => {
    paintSurface(document.documentElement, surfaceFromTokens(tokens));
  }, [tokens]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

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
    return <ComponentPage slug={route.slug} library={load.library} queue={load.queue} />;
  }
  return <Overview library={load.library} queue={load.queue} />;
}

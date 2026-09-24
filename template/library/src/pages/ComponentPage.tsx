import { ArrowLeftIcon, HistoryIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { HistoryView } from "@/components/HistoryView";
import { StateFrame } from "@/components/StateFrame";
import { componentView, type Component, type ComponentView, type Library, type QueueOutcome } from "@/library";
import { href } from "@/route";

type Props = {
  slug: string;
  view: "states" | "history";
  library: Library;
  queue: (slug: string) => Promise<QueueOutcome>;
};

export function ComponentPage({ slug, view, library, queue }: Props) {
  const { manifest, events, requests } = library;
  const component = manifest.components.find((c) => c.slug === slug);
  if (!component) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10 text-sm text-muted-foreground">
        <a href={href.overview()} className="hover:underline">Library</a> has no component called {slug}.
      </main>
    );
  }
  const look = componentView(component, events, requests);
  const moving = look.kind === "shimmer";
  return (
    <main className="mx-auto grid max-w-5xl gap-10 px-6 py-10 md:grid-cols-[1fr_12rem]">
      <div className="flex min-w-0 flex-col gap-8">
        <header className="flex flex-col gap-3">
          <a href={href.overview()} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-4" /> Library
          </a>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-medium">{component.name}</h1>
            <Badge variant="outline" className="text-muted-foreground">{component.category}</Badge>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="History"
              aria-pressed={view === "history"}
              className="ml-auto text-muted-foreground/60 aria-pressed:text-foreground"
              nativeButton={false}
              render={<a href={view === "history" ? href.component(slug) : href.history(slug)} />}
            >
              <HistoryIcon />
            </Button>
          </div>
        </header>
        {view === "history" ? (
          <HistoryView component={component} events={events} moving={moving} />
        ) : (
          <States component={component} look={look} queue={queue} />
        )}
      </div>
      <SubNavigation components={manifest.components} current={slug} view={view} />
    </main>
  );
}

function States({ component, look, queue }: { component: Component; look: ComponentView; queue: Props["queue"] }) {
  switch (look.kind) {
    case "shimmer":
      return (
        <div className="flex h-40 items-center justify-center rounded-lg bg-muted/60">
          <Shimmer className="text-sm">{look.activity}</Shimmer>
        </div>
      );
    case "skipped":
      return (
        <div className="flex flex-col gap-3">
          {look.screenshot && <img src={look.screenshot} alt={`${component.name} in the product`} className="w-full rounded-lg" />}
          <p className="text-sm text-muted-foreground">{look.reason}</p>
          <Button size="sm" variant="outline" className="self-start" onClick={() => queue(component.slug)}>
            Queue it
          </Button>
        </div>
      );
    case "preview":
      return (
        <Tabs defaultValue={component.states[0].name} className="gap-4">
          <TabsList variant="line" id="states">
            {component.states.map((state) => (
              <TabsTrigger key={state.name} value={state.name}>{state.name}</TabsTrigger>
            ))}
          </TabsList>
          {component.states.map((state) => (
            <TabsContent key={state.name} value={state.name}>
              <div className="rounded-xl p-2 ring-1 ring-foreground/10">
                <StateFrame state={state} title={component.name} />
              </div>
            </TabsContent>
          ))}
        </Tabs>
      );
  }
}

function SubNavigation({ components, current, view }: { components: Component[]; current: string; view: "states" | "history" }) {
  return (
    <nav className="hidden flex-col gap-6 text-sm md:flex">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">On this page</span>
        <a href={href.component(current)} className={linkClass(view === "states")}>States</a>
        <a href={href.history(current)} className={linkClass(view === "history")}>History</a>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Components</span>
        <ScrollArea className="max-h-[60vh]">
          <div className="flex flex-col gap-1">
            {components.map((c) => (
              <a key={c.slug} href={href.component(c.slug)} className={linkClass(c.slug === current)}>{c.name}</a>
            ))}
          </div>
        </ScrollArea>
      </div>
    </nav>
  );
}

function linkClass(active: boolean): string {
  if (active) return "text-foreground";
  return "text-muted-foreground hover:text-foreground";
}

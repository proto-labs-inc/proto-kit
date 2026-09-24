import { ArrowLeftIcon, ChevronDownIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { HistoryView } from "@/components/HistoryView";
import { SkippedNotice } from "@/components/SkippedNotice";
import { StateFrame } from "@/components/StateFrame";
import { componentView, type ActivityEvent, type Component, type ComponentView, type Library, type QueueOutcome } from "@/library";
import { href } from "@/route";

type Props = {
  slug: string;
  library: Library;
  queue: (slug: string) => Promise<QueueOutcome>;
};

export function ComponentPage({ slug, library, queue }: Props) {
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
          <h1 className="text-2xl font-medium">{component.name}</h1>
        </header>
        <States component={component} look={look} queue={queue} />
        <Underneath component={component} events={events} moving={moving} />
      </div>
      <SubNavigation components={manifest.components} current={slug} />
    </main>
  );
}

function States({ component, look, queue }: { component: Component; look: ComponentView; queue: Props["queue"] }) {
  switch (look.kind) {
    case "shimmer":
      return (
        <div className="flex h-40 items-center justify-center rounded-xl bg-muted/60">
          <Shimmer className="text-sm">{look.activity}</Shimmer>
        </div>
      );
    case "skipped":
      return (
        <div className="flex flex-col gap-2">
          {look.screenshot && (
            <div className="overflow-hidden rounded-xl bg-white ring-1 ring-foreground/10">
              <img src={look.screenshot} alt={`${component.name} in the product`} className="mx-auto block max-w-full" />
            </div>
          )}
          <SkippedNotice component={component} reason={look.reason} queue={queue} />
        </div>
      );
    case "preview":
      return (
        <Tabs defaultValue={component.states[0].name} className="gap-4">
          <TabsList variant="line">
            {component.states.map((state) => (
              <TabsTrigger key={state.name} value={state.name}>{state.name}</TabsTrigger>
            ))}
          </TabsList>
          {component.states.map((state) => (
            <TabsContent key={state.name} value={state.name}>
              <div className="overflow-hidden rounded-xl bg-white ring-1 ring-foreground/10">
                <StateFrame state={state} title={component.name} />
              </div>
            </TabsContent>
          ))}
        </Tabs>
      );
  }
}

/**
 * What happened underneath the component (MAA-163): the import's
 * iterations and activity for it, revealed beneath the preview rather
 * than shown on a page of its own. Open by itself while the component
 * is still moving, since that is when there is something to watch.
 */
function Underneath({ component, events, moving }: { component: Component; events: ActivityEvent[]; moving: boolean }) {
  const passes = component.history.length;
  const lines = events.filter((e) => e.component === component.slug).length;
  let summary = "nothing recorded yet";
  if (passes > 0 || lines > 0) summary = `${passes} ${passes === 1 ? "pass" : "passes"}, ${lines} activity ${lines === 1 ? "line" : "lines"}`;
  return (
    <Collapsible defaultOpen={moving} className="group/underneath">
      <CollapsibleTrigger
        render={<button type="button" className="flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground" />}
      >
        <ChevronDownIcon className="size-3.5 transition-transform group-data-[panel-open]/underneath:rotate-180" />
        <span>Underneath: {summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 rounded-xl bg-muted/50 p-5">
          <HistoryView component={component} events={events} moving={moving} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SubNavigation({ components, current }: { components: Component[]; current: string }) {
  return (
    <nav className="hidden flex-col gap-1 text-sm md:flex">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Components</span>
      <ScrollArea className="max-h-[70vh]">
        <div className="flex flex-col gap-1">
          {components.map((c) => (
            <a key={c.slug} href={href.component(c.slug)} className={linkClass(c.slug === current)}>{c.name}</a>
          ))}
        </div>
      </ScrollArea>
    </nav>
  );
}

function linkClass(active: boolean): string {
  if (active) return "text-foreground";
  return "text-muted-foreground hover:text-foreground";
}

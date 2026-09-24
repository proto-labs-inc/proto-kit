import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { Component, ComponentView, QueueOutcome } from "@/library";
import { href } from "@/route";
import { Rendered } from "./Rendered";
import { SkippedNotice } from "./SkippedNotice";

type Props = {
  component: Component;
  view: ComponentView;
  queue: (slug: string) => Promise<QueueOutcome>;
};

const PLACEHOLDER_HEIGHT = 120;

/**
 * One component on the overview, laid out the way ui.shadcn.com/blocks
 * lays out a block: a slim header line, then the preview at full width
 * in a bordered frame. Hovering the block reveals its actions; "See
 * states" opens the component's page. The preview is the component
 * itself in its default state, rendered from its module. A skipped
 * component carries its notice under the frame, not inside it.
 */
export function ComponentBlock({ component, view, queue }: Props) {
  return (
    <section id={component.slug} className="group flex scroll-mt-8 flex-col gap-2">
      <div className="flex min-h-7 items-center gap-3 text-sm">
        <a href={href.component(component.slug)} className="font-medium hover:underline">
          {component.name}
        </a>
        <Summary component={component} view={view} />
        <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {view.kind === "preview" && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Open the default state on its own"
              className="text-muted-foreground"
              nativeButton={false}
              render={<a href={href.render(component.slug, view.state.name)} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            nativeButton={false}
            render={<a href={href.component(component.slug)} />}
          >
            See states <ArrowRightIcon />
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl bg-white ring-1 ring-foreground/10">
        <Body component={component} view={view} />
      </div>
      {view.kind === "skipped" && <SkippedNotice component={component} reason={view.reason} queue={queue} />}
    </section>
  );
}

function Summary({ component, view }: { component: Component; view: ComponentView }) {
  if (view.kind !== "preview") return null;
  const n = component.states.length;
  let label = `${n} states`;
  if (n === 1) label = "1 state";
  return <span className="text-muted-foreground">{label}</span>;
}

function Body({ component, view }: { component: Component; view: ComponentView }) {
  switch (view.kind) {
    case "preview":
      return (
        <div className="p-5">
          <Rendered component={component} state={view.state} />
        </div>
      );
    case "shimmer":
      return (
        <div className="flex items-center justify-center bg-muted/60" style={{ height: PLACEHOLDER_HEIGHT }}>
          <Shimmer className="text-sm">{view.activity}</Shimmer>
        </div>
      );
    case "skipped":
      return <ProductShot component={component} screenshot={view.screenshot} />;
  }
}

/**
 * MAA-164: the real product's screenshot stands in for the states. The
 * import crops it to the component's own rect; the height cap is the
 * safety net for a crop that is not, so a page-tall shot never
 * dominates the overview.
 */
function ProductShot({ component, screenshot }: { component: Component; screenshot: string | null }) {
  if (screenshot === null) return <div className="bg-muted/60" style={{ height: PLACEHOLDER_HEIGHT }} />;
  return <img src={screenshot} alt={`${component.name} in the product`} className="mx-auto block max-h-80 max-w-full object-contain" />;
}

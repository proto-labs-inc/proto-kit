import { useState } from "react";
import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { Component, ComponentView, QueueOutcome } from "@/library";
import { href } from "@/route";
import { StateFrame } from "./StateFrame";

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
 * states" opens the component's page.
 */
export function ComponentBlock({ component, view, queue }: Props) {
  return (
    <section id={component.slug} className="group flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-3 text-sm">
        <a href={href.component(component.slug)} className="font-medium hover:underline">
          {component.name}
        </a>
        <span className="text-muted-foreground">{component.category}</span>
        <Summary component={component} view={view} />
        <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {view.kind === "preview" && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Open the default state in a new tab"
              className="text-muted-foreground"
              nativeButton={false}
              render={<a href={view.state.file} target="_blank" rel="noreferrer" />}
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
        <Body component={component} view={view} queue={queue} />
      </div>
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

function Body({ component, view, queue }: Props) {
  switch (view.kind) {
    case "preview":
      return <StateFrame state={view.state} title={component.name} />;
    case "shimmer":
      return (
        <div className="flex items-center justify-center bg-muted/60" style={{ height: PLACEHOLDER_HEIGHT }}>
          <Shimmer className="text-sm">{view.activity}</Shimmer>
        </div>
      );
    case "skipped":
      return <Skipped component={component} reason={view.reason} screenshot={view.screenshot} queue={queue} />;
  }
}

type SkippedProps = {
  component: Component;
  reason: string;
  screenshot: string | null;
  queue: (slug: string) => Promise<QueueOutcome>;
};

/** MAA-164: the real product's screenshot, one plain sentence, one button. */
function Skipped({ component, reason, screenshot, queue }: SkippedProps) {
  const [outcome, setOutcome] = useState<QueueOutcome | "asking" | null>(null);
  const ask = async () => {
    setOutcome("asking");
    setOutcome(await queue(component.slug));
  };
  let note: string | null = null;
  if (outcome === "no-import") note = "The import is not running, so nothing can take this yet.";
  return (
    <div className="flex flex-col">
      {screenshot ? (
        <img src={screenshot} alt={`${component.name} in the product`} className="mx-auto block max-w-full" />
      ) : (
        <div className="bg-muted/60" style={{ height: PLACEHOLDER_HEIGHT }} />
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-foreground/10 bg-muted/40 px-4 py-3">
        <p className="m-0 text-sm text-muted-foreground">{reason}</p>
        <div className="ml-auto flex items-center gap-3">
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
          <Button size="sm" variant="outline" onClick={ask} disabled={outcome === "asking"}>
            Queue it
          </Button>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { rebuiltNote, type Component, type ComponentView, type Courier } from "@/library";
import { href } from "@/route";
import { NotBuilt } from "./NotBuilt";
import { ProductCrop } from "./ProductCrop";
import { Rendered } from "./Rendered";

type Props = {
  component: Component;
  all: Component[];
  view: ComponentView;
  courier: Courier;
  justAdded: boolean;
};

const PLACEHOLDER_HEIGHT = 120;

/**
 * One component on the overview, laid out the way ui.shadcn.com/blocks
 * lays out a block: a slim header line, then the preview at full width
 * in a bordered frame. Hovering the block reveals its actions; "See
 * states" opens the component's page. The preview is the component
 * itself in its default state, rendered from its module; a component
 * that is not built shows the product's own crop of it, with the strip
 * that says why under the frame, not inside it.
 */
export function ComponentBlock({ component, all, view, courier, justAdded }: Props) {
  const [comparing, setComparing] = useState(false);
  const note = rebuiltNote(component, all);
  return (
    <section id={component.slug} className="group flex scroll-mt-8 flex-col gap-2">
      <div className="flex min-h-7 items-center gap-3 text-sm">
        <a href={href.component(component.slug)} className="font-medium hover:underline">
          {component.name}
        </a>
        {justAdded && <span className="text-muted-foreground">Just added</span>}
        {view.kind === "preview" && component.screenshot && (
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setComparing((was) => !was)}>
            {comparing ? "Hide the product's own" : "Compare with the product"}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {view.kind === "preview" && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Open ${component.name} in a new tab`}
              className="text-muted-foreground"
              nativeButton={false}
              render={<a href={href.component(component.slug, view.state.name)} target="_blank" rel="noreferrer" />}
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
      {note && <p className="m-0 text-sm text-muted-foreground">{note}</p>}
      <div className="overflow-hidden rounded-xl bg-white ring-1 ring-foreground/10">
        <Body component={component} view={view} />
      </div>
      {comparing && component.screenshot && (
        <div className="flex flex-col gap-1">
          <div className="overflow-hidden rounded-xl bg-white ring-1 ring-foreground/10">
            <ProductCrop name={component.name} screenshot={component.screenshot} />
          </div>
          <span className="text-xs text-muted-foreground">In the product</span>
        </div>
      )}
      {view.kind !== "preview" && <NotBuilt component={component} view={view} courier={courier} />}
    </section>
  );
}

function Body({ component, view }: { component: Component; view: ComponentView }) {
  switch (view.kind) {
    case "preview":
      return (
        <div className="p-5">
          <Rendered name={component.name} module={component.module} state={view.state} />
        </div>
      );
    case "working":
      if (view.screenshot !== null) return <ProductCrop name={component.name} screenshot={view.screenshot} />;
      return (
        <div className="flex items-center justify-center bg-muted/60" style={{ height: PLACEHOLDER_HEIGHT }}>
          <Shimmer className="text-sm">{view.activity}</Shimmer>
        </div>
      );
    case "pending":
    case "skipped":
      return <ProductCrop name={component.name} screenshot={view.screenshot} />;
  }
}

import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { rebuiltNote, type Component, type ComponentView, type Courier, type Library } from "@/library";
import { href } from "@/route";
import type { SendOutcome } from "@/courier";
import { CheckStrip } from "./Checks";
import { NotBuilt } from "./NotBuilt";
import { PLACEHOLDER_HEIGHT, ProductCrop } from "./ProductCrop";
import { Rendered } from "./Rendered";
import { Stage } from "./Stage";

type Props = {
  component: Component;
  library: Library;
  view: ComponentView;
  courier: Courier;
  justAdded: boolean;
};

type Ask = "idle" | "asking" | SendOutcome;

/**
 * One component on the overview, laid out the way ui.shadcn.com/blocks
 * lays out a block: a slim header line, then the component at full
 * width and its natural size, in a frame painted with the backdrop it
 * had in the product. Hovering the block reveals its actions; "See
 * states" opens the component's page. A built component renders from
 * its own module in its default state. One the import has not built
 * yet shows the product's own picture of it in a dashed frame, with
 * "Build it" on hover and the strip that says why under the frame, not
 * inside it. While the import reads a component a light passes over
 * its frame and the latest check shows as it lands; once built, the
 * picture develops into the real thing.
 */
export function ComponentBlock({ component, library, view, courier, justAdded }: Props) {
  const [comparing, setComparing] = useState(false);
  const [ask, setAsk] = useState<Ask>("idle");
  const send = async (call: Courier["ask"]) => {
    setAsk("asking");
    setAsk(await call(component.slug));
  };
  const note = rebuiltNote(component, library);
  const holds = view.kind === "preview" ? "component" : "picture";
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
      <Stage holds={holds} backdrop={component.backdrop}>
        <Develop key={bodyKey(view)}>
          <Body component={component} view={view} />
        </Develop>
        {view.kind === "working" && <Light />}
        {view.kind === "skipped" && ask !== "unreachable" && (
          <Button
            size="sm"
            className="absolute right-3 bottom-3 opacity-0 shadow-md transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            onClick={() => send(courier.ask)}
            disabled={ask === "asking"}
          >
            Build it
          </Button>
        )}
      </Stage>
      {comparing && component.screenshot && (
        <div className="flex flex-col gap-1">
          <Stage holds="picture" backdrop={component.backdrop}>
            <ProductCrop name={component.name} screenshot={component.screenshot} />
          </Stage>
          <span className="text-xs text-muted-foreground">In the product</span>
        </div>
      )}
      {view.kind !== "preview" && <NotBuilt component={component} view={view} courier={courier} ask={ask} onAsk={() => send(courier.ask)} onWithdraw={() => send(courier.withdraw)} />}
    </section>
  );
}

/** What the frame holds, so a change of it develops in: the built component, the latest check, the product's picture, or nothing yet. */
function bodyKey(view: ComponentView): string {
  if (view.kind === "preview") return "component";
  if (view.kind === "working" && view.latest !== null) return `check-${view.latest.screenshot}`;
  if (view.screenshot !== null) return "picture";
  return "blank";
}

/** The frame's contents come in from a blur, the way a photograph develops. */
function Develop({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, filter: "blur(10px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
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
      if (view.latest !== null) return <CheckStrip pass={view.latest} name={component.name} />;
      if (view.screenshot !== null) return <ProductCrop name={component.name} screenshot={view.screenshot} />;
      return <div style={{ height: PLACEHOLDER_HEIGHT }} />;
    case "pending":
    case "skipped":
      return <ProductCrop name={component.name} screenshot={view.screenshot} />;
  }
}

/** A light passing over the frame while the import reads the component. */
function Light() {
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-1/3"
      style={{ background: "linear-gradient(90deg, transparent, color-mix(in oklab, var(--foreground) 12%, transparent), transparent)" }}
      initial={{ left: "-35%" }}
      animate={{ left: "110%" }}
      transition={{ duration: 1.6, repeat: Infinity, repeatDelay: 0.5, ease: "easeInOut" }}
    />
  );
}

import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { activityFor, pixelsDiffer, type Component, type Library, type Pass } from "@/library";
import { Crisp } from "./ProductCrop";
import { clock } from "@/time";

type Props = { component: Component; library: Library; moving: boolean };

/**
 * Side by side with the product: the reveal beneath a component's preview (MAA-163),
 * with every pass the import made against the product, opened on the
 * finished pass with the earlier ones a step back, and the activity
 * for the component underneath. Open by itself while the component is
 * still moving, since that is when there is something to watch.
 */
export function MatchedView({ component, library, moving }: Props) {
  return (
    <Collapsible defaultOpen={moving} className="group/matched">
      <CollapsibleTrigger
        render={<button type="button" className="flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground" />}
      >
        <ChevronDownIcon className="size-4 transition-transform group-data-[panel-open]/matched:rotate-180" />
        <span className="font-medium text-foreground">Side by side with the product</span>
        <span>{summary(component)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 flex flex-col gap-10 rounded-xl bg-muted/50 p-5">
          <Passes component={component} moving={moving} />
          <Activity component={component} library={library} moving={moving} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One phrase after the heading: what the passes add up to. */
function summary(component: Component): string {
  const { history } = component;
  if (history.length === 0) {
    if (component.status === "skipped") return "not built";
    if (component.unverified) return "not checked";
    return "";
  }
  const last = history[history.length - 1];
  if (last.mismatch === 0) return `identical after ${tries(history.length)}`;
  return `${tries(history.length)}, not identical yet`;
}

function tries(n: number): string {
  if (n === 1) return "1 try";
  return `${n} tries`;
}

function Passes({ component, moving }: { component: Component; moving: boolean }) {
  const { history } = component;
  // Opens on the finished pass; a pass landing while the import runs
  // is followed only when the finished one was showing.
  const [index, setIndex] = useState(Math.max(0, history.length - 1));
  const [onLast, setOnLast] = useState(true);
  useEffect(() => {
    if (onLast) setIndex(Math.max(0, history.length - 1));
  }, [history.length, onLast]);

  if (history.length === 0) return <NoPasses component={component} moving={moving} />;
  const pass = history[Math.min(index, history.length - 1)];
  const go = (i: number) => {
    setIndex(i);
    setOnLast(i === history.length - 1);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="text-2xl font-medium tabular-nums">{pixelsDiffer(pass.mismatch)}</span>
        <span className="text-sm text-muted-foreground">
          try {index + 1} of {history.length} · <span className="tabular-nums">{clock(pass.at)}</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Earlier try" onClick={() => go(index - 1)} disabled={index === 0}>
            <ChevronLeftIcon />
          </Button>
          {history.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Try ${i + 1}`}
              onClick={() => go(i)}
              className={`size-2 rounded-full ${i === index ? "bg-foreground" : "bg-foreground/25"}`}
            />
          ))}
          <Button size="icon-sm" variant="ghost" aria-label="Later try" onClick={() => go(index + 1)} disabled={index === history.length - 1}>
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <figure className="m-0 flex flex-col gap-1">
          <Crisp src={pass.screenshot} alt={`${component.name} as the library built it, try ${index + 1}`} className={PANEL} />
          <figcaption className="text-xs text-muted-foreground">As the library built it</figcaption>
        </figure>
        <figure className="m-0 flex flex-col gap-1">
          <Difference pass={pass} index={index} />
          <figcaption className="text-xs text-muted-foreground">Against the product</figcaption>
        </figure>
      </div>
      <p className="m-0 text-sm text-muted-foreground">{pass.activity}</p>
    </div>
  );
}

/** A pass's two captures share one frame: white, at 1x, with the same ring. */
const PANEL = "flex-1 rounded-lg bg-white py-3 ring-1 ring-foreground/10";

/** The diff image, or a plain "no difference" panel when the pass was clean. */
function Difference({ pass, index }: { pass: Pass; index: number }) {
  if (pass.mismatch > 0) return <Crisp src={pass.diff} alt={`What differs from the product, try ${index + 1}`} className={PANEL} />;
  return (
    <div className={`${PANEL} flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground`}>
      <CheckIcon className="size-4" />
      No difference
    </div>
  );
}

function NoPasses({ component, moving }: { component: Component; moving: boolean }) {
  if (moving) return <Shimmer className="text-sm">Waiting for the first try</Shimmer>;
  let why = `The import recorded no check of ${component.name} against the product.`;
  if (component.unverified) why = component.unverified;
  if (component.status === "skipped" && component.reason) why = component.reason;
  return <p className="m-0 text-sm text-muted-foreground">{why}</p>;
}

function Activity({ component, library, moving }: { component: Component; library: Library; moving: boolean }) {
  const lines = activityFor(component, library);
  return (
    <Task>
      <TaskTrigger title={`Activity for ${component.name}`} />
      <TaskContent>
        {lines.length === 0 && <TaskItem>Nothing yet.</TaskItem>}
        {lines.map((event, i) => {
          const last = i === lines.length - 1;
          return (
            <TaskItem key={`${event.at}-${i}`} className="flex gap-3">
              <span className="tabular-nums text-muted-foreground/60">{clock(event.at)}</span>
              {last && moving ? <Shimmer as="span">{event.activity}</Shimmer> : <span>{event.activity}</span>}
            </TaskItem>
          );
        })}
      </TaskContent>
    </Task>
  );
}

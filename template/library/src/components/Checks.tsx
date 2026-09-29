import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { activityFor, identical, type Component, type Library, type Pass } from "@/library";
import { Crisp } from "./ProductCrop";
import { clock } from "@/time";

/**
 * A check, as one picture. The import's difference image is the
 * product's own capture with every pixel our copy gets wrong painted
 * red, so it already holds the product, our copy's misses and the
 * verdict in one frame: red fading out as the checks go on is the
 * status, and a check with no red left is identical, with nothing to
 * say. The other two layers, the product's capture and our copy, are
 * a click away in the same frame, so the eye never has to travel
 * between panels to compare.
 */

type Layer = "difference" | "product" | "copy";

const LAYERS: { layer: Layer; label: string }[] = [
  { layer: "difference", label: "Difference" },
  { layer: "product", label: "Product" },
  { layer: "copy", label: "Our copy" },
];

function source(pass: Pass, layer: Layer): string | null {
  switch (layer) {
    case "difference":
      return pass.diff;
    case "product":
      return pass.live ?? null;
    case "copy":
      return pass.screenshot;
  }
}

type PictureProps = { pass: Pass; layer: Layer; name: string; className?: string };

/** One layer of a check, at natural size, on a plain frame of its own. */
function Picture({ pass, layer, name, className = "" }: PictureProps) {
  const src = source(pass, layer);
  if (src === null) return null;
  const alt = { difference: `${name}: the product, with what our copy gets wrong in red`, product: `${name} in the product`, copy: `${name} as the library built it` }[layer];
  return <Crisp src={src} alt={alt} className={`rounded-lg bg-background py-3 ring-1 ring-foreground/10 ${className}`} />;
}

/**
 * The latest check as it lands, for a component still being read: the
 * product's capture, our copy and the difference in a row, each at
 * natural size, replaced as the next check comes in.
 */
export function CheckStrip({ pass, name }: { pass: Pass; name: string }) {
  const layers = LAYERS.filter(({ layer }) => source(pass, layer) !== null);
  return (
    <div className="flex flex-wrap gap-4 p-5">
      {layers.map(({ layer, label }) => (
        <figure key={layer} className="m-0 flex min-w-0 flex-1 flex-col gap-1">
          <Picture pass={pass} layer={layer} name={name} />
          <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

type Props = { component: Component; library: Library; moving: boolean };

/**
 * Checked against the product: the reveal beneath a component's
 * preview (MAA-163), stepping through every check the import made,
 * opened on the last one with the earlier ones a step back, and the
 * activity for the component underneath. Open by itself while the
 * component is still moving, since that is when there is something to
 * watch: each check shows the moment it lands.
 */
export function Checks({ component, library, moving }: Props) {
  return (
    <Collapsible defaultOpen={moving} className="group/checks">
      <CollapsibleTrigger
        render={<button type="button" className="flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground" />}
      >
        <ChevronDownIcon className="size-4 transition-transform group-data-[panel-open]/checks:rotate-180" />
        <span className="font-medium text-foreground">Checked against the product</span>
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

/** One phrase after the heading: what the checks add up to. */
function summary(component: Component): string {
  const { history } = component;
  if (history.length === 0) {
    if (component.status === "skipped") return "not built";
    if (component.unverified) return "not checked";
    return "";
  }
  const last = history[history.length - 1];
  if (identical(last)) return `identical after ${checks(history.length)}`;
  return `${checks(history.length)}, not identical yet`;
}

function checks(n: number): string {
  if (n === 1) return "1 check";
  return `${n} checks`;
}

function Passes({ component, moving }: { component: Component; moving: boolean }) {
  const { history } = component;
  // Opens on the last check; a check landing while the import runs is
  // followed only when the last one was showing.
  const [index, setIndex] = useState(Math.max(0, history.length - 1));
  const [onLast, setOnLast] = useState(true);
  const [layer, setLayer] = useState<Layer>("difference");
  useEffect(() => {
    if (onLast) setIndex(Math.max(0, history.length - 1));
  }, [history.length, onLast]);

  if (history.length === 0) return <NoPasses component={component} moving={moving} />;
  const pass = history[Math.min(index, history.length - 1)];
  const go = (i: number) => {
    setIndex(i);
    setOnLast(i === history.length - 1);
  };
  const showing = source(pass, layer) === null ? "difference" : layer;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="text-sm font-medium">
          Check {index + 1} of {history.length}
        </span>
        <span className="text-sm tabular-nums text-muted-foreground">{clock(pass.at)}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Earlier check" onClick={() => go(index - 1)} disabled={index === 0}>
            <ChevronLeftIcon />
          </Button>
          {history.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Check ${i + 1}`}
              onClick={() => go(i)}
              className={`size-2 rounded-full ${i === index ? "bg-foreground" : "bg-foreground/25"}`}
            />
          ))}
          <Button size="icon-sm" variant="ghost" aria-label="Later check" onClick={() => go(index + 1)} disabled={index === history.length - 1}>
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
      <Picture pass={pass} layer={showing} name={component.name} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {LAYERS.filter((l) => source(pass, l.layer) !== null).map(({ layer: l, label }) => (
          <button
            key={l}
            type="button"
            aria-pressed={l === showing}
            onClick={() => setLayer(l)}
            className={l === showing ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="m-0 text-sm text-muted-foreground">{pass.activity}</p>
    </div>
  );
}

function NoPasses({ component, moving }: { component: Component; moving: boolean }) {
  if (moving) return <Shimmer className="text-sm">Waiting for the first check</Shimmer>;
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

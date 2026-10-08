import { useState } from "react";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, CircleSlashIcon, ClockIcon, LoaderCircleIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { componentView, type Component, type ComponentView, type Library, type Manifest, type ImportStage } from "@/library";
import { href } from "@/route";
import { clock, elapsed } from "@/time";
import { usePreviewThemeControl } from "@/theme";

const STEP_NAMES = { foundations: "Foundations", core: "Core components", extended: "Extended library" };
const STEP_IDS = ["foundations", "core", "extended"] as const;

/** The same three steps stay in the sidebar throughout the import. */
export function ImportQueue({ library }: { library: Library }) {
  const { manifest } = library;
  return (
    <aside aria-label="Import progress" className="-order-1 flex flex-col gap-3 md:sticky md:top-8 md:order-none md:max-h-[calc(100vh-4rem)] md:overflow-y-auto md:self-start">
      <Finish manifest={manifest} />
      <ol className="m-0 flex list-none flex-col divide-y divide-border rounded-xl border border-border bg-background p-0 shadow-xs">
        {STEP_IDS.map((id, index) => {
          const components = manifest.components.filter((component) => componentStep(component) === id);
          const step = manifest.importStages?.find((step) => step.id === id);
          // Older libraries have no checkpoints. Only a completed import can
          // certify their steps; otherwise explicitly say progress is unknown.
          const status = step?.status ?? (manifest.completedAt ? "done" : "unknown");
          return <Step key={id} id={id} index={index} status={status} step={step} components={components} library={library} />;
        })}
      </ol>
    </aside>
  );
}

function componentStep(component: Component): "core" | "extended" {
  if (component.stage) return component.stage;
  const name = `${component.slug} ${component.name}`.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  return /(^|[\s-])(button|input|select|checkbox|radio|switch|toggle|tab|tabs|badge|menu|dropdown|dialog|modal|tooltip|textarea|text-field|form-field)([\s-]|$)/.test(name) ? "core" : "extended";
}

type StepProps = {
  id: ImportStage["id"]; index: number; status: ImportStage["status"] | "unknown";
  step?: ImportStage; components: Component[]; library: Library;
};

function Step({ id, index, status, step, components, library }: StepProps) {
  // Follow the active step until the user chooses otherwise. Their choice
  // survives manifest polling, and completed steps remain inspectable.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const done = status === "done";
  const gaps = components.filter((component) => component.status === "skipped").length;
  const summary = done ? (gaps ? `Done · ${gaps} failed or skipped` : "Done")
    : status === "waiting" ? "Waiting for the previous step"
    : status === "unknown" ? "Progress unavailable"
    : id === "foundations" ? "Importing styles in both themes"
    : `${step?.verified ?? 0} of ${step?.total ?? components.length} verified${gaps ? ` · ${gaps} failed or skipped` : ""}`;
  return (
    <li aria-current={status === "active" ? "step" : undefined}>
      <Collapsible open={expanded ?? (status === "active" || status === "unknown")} onOpenChange={setExpanded} className="group/stage">
        <CollapsibleTrigger render={<button type="button" />} className="flex w-full items-start gap-2.5 rounded-lg px-3 py-4 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px]">
          <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs ${done || status === "active" ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground"}`}>
            {done ? <CheckIcon className="size-3.5" aria-hidden="true" /> : index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">{STEP_NAMES[id]}</span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{summary}</span>
          </span>
          <ChevronDownIcon aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-closed]/stage:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {id === "foundations" ? <Foundations manifest={library.manifest} done={done} /> : (
            <ul className="m-0 flex list-none flex-col gap-2 px-3 pb-4">
              {components.map((component) => (
                <li key={component.slug} className="group/row flex flex-col gap-0.5 rounded-md px-1 py-1 text-sm hover:bg-muted">
                  <Row component={component} view={componentView(component, library)} waiting={status === "waiting" || component.status === "found"} />
                </li>
              ))}
              {components.length === 0 && <li className="px-1 text-xs text-muted-foreground">{done ? "No components in this step" : "No components listed yet"}</li>}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function Foundations({ manifest, done }: { manifest: Manifest; done: boolean }) {
  const { setTheme } = usePreviewThemeControl();
  const rows = [
    { title: "Type styles", count: manifest.type.length, target: "type-styles", theme: null, detail: manifest.type.map((style) => style.name).join(" · ") },
    { title: "Light colours", count: manifest.themes.light.length, target: "colours", theme: "light" as const, detail: "Light theme" },
    { title: "Dark colours", count: manifest.themes.dark.length, target: "colours", theme: "dark" as const, detail: "Dark theme" },
  ];
  return <ul className="m-0 flex list-none flex-col gap-3 px-4 pb-4">
    {rows.map((row) => <li key={row.title} className="text-sm">
      <button type="button" onClick={() => { if (row.theme) setTheme(row.theme); jumpTo(row.target); }} className="flex w-full items-center gap-2 text-left hover:underline">
        {done ? <CheckIcon className={MARK} aria-hidden="true" /> : <span className="size-3.5 shrink-0 rounded-full border border-muted-foreground/40" aria-hidden="true" />}
        <span className="flex-1">{row.title}</span><span className="text-xs tabular-nums text-muted-foreground">{row.count}</span>
      </button>
      <p className="m-0 ml-5.5 mt-1 text-xs leading-relaxed text-muted-foreground">{done ? "Done" : row.count ? "Imported · awaiting step verification" : "Waiting to import"}</p>
      {row.count > 0 && <p className="m-0 ml-5.5 mt-1 text-xs leading-relaxed text-muted-foreground">{row.detail}</p>}
    </li>)}
  </ul>;
}

function Finish({ manifest }: { manifest: Manifest }) {
  if (manifest.completedAt === null || manifest.startedAt === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<p className="m-0 flex cursor-default items-center gap-2 text-xs text-muted-foreground" />}
      >
        <CheckIcon className="size-3.5 shrink-0" />
        <span className="text-foreground">Finished {clock(manifest.completedAt)}</span>
        <span className="h-px flex-1 bg-border" />
      </TooltipTrigger>
      <TooltipContent align="start" side="bottom">
        Started {clock(manifest.startedAt)}, took {elapsed(manifest.startedAt, manifest.completedAt)}
      </TooltipContent>
    </Tooltip>
  );
}

function jumpTo(slug: string) {
  document.getElementById(slug)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Row({ component, view, waiting = false }: { component: Component; view: ComponentView; waiting?: boolean }) {
  return (
    <>
      <div className="flex items-center gap-2">
        {waiting && view.kind === "working" ? <ClockIcon className={MARK} /> : <Mark component={component} view={view} />}
        <button type="button" onClick={() => jumpTo(component.slug)} className="min-w-0 flex-1 truncate text-left text-foreground">
          {component.name}
        </button>
        <a
          href={href.component(component.slug)}
          aria-label={`Open ${component.name}`}
          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/10 hover:text-foreground group-hover/row:opacity-100 focus-visible:opacity-100"
        >
          <ArrowRightIcon className="size-3.5" />
        </a>
      </div>
      {waiting && view.kind === "working" ? <span className="ml-6 text-xs text-muted-foreground">Waiting to import</span> : <Description component={component} view={view} />}
    </>
  );
}

const MARK = "size-3.5 shrink-0 text-muted-foreground";

function Mark({ component, view }: { component: Component; view: ComponentView }) {
  switch (view.kind) {
    case "working":
      if (component.status === "found") return <span className="mx-0.5 inline-block size-2.5 shrink-0 rounded-full border border-muted-foreground/50" />;
      return <LoaderCircleIcon className={`${MARK} animate-spin text-foreground`} />;
    case "preview":
      return <CheckIcon className={MARK} />;
    case "pending":
      return <ClockIcon className={MARK} />;
    case "skipped":
      return <CircleSlashIcon className={MARK} />;
  }
}

/** The row's second line: the import's latest word on it, its states, or why it is not built, whole. */
function Description({ component, view }: { component: Component; view: ComponentView }) {
  const line = "ml-6 text-xs text-muted-foreground";
  switch (view.kind) {
    case "working":
      return (
        <Shimmer as="span" className={`${line} line-clamp-1`}>
          {view.activity}
        </Shimmer>
      );
    case "preview":
      return <span className={`${line} line-clamp-1`}>{component.states.map((s) => s.name).join(" · ")}</span>;
    case "pending":
      return <span className={line}>{view.sentence}</span>;
    case "skipped":
      return <span className={line}>{view.reason}</span>;
  }
}

import { AnimatePresence, motion } from "motion/react";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, CircleSlashIcon, ClockIcon, LoaderCircleIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { componentView, type Component, type ComponentView, type Library, type Manifest } from "@/library";
import { href } from "@/route";
import { clock, elapsed } from "@/time";

/**
 * The import, beside the page, in a framed panel: the components in
 * sections with a fixed title and a count ("2 Reading", "4 Built"),
 * each section folding, so nothing in the rail changes its words as
 * the import moves; a component moves from one section to the next,
 * and its row travels with it. The row being read says the import's
 * latest word on it, shimmering; a skipped row says the whole reason.
 * Each row jumps to its block, and its arrow opens its page. A
 * finished import carries the time it finished above the panel.
 */
export function ImportQueue({ library }: { library: Library }) {
  const { manifest } = library;
  const stages = byStage(library);
  return (
    <aside className="-order-1 flex flex-col gap-3 md:sticky md:top-8 md:order-none md:self-start">
      <Finish manifest={manifest} />
      {stages.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-background px-3 pt-2 pb-2 shadow-xs">
          {stages.map((stage) => (
            <Collapsible key={stage.title} defaultOpen className="group/stage">
              <CollapsibleTrigger
                render={
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
                  />
                }
              >
                <ChevronDownIcon className="size-4 transition-transform group-data-[panel-closed]/stage:-rotate-90" />
                <span className="tabular-nums text-foreground">{stage.rows.length}</span>
                {stage.title}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="m-0 mt-2 flex list-none flex-col p-0">
                  <AnimatePresence initial={false}>
                    {stage.rows.map(({ component, view }) => (
                      <motion.li
                        key={component.slug}
                        layout
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ type: "spring", stiffness: 360, damping: 34 }}
                        className="group/row flex flex-col gap-0.5 rounded-md px-3 py-1 text-sm transition-colors hover:bg-muted"
                      >
                        <Row component={component} view={view} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      )}
    </aside>
  );
}

type Stage = "Reading" | "Queued" | "Built" | "Skipped";
type StageRows = { title: Stage; rows: { component: Component; view: ComponentView }[] };

/** The stage a component's view is at; the section it sits in. */
function stageOf(view: ComponentView): Stage {
  switch (view.kind) {
    case "working":
      return "Reading";
    case "pending":
      return "Queued";
    case "preview":
      return "Built";
    case "skipped":
      return "Skipped";
  }
}

/** The stages in the order the import moves through them, only those with a component in them. */
function byStage(library: Library): StageRows[] {
  const order: Stage[] = ["Reading", "Queued", "Built", "Skipped"];
  const stages = order.map((title) => ({ title, rows: [] as StageRows["rows"] }));
  for (const component of library.manifest.components) {
    const view = componentView(component, library);
    stages.find((s) => s.title === stageOf(view))?.rows.push({ component, view });
  }
  return stages.filter((s) => s.rows.length > 0);
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

function Row({ component, view }: { component: Component; view: ComponentView }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Mark component={component} view={view} />
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
      <Description component={component} view={view} />
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

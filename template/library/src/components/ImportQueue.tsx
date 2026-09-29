import { AnimatePresence, motion } from "motion/react";
import { CheckIcon, CircleSlashIcon, ClockIcon, LoaderCircleIcon } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { componentView, skipHeading, type Component, type ComponentView, type Library, type Manifest } from "@/library";
import { clock, elapsed } from "@/time";

/**
 * The import, beside the page: the components in fixed sections that
 * count them (Reading, Queued, Built, Skipped), so nothing in the rail
 * changes its words as the import moves; a component moves from one
 * section to the next, and its row travels with it. The row being read
 * says the import's latest word on it, shimmering; a finished import
 * ends on the time it finished. Each row jumps to its card.
 */
export function ImportQueue({ library }: { library: Library }) {
  const { manifest } = library;
  const stages = byStage(library);
  return (
    <aside className="-order-1 flex flex-col gap-5 md:sticky md:top-8 md:order-none md:self-start">
      <Finish manifest={manifest} />
      {stages.map((stage) => (
        <motion.section layout key={stage.title} className="flex flex-col gap-1.5">
          <h2 className="flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
            <span className="tabular-nums text-foreground">{stage.rows.length}</span>
            {stage.title}
          </h2>
          <ul className="m-0 flex list-none flex-col p-0">
            <AnimatePresence initial={false}>
              {stage.rows.map(({ component, view }) => (
                <motion.li
                  key={component.slug}
                  layoutId={`row-${component.slug}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: "spring", stiffness: 360, damping: 34 }}
                >
                  <button
                    type="button"
                    onClick={() => jumpTo(component.slug)}
                    className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  >
                    <span className="flex items-center gap-2 text-[13px]">
                      <Mark view={view} />
                      <span className="truncate">{component.name}</span>
                    </span>
                    <Description component={component} view={view} />
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </motion.section>
      ))}
    </aside>
  );
}

type Stage = "Reading" | "Queued" | "Built" | "Skipped";
type StageRows = { title: Stage; rows: { component: Component; view: ComponentView }[] };

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
    <p
      className="m-0 flex items-center gap-2 text-xs text-muted-foreground"
      title={`Started ${clock(manifest.startedAt)}, took ${elapsed(manifest.startedAt, manifest.completedAt)}`}
    >
      <CheckIcon className="size-3.5 text-emerald-600" strokeWidth={2.5} />
      <span className="text-foreground">Finished {clock(manifest.completedAt)}</span>
      <span className="h-px flex-1 bg-border" />
    </p>
  );
}

function jumpTo(slug: string) {
  document.getElementById(slug)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const MARK = "size-3.5 shrink-0";

function Mark({ view }: { view: ComponentView }) {
  switch (view.kind) {
    case "working":
      return <LoaderCircleIcon className={`${MARK} animate-spin text-foreground`} />;
    case "preview":
      return <CheckIcon className={`${MARK} text-emerald-600`} strokeWidth={2.5} />;
    case "pending":
      return <ClockIcon className={`${MARK} text-muted-foreground`} />;
    case "skipped":
      return <CircleSlashIcon className={`${MARK} text-muted-foreground`} />;
  }
}

/** The row's second line: the import's latest word on it, its states, or why it is not built. */
function Description({ component, view }: { component: Component; view: ComponentView }) {
  const line = "line-clamp-1 pl-5.5 text-xs text-muted-foreground";
  switch (view.kind) {
    case "working":
      return (
        <Shimmer as="span" className="line-clamp-1 pl-5.5 text-xs">
          {view.activity}
        </Shimmer>
      );
    case "preview":
      return <span className={line}>{component.states.map((s) => s.name).join(" · ")}</span>;
    case "pending":
      return <span className={line}>{view.sentence}</span>;
    case "skipped":
      return <span className={line}>{`${skipHeading(view.skipKind)}: ${view.reason}`}</span>;
  }
}

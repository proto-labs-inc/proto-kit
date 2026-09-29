import { ArrowRightIcon, CheckIcon, CircleSlashIcon, ClockIcon, LoaderCircleIcon } from "lucide-react";
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { componentView, skipHeading, type Component, type ComponentView, type Library, type Manifest } from "@/library";
import { href } from "@/route";
import { clock, elapsed } from "@/time";

/**
 * The import's components as the AI Elements Queue, one section per
 * stage with a fixed title and a count ("2 Reading", "4 Built"), so
 * nothing in the rail changes its words as the import moves: a
 * component moves from one section to the next. Each row is a jump to
 * its block. A finished import carries a Checkpoint marking the end.
 * Nothing here shimmers; the header's "Importing" is the one moving
 * word on the page, and a spinner marks each component being read.
 */
export function ImportQueue({ library }: { library: Library }) {
  const { manifest } = library;
  const stages = byStage(library);
  return (
    <aside className="-order-1 flex flex-col gap-3 md:sticky md:top-8 md:order-none md:self-start">
      <Finish manifest={manifest} />
      {manifest.components.length > 0 && (
        <Queue>
          {stages.map((stage) => (
            <QueueSection key={stage.title}>
              <QueueSectionTrigger>
                <QueueSectionLabel count={stage.rows.length} label={stage.title} />
              </QueueSectionTrigger>
              <QueueSectionContent>
                <QueueList>
                  {stage.rows.map(({ component, view }) => (
                    <Row key={component.slug} component={component} view={view} />
                  ))}
                </QueueList>
              </QueueSectionContent>
            </QueueSection>
          ))}
        </Queue>
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
    <Checkpoint>
      <CheckpointIcon>
        <CheckIcon className="size-4 shrink-0" />
      </CheckpointIcon>
      <CheckpointTrigger tooltip={`Started ${clock(manifest.startedAt)}, took ${elapsed(manifest.startedAt, manifest.completedAt)}`}>
        Finished {clock(manifest.completedAt)}
      </CheckpointTrigger>
    </Checkpoint>
  );
}

function jumpTo(slug: string) {
  document.getElementById(slug)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Row({ component, view }: { component: Component; view: ComponentView }) {
  return (
    <QueueItem className="cursor-pointer" onClick={() => jumpTo(component.slug)}>
      <div className="flex items-center gap-2">
        <Mark component={component} view={view} />
        <QueueItemContent className="text-foreground">{component.name}</QueueItemContent>
        <QueueItemActions>
          <QueueItemAction
            aria-label={`Open ${component.name}`}
            nativeButton={false}
            render={<a href={href.component(component.slug)} onClick={(e) => e.stopPropagation()} />}
          >
            <ArrowRightIcon className="size-3.5" />
          </QueueItemAction>
        </QueueItemActions>
      </div>
      <QueueItemDescription className="line-clamp-1">{description(component, view)}</QueueItemDescription>
    </QueueItem>
  );
}

const MARK = "size-3.5 shrink-0 text-muted-foreground";

function Mark({ component, view }: { component: Component; view: ComponentView }) {
  switch (view.kind) {
    case "working":
      if (component.status === "found") return <QueueItemIndicator className="mx-0.5" />;
      return <LoaderCircleIcon className={`${MARK} animate-spin`} />;
    case "preview":
      return <CheckIcon className={MARK} />;
    case "pending":
      return <ClockIcon className={MARK} />;
    case "skipped":
      return <CircleSlashIcon className={MARK} />;
  }
}

/** The row's second line: the import's latest word on it, its states, or why it is not built. */
function description(component: Component, view: ComponentView): string {
  switch (view.kind) {
    case "working":
      return view.activity;
    case "preview":
      return component.states.map((s) => s.name).join(" · ");
    case "pending":
      return view.sentence;
    case "skipped":
      return `${skipHeading(view.skipKind)}: ${view.reason}`;
  }
}

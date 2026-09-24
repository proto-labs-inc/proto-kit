import { useEffect, useState } from "react";
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
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  componentView,
  importInProgress,
  latestActivity,
  type Component,
  type ComponentView,
  type Library,
  type Manifest,
} from "@/library";
import { href } from "@/route";
import { clock, elapsed } from "@/time";

/**
 * The import's live status, as the AI Elements Queue: every component
 * with its state, each row a jump to its block. While the import runs
 * the import's latest line shimmers above it and the list is open;
 * once it finishes the list folds under a Checkpoint marking the end,
 * and reopens from there or when a queued component sets it moving.
 */
export function ImportQueue({ library }: { library: Library }) {
  const { manifest, events, requests } = library;
  const running = importInProgress(library);
  const [open, setOpen] = useState(running);
  useEffect(() => setOpen(running), [running]);

  return (
    <aside className="-order-1 flex flex-col gap-3 md:sticky md:top-8 md:order-none md:self-start">
      {running ? (
        <Shimmer className="px-3 text-sm">{latestActivity(events) ?? "Starting the import"}</Shimmer>
      ) : (
        <Finish manifest={manifest} onToggle={() => setOpen((was) => !was)} />
      )}
      {manifest.components.length > 0 && (
        <Queue>
          <QueueSection open={open} onOpenChange={setOpen}>
            <QueueSectionTrigger>
              <QueueSectionLabel count={manifest.components.length} label="components" />
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                {manifest.components.map((component) => (
                  <Row key={component.slug} component={component} view={componentView(component, events, requests)} />
                ))}
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        </Queue>
      )}
    </aside>
  );
}

function Finish({ manifest, onToggle }: { manifest: Manifest; onToggle: () => void }) {
  if (manifest.completedAt === null || manifest.startedAt === null) return null;
  return (
    <Checkpoint>
      <CheckpointIcon>
        <CheckIcon className="size-4 shrink-0" />
      </CheckpointIcon>
      <CheckpointTrigger tooltip={`Started ${clock(manifest.startedAt)}, took ${elapsed(manifest.startedAt, manifest.completedAt)}`} onClick={onToggle}>
        Import complete {clock(manifest.completedAt)}
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
      <QueueItemDescription className="line-clamp-1">
        <Description view={view} states={component.states.length} />
      </QueueItemDescription>
    </QueueItem>
  );
}

const MARK = "size-3.5 shrink-0 text-muted-foreground";

function Mark({ component, view }: { component: Component; view: ComponentView }) {
  switch (component.status) {
    case "found":
      return <QueueItemIndicator className="mx-0.5" />;
    case "extracting":
      return <LoaderCircleIcon className={`${MARK} animate-spin`} />;
    case "done":
      return <CheckIcon className={MARK} />;
    case "queued":
      return <ClockIcon className={MARK} />;
    case "skipped":
      if (view.kind === "shimmer") return <ClockIcon className={MARK} />;
      return <CircleSlashIcon className={MARK} />;
  }
}

function Description({ view, states }: { view: ComponentView; states: number }) {
  switch (view.kind) {
    case "shimmer":
      return <Shimmer as="span">{view.activity}</Shimmer>;
    case "preview":
      if (states === 1) return "1 state";
      return `${states} states`;
    case "skipped":
      return `Skipped: ${view.reason}`;
  }
}

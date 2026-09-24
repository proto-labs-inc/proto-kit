import { useEffect, useState } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import type { ActivityEvent, Component } from "@/library";
import { clock } from "@/time";

const STEP_MS = 900;

type Props = { component: Component; events: ActivityEvent[]; moving: boolean };

/**
 * The hidden debug view (MAA-163): every iteration the import made of
 * this component, played in order so the mismatch visibly falls, and
 * the activity stream for it underneath.
 */
export function HistoryView({ component, events, moving }: Props) {
  const own = events.filter((e) => e.component === component.slug);
  return (
    <div className="flex flex-col gap-10">
      <Player component={component} />
      <Task>
        <TaskTrigger title={`Activity for ${component.name}`} />
        <TaskContent>
          {own.length === 0 && <TaskItem>Nothing recorded yet.</TaskItem>}
          {own.map((event, i) => {
            const last = i === own.length - 1;
            return (
              <TaskItem key={`${event.at}-${i}`} className="flex gap-3">
                <span className="tabular-nums text-muted-foreground/60">{clock(event.at)}</span>
                {last && moving ? <Shimmer as="span">{event.activity}</Shimmer> : <span>{event.activity}</span>}
              </TaskItem>
            );
          })}
        </TaskContent>
      </Task>
    </div>
  );
}

function Player({ component }: { component: Component }) {
  const { history } = component;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(history.length > 1);

  useEffect(() => {
    if (!playing) return;
    if (index >= history.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setIndex(index + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, index, history.length]);

  // A new iteration landing while the import runs: follow it.
  useEffect(() => {
    if (history.length > 0 && index > history.length - 1) setIndex(history.length - 1);
  }, [history.length, index]);

  if (history.length === 0) {
    return <p className="text-sm text-muted-foreground">No iterations recorded for {component.name}.</p>;
  }
  const iteration = history[Math.min(index, history.length - 1)];
  const replay = () => {
    setIndex(0);
    setPlaying(true);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-4">
        <span className="text-4xl font-medium tabular-nums">{iteration.mismatch.toLocaleString()}</span>
        <span className="text-sm text-muted-foreground">pixels off, iteration {index + 1} of {history.length}</span>
        <div className="ml-auto flex items-center gap-1">
          {history.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Iteration ${i + 1}`}
              onClick={() => {
                setPlaying(false);
                setIndex(i);
              }}
              className={`size-2 rounded-full ${i === index ? "bg-foreground" : "bg-foreground/25"}`}
            />
          ))}
          {playing ? (
            <Button size="icon-sm" variant="ghost" aria-label="Pause" onClick={() => setPlaying(false)}>
              <PauseIcon />
            </Button>
          ) : (
            <Button size="icon-sm" variant="ghost" aria-label="Replay" onClick={replay}>
              <PlayIcon />
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <figure className="m-0">
          <img src={iteration.screenshot} alt={`Replica, iteration ${index + 1}`} className="w-full rounded-lg ring-1 ring-foreground/10" />
          <figcaption className="mt-1 text-xs text-muted-foreground">Replica</figcaption>
        </figure>
        <figure className="m-0">
          <img src={iteration.diff} alt={`Diff, iteration ${index + 1}`} className="w-full rounded-lg ring-1 ring-foreground/10" />
          <figcaption className="mt-1 text-xs text-muted-foreground">Diff against the product</figcaption>
        </figure>
      </div>
      <p className="text-sm text-muted-foreground">
        <span className="tabular-nums text-muted-foreground/60">{clock(iteration.at)} </span>
        {iteration.activity}
      </p>
    </div>
  );
}

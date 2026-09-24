import { useState } from "react";
import { CircleSlashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Component, QueueOutcome } from "@/library";

type Props = {
  component: Component;
  reason: string;
  queue: (slug: string) => Promise<QueueOutcome>;
};

type Ask = "idle" | "asking" | QueueOutcome;

/**
 * MAA-164: the strip under a skipped component's screenshot. It is
 * about the extraction, not the component, so it sits outside the
 * frame: why the import could not build it on the left, what queueing
 * does and the button on the right.
 */
export function SkippedNotice({ component, reason, queue }: Props) {
  const [ask, setAsk] = useState<Ask>("idle");
  const send = async () => {
    setAsk("asking");
    setAsk(await queue(component.slug));
  };
  let aside = "Queueing asks the import to try again.";
  if (ask === "no-import") aside = "The import is not running, so nothing can take this yet.";
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-dashed border-foreground/20 bg-muted/50 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CircleSlashIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="text-sm">
          <p className="m-0 font-medium">Not built by the import</p>
          <p className="m-0 text-muted-foreground">{reason}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">{aside}</span>
        <Button size="sm" variant="outline" onClick={send} disabled={ask === "asking"}>
          Queue it
        </Button>
      </div>
    </div>
  );
}

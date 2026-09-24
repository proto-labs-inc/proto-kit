import { useState } from "react";
import { CircleSlashIcon, ClockIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { skipHeading, type Component, type ComponentView, type Courier } from "@/library";
import type { SendOutcome } from "@/courier";

type Props = {
  component: Component;
  view: Exclude<ComponentView, { kind: "preview" }>;
  courier: Courier;
};

type Ask = "idle" | "asking" | SendOutcome;

/**
 * The strip under a component that is not built: it is about the
 * import, not the component, so it sits outside the frame. Grouped by
 * why (the heading is the skip's kind, the sentence its reason), and
 * carrying the one pending sentence while the component is queued, or
 * the import's latest line while it is being read again.
 */
export function NotBuilt({ component, view, courier }: Props) {
  const [ask, setAsk] = useState<Ask>("idle");
  const send = async (call: Courier["ask"]) => {
    setAsk("asking");
    setAsk(await call(component.slug));
  };
  switch (view.kind) {
    case "working":
      if (view.screenshot === null) return null;
      return (
        <Strip icon={<LoaderCircleIcon className={`${ICON} animate-spin`} />}>
          <Shimmer as="p" className="m-0 text-sm">{view.activity}</Shimmer>
        </Strip>
      );
    case "pending":
      return (
        <Strip
          icon={<ClockIcon className={ICON} />}
          aside={
            view.withdrawable && (
              <Button size="sm" variant="ghost" onClick={() => send(courier.withdraw)} disabled={ask === "asking"}>
                Cancel
              </Button>
            )
          }
        >
          <p className="m-0 text-sm font-medium">{view.sentence}</p>
          {view.reason && <p className="m-0 text-sm text-muted-foreground">{view.reason}</p>}
        </Strip>
      );
    case "skipped": {
      let aside = "Queueing asks the import to try again.";
      if (ask === "unreachable") aside = "Only the live library can ask; open it from your agent's session.";
      return (
        <Strip
          icon={<CircleSlashIcon className={ICON} />}
          aside={
            <>
              <span className="text-xs text-muted-foreground">{aside}</span>
              <Button size="sm" variant="outline" onClick={() => send(courier.ask)} disabled={ask === "asking"}>
                Queue it
              </Button>
            </>
          }
        >
          <p className="m-0 text-sm font-medium">{skipHeading(view.skipKind)}</p>
          <p className="m-0 text-sm text-muted-foreground">{view.reason}</p>
        </Strip>
      );
    }
  }
}

const ICON = "mt-0.5 size-4 shrink-0 text-muted-foreground";

function Strip({ icon, aside, children }: { icon: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-dashed border-foreground/20 bg-muted/50 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {icon}
        <div className="flex flex-col gap-0.5">{children}</div>
      </div>
      {aside && <div className="flex items-center gap-3">{aside}</div>}
    </div>
  );
}

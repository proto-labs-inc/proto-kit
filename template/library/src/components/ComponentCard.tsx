import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { Component, ComponentView, QueueOutcome } from "@/library";
import { href } from "@/route";
import { StateFrame } from "./StateFrame";

type Props = {
  component: Component;
  view: ComponentView;
  queue: (slug: string) => Promise<QueueOutcome>;
};

const PLACEHOLDER_HEIGHT = 120;

export function ComponentCard({ component, view, queue }: Props) {
  return (
    <Card size="sm" className="relative">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <a href={href.component(component.slug)} className="after:absolute after:inset-0 hover:underline">
            {component.name}
          </a>
          <Badge variant="outline" className="text-muted-foreground">
            {component.category}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <CardBody component={component} view={view} queue={queue} />
      </CardContent>
    </Card>
  );
}

function CardBody({ component, view, queue }: Props) {
  switch (view.kind) {
    case "preview":
      return <StateFrame state={view.state} title={component.name} />;
    case "shimmer":
      return (
        <div
          className="flex items-center justify-center rounded-lg bg-muted/60"
          style={{ height: PLACEHOLDER_HEIGHT }}
        >
          <Shimmer className="text-sm">{view.activity}</Shimmer>
        </div>
      );
    case "skipped":
      return <Skipped component={component} reason={view.reason} screenshot={view.screenshot} queue={queue} />;
  }
}

type SkippedProps = {
  component: Component;
  reason: string;
  screenshot: string | null;
  queue: (slug: string) => Promise<QueueOutcome>;
};

/** MAA-164: the real product's screenshot, one plain sentence, one button. */
function Skipped({ component, reason, screenshot, queue }: SkippedProps) {
  const [outcome, setOutcome] = useState<QueueOutcome | "asking" | null>(null);
  const ask = async () => {
    setOutcome("asking");
    setOutcome(await queue(component.slug));
  };
  let note: string | null = null;
  if (outcome === "no-import") note = "The import is not running, so nothing can take this yet.";
  return (
    <div className="flex flex-col gap-3">
      {screenshot ? (
        <img src={screenshot} alt={`${component.name} in the product`} className="w-full rounded-lg" />
      ) : (
        <div className="rounded-lg bg-muted/60" style={{ height: PLACEHOLDER_HEIGHT }} />
      )}
      <p className="text-sm text-muted-foreground">{reason}</p>
      <div className="relative z-10 flex items-center gap-3 self-start">
        <Button size="sm" variant="outline" onClick={ask} disabled={outcome === "asking"}>
          Queue it
        </Button>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
    </div>
  );
}

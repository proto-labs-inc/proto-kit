import { CheckIcon } from "lucide-react";
import type { ImportStage } from "@/library";

export function ImportSteps({ stages }: { stages?: ImportStage[] | null }) {
  if (!stages?.length) return null;
  return (
    <ol aria-label="Import progress" className="m-0 grid list-none gap-5 border-y border-border py-5 sm:grid-cols-3">
      {stages.map((stage, index) => (
        <li key={stage.id} aria-current={stage.status === "active" ? "step" : undefined} className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs ${stage.status === "waiting" ? "border-border text-muted-foreground" : "border-foreground bg-foreground text-background"}`}>
              {stage.status === "done" ? <CheckIcon className="size-3.5" aria-hidden="true" /> : index + 1}
            </span>
            <span className={stage.status === "waiting" ? "text-muted-foreground" : "text-foreground"}>{stage.title}</span>
          </div>
          <p role="status" className="m-0 mt-2 text-xs text-muted-foreground">
            {stage.status === "done" ? (stage.gaps?.length ? `Done with ${stage.gaps.length} gaps` : "Done") : stage.status === "waiting" ? "Waiting for the previous step" : stage.id === "foundations" ? "Reading and checking styles in both themes" : `${stage.verified} of ${stage.total} verified in both themes`}
          </p>
          {!!stage.gaps?.length && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Failed or skipped ({stage.gaps.length})</summary>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {stage.gaps.map((gap, i) => <li key={`${gap.name}-${i}`}>{gap.name}: {gap.reason}</li>)}
              </ul>
            </details>
          )}
          {stage.status === "active" && stage.remaining.length > 0 && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Still to finish ({stage.remaining.length})</summary>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {stage.remaining.map((name, i) => <li key={`${name}-${i}`}>{name}</li>)}
              </ul>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

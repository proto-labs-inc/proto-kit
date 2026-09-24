"use client";

/**
 * The AI Elements Context element (elements.ai-sdk.dev/components/context)
 * with its schema turned from a model's token budget into the import's
 * progress: the ring in the trigger fills as components land, and the
 * hover card is where the library says what the import read. The
 * token-cost rows and their `ai` / `tokenlens` dependencies are gone;
 * the import has no such numbers.
 */
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { type ComponentProps, createContext, useContext } from "react";

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

type ContextSchema = {
  /** Items finished so far. */
  done: number;
  /** Items the import set out to do; 0 while it is still counting. */
  total: number;
};

const ContextContext = createContext<ContextSchema | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);

  if (!context) {
    throw new Error("Context components must be used within Context");
  }

  return context;
};

const fraction = ({ done, total }: ContextSchema): number => {
  if (total === 0) return 0;
  return Math.min(1, done / total);
};

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({ done, total, ...props }: ContextProps) => (
  <ContextContext.Provider value={{ done, total }}>
    <HoverCard {...props} />
  </ContextContext.Provider>
);

const ContextIcon = () => {
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const dashOffset = circumference * (1 - fraction(useContextValue()));

  return (
    <svg
      aria-label="Import progress"
      height="20"
      role="img"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transformOrigin: "center", transform: "rotate(-90deg)", transition: "stroke-dashoffset 400ms ease" }}
      />
    </svg>
  );
};

export type ContextTriggerProps = ComponentProps<typeof Button>;

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => (
  <HoverCardTrigger
    delay={0}
    closeDelay={0}
    render={
      <Button type="button" variant="ghost" {...props}>
        <span className="font-medium text-muted-foreground">{children}</span>
        <ContextIcon />
      </Button>
    }
  />
);

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export const ContextContent = ({
  className,
  ...props
}: ContextContentProps) => (
  <HoverCardContent
    className={cn("min-w-60 divide-y overflow-hidden p-0", className)}
    {...props}
  />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const value = useContextValue();

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children}
      <Progress className="bg-muted" value={fraction(value) * PERCENT_MAX} />
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

export const ContextContentBody = ({
  children,
  className,
  ...props
}: ContextContentBodyProps) => (
  <div className={cn("w-full p-3", className)} {...props}>
    {children}
  </div>
);

export type ContextContentFooterProps = ComponentProps<"div">;

export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => (
  <div
    className={cn(
      "flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

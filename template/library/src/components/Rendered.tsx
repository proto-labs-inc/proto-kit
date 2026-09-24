import { Component as ReactComponent, Suspense, lazy, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { ComponentState } from "@/library";

/**
 * An imported component, rendered live from its module with a state's
 * props (no iframe: the module's stylesheet is scoped, so the product's
 * styles stay inside it). Modules live at src/components/<slug>/<Slug>.tsx
 * and are found by a glob, so a new component needs no registry edit;
 * each is imported lazily, so only the components the page shows are
 * loaded and a half-authored one never breaks the page.
 */

// Imported modules are the PascalCase files; the app's own components
// under ui/ and ai-elements/ are lowercase and never match.
const MODULES = import.meta.glob<{ default: ComponentType<Record<string, unknown>> }>("/src/components/*/[A-Z]*.tsx");
const UNITS = import.meta.glob<{ default: { states: ComponentState[] } }>("/src/components/*/component.json");
const loaded = new Map<string, ComponentType<Record<string, unknown>>>();

/** The module path of the component in src/components/<slug>/, whether or not the manifest names it yet. */
export function moduleOf(slug: string): string | null {
  const key = Object.keys(MODULES).find((k) => k.startsWith(`/src/components/${slug}/`));
  if (!key) return null;
  return key.slice(1);
}

/** The states in the unit's own component.json, so the render route can show a state before it is landed. */
export async function statesOf(slug: string): Promise<ComponentState[] | null> {
  const load = UNITS[`/src/components/${slug}/component.json`];
  if (!load) return null;
  return (await load()).default.states;
}

function componentFor(module: string): ComponentType<Record<string, unknown>> | null {
  const key = `/${module}`;
  const load = MODULES[key];
  if (!load) return null;
  let component = loaded.get(key);
  if (!component) {
    component = lazy(load);
    loaded.set(key, component);
  }
  return component;
}

type Props = { name: string; module: string | undefined; state: ComponentState };

export function Rendered({ name, module, state }: Props) {
  if (!module) return <Missing what={`${name} has no module yet`} />;
  const Imported = componentFor(module);
  if (!Imported) return <Missing what={`${module} is not in the app`} />;
  return (
    <Boundary key={`${module}:${state.name}`} name={name}>
      <Suspense fallback={<span data-loading={module}><Shimmer className="text-sm">{`Loading ${name}`}</Shimmer></span>}>
        <Imported {...state.props} />
      </Suspense>
    </Boundary>
  );
}

function Missing({ what }: { what: string }) {
  return <p className="m-0 text-sm text-muted-foreground">{what}</p>;
}

type BoundaryState = { error: Error | null };

/** A component that throws shows its error in its own block, not a blank page. */
class Boundary extends ReactComponent<{ name: string; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.name} threw while rendering`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <p className="m-0 text-sm text-muted-foreground">{this.props.name} threw while rendering: {this.state.error.message}</p>;
    }
    return this.props.children;
  }
}

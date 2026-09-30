import { useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckStrip, Checks } from "@/components/Checks";
import { NotBuilt, type Ask } from "@/components/NotBuilt";
import { Stage } from "@/components/Stage";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Fit } from "@/components/Fit";
import { ProductCrop, usePictureWidth } from "@/components/ProductCrop";
import { Rendered } from "@/components/Rendered";
import { componentView, rebuiltNote, tokensFor, type Component, type ComponentView, type Courier, type Library, type ThemeId, type Token } from "@/library";
import { href } from "@/route";
import { hexOf } from "@/surface";
import { usePreviewTheme } from "@/theme";

type Props = {
  slug: string;
  /** The state the address names, or null for the default. */
  state: string | null;
  library: Library;
  courier: Courier;
};

export function ComponentPage({ slug, state, library, courier }: Props) {
  const { manifest } = library;
  const theme = usePreviewTheme();
  const tokens = tokensFor(manifest, theme);
  const component = manifest.components.find((c) => c.slug === slug);
  if (!component) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10 text-sm text-muted-foreground">
        <a href={href.overview()} className="hover:underline">Design system</a> has no component called {slug}.
      </main>
    );
  }
  const view = componentView(component, library);
  const moving = view.kind === "working";
  const note = rebuiltNote(component, library);
  return (
    <main className="mx-auto grid max-w-5xl gap-10 px-6 py-10 md:grid-cols-[1fr_12rem]">
      <div className="flex min-w-0 flex-col gap-8">
        <header className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-3">
            <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href={href.overview()}>Design system</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{component.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
            </Breadcrumb>
            <h1 className="text-2xl font-medium">{component.name}</h1>
            {note && <p className="m-0 text-sm text-muted-foreground">{note}</p>}
          </div>
          <ThemeToggle />
        </header>
        <States component={component} view={view} state={state} courier={courier} />
        {component.tokens[theme].length > 0 && <Colours component={component} tokens={tokens} theme={theme} />}
        <Checks component={component} library={library} moving={moving} />
      </div>
      <SubNavigation components={manifest.components} current={slug} />
    </main>
  );
}

type StatesProps = { component: Component; view: ComponentView; state: string | null; courier: Courier };

/**
 * The component in each of its states, one tab per state and the state
 * in the address, so "look at the empty table" can be sent; a component
 * with one state shows it without a tab strip. A component that is not
 * built shows the product's own crop, at its natural size on the
 * component's own backdrop, and the strip that says why; the checks
 * landing for one being read are in the reveal below, open.
 */
function States({ component, view, state, courier }: StatesProps) {
  const [comparing, setComparing] = useState(false);
  const [ask, setAsk] = useState<Ask>("idle");
  const productWidth = usePictureWidth(component.screenshot ?? null);
  const send = async (call: Courier["ask"]) => {
    setAsk("asking");
    setAsk(await call(component.slug));
  };
  if (view.kind !== "preview") {
    return (
      <div className="flex flex-col gap-2">
        <Stage holds="picture" backdrop={component.backdrop}>
          {view.kind === "working" && view.latest !== null ? (
            <CheckStrip pass={view.latest} name={component.name} />
          ) : (
            <ProductCrop name={component.name} screenshot={view.screenshot} />
          )}
        </Stage>
        <NotBuilt component={component} view={view} courier={courier} ask={ask} onAsk={() => send(courier.ask)} onWithdraw={() => send(courier.withdraw)} />
      </div>
    );
  }
  const names = component.states.map((s) => s.name);
  let current = names[0];
  if (state !== null && names.includes(state)) current = state;
  const show = (name: string) => {
    window.location.hash = href.component(component.slug, name);
  };
  return (
    <div className="flex flex-col gap-4">
      <Tabs value={current} onValueChange={(value) => show(String(value))} className="gap-4">
        {names.length > 1 && (
          <TabsList variant="line">
            {names.map((name) => (
              <TabsTrigger key={name} value={name}>{name}</TabsTrigger>
            ))}
          </TabsList>
        )}
        {component.states.map((look) => (
          <TabsContent key={look.name} value={look.name}>
            <Stage holds="component" backdrop={component.backdrop}>
              <Fit width={look.width ?? productWidth ?? undefined} className="p-5">
                <Rendered name={component.name} module={component.module} state={look} />
              </Fit>
            </Stage>
          </TabsContent>
        ))}
      </Tabs>
      {component.screenshot && (
        <div className="flex flex-col gap-2">
          <button type="button" className="self-start text-sm text-muted-foreground hover:text-foreground" onClick={() => setComparing((was) => !was)}>
            {comparing ? "Hide the product's own" : "Compare with the product"}
          </button>
          {comparing && (
            <Stage holds="picture" backdrop={component.backdrop}>
              <ProductCrop name={component.name} screenshot={component.screenshot} />
            </Stage>
          )}
        </div>
      )}
    </div>
  );
}

/** The colours the component is made of, from the palette, each a swatch with its name. */
function Colours({ component, tokens, theme }: { component: Component; tokens: Token[]; theme: ThemeId }) {
  const used = component.tokens[theme].map((name) => tokens.find((t) => t.name === name)).filter((t): t is Token => t !== undefined);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">Colours it uses</h2>
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-xs">
        {used.map((token) => (
          <li key={token.name} className="flex items-center gap-2">
            <span className="size-4 rounded ring-1 ring-foreground/10" style={{ background: token.value }} title={token.value} />
            <span className="font-medium">{token.name}</span>
            <span className="text-muted-foreground">{hexOf(token.value)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SubNavigation({ components, current }: { components: Component[]; current: string }) {
  return (
    <nav className="hidden flex-col gap-1 text-sm md:flex">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Components</span>
      <ScrollArea className="max-h-[70vh]">
        <div className="flex flex-col gap-1">
          {components.map((c) => (
            <a key={c.slug} href={href.component(c.slug)} className={linkClass(c.slug === current)}>{c.name}</a>
          ))}
        </div>
      </ScrollArea>
    </nav>
  );
}

function linkClass(active: boolean): string {
  if (active) return "text-foreground";
  return "text-muted-foreground hover:text-foreground";
}

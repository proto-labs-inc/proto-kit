import { motion } from "motion/react";
import type { Component, ThemeId, Token } from "@/library";
import { href } from "@/route";
import { hexOf } from "@/surface";

type Props = { tokens: Token[]; components: Component[]; theme: ThemeId };

/**
 * The palette, grouped the way the product groups it, each swatch
 * naming the built components that use it, so a colour and the
 * things made of it are one click apart in both directions. Every
 * value reads as hex whatever syntax the product wrote it in; the
 * product's own spelling is on the swatch's tooltip.
 */
export function TokenSwatches({ tokens, components, theme }: Props) {
  const groups = new Map<string, Token[]>();
  for (const token of tokens) {
    const list = groups.get(token.group) ?? [];
    list.push(token);
    groups.set(token.group, list);
  }
  return (
    <div className="flex flex-col gap-6">
      {[...groups].map(([group, list]) => (
        <div key={group}>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-4">
            {list.map((token) => (
              <motion.div
                key={token.name}
                layout
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "spring", stiffness: 380, damping: 26 }}
                className="flex flex-col gap-2"
              >
                <div
                  className="h-16 rounded-xl ring-1 ring-foreground/10"
                  style={{ background: token.value }}
                  title={token.value}
                />
                <div className="text-xs leading-tight">
                  <div className="font-medium">{token.name}</div>
                  <div className="text-muted-foreground">
                    {hexOf(token.value)}
                    {token.role && <span className="ml-1">· {token.role}</span>}
                  </div>
                  <UsedBy token={token} components={components} theme={theme} />
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UsedBy({ token, components, theme }: { token: Token; components: Component[]; theme: ThemeId }) {
  const users = components.filter((c) => c.status === "done" && c.tokens[theme].includes(token.name));
  if (users.length === 0) return null;
  return (
    <div className="mt-1 text-muted-foreground">
      {users.map((c, i) => (
        <span key={c.slug}>
          {i > 0 && ", "}
          <a href={href.component(c.slug)} className="hover:text-foreground hover:underline">{c.name}</a>
        </span>
      ))}
    </div>
  );
}

/** Local component requests stored in public/queue.json by the dev server.
 * An active import checks this queue at finite checkpoints. Published snapshots
 * have no POST handler, so requests correctly report "unreachable" there.
 */

/** The slug that asks for the whole import again, rather than one component. */
export const EVERYTHING = "*";

export type SendOutcome = "sent" | "unreachable";

type Message = { action: "add" | "remove"; slug: string };

async function send(message: Message): Promise<SendOutcome> {
  try {
    const res = await fetch("queue.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) return "unreachable";
  } catch {
    return "unreachable";
  }
  return "sent";
}

/** Ask for a component to be built (its slug) or for everything again (EVERYTHING). */
export const ask = (slug: string) => send({ action: "add", slug });

/** Take back a request nothing has picked up yet. */
export const withdraw = (slug: string) => send({ action: "remove", slug });

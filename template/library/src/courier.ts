/**
 * How the app asks the import for something: the one place the request
 * transport lives, so the site's courier (MAA-173) can replace it
 * without touching the pages. Today a request is a POST to the dev
 * server, which adds it to public/queue.json for the import to poll
 * (docs/library-contract.md, "queue.json"). A published build has no
 * server behind it, so there every request comes back "unreachable"
 * and the page says only the live library can ask.
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

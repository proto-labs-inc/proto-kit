import { usePreviewState } from "@proto-labs-inc/rig";

/**
 * Starter page. Replace everything inside <div className="app"> with the
 * real prototype — keeping the two rules it demonstrates:
 *
 * 1. Every visually coherent component's root element carries a
 *    kebab-case `data-proto-id` — the Frame's comment mode hit-tests
 *    these for selection and comment anchoring. Repeating an id across
 *    list rows is fine; renaming one breaks comments already anchored
 *    to it.
 * 2. Every distinct mode a reviewer should reach is a preview state in
 *    public/prototype.json, driven through usePreviewState.
 */
export function App() {
  const [state] = usePreviewState("default", ["default", "empty"]);

  return (
    <div className="app">
      <header data-proto-id="header">
        <h1>Prototype</h1>
      </header>
      {state === "empty" ? (
        <div className="empty" data-proto-id="empty-state">
          Nothing here yet.
        </div>
      ) : (
        <main data-proto-id="content">
          <p>Build the prototype here.</p>
        </main>
      )}
    </div>
  );
}

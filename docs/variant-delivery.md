# Implement before capturing variants

For passes that create or change variants, use this order. References-only
passes do not implement variants or produce variant thumbnails.

Preserve the existing responsive rules as much as possible: reuse the source's
breakpoints, fluid sizing, wrapping, overflow handling, and responsive visibility.
Adapt them only where the requested direction requires it, and check the result
at the existing narrow and wide layouts.

When the changed component repeats, apply the selected variant consistently to
every instance throughout the prototype, not just the selected occurrence.
Inspect its usages before implementation and use shared rendering where possible.
Keep each instance's own data and state. Unless the user explicitly limits the
change to one instance, the coordinator must wire all occurrences to the same
variant selection and verify they all update when switching variants.

1. Implement each variant in its source module and wire it into the actual
   prototype component through the rig's variant selection. Register its
   identity and required ancestors with the guarded manifest writer so it can
   be selected. A scaffold, manifest entry, or standalone mockup is not a
   finished implementation.
2. In the running prototype, select every affected variant through the same
   selection path the Frame uses. Confirm the intended component visibly
   renders that implementation, including required ancestor variants. Switch
   away and back, and check an unaffected sibling when one exists. A changed
   URL, successful tool call, or typecheck alone is not proof of rendering.
   If the loaded preview is stale, refresh it and repeat this check.
3. Only after that check, capture the variant's thumbnail from its actual
   rendered component using the kit's preview tools. Do not draw a substitute,
   capture an isolated mockup, or capture an unimplemented scaffold. Keep the
   captured image associated with the exact component, set, and variant IDs
   that were verified. Recapture after any subsequent visual change.
4. Save the verified preview metadata with the guarded writer. When the desktop
   provides `show_component_versions`, deliver those screenshots to chat only
   after steps 1 through 3. A ready batch may be delivered while other work
   continues, before publication; it does not need to wait for the chat to end.

If implementation, switching, or capture fails, fix that stage before exposing
its thumbnail as a selectable version. Report the specific unfinished stage;
do not present screenshots as completed interactive variants. Continue the
skill's build and publish steps after local delivery.

When delegating, the coordinator owns integration into the prototype and the
manifest. Builders implement their modules first and must wait for that
integration before running capture. The coordinator verifies switching in the
integrated prototype before delivering any gallery.

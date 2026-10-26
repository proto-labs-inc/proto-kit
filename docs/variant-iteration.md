# Choose how to iterate

When the user asks to iterate on an alternate (variant) or a set of alternates,
use your best judgment to decide whether to edit the existing variants in place
or create new variants. Follow explicit instructions first, then infer intent
from the requested change and conversation context. “Iterate” alone does not
require new variants.

Alternates are mutable, not immutable snapshots. Default to editing in place
when the user asks to refine existing work (for example, "make this calmer",
"fix the spacing", or "apply this to all alternates"). Keep the same variant
IDs and count, updating the implementations and previews. Do not clone an
alternate merely to preserve its previous appearance or create a new set for
each revision. Create additional variants only when the request calls for new
options or retaining the previous versions for comparison.

Choose the operation before registering or scaffolding work. A tool action or
copied prompt labeled `add-variants` is not by itself evidence that the user
wants more alternatives; read the actual request and target. Instructions to
preserve all existing variants apply when adding options, not when editing
the variants the user asked to change.

References are opt-in: do not gather or present them unless the user explicitly
asks, including `inputs.references: true` in a website brief. Reuse supplied or
existing context internally and preserve saved references without adding an
unsolicited reference batch or selection step.

- Edit in place for corrections, polish, or refinements to the current choices,
  including a requested change across a whole set. Use edit-variant for all
  targeted variants, preserving their IDs and unaffected siblings.
- Add variants when the user wants more options, distinct directions, or a
  comparison that keeps the current choices available. Use add-variants for
  an existing set; use create-variant-set when a new set is requested.

Briefly state the chosen approach and proceed. Ask only when the intent remains
materially ambiguous and choosing would risk replacing work the user wants to
keep. Do not let the entry skill's name override the user's intent; switch to
the appropriate workflow before making changes.

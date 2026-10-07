This project is paused, but you only find out on the project's home page. The top bar's project switcher ("Prooject ⌄", next to "main PRODUCTION") looks exactly like an active project's. From any other page you'd have no idea it's paused or that the resume deadline is 09 Nov 2027.

Make the paused state visible in two places that work together: the project switcher in the top bar, and the "Project is paused" notice on the page. Resuming from either one starts the restore in both. The notice shows "Restoration in progress" and the switcher shows the project as restoring. Keep everything else on the page as it is, and use Supabase's own components and styles from the codebase.

Give 3 variants of how the two work together, each changing both:
1. **Badge + notice:** the switcher gets a small "Paused" badge. Its dropdown lists the project with "Resumable until 09 Nov 2027" and a Resume action. The notice keeps its full detail.
2. **Switcher-first:** the dropdown is where you act. It holds the deadline, what happens after it, Resume and Download backups. The notice slims to one line pointing at it.
3. **Notice-first:** the switcher only shows a paused dot. Clicking it scrolls to and highlights the notice, which carries every action.

Preview states: `default` (paused), `menu-open` (switcher dropdown open), `resuming`. The paused date isn't shown on the page; don't invent one.

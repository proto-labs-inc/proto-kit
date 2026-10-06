This is the home page of a paused project in the Supabase dashboard. The "Project is paused" card lists the critical facts as four equal bullets: all data, including backups and storage objects, is safe; I can resume the project from the dashboard until 09 Nov 2027; after that it can't be resumed but the data stays downloadable; upgrading to Pro prevents future pauses. Below that are "Resume project" and "Upgrade to Pro" buttons and an "Export your data / Download backups" row. Everything has the same weight, so the one deadline that matters (resumable until 09 Nov 2027) and the main action (resume) don't stand out, and "Upgrade to Pro" is the most prominent button.

Redesign the paused-project notice so the critical information reads at a glance: what state the project is in, that my data is safe, the resume deadline and what happens after it, and what I can do now (resume, download backups, upgrade). Keep everything else on the page (sidebar, top bar, org and project switchers) as it is. Use Supabase's own components and styles from the codebase.

Give me 3 variants of the notice that display this information in different ways:
1. Deadline first: the resume deadline is the headline, with a countdown-style "resumable for N more days" line, "Resume project" as the primary button, and the other facts beneath.
2. Status checklist: a card with a short list of facts, each with an icon and a state (data: safe; resume: available until 09 Nov 2027; after that: download only), with the actions grouped at the bottom.
3. Timeline: a horizontal timeline from "paused" through "today" to "09 Nov 2027, no longer resumable", with the actions at the "today" point.

Keep the real project name ("Prooject"), org ("Throwaway", Free plan) and dates. Include a state where the resume is in progress.

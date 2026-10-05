---
name: ds-bench-gallery
description: Build a UI gallery of screenshots of what the agents rendered in one or more open-design-system-bench runs, per context level, rep and run. Use when asked to show, browse, compare or review what the agents produced, or to build a gallery from run directories.
---

# Generated output gallery

One command, no interpretation:

```bash
npx tsx src/cli.ts gallery runs/<run-id> [runs/<other-run-id> ...]
```

- Every ok cell is built (`vite build` in its `workspace/`) and captured with headless Chrome into
  `screenshot.png` next to its `grades.json`; a build failure is shown on the card instead. Both
  are cached, so a second `gallery` call only renders the page.
- The page: a task picker, rows per context level (and model), a card per rep with the screenshot,
  score, gate, turns, cost and a dimensions drill-down; gate filter, context toggles, size slider.
- Without a run directory the most recent run is used. Keep the html next to the run (the
  default `<runDir>/gallery.html`): it links the screenshots by relative path. Serve `runs/`
  over http to browse it (`npm run serve` or the workspace launch config on port 4189).
- No Chrome on the machine: the page still renders with "no screenshot" cards; set `CHROME_PATH`.

When the user wants a walkthrough of a cell, read that cell's `files/` and `diff.patch` rather
than summarizing from its score.

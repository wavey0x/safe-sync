# Safe Sync: notes for agents

## Checking a change in the browser

- Only for changes you can see: one quick look at the screen that changed. Logic is `bun test`'s job
  (about 3 s). Don't replay flows in the browser to test behavior (signing rounds, queues, who may do what);
  if a test doesn't cover it, add one.
- Use the fast sandbox: `bun run sandbox:fast` (launch configuration `sandbox-fast`). It has no Safe service
  pacing or throttling, and the sandbox wallet answers at once.
- Keep it running. It serves `dist/safe-sync.html` fresh on every request, so `bun run build` and reload.
- Go straight to the screen: `/link` opens a signing link for the sandbox's own batch, and the compose draft
  is already filled in.
- Read the page (text, attributes) rather than looking at screenshots, and wait for a state rather than a
  fixed time. Take one screenshot at the end when the change is visual.
- Slow loading and pacing only show in the normal sandbox (`bun run sandbox`).

## Tests

- When a feature goes, its tests go in the same commit.

## README screenshots

- `bun run screenshots` retakes `docs/*.png` from the sandbox in headless Chrome (about 20 s). Run it
  only when a screen they show changes, and commit them with that change. It isn't a way to check a change.

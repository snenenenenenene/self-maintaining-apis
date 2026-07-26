# self-maintaining-apis

**Dependabot for API breakage.** When a vendor ships a breaking change, don't just get a red build — get a green PR.

Point it at a repo and a dependency. It bumps the dep on a branch, runs your build, and if the upgrade broke your call sites it hands the errors to Claude, patches until the build is green, and opens the PR. If the bump was clean, you get the boring one-line PR. If it can't fix it in a few rounds, it stops and leaves the branch for a human — no half-migrations pushed silently.

No API key: it shells out to your local [`claude`](https://claude.com/claude-code) CLI for the fix step and `gh` for the PR.

## Use

```bash
# Run the build; if it's broken, let Claude patch until green (no bump).
node bin/self-maintain.mjs fix <repo>

# Bump <dep> to latest on a branch, migrate the call sites, open a PR.
node bin/self-maintain.mjs upgrade <repo> <dep>
```

## How it works

1. **Detect** — infers your package manager from the lockfile and the cheapest "does the API still fit" check (`typecheck` script → `build` script → bare `tsc --noEmit`).
2. **Bump** (`upgrade` only) — `<pm> add <dep>@latest` on a fresh `self-maintain/bump-<dep>` branch.
3. **Fix loop** — run the build; while red, feed the exact errors to `claude -p --permission-mode acceptEdits` with a tight "migrate only the call sites, change nothing else" prompt; re-verify. Bounded to 3 rounds.
4. **Ship** — commit, push, `gh pr create` with a summary of what broke and what got migrated. Still red after 3 rounds → exit non-zero, branch left for a human.

## Why this is the wedge

Dependabot tells you a dependency changed. It doesn't fix your code when the change is breaking — that's still a human afternoon of reading changelogs and chasing type errors. This closes that last mile, and it's dogfoodable across every repo you already maintain.

## Try it

`demo/` ships an intentionally-broken upgrade: `sdk.ts` is "v2" of a fake vendor SDK where `send(options)` became `send(channel, message)`, and `app.ts` still calls it the old way, so `npm run typecheck` fails.

```bash
cd demo && npm install && cd ..
node bin/self-maintain.mjs fix demo
```

You'll watch it detect the break, patch `app.ts` to the new signature, and go green. (Needs a logged-in `claude` CLI — run `claude` once interactively if you hit a 401.)

## Status

Prototype. Proven: PM/build detection, the bounded detect→fix→verify loop, honest failure exit, and the green success path. Next: watch mode (poll dependency releases and open PRs proactively), a `--build` flag for non-TS repos, and running the fix in an isolated worktree so parallel bumps don't collide.

MIT.

# self-maintaining-apis

**Dependabot for API breakage.** When a vendor ships a breaking change, don't just get a red build, get a green PR.

Point it at a repo and a dependency. It bumps the dep on a branch, runs your build, and if the upgrade broke your call sites it hands the errors to Claude, patches until the build is green, and opens the PR. If the bump was clean, you get the boring one-line PR. If it can't fix it in a few rounds, it stops and leaves the branch for a human, no half-migrations pushed silently.

The fix step calls the **Anthropic API directly**, no Claude Code install, no interactive login, so it runs unattended in CI. Set `ANTHROPIC_API_KEY` and it works. (`gh` is used for the PR.)

→ **[self-maintaining-apis-senne-bels-projects.vercel.app](https://self-maintaining-apis-senne-bels-projects.vercel.app)**

## Use

```bash
# Run the build; if it's broken, let Claude patch until green (no bump).
node bin/self-maintain.mjs fix <repo>

# Bump <dep> to latest on a branch, migrate the call sites, open a PR.
node bin/self-maintain.mjs upgrade <repo> <dep>

# Poll vendor changelogs, classify new entries as breaking or not, keep receipts.
node bin/self-maintain.mjs watch

# Join the newest breaking receipts against <repo>'s package.json and open one PR
# (a range bump, or a report with a precise no-fix-needed verdict). --dry-run prints the report only.
node bin/self-maintain.mjs map <repo> [--dry-run]
```

Set `ANTHROPIC_API_KEY` for the fix step. Override the model with `SELF_MAINTAIN_MODEL` (default `claude-opus-4-8`). With no key set, it falls back to your local [`claude`](https://claude.com/claude-code) CLI.

### In CI (GitHub Action)

Add [`ANTHROPIC_API_KEY`](https://console.anthropic.com/) as a repo secret, then:

```yaml
- run: npm ci
- uses: snenenenenenene/self-maintaining-apis@v1
  with:
    dependency: "@acme/sdk"
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

A full example (schedule + matrix of watched deps) is in [`.github/workflows/self-maintain.example.yml`](.github/workflows/self-maintain.example.yml). The job needs `permissions: { contents: write, pull-requests: write }`.

## How it works

1. **Detect**: infers your package manager from the lockfile and the cheapest "does the API still fit" check (`typecheck` script, then `build` script, then a bare `tsc --noEmit`).
2. **Bump** (`upgrade` only): `<pm> add <dep>@latest` on a fresh `self-maintain/bump-<dep>` branch.
3. **Fix loop**: run the build; while red, send the exact errors plus the referenced source files to Claude with a tight "migrate only the call sites, change nothing else" prompt, write the patched files back, and re-verify. Bounded to 3 rounds.
4. **Ship**: commit, push, `gh pr create` with a summary of what broke and what got migrated. Still red after 3 rounds, it exits non-zero and leaves the branch for a human.

### Watch (top of the loop)

`watch` polls a handful of real vendor changelog/release feeds (Vercel, Resend, the OpenAI and Stripe Node SDK GitHub releases, and the `resend` npm registry entry), and for each new entry it hasn't seen before, runs it through a deterministic keyword rule set (remove/deprecate/rename/breaking change/no longer/sunset/EOL/not supported/migration required/auth or token change/requires an update/major version bump). Every verdict keeps a receipt: the source URL, the exact quoted line that triggered it, and when it was fetched. State lives in `data/watch-state.json` so re-runs only report what's new; each run also writes `data/receipts-<date>.json` and a human-readable `docs/watcher-<date>.md`. Exits `1` only when a *new* entry classifies as breaking, `0` otherwise; an unreachable source is logged and skipped, never a crash. No model call, no API key, no dependencies — it's the input a later step will map onto call sites in a target repo.

### Map (middle of the loop)

`map <repo>` reads the newest `data/receipts-<date>.json`, keeps the `breaking` entries, and joins them by package name against `<repo>/package.json` (dependencies, devDependencies, optionalDependencies). For each match it does version arithmetic on the declared range against the npm registry's version list (prereleases count as unreachable unless the range names one) and a static search of the repo's own source (skipping `node_modules`, `.git`, `.next`, `dist`, `build`, `out`, `.vercel`, `coverage`, and anything over 1 MB) for the symbols the quoted line names, restricted to files that import the package. The result is exactly one PR on that repo, opened from a fresh `git worktree` on a `self-maintain/map-<pkg>-<date>` branch off `origin/<default>`, never on the default branch: outcome `fix` bumps the one range line in `package.json` (only when the range does not reach the newest stable version and no call site uses an affected symbol), otherwise outcome `verdict` commits a single `self-maintain-report.md` with the receipt, the arithmetic, and the call-site table (unreachable, no call sites, or manual review required with the call sites listed). Exits non-zero when the path does not resolve or nothing joins. Deterministic, no model call, no API key; needs an authenticated `gh` for the PR.

## Why this is the wedge

Dependabot tells you a dependency changed. It doesn't fix your code when the change is breaking. That part is still yours: read the changelog, find the moved API, patch the call sites, re-run. That work is a good fit for an agent, and you can point it at every repo you already maintain.

## Try it

`demo/` ships an intentionally-broken upgrade: `sdk.ts` is "v2" of a fake vendor SDK where `send(options)` became `send(channel, message)`, and `app.ts` still calls it the old way, so `npm run typecheck` fails.

```bash
cd demo && npm install && cd ..
ANTHROPIC_API_KEY=sk-ant-... node bin/self-maintain.mjs fix demo
```

You'll watch it detect the break, patch `app.ts` to the new signature, and go green.

## Status

Early but real. Proven: package-manager/build detection, the bounded detect→fix→verify loop, the headless Anthropic-API fixer, honest failure exit, the green success path, and now `watch` polling real changelogs with receipts. JS/TS builds only today. Next: mapping a `watch`-flagged breaking entry onto call sites in a target repo and opening the PR, a `--build` flag for non-TS repos, and running the fix in an isolated worktree so parallel bumps don't collide.

MIT.

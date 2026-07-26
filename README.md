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

Early but real. Proven: package-manager/build detection, the bounded detect→fix→verify loop, the headless Anthropic-API fixer, honest failure exit, and the green success path. JS/TS builds only today. Next: watch mode (poll dependency releases and open PRs proactively), a `--build` flag for non-TS repos, and running the fix in an isolated worktree so parallel bumps don't collide.

MIT.

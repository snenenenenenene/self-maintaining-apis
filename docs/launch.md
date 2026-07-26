# Launch kit

Live site: https://self-maintaining-apis-senne-bels-projects.vercel.app
Repo: https://github.com/snenenenenenene/self-maintaining-apis

## Show HN draft

**Title:** Show HN: Self-Maintaining APIs – when a dep upgrade breaks your build, get a green PR

**Body:**

Dependabot and Renovate keep my versions current but hand me the breakage. When an upgrade is a breaking change, fixing it is still a manual afternoon: read the changelog, find the moved API, patch every call site, re-run the build. It's the same shape every time — which is exactly what an agent is good at.

So I built a small tool that closes that last mile. Point it at a repo and a dependency:

    npx self-maintaining-apis upgrade . @acme/sdk

On a fresh branch it bumps the dep to latest and runs your build (typecheck first, then build script). If the upgrade breaks the build, it sends the exact errors plus the referenced source files to Claude with a tight "migrate the call sites, don't refactor" brief, writes the patched files back, re-runs, and loops — bounded to 3 rounds. Clean bump → a boring one-line PR. Can't fix it in three rounds → it stops and leaves the branch. It never pushes a half-migration silently.

There's a GitHub Action so it runs unattended in CI (on a schedule or a dispatch), and the fix step calls the Anthropic API directly, so there's no Claude Code install and no interactive login — just an `ANTHROPIC_API_KEY` secret.

It's ~250 lines, no runtime deps, MIT. I've been dogfooding it across my own repos. Honest about the limits: it's early, it only does JS/TS builds today, and the "migrate" step is only as good as the model on your specific breakage — the bounded-rounds + leave-the-branch design is there because I don't trust it to be right every time.

Would love feedback on where it breaks, and whether the "verify with your own build, don't trust the diff" loop is the right safety model.

Repo: https://github.com/snenenenenenene/self-maintaining-apis

## Distribution checklist

- [ ] Tag `v1` so the Action resolves (`snenenenenenene/self-maintaining-apis@v1`) — done at launch.
- [ ] Publish to the **GitHub Action Marketplace** (repo → Releases → "Publish this Action"; `action.yml` already has `branding`).
- [ ] Show HN (above). Post Tue–Thu morning US time; reply to every comment.
- [ ] Demo GIF: record `self-maintain fix demo` going red → patched → green; drop it at the top of the README (the one asset still worth adding by hand).
- [ ] `npm publish` so `npx self-maintaining-apis` works without a clone (add a `bin` — already declared in package.json).
- [ ] Post in r/devops and the Renovate/Dependabot discussions as a complement, not a competitor.

## The two forks (decide before sinking weeks in)

- **Feature vs company.** Narrow "Dependabot for breakage" could be shipped by Renovate/GitHub as a feature. The venture-scale version is broader: autonomous codebase maintenance / self-healing dependencies.
- **YC vs Canada.** YC is SF + 3 months in-person, which pulls against the Sept-2027 Canada move. Get users first; let traction decide whether YC (or acquihire interest) is worth the pull.

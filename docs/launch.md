# Launch kit

Live site: https://self-maintaining-apis-senne-bels-projects.vercel.app
Repo: https://github.com/snenenenenenene/self-maintaining-apis

## Show HN draft

**Title:** Show HN: Self-Maintaining APIs – when a dep upgrade breaks your build, get a green PR

**Body:**

Dependabot and Renovate keep my versions current but hand me the breakage. When an upgrade is a breaking change, fixing it is still a manual afternoon: read the changelog, find the moved API, patch every call site, re-run the build. It's the same shape every time, which is exactly what an agent is good at.

So I built a small tool that closes that last mile. Point it at a repo and a dependency:

    npx self-maintaining-apis upgrade . @acme/sdk

On a fresh branch it bumps the dep to latest and runs your build (typecheck first, then build script). If the upgrade breaks the build, it sends the exact errors plus the referenced source files to Claude with a tight "migrate the call sites, don't refactor" brief, writes the patched files back, re-runs, and loops, bounded to 3 rounds. Clean bump → a boring one-line PR. Can't fix it in three rounds → it stops and leaves the branch. It never pushes a half-migration silently.

There's a GitHub Action so it runs unattended in CI (on a schedule or a dispatch), and the fix step calls the Anthropic API directly, so there's no Claude Code install and no interactive login, just an `ANTHROPIC_API_KEY` secret.

It's ~250 lines, no runtime deps, MIT. I've been dogfooding it across my own repos. Honest about the limits: it's early, it only does JS/TS builds today, and the "migrate" step is only as good as the model on your specific breakage, the bounded-rounds + leave-the-branch design is there because I don't trust it to be right every time.

Would love feedback on where it breaks, and whether the "verify with your own build, don't trust the diff" loop is the right safety model.

Repo: https://github.com/snenenenenenene/self-maintaining-apis

## Distribution checklist

- [x] Tag `v1` so the Action resolves (`snenenenenenene/self-maintaining-apis@v1`).
- [x] Publish to the **GitHub Action Marketplace** (Dependency management + Continuous integration).
- [x] `npm publish` so `npx self-maintaining-apis` works without a clone.
- [ ] Show HN (above). Post Tue–Thu morning US time; reply to every comment.
- [ ] Demo GIF: record `self-maintain fix demo` going red → patched → green; drop it at the top of the README (the one asset still worth adding by hand).
- [ ] Post in r/devops and the Renovate/Dependabot discussions as a complement, not a competitor.

## The two forks (decided)

### Feature vs company: wedge narrow, roadmap broad

The narrow "Dependabot for breakage" is the right wedge because it is concrete, demoable, and useful in the first minute. It is not the moat: GitHub or Renovate could ship it, and the code is trivial to clone. Treat the tool as a feature today and let usage decide whether there is a company. The defensible assets are the ones that only accrue from real runs:

1. A breakage corpus: which upgrades break what, and the migrations that actually passed a build.
2. A trust track record: verify with your own build, leave the branch, never push a half-migration. In autonomous code-editing, safety reputation is the product.
3. Distribution: Marketplace, npm, and CI integration.

Action: instrument every run (what broke, did the fix pass, rounds used). That telemetry, not a guess, resolves this fork. Do not commit to "company" scope before there are users.

### YC vs Canada: do not optimize for YC now; reframe around the move

- Premature. YC matters only if the fork above resolves toward "company" and there is traction. Neither exists yet, and a solo founder with no users has low YC odds regardless (YC pushes hard for 2+ founders).
- Timing is not strictly either/or. A single batch that ends before the Sept-2027 move is additive; YC's real pull is the expectation of staying near SF long-term, which is what fights a committed relocation.
- Reframe: if the thesis holds and the move happens anyway, Canada's Start-up Visa Program is a founder immigration pathway, so the company becomes the vehicle for the move rather than its casualty. Canadian accelerators (Techstars Toronto, NEXT Canada) serve both goals at once.

Action: get users, preserve optionality. If traction appears before end-2026, evaluate Canadian founder programs first; treat SF YC as opt-in only if a batch cleanly fits the pre-move window and a co-founder is in place.

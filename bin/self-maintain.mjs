#!/usr/bin/env node
// Self-Maintaining APIs — the upgrade-and-autofix loop.
//
//   self-maintain fix     <repo>          run the build; if broken, let Claude patch until green
//   self-maintain upgrade <repo> <dep>    bump <dep> to latest on a branch, then fix, then open a PR
//
// No API key: shells out to the local `claude` CLI for the fix step, and `gh` for the PR.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_FIX_ROUNDS = 3;

function sh(cmd, args, cwd, { quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  if (!quiet && out.trim()) process.stdout.write(out);
  return { ok: r.status === 0, out, status: r.status };
}

// npm | pnpm | yarn | bun, inferred from the lockfile.
function detectPM(repo) {
  if (existsSync(join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repo, "yarn.lock"))) return "yarn";
  if (existsSync(join(repo, "bun.lockb"))) return "bun";
  return "npm";
}

// The cheapest command that proves the API still fits: a typecheck if there is one,
// else the build script, else a bare `tsc --noEmit`.
function buildStep(repo) {
  const pkgPath = join(repo, "package.json");
  const scripts = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, "utf8")).scripts || {}) : {};
  const pm = detectPM(repo);
  const run = (s) => (pm === "npm" ? ["npm", ["run", s]] : [pm, ["run", s]]);
  if (scripts.typecheck) return run("typecheck");
  if (scripts["type-check"]) return run("type-check");
  if (scripts.build) return run("build");
  return ["npx", ["tsc", "--noEmit"]]; // ponytail: assumes TS; add a --build flag when a non-TS repo shows up
}

function runBuild(repo) {
  const [cmd, args] = buildStep(repo);
  console.log(`\n▶ build: ${cmd} ${args.join(" ")}`);
  return sh(cmd, args, repo);
}

function bump(repo, dep) {
  const pm = detectPM(repo);
  const add = pm === "npm" ? ["install", `${dep}@latest`]
    : pm === "yarn" ? ["add", `${dep}@latest`]
    : ["add", `${dep}@latest`]; // pnpm, bun
  console.log(`\n▶ bump: ${pm} ${add.join(" ")}`);
  return sh(pm, add, repo);
}

function claudeFix(repo, buildOutput, dep) {
  const context = dep
    ? `You just upgraded the dependency "${dep}" to its latest version and the build broke.`
    : `The build is broken.`;
  const prompt =
    `${context} Here is the failing build output:\n\n${buildOutput}\n\n` +
    `Edit the source files in this repo so the build passes. ` +
    `Only migrate the code to the new API surface — do not change unrelated logic, do not touch tests unless the failure is in a test, and do not downgrade the dependency. ` +
    `When done, stop.`;
  console.log(`\n▶ asking claude to patch…`);
  // acceptEdits so the headless run can actually write the fix.
  return sh("claude", ["-p", prompt, "--permission-mode", "acceptEdits"], repo);
}

function main() {
  const [, , sub, repoArg, dep] = process.argv;
  const repo = repoArg && (repoArg.startsWith("/") ? repoArg : join(process.cwd(), repoArg));

  if (!sub || !repo || (sub === "upgrade" && !dep)) {
    console.log("usage:\n  self-maintain fix <repo>\n  self-maintain upgrade <repo> <dep>");
    process.exit(2);
  }
  if (!existsSync(join(repo, "package.json")) && !existsSync(join(repo, "tsconfig.json"))) {
    console.error(`no package.json/tsconfig.json in ${repo}`);
    process.exit(2);
  }

  let branch;
  if (sub === "upgrade") {
    branch = `self-maintain/bump-${dep.replace(/[^a-z0-9.-]/gi, "-")}`;
    console.log(`▶ branch: ${branch}`);
    sh("git", ["checkout", "-b", branch], repo);
    const b = bump(repo, dep);
    if (!b.ok) { console.error("bump failed (registry/network?) — aborting"); process.exit(1); }
  }

  // Detect → fix → verify, up to MAX_FIX_ROUNDS.
  let build = runBuild(repo);
  let rounds = 0;
  while (!build.ok && rounds < MAX_FIX_ROUNDS) {
    rounds++;
    console.log(`\n✗ build red — fix round ${rounds}/${MAX_FIX_ROUNDS}`);
    claudeFix(repo, build.out, dep);
    build = runBuild(repo);
  }

  if (!build.ok) {
    console.error(`\n✗ still broken after ${rounds} round(s). Leaving the branch for a human.`);
    process.exit(1);
  }
  console.log(`\n✓ build green${rounds ? ` after ${rounds} fix round(s)` : ""}.`);

  if (sub === "upgrade") {
    sh("git", ["add", "-A"], repo);
    sh("git", ["commit", "-m", `chore(deps): bump ${dep} to latest + migrate call sites`], repo);
    const pushed = sh("git", ["push", "-u", "origin", branch], repo);
    if (!pushed.ok) { console.error("push failed — is there a remote?"); process.exit(1); }
    const title = `chore(deps): bump ${dep} to latest`;
    const body = rounds
      ? `Automated by self-maintaining-apis.\n\nBumped \`${dep}\` to latest; the upgrade broke the build and Claude migrated the call sites over ${rounds} round(s). Build is green.`
      : `Automated by self-maintaining-apis.\n\nBumped \`${dep}\` to latest. Clean upgrade — build stayed green, no code changes needed.`;
    const pr = sh("gh", ["pr", "create", "--title", title, "--body", body], repo);
    if (pr.ok) console.log(`\n✓ PR opened.`);
  }
}

main();

#!/usr/bin/env node
// Self-Maintaining APIs, the upgrade-and-autofix loop.
//
//   self-maintain fix     <repo>          run the build; if broken, let Claude patch until green
//   self-maintain upgrade <repo> <dep>    bump <dep> to latest on a branch, then fix, then open a PR
//
// No API key: shells out to the local `claude` CLI for the fix step, and `gh` for the PR.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

const MAX_FIX_ROUNDS = 3;
const MODEL = process.env.SELF_MAINTAIN_MODEL || "claude-opus-4-8";
const MAX_FILE_BYTES = 60_000; // don't ship a giant generated file to the model
const MAX_FILES = 12;

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

// Pull the source files a build error names, so we can hand the model the code it
// has to migrate. Matches tsc (`app.ts(7,9):`), eslint/node (`src/a.ts:12:3`), etc.
function filesFromBuildOutput(repo, out) {
  const rx = /([\w./@-]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte))[(:]/g;
  const seen = new Set();
  const files = [];
  for (const m of out.matchAll(rx)) {
    const rel = m[1].replace(/^\.\//, "");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = resolve(repo, rel);
    if (!existsSync(abs) || relative(repo, abs).startsWith("..")) continue;
    const content = readFileSync(abs, "utf8");
    if (content.length > MAX_FILE_BYTES) continue;
    files.push({ rel, abs, content });
    if (files.length >= MAX_FILES) break;
  }
  return files;
}

// Ask Claude (Anthropic API, headless) to migrate the broken call sites and write
// the corrected files back. No Claude Code / interactive login required, CI-ready.
async function anthropicFix(repo, buildOutput, dep, key) {
  const files = filesFromBuildOutput(repo, buildOutput);
  if (files.length === 0) {
    console.log("  (no source files named in the build output, nothing to hand the model)");
    return false;
  }
  const context = dep
    ? `A dependency upgrade ("${dep}" → latest) broke the build.`
    : `The build is broken.`;
  const prompt =
    `${context} Below are the failing build errors, then the current contents of the files they reference.\n\n` +
    `Return the COMPLETE corrected contents of ONLY the files that must change to make the build pass. ` +
    `Migrate the code to the dependency's new API surface. Do not refactor, do not change unrelated logic, do not touch tests unless the error is in a test, do not downgrade the dependency.\n\n` +
    `Format each changed file EXACTLY as:\n===FILE: <relative/path>===\n\`\`\`\n<full file content>\n\`\`\`\n\n` +
    `=== BUILD ERRORS ===\n${buildOutput}\n\n` +
    files.map((f) => `===FILE: ${f.rel}===\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n");

  console.log(`\n▶ asking Claude (${MODEL}) to patch ${files.length} file(s) via the API…`);
  let text;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) { console.error(`  API error ${res.status}: ${(await res.text()).slice(0, 200)}`); return false; }
    const json = await res.json();
    text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  } catch (e) {
    console.error(`  API call failed: ${e.message}`);
    return false;
  }
  return writePatchedFiles(repo, text);
}

// Parse the ===FILE:===\n```…``` blocks the model returns and write each back,
// refusing any path that escapes the repo.
function writePatchedFiles(repo, text) {
  const rx = /===FILE:\s*(.+?)\s*===\s*```[\w-]*\n([\s\S]*?)\n```/g;
  let wrote = 0;
  for (const m of text.matchAll(rx)) {
    const rel = m[1].trim();
    const abs = resolve(repo, rel);
    if (isAbsolute(rel) || relative(repo, abs).startsWith("..")) {
      console.error(`  refusing to write outside repo: ${rel}`);
      continue;
    }
    writeFileSync(abs, m[2].endsWith("\n") ? m[2] : m[2] + "\n");
    console.log(`  patched ${rel}`);
    wrote++;
  }
  if (!wrote) console.error("  model returned no parseable file blocks");
  return wrote > 0;
}

// Fixer entry point: prefer the headless Anthropic API (works in CI); fall back to
// the local `claude` CLI only when no API key is set.
async function applyFix(repo, buildOutput, dep) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return anthropicFix(repo, buildOutput, dep, key);
  console.log(`\n▶ no ANTHROPIC_API_KEY, falling back to the local claude CLI…`);
  const prompt =
    `${dep ? `A dependency upgrade ("${dep}") broke the build.` : "The build is broken."} ` +
    `Here is the failing build output:\n\n${buildOutput}\n\n` +
    `Edit the source files so the build passes. Migrate only the broken call sites; don't refactor or downgrade the dependency.`;
  const r = sh("claude", ["-p", prompt, "--permission-mode", "acceptEdits"], repo);
  return r.ok;
}

async function main() {
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
    if (!b.ok) { console.error("bump failed (registry/network?), aborting"); process.exit(1); }
  }

  // Detect → fix → verify, up to MAX_FIX_ROUNDS.
  let build = runBuild(repo);
  let rounds = 0;
  while (!build.ok && rounds < MAX_FIX_ROUNDS) {
    rounds++;
    console.log(`\n✗ build red, fix round ${rounds}/${MAX_FIX_ROUNDS}`);
    await applyFix(repo, build.out, dep);
    build = runBuild(repo);
  }

  if (!build.ok) {
    console.error(`\n✗ still broken after ${rounds} round(s). Leaving the branch for a human.`);
    process.exit(1);
  }
  console.log(`\n✓ build green${rounds ? ` after ${rounds} fix round(s)` : ""}.`);

  if (sub === "upgrade") {
    // Stage only tracked files we touched (manifest, lockfile, patched sources);
    // never sweep in a dirty working tree's untracked files.
    sh("git", ["add", "-u"], repo);
    sh("git", ["commit", "-m", `chore(deps): bump ${dep} to latest + migrate call sites`], repo);
    const pushed = sh("git", ["push", "-u", "origin", branch], repo);
    if (!pushed.ok) { console.error("push failed, is there a remote?"); process.exit(1); }
    const title = `chore(deps): bump ${dep} to latest`;
    const body = rounds
      ? `Automated by self-maintaining-apis.\n\nBumped \`${dep}\` to latest; the upgrade broke the build and Claude migrated the call sites over ${rounds} round(s). Build is green.`
      : `Automated by self-maintaining-apis.\n\nBumped \`${dep}\` to latest. Clean upgrade, build stayed green, no code changes needed.`;
    const pr = sh("gh", ["pr", "create", "--title", title, "--body", body], repo);
    if (pr.ok) console.log(`\n✓ PR opened.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

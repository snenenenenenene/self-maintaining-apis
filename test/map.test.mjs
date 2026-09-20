import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseRange,
  satisfies,
  maxSatisfying,
  newestStable,
  selectEntries,
  symbolsFromQuote,
  listSourceFiles,
  findCallSites,
  importRegExp,
  decideEntry,
  planMap,
  applyRangeBump,
  renderReport,
  findNewestReceiptsFile,
  githubSlugFromRemote,
  readDeclaredDependencies,
  runMap,
  REPORT_FILE,
} from "../bin/lib/map.mjs";

// ---- fixtures: real receipt records from data/receipts-2026-09-20.json ----

const FETCHED_AT = "2026-09-20T08:32:39.371Z";

function receipt(source, title, quote, extra = {}) {
  const url = `https://example.test/${title}`;
  return {
    source,
    id: title,
    title,
    url,
    verdict: "breaking",
    reason: "matched pattern: remove/removed/removal",
    receipt: { url, quote, fetched_at: FETCHED_AT },
    ...extra,
  };
}

const STRIPE_PRERELEASE = receipt(
  "Stripe Node SDK Releases",
  "v22.7.0-alpha.2",
  "Remove support for `execute` and `submit` methods on resource `V2.Core.ApprovalRequest`"
);
const STRIPE_STABLE = receipt(
  "Stripe Node SDK Releases",
  "v22.4.0",
  "Remove support for `proof_of_registration` on `AccountCreateParams.documents`."
);
const STRIPE_VERSIONS = ["21.0.0", "21.5.0", "22.3.1", "22.4.0", "22.6.0", "22.6.2", "22.7.0-alpha.2", "22.7.0-beta.1"];

// A throwaway repo on disk with the given package.json deps and source files.
function fixtureRepo({ deps = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sm-map-fixture-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", private: true, dependencies: deps }, null, 2) + "\n"
  );
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function sources(dir) {
  return listSourceFiles(dir);
}

// ---- range/version join ----

test("range join: a caret range that already reaches the affected version is satisfied", () => {
  const range = parseRange("^22.6.2");
  assert.equal(satisfies("22.6.2", range), true);
  assert.equal(satisfies("22.6.0", range), false, "below the floor");
  assert.equal(satisfies("23.0.0", range), false, "next major");
  assert.equal(maxSatisfying(STRIPE_VERSIONS, range), "22.6.2");
  assert.equal(newestStable(STRIPE_VERSIONS), "22.6.2");
});

test("range join: a range on the previous major does not reach the newest stable", () => {
  const range = parseRange("^21.0.0");
  assert.equal(maxSatisfying(STRIPE_VERSIONS, range), "21.5.0");
  assert.equal(satisfies("22.4.0", range), false);
  assert.equal(parseRange("workspace:*"), null, "unparseable ranges are null, not a guess");
  assert.equal(satisfies("1.9.0", parseRange(">=1.2 <2 || 3.x")), true);
  assert.equal(satisfies("3.4.0", parseRange(">=1.2 <2 || 3.x")), true);
  assert.equal(satisfies("2.0.0", parseRange(">=1.2 <2 || 3.x")), false);
});

test("prerelease: unreachable unless the declared range names one", () => {
  assert.equal(satisfies("22.7.0-alpha.2", parseRange("^22.6.2")), false);
  assert.equal(satisfies("22.7.0-alpha.2", parseRange("^22.7.0-alpha.1")), true);
  assert.equal(maxSatisfying(STRIPE_VERSIONS, parseRange("^22.6.2")), "22.6.2", "prereleases never win maxSatisfying");

  const dir = fixtureRepo({
    deps: { stripe: "^22.6.2" },
    files: { "lib/stripe.ts": 'import Stripe from "stripe";\nexport const approve = (r) => r.execute();\n' },
  });
  try {
    const declared = readDeclaredDependencies(dir);
    const [sel] = selectEntries({ entries: [STRIPE_PRERELEASE] }, declared);
    const files = sources(dir);
    const d = decideEntry(sel, declared.get("stripe"), STRIPE_VERSIONS, files, findCallSites(files, importRegExp("stripe")));
    assert.equal(d.verdict, "unreachable");
    assert.equal(d.resolved, "22.6.2");
    assert.match(d.reason, /prerelease/);
    // The call site is still listed for the reader, but does not change the verdict.
    assert.equal(d.callSites.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- select ----

test("select: joins breaking entries by package and ignores sources that name none", () => {
  const vercel = receipt("Vercel Changelog", "Hobby projects retain fewer deployments", "Preview deployments no longer get their own protection.");
  const nonBreaking = { ...STRIPE_STABLE, verdict: "non-breaking" };
  const withField = receipt("npm: resend", "resend@7.0.0", "resend published 7.0.0, a major version bump from 6.28.1 to 7.0.0.", { package: "resend" });
  const declared = new Map([["stripe", { range: "^22.6.2", field: "dependencies" }], ["resend", { range: "^6.12.2", field: "dependencies" }]]);
  const selected = selectEntries({ entries: [vercel, nonBreaking, STRIPE_STABLE, withField] }, declared);
  assert.deepEqual(selected.map((s) => [s.pkg, s.version]), [["stripe", "22.4.0"], ["resend", "7.0.0"]]);
});

test("select: symbols come from the backticked identifiers in the quoted line", () => {
  assert.deepEqual(symbolsFromQuote(STRIPE_PRERELEASE.receipt.quote), ["execute", "submit", "ApprovalRequest"]);
  assert.deepEqual(symbolsFromQuote("Remove support for `taxes` on `PaymentIntent.payment_details.car_rental_data[].total.tax`"), ["taxes", "tax"]);
  assert.deepEqual(symbolsFromQuote("Remove unused Retry-After header support"), []);
});

// ---- call sites ----

test("call sites: dependency found but zero call sites gives a no-call-sites verdict", () => {
  const dir = fixtureRepo({
    deps: { stripe: "^22.6.2" },
    files: {
      "lib/stripe.ts": 'import Stripe from "stripe";\nexport const stripe = new Stripe(process.env.KEY);\n',
      "lib/other.ts": "export const documents = [];\n", // mentions the symbol but does not import stripe
    },
  });
  try {
    const declared = readDeclaredDependencies(dir);
    const [sel] = selectEntries({ entries: [STRIPE_STABLE] }, declared);
    const files = sources(dir);
    const d = decideEntry(sel, declared.get("stripe"), STRIPE_VERSIONS, files, findCallSites(files, importRegExp("stripe")));
    assert.equal(d.reachable, "yes");
    assert.equal(d.verdict, "no call sites");
    assert.equal(d.callSites.count, 0);
    assert.match(d.reason, /no line in the 1 file\(s\) importing stripe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("call sites: dependency found with call sites is manual review, with path:line rows and a count", () => {
  const many = Array.from({ length: 25 }, (_, i) => `  documents: { proof_of_registration: file${i} },`).join("\n");
  const dir = fixtureRepo({
    deps: { stripe: "^22.6.2" },
    files: {
      "lib/stripe.ts": `import Stripe from "stripe";\nexport const params = {\n${many}\n};\n`,
      "node_modules/stripe/index.js": 'require("stripe"); proof_of_registration;\n',
      ".next/server/x.js": 'require("stripe"); proof_of_registration;\n',
      "dist/x.js": 'require("stripe"); proof_of_registration;\n',
      "big.ts": 'import "stripe";\n' + "proof_of_registration\n".repeat(60_000),
    },
  });
  try {
    const declared = readDeclaredDependencies(dir);
    const [sel] = selectEntries({ entries: [STRIPE_STABLE] }, declared);
    const files = sources(dir);
    assert.deepEqual(files.map((f) => f.rel), ["lib/stripe.ts"], "node_modules, .next, dist and files over 1 MB are excluded");
    const d = decideEntry(sel, declared.get("stripe"), STRIPE_VERSIONS, files, findCallSites(files, importRegExp("stripe")));
    assert.equal(d.verdict, "manual review required");
    assert.equal(d.callSites.count, 25);
    assert.equal(d.callSites.rows.length, 20, "at most 20 rows");
    assert.equal(d.callSites.rows[0].path, "lib/stripe.ts");
    assert.equal(d.callSites.rows[0].line, 3);
    assert.match(d.callSites.rows[0].text, /proof_of_registration/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- decide and fix ----

test("fix: a range below the newest stable with no affected call sites bumps only the range line", () => {
  const dir = fixtureRepo({
    deps: { stripe: "^21.0.0", zod: "^3.0.0" },
    files: { "lib/stripe.ts": 'import Stripe from "stripe";\nexport const stripe = new Stripe("k");\n' },
  });
  try {
    const declared = readDeclaredDependencies(dir);
    const plan = planMap({
      receipts: { entries: [STRIPE_STABLE, STRIPE_PRERELEASE] },
      declared,
      versionsByPackage: { stripe: STRIPE_VERSIONS },
      sourceFiles: sources(dir),
    });
    assert.equal(plan.outcome, "fix");
    assert.deepEqual(plan.fixes.map((f) => [f.pkg, f.from, f.to]), [["stripe", "^21.0.0", "^22.6.2"]]);

    const before = readFileSync(join(dir, "package.json"), "utf8");
    const after = applyRangeBump(before, plan.fixes[0]);
    const changed = before.split("\n").filter((line, i) => line !== after.split("\n")[i]);
    assert.equal(changed.length, 1, "exactly one line differs");
    assert.equal(changed[0].trim(), '"stripe": "^21.0.0",');
    assert.match(after, /"stripe": "\^22\.6\.2",/);
    assert.match(after, /"zod": "\^3\.0\.0"/);
    assert.equal(after.split("\n").length, before.split("\n").length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix is refused when any entry needs manual review, and when the range already reaches newest stable", () => {
  const withUse = fixtureRepo({
    deps: { stripe: "^21.0.0" },
    files: { "lib/stripe.ts": 'import Stripe from "stripe";\nconst p = { documents: { proof_of_registration: f } };\n' },
  });
  const upToDate = fixtureRepo({ deps: { stripe: "^22.6.2" }, files: { "a.ts": 'import "stripe";\n' } });
  try {
    const plan1 = planMap({
      receipts: { entries: [STRIPE_STABLE] },
      declared: readDeclaredDependencies(withUse),
      versionsByPackage: { stripe: STRIPE_VERSIONS },
      sourceFiles: sources(withUse),
    });
    assert.equal(plan1.outcome, "verdict", "22.4.0 is unreachable today but would be after the bump, and a call site uses the symbol");
    assert.equal(plan1.fixes.length, 0);
    assert.equal(plan1.decisions[0].verdict, "unreachable");
    assert.equal(plan1.decisions[0].blocksFix, true);

    const plan2 = planMap({
      receipts: { entries: [STRIPE_STABLE] },
      declared: readDeclaredDependencies(upToDate),
      versionsByPackage: { stripe: STRIPE_VERSIONS },
      sourceFiles: sources(upToDate),
    });
    assert.equal(plan2.outcome, "verdict");
    assert.equal(plan2.overall, "no call sites");
    assert.equal(plan2.fixes.length, 0);

    const report = renderReport(plan2, { repoName: "fixture", receiptsFile: "/x/receipts-2026-09-20.json", date: "2026-09-20" });
    assert.match(report, /Outcome: verdict, no call sites/);
    assert.match(report, /Source: Stripe Node SDK Releases/);
    assert.match(report, /Receipt: https:\/\/example\.test\/v22\.4\.0/);
    assert.match(report, /Quoted line: "Remove support for `proof_of_registration`/);
    assert.match(report, new RegExp(`Fetched at: ${FETCHED_AT}`));
    assert.match(report, /resolves to 22\.6\.2; newest stable 22\.6\.2/);
    assert.doesNotMatch(report, /\u2014/, "no em dashes in committed prose");
  } finally {
    rmSync(withUse, { recursive: true, force: true });
    rmSync(upToDate, { recursive: true, force: true });
  }
});

// ---- run orchestration: receipts lookup, exit codes, one PR on a fresh worktree ----

function fixtureRoot(entries) {
  const root = mkdtempSync(join(tmpdir(), "sm-map-root-"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "receipts-2026-09-19.json"), JSON.stringify({ entries: [] }));
  writeFileSync(join(root, "data", "receipts-2026-09-20.json"), JSON.stringify({ entries }));
  return root;
}

test("runMap: picks the newest receipts file and exits non-zero when nothing joins", async () => {
  const root = fixtureRoot([STRIPE_STABLE]);
  const repo = fixtureRepo({ deps: { resend: "^6.12.2" } });
  const logs = [];
  try {
    assert.match(findNewestReceiptsFile(join(root, "data")), /receipts-2026-09-20\.json$/);
    const r = await runMap({ repoRoot: root, repoPath: repo, log: (m) => logs.push(m), fetchImpl: async () => ({ ok: false }) });
    assert.equal(r.exitCode, 1);
    assert.match(logs.join("\n"), /nothing to act on: receipts-2026-09-20\.json has 1 breaking entries naming stripe, and .* declares none of them/);
    const bad = await runMap({ repoRoot: root, repoPath: join(repo, "missing"), log: (m) => logs.push(m) });
    assert.equal(bad.exitCode, 1);
    assert.match(logs.at(-1), /cannot resolve/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runMap: verdict outcome commits one report on a self-maintain branch off origin default and opens one PR", async () => {
  const root = fixtureRoot([STRIPE_STABLE, STRIPE_PRERELEASE]);
  const repo = fixtureRepo({
    deps: { stripe: "^22.6.2" },
    files: { "lib/stripe.ts": 'import Stripe from "stripe";\nconst p = { documents: { proof_of_registration: f } };\n' },
  });
  const calls = [];
  const worktree = "/tmp/sm-map-" + repo.split("/").pop().toLowerCase() + "-2026-09-20";
  const sh = (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    const line = `${cmd} ${args.join(" ")}`;
    if (line === "git remote get-url origin") return { ok: true, out: "https://github.com/acme/widgets.git" };
    if (line.startsWith("git symbolic-ref")) return { ok: true, out: "origin/main" };
    if (line.startsWith("git rev-parse --verify")) return { ok: false, out: "" };
    if (line.startsWith("git worktree add")) { mkdirSync(args[2], { recursive: true }); return { ok: true, out: "" }; }
    if (line.startsWith("git worktree remove")) { rmSync(args[3], { recursive: true, force: true }); return { ok: true, out: "" }; }
    if (cmd === "gh" && args[0] === "pr") return { ok: true, out: "https://github.com/acme/widgets/pull/7" };
    return { ok: true, out: "" };
  };
  const logs = [];
  try {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ versions: Object.fromEntries(STRIPE_VERSIONS.map((v) => [v, {}])) }) });
    const r = await runMap({ repoRoot: root, repoPath: repo, sh, fetchImpl, now: new Date("2026-09-20T12:00:00Z"), log: (m) => logs.push(m) });
    assert.equal(r.exitCode, 0);
    assert.equal(r.prUrl, "https://github.com/acme/widgets/pull/7");
    assert.equal(r.branch, "self-maintain/map-stripe-2026-09-20");

    const add = calls.find((c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add");
    assert.deepEqual(add.args, ["worktree", "add", worktree, "-b", "self-maintain/map-stripe-2026-09-20", "origin/main"]);
    assert.equal(add.cwd, repo, "worktree is added from inside the target repo");

    const staged = calls.filter((c) => c.cmd === "git" && c.args[0] === "add");
    assert.deepEqual(staged.map((c) => c.args), [["add", REPORT_FILE]], "only the report is staged");
    assert.ok(calls.every((c) => !(c.cmd === "git" && c.args[0] === "push" && c.args.includes("main"))), "never pushes the default branch");
    const push = calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    assert.deepEqual(push.args, ["push", "-u", "origin", "self-maintain/map-stripe-2026-09-20"]);
    assert.equal(push.cwd, worktree);

    const prs = calls.filter((c) => c.cmd === "gh");
    assert.equal(prs.length, 1, "exactly one PR");
    const pr = prs[0].args;
    assert.equal(pr[3], "acme/widgets");
    assert.equal(pr[pr.indexOf("--base") + 1], "main");
    const body = pr[pr.indexOf("--body") + 1];
    assert.match(body, /Outcome: verdict, manual review required/);
    assert.match(body, /lib\/stripe\.ts:2/);
    assert.match(body, /\nA human must review and merge this pull request\.\n/);
    assert.match(body, /\nGenerated by self-maintaining-apis from https:\/\/example\.test\/v22\.4\.0, https:\/\/example\.test\/v22\.7\.0-alpha\.2\n$/);

    assert.equal(existsSync(worktree), false, "worktree removed afterwards");
    assert.equal(existsSync(join(repo, REPORT_FILE)), false, "the target checkout itself is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("githubSlugFromRemote handles https and ssh remotes", () => {
  assert.equal(githubSlugFromRemote("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(githubSlugFromRemote("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(githubSlugFromRemote("https://gitlab.com/acme/widgets.git"), null);
});

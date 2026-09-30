// The map half of the loop: take the newest receipts file, keep the breaking
// entries, join them against what a target repo declares in package.json, and
// turn the result into exactly one pull request on that repo. The PR either
// bumps a declared range (outcome `fix`, only when that one line is provably the
// whole change) or records a precise no-fix-needed verdict with the receipt
// (outcome `verdict`).
//
// Every decision here is deterministic: version arithmetic on the declared
// range, and a static search of the repo's own source. No model call.
// Zero runtime dependencies: Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { packageForSource } from "./watch.mjs";

export const USER_AGENT = "self-maintaining-apis-map/0.1";
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_CALL_SITE_ROWS = 20;
export const MAX_SOURCE_FILE_BYTES = 1_000_000;
export const REPORT_FILE = "self-maintain-report.md";
export const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", ".vercel", "coverage"]);
const SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro",
]);

// ---- semver: just enough to answer "does this declared range reach that version" ----

export function parseVersion(input) {
  const s = String(input || "").trim().replace(/^v/, "");
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return {
    raw: s,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

function compareIdentifiers(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1; // numeric identifiers sort before alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a, b) {
  const va = typeof a === "string" ? parseVersion(a) : a;
  const vb = typeof b === "string" ? parseVersion(b) : b;
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  if (va.patch !== vb.patch) return va.patch - vb.patch;
  // A version with a prerelease tag sorts below the same version without one.
  if (va.prerelease.length && !vb.prerelease.length) return -1;
  if (!va.prerelease.length && vb.prerelease.length) return 1;
  const n = Math.max(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < n; i++) {
    if (va.prerelease[i] === undefined) return -1;
    if (vb.prerelease[i] === undefined) return 1;
    const c = compareIdentifiers(va.prerelease[i], vb.prerelease[i]);
    if (c !== 0) return c;
  }
  return 0;
}

// Expands one range token ("^1.2.3", "~1.2", ">=2", "1.x", "*", "1.2.3") into
// a list of primitive comparators { op, version }. Returns null when the token
// is not something we can reason about (git URLs, tags, "workspace:*", ...).
function expandToken(token) {
  const t = token.trim();
  if (t === "" || t === "*" || /^x$/i.test(t)) return [];
  const m = t.match(/^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i);
  if (!m) return null;
  const op = m[1] || "";
  const isX = (v) => v === undefined || /^[x*]$/i.test(v);
  const major = isX(m[2]) ? null : Number(m[2]);
  const minor = isX(m[3]) ? null : Number(m[3]);
  const patch = isX(m[4]) ? null : Number(m[4]);
  const pre = m[5] ? `-${m[5]}` : "";
  if (major === null) return [];
  const v = (a, b, c, p = "") => ({ major: a, minor: b, patch: c, prerelease: p ? p.slice(1).split(".") : [], raw: `${a}.${b}.${c}${p}` });

  if (op === "^") {
    const lo = v(major, minor ?? 0, patch ?? 0, pre);
    let hi;
    if (major > 0 || minor === null) hi = v(major + 1, 0, 0, "-0");
    else if (minor > 0 || patch === null) hi = v(0, minor + 1, 0, "-0");
    else hi = v(0, minor, patch + 1, "-0");
    return [{ op: ">=", version: lo }, { op: "<", version: hi }];
  }
  if (op === "~") {
    const lo = v(major, minor ?? 0, patch ?? 0, pre);
    const hi = minor === null ? v(major + 1, 0, 0, "-0") : v(major, minor + 1, 0, "-0");
    return [{ op: ">=", version: lo }, { op: "<", version: hi }];
  }
  if (minor === null || patch === null) {
    // X-range with a comparison operator, or a bare partial like "1.2".
    const lo = v(major, minor ?? 0, 0);
    const hi = minor === null ? v(major + 1, 0, 0, "-0") : v(major, minor + 1, 0, "-0");
    if (op === "" || op === "=") return [{ op: ">=", version: lo }, { op: "<", version: hi }];
    if (op === ">") return [{ op: ">=", version: hi }];
    if (op === "<=") return [{ op: "<", version: hi }];
    if (op === ">=") return [{ op: ">=", version: lo }];
    if (op === "<") return [{ op: "<", version: lo }];
  }
  const exact = v(major, minor, patch, pre);
  if (op === "" || op === "=") return [{ op: "=", version: exact }];
  return [{ op, version: exact }];
}

// A range is a list of alternatives (split on ||); each alternative is a list of
// comparators that must all hold. Hyphen ranges ("1.2.3 - 2.3.4") are supported.
export function parseRange(rangeText) {
  const text = String(rangeText ?? "").trim();
  if (text === "" || text === "latest") return text === "" ? [[]] : null;
  const alternatives = [];
  for (const alt of text.split("||")) {
    let s = alt.trim();
    if (s === "") { alternatives.push([]); continue; }
    const hyphen = s.match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen) {
      const lo = expandToken(`>=${hyphen[1]}`);
      const hi = expandToken(`<=${hyphen[2]}`);
      if (!lo || !hi) return null;
      alternatives.push([...lo, ...hi]);
      continue;
    }
    // Normalise "> 1.2.3" to ">1.2.3" so a stray space does not split a token.
    s = s.replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1");
    const comparators = [];
    for (const token of s.split(/\s+/)) {
      const c = expandToken(token);
      if (c === null) return null;
      comparators.push(...c);
    }
    alternatives.push(comparators);
  }
  return alternatives;
}

function comparatorHolds(version, { op, version: target }) {
  const c = compareVersions(version, target);
  switch (op) {
    case "=": return c === 0;
    case ">": return c > 0;
    case ">=": return c >= 0;
    case "<": return c < 0;
    case "<=": return c <= 0;
    default: return false;
  }
}

// Does the declared range name a prerelease tag anywhere? A prerelease version
// counts as reachable only when it does; the "-0" sentinel on generated upper
// bounds is not a named prerelease.
export function rangeNamesPrerelease(range) {
  return (range || []).some((alt) => alt.some((c) => c.version.prerelease.length && c.version.prerelease[0] !== "0"));
}

export function satisfies(versionText, range) {
  const version = typeof versionText === "string" ? parseVersion(versionText) : versionText;
  if (!version || !range) return false;
  if (version.prerelease.length && !rangeNamesPrerelease(range)) return false;
  return range.some((alt) => alt.every((c) => comparatorHolds(version, c)));
}

export function isPrerelease(versionText) {
  const v = parseVersion(versionText);
  return Boolean(v && v.prerelease.length);
}

export function sortVersions(list) {
  return list.filter((v) => parseVersion(v)).sort((a, b) => compareVersions(a, b));
}

// Newest version in `versions` the range resolves to, or null.
export function maxSatisfying(versions, range) {
  const ok = sortVersions(versions).filter((v) => satisfies(v, range));
  return ok.length ? ok[ok.length - 1] : null;
}

export function newestStable(versions) {
  const stable = sortVersions(versions).filter((v) => !isPrerelease(v));
  return stable.length ? stable[stable.length - 1] : null;
}

// ---- select: which breaking entries name a package this repo declares ----

export function findNewestReceiptsFile(dataDir) {
  if (!existsSync(dataDir)) return null;
  const files = readdirSync(dataDir)
    .filter((f) => /^receipts-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  return files.length ? join(dataDir, files[files.length - 1]) : null;
}

export function readDeclaredDependencies(repoPath) {
  const pkgPath = join(repoPath, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const declared = new Map();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] || {})) {
      if (!declared.has(name)) declared.set(name, { range: String(range), field });
    }
  }
  return declared;
}

export function packageForEntry(entry) {
  return entry.package || packageForSource(entry.source);
}

// "v22.6.0" -> "22.6.0"; "resend@6.28.1" -> "6.28.1"; anything else -> null.
export function versionFromEntry(entry, pkg) {
  const title = String(entry.title || "").trim();
  const stripped = pkg && title.startsWith(`${pkg}@`) ? title.slice(pkg.length + 1) : title;
  const v = parseVersion(stripped);
  return v ? v.raw : null;
}

export function selectEntries(receipts, declared) {
  const selected = [];
  for (const entry of receipts.entries || []) {
    if (entry.verdict !== "breaking") continue;
    const pkg = packageForEntry(entry);
    if (!pkg || !declared.has(pkg)) continue;
    selected.push({ entry, pkg, version: versionFromEntry(entry, pkg) });
  }
  return selected;
}

// ---- call sites: static search over the repo's own source ----

// Backticked identifiers in the quoted line are the affected symbols or fields:
// "Remove support for `execute` on `V2.Core.ApprovalRequest`" -> execute, ApprovalRequest.
export function symbolsFromQuote(quote) {
  const out = [];
  for (const m of String(quote || "").matchAll(/`([^`]+)`/g)) {
    const token = m[1].replace(/\[\]/g, "").replace(/\(\)$/, "").trim();
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(token)) continue;
    const leaf = token.split(".").pop();
    if (!out.includes(leaf)) out.push(leaf);
  }
  return out;
}

export function listSourceFiles(repoPath) {
  const files = [];
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        walk(join(dir, d.name));
        continue;
      }
      if (!d.isFile()) continue;
      const ext = d.name.slice(d.name.lastIndexOf("."));
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      const abs = join(dir, d.name);
      let size;
      try { size = statSync(abs).size; } catch { continue; }
      if (size > MAX_SOURCE_FILE_BYTES) continue;
      files.push({ rel: relative(repoPath, abs).split("\\").join("/"), abs });
    }
  };
  walk(repoPath);
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lines that import or require the package: from "pkg", from "pkg/sub", require("pkg"), import("pkg").
export function importRegExp(pkg) {
  const p = escapeRegExp(pkg);
  return new RegExp(`(?:from\\s*|require\\s*\\(\\s*|import\\s*\\(\\s*)["'](?:${p})(?:/[^"']*)?["']`);
}

export function symbolRegExp(symbol) {
  return new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
}

// Scan `files` (each { rel, abs } or { rel, text }) for lines matching `re`.
// Returns at most MAX_CALL_SITE_ROWS rows plus the full count.
export function findCallSites(files, re, limit = MAX_CALL_SITE_ROWS) {
  const rows = [];
  let count = 0;
  const matchedFiles = new Set();
  for (const f of files) {
    let text = f.text;
    if (text === undefined) {
      try { text = readFileSync(f.abs, "utf8"); } catch { continue; }
    }
    if (text.includes("\0")) continue; // binary, not source
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      count++;
      matchedFiles.add(f.rel);
      if (rows.length < limit) rows.push({ path: f.rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
    }
  }
  return { rows, count, files: [...matchedFiles] };
}

// ---- decide: version arithmetic plus call sites, one verdict per entry ----

function describeRange(range, versions, declaredText) {
  if (!range) return { resolved: null, note: `declared range "${declaredText}" is not a version range this tool can evaluate` };
  const resolved = maxSatisfying(versions, range);
  if (!resolved) return { resolved: null, note: `declared range "${declaredText}" resolves to none of the ${versions.length} known versions` };
  return { resolved, note: `declared range "${declaredText}" resolves to ${resolved}` };
}

export function decideEntry({ entry, pkg, version }, declared, versions, sourceFiles, importSites) {
  const range = parseRange(declared.range);
  const { resolved, note } = describeRange(range, versions, declared.range);
  const symbols = symbolsFromQuote(entry.receipt && entry.receipt.quote);

  // Symbol search is restricted to files that import the package, so common
  // words like `execute` or `taxes` do not match unrelated code.
  const importingFiles = sourceFiles.filter((f) => importSites.files.includes(f.rel));
  let callSites = { rows: [], count: 0, files: [] };
  if (symbols.length) {
    const re = new RegExp(symbols.map((s) => symbolRegExp(s).source).join("|"));
    callSites = findCallSites(importingFiles, re);
  }

  const arithmetic = [];
  let reachable;
  if (!version) {
    reachable = "unknown";
    arithmetic.push(`the entry title "${entry.title}" does not name a version, so reachability cannot be computed`);
  } else if (!range || !resolved) {
    reachable = "unknown";
    arithmetic.push(note);
  } else if (isPrerelease(version) && !rangeNamesPrerelease(range)) {
    reachable = "no";
    arithmetic.push(note);
    arithmetic.push(`${version} is a prerelease and the declared range names no prerelease, so it is unreachable`);
  } else if (compareVersions(resolved, version) >= 0) {
    reachable = "yes";
    arithmetic.push(note);
    arithmetic.push(`${resolved} >= ${version}, so the change introduced in ${version} is reachable`);
  } else {
    reachable = "no";
    arithmetic.push(note);
    arithmetic.push(`${resolved} < ${version}, so the change introduced in ${version} is unreachable`);
  }

  let verdict;
  let reason;
  if (reachable === "no") {
    verdict = "unreachable";
    reason = arithmetic[arithmetic.length - 1];
  } else if (symbols.length && callSites.count === 0) {
    verdict = "no call sites";
    reason = `no line in the ${importingFiles.length} file(s) importing ${pkg} uses ${symbols.map((s) => `\`${s}\``).join(", ")}`;
  } else if (symbols.length) {
    verdict = "manual review required";
    reason = `${callSites.count} call site(s) use ${symbols.map((s) => `\`${s}\``).join(", ")}`;
  } else if (importSites.count === 0) {
    verdict = "no call sites";
    reason = `the quoted line names no symbol and nothing in the repo imports ${pkg}`;
  } else {
    verdict = "manual review required";
    reason = `the quoted line names no symbol to search for, and ${importSites.count} line(s) import ${pkg}`;
    callSites = importSites;
  }
  if (reachable === "unknown") reason = `${arithmetic[0]}; ${reason}`;

  // Would this entry need a human once its version is reachable? Used by the
  // fix gate, which must look past today's range: a bump makes stable entries
  // reachable, while prereleases stay unreachable under any stable range.
  const usesSymbol = symbols.length ? callSites.count > 0 : importSites.count > 0;
  const blocksFix = usesSymbol && !(version && isPrerelease(version));

  return { entry, pkg, version, declared, resolved, reachable, symbols, callSites, arithmetic, verdict, reason, blocksFix };
}

// Outcome `fix` only when it is provable and mechanical: a simple caret, tilde
// or exact range that does not reach the newest stable version, and not a
// single entry that uses an affected symbol once reachable. Everything else is
// a verdict.
function simpleRangeBump(declaredText, target) {
  const m = String(declaredText).trim().match(/^(\^|~|=)?v?(\d+\.\d+\.\d+)$/);
  if (!m) return null;
  return `${m[1] || ""}${target}`;
}

export function planMap({ receipts, declared, versionsByPackage, sourceFiles }) {
  const selected = selectEntries(receipts, declared);
  if (!selected.length) return { outcome: "none", packages: [], decisions: [] };

  const packages = [...new Set(selected.map((s) => s.pkg))].sort();
  const decisions = [];
  const summary = {};
  for (const pkg of packages) {
    const dep = declared.get(pkg);
    const versions = versionsByPackage[pkg] || [];
    const importSites = findCallSites(sourceFiles, importRegExp(pkg));
    const range = parseRange(dep.range);
    const stable = newestStable(versions);
    const resolved = range ? maxSatisfying(versions, range) : null;
    summary[pkg] = { declared: dep, importSites, stable, resolved, versionCount: versions.length };
    for (const s of selected.filter((x) => x.pkg === pkg)) {
      decisions.push(decideEntry(s, dep, versions, sourceFiles, importSites));
    }
  }

  const fixes = [];
  for (const pkg of packages) {
    const { declared: dep, stable, resolved } = summary[pkg];
    if (!stable || !resolved || compareVersions(resolved, stable) >= 0) continue;
    const blocked = decisions.some((d) => d.pkg === pkg && d.blocksFix);
    const bumped = simpleRangeBump(dep.range, stable);
    if (blocked || !bumped) continue;
    fixes.push({ pkg, field: dep.field, from: dep.range, to: bumped, stable, resolved });
  }
  const anyReview = decisions.some((d) => d.verdict === "manual review required");
  const anyBlocked = decisions.some((d) => d.blocksFix);
  const outcome = fixes.length && !anyReview && !anyBlocked ? "fix" : "verdict";
  const overall = anyReview
    ? "manual review required"
    : decisions.some((d) => d.verdict === "no call sites")
      ? "no call sites"
      : "unreachable";
  return { outcome, packages, decisions, summary, fixes, overall };
}

// Rewrite exactly the one `"pkg": "range"` line inside the named field, keeping
// every other byte of package.json as it was.
export function applyRangeBump(packageJsonText, { pkg, field, from, to }) {
  const lines = packageJsonText.split("\n");
  const fieldRe = new RegExp(`^\\s*"${escapeRegExp(field)}"\\s*:\\s*\\{`);
  const lineRe = new RegExp(`^(\\s*"${escapeRegExp(pkg)}"\\s*:\\s*")${escapeRegExp(from)}("\\s*,?\\s*)$`);
  let inField = false;
  for (let i = 0; i < lines.length; i++) {
    if (!inField) { inField = fieldRe.test(lines[i]); continue; }
    if (/^\s*\}/.test(lines[i])) { inField = false; continue; }
    const m = lines[i].match(lineRe);
    if (!m) continue;
    lines[i] = `${m[1]}${to}${m[2]}`;
    return lines.join("\n");
  }
  throw new Error(`${pkg}@${from} not found under ${field} in package.json`);
}

// ---- report ----

function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function callSiteTable(callSites) {
  if (!callSites.count) return "No call sites.\n";
  const rows = callSites.rows.map((r) => `| ${cell(r.path)}:${r.line} | \`${cell(r.text).replace(/`/g, "'")}\` |`).join("\n");
  const more = callSites.count > callSites.rows.length ? `\n${callSites.count - callSites.rows.length} more not shown.\n` : "\n";
  return `| location | line |\n| --- | --- |\n${rows}\n\n${callSites.count} call site(s).${more}`;
}

export function renderReport(plan, { repoName, receiptsFile, date }) {
  const lines = [];
  lines.push(`# Breaking changelog entries mapped to ${repoName}`);
  lines.push("");
  lines.push(`Receipts: ${basename(receiptsFile)}. Run date: ${date}.`);
  lines.push("");
  if (plan.outcome === "fix") {
    lines.push("## Outcome: fix");
    lines.push("");
    for (const f of plan.fixes) {
      lines.push(`- ${f.pkg} (${f.field}): ${f.from} changed to ${f.to}. The declared range resolved to ${f.resolved}, the newest stable version is ${f.stable}, and no call site uses a symbol named in the breaking entries below, so the range bump is the whole change. The lockfile is not updated here.`);
    }
  } else {
    lines.push(`## Outcome: verdict, ${plan.overall}`);
    lines.push("");
    lines.push("No file other than this report is changed.");
  }
  lines.push("");
  lines.push("## Version arithmetic");
  lines.push("");
  for (const pkg of plan.packages) {
    const s = plan.summary[pkg];
    lines.push(`- ${pkg}: declared "${s.declared.range}" in ${s.declared.field}; resolves to ${s.resolved || "nothing"}; newest stable ${s.stable || "unknown"}; ${s.versionCount} versions considered; ${s.importSites.count} import line(s) in ${s.importSites.files.length} file(s).`);
  }
  lines.push("");
  lines.push("## Entries");
  lines.push("");
  for (const d of plan.decisions) {
    const r = d.entry.receipt || {};
    lines.push(`### ${d.pkg}: ${d.entry.title}`);
    lines.push("");
    lines.push(`- Source: ${d.entry.source}`);
    lines.push(`- Receipt: ${r.url || d.entry.url}`);
    lines.push(`- Quoted line: "${cell(r.quote)}"`);
    lines.push(`- Fetched at: ${r.fetched_at || "unknown"}`);
    lines.push(`- Classified as: ${d.entry.verdict} (${d.entry.reason})`);
    lines.push(`- Verdict: ${d.verdict}`);
    lines.push(`- Reason: ${d.reason}`);
    lines.push(`- Affected symbols searched: ${d.symbols.length ? d.symbols.map((s) => `\`${s}\``).join(", ") : "none named in the quoted line"}`);
    lines.push(`- Arithmetic: ${d.arithmetic.join("; ")}`);
    lines.push("");
    lines.push(callSiteTable(d.callSites));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---- registry lookup (public, unauthenticated; abbreviated metadata) ----

export async function fetchVersions(pkg, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${pkg}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return Object.keys(json.versions || {});
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- git and gh plumbing for the target repo ----

function runCmd(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim(), status: r.status };
}

export function githubSlugFromRemote(url) {
  const m = String(url || "").trim().match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function defaultBranch(repoPath, slug, sh) {
  const sym = sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath);
  if (sym.ok && sym.out.startsWith("origin/")) return sym.out.slice("origin/".length);
  const gh = sh("gh", ["repo", "view", slug, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], repoPath);
  if (gh.ok && gh.out) return gh.out;
  return "main";
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Main entry point. `sh`, `fetchImpl` and `now` are injectable for tests.
export async function runMap({
  repoRoot,
  repoPath,
  fetchImpl = fetch,
  now = new Date(),
  sh = runCmd,
  log = console.log,
  dryRun = false,
} = {}) {
  const fail = (msg) => { log(msg); return { exitCode: 1, reason: msg }; };

  if (!repoPath || !existsSync(repoPath) || !existsSync(join(repoPath, "package.json"))) {
    return fail(`cannot resolve ${repoPath || "(no path)"}: expected a directory with a package.json`);
  }
  const receiptsFile = findNewestReceiptsFile(join(repoRoot, "data"));
  if (!receiptsFile) return fail(`no data/receipts-*.json under ${repoRoot}; run watch first`);
  const receipts = JSON.parse(readFileSync(receiptsFile, "utf8"));
  const declared = readDeclaredDependencies(repoPath);
  const breaking = (receipts.entries || []).filter((e) => e.verdict === "breaking");
  const selected = selectEntries(receipts, declared);
  if (!selected.length) {
    const named = [...new Set(breaking.map((e) => packageForEntry(e)).filter(Boolean))];
    return fail(
      `nothing to act on: ${basename(receiptsFile)} has ${breaking.length} breaking entries naming ${named.length ? named.join(", ") : "no package"}, ` +
        `and ${basename(repoPath)} declares none of them`
    );
  }

  const packages = [...new Set(selected.map((s) => s.pkg))].sort();
  const versionsByPackage = {};
  for (const pkg of packages) {
    let versions = await fetchVersions(pkg, fetchImpl);
    if (!versions) {
      // Offline fallback: the versions the receipts themselves name.
      versions = (receipts.entries || []).map((e) => (packageForEntry(e) === pkg ? versionFromEntry(e, pkg) : null)).filter(Boolean);
      log(`registry unreachable for ${pkg}; using the ${versions.length} versions named in the receipts`);
    }
    versionsByPackage[pkg] = versions;
  }

  const sourceFiles = listSourceFiles(repoPath).filter((f) => f.rel !== REPORT_FILE);
  const plan = planMap({ receipts, declared, versionsByPackage, sourceFiles });
  const date = now.toISOString().slice(0, 10);
  const repoName = basename(repoPath);
  const report = renderReport(plan, { repoName, receiptsFile, date });
  log(`outcome: ${plan.outcome}${plan.outcome === "verdict" ? `, ${plan.overall}` : ""}; ${plan.decisions.length} entries across ${packages.join(", ")}`);
  if (dryRun) {
    log(report);
    return { exitCode: 0, plan, report };
  }

  // One PR per run, on a fresh worktree, never on the default branch.
  const remote = sh("git", ["remote", "get-url", "origin"], repoPath);
  const slug = remote.ok ? githubSlugFromRemote(remote.out) : null;
  if (!slug) return fail(`cannot find a GitHub origin remote in ${repoPath}`);
  const base = defaultBranch(repoPath, slug, sh);
  const branch = `self-maintain/${slugify(`map-${packages.join("-")}`)}-${date}`;
  const worktree = `/tmp/sm-map-${slugify(repoName)}-${date}`;
  log(`repo: ${slug}, base: ${base}, branch: ${branch}, worktree: ${worktree}`);

  const fetched = sh("git", ["fetch", "origin", base], repoPath);
  if (!fetched.ok) return fail(`git fetch origin ${base} failed: ${fetched.out}`);
  if (existsSync(worktree)) sh("git", ["worktree", "remove", "--force", worktree], repoPath);
  if (sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoPath).ok) {
    sh("git", ["branch", "-D", branch], repoPath);
  }
  const added = sh("git", ["worktree", "add", worktree, "-b", branch, `origin/${base}`], repoPath);
  if (!added.ok) return fail(`git worktree add failed: ${added.out}`);

  const cleanup = () => sh("git", ["worktree", "remove", "--force", worktree], repoPath);
  try {
    let title;
    let commitMessage;
    if (plan.outcome === "fix") {
      const pkgPath = join(worktree, "package.json");
      let text = readFileSync(pkgPath, "utf8");
      for (const f of plan.fixes) text = applyRangeBump(text, f);
      writeFileSync(pkgPath, text);
      sh("git", ["add", "package.json"], worktree);
      const what = plan.fixes.map((f) => `${f.pkg} ${f.from} to ${f.to}`).join(", ");
      title = `Bump ${what}`;
      commitMessage = `Bump ${what}\n\nThe declared range did not reach the newest stable version and no call site uses a symbol named in the breaking changelog entries. See the pull request for the receipts.`;
    } else {
      writeFileSync(join(worktree, REPORT_FILE), report);
      sh("git", ["add", REPORT_FILE], worktree);
      title = `Changelog verdict for ${packages.join(", ")}: ${plan.overall}`;
      commitMessage = `Record changelog verdict for ${packages.join(", ")}: ${plan.overall}\n\nAdds ${REPORT_FILE} with the receipts, the version arithmetic and the call sites. No other file changes.`;
    }
    const committed = sh("git", ["commit", "-m", commitMessage], worktree);
    if (!committed.ok) return fail(`git commit failed: ${committed.out}`);
    const pushed = sh("git", ["push", "-u", "origin", branch], worktree);
    if (!pushed.ok) return fail(`git push failed: ${pushed.out}`);

    const receiptUrls = [...new Set(plan.decisions.map((d) => (d.entry.receipt && d.entry.receipt.url) || d.entry.url))];
    const body =
      `${report}\n` +
      `A human must review and merge this pull request.\n\n` +
      `Generated by self-maintaining-apis from ${receiptUrls.join(", ")}\n`;
    const pr = sh("gh", ["pr", "create", "-R", slug, "--base", base, "--head", branch, "--title", title, "--body", body], worktree);
    if (!pr.ok) return fail(`gh pr create failed (branch ${branch} is pushed): ${pr.out}`);
    const prUrl = (pr.out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [pr.out])[0];
    log(`PR opened: ${prUrl}`);
    return { exitCode: 0, plan, report, branch, prUrl };
  } finally {
    cleanup();
  }
}

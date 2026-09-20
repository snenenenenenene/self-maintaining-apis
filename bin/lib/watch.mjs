// The watch half of the loop: poll vendor changelogs, classify each entry as
// breaking or not with a deterministic rule set, and keep a receipt (source URL +
// the exact quoted line + when it was fetched) for every new entry found.
//
// Zero runtime dependencies: Node built-ins only (fetch, node:fs, node:path).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const USER_AGENT = "self-maintaining-apis-watch/0.1";
export const FETCH_TIMEOUT_MS = 15_000;
const MAX_ENTRIES_PER_SOURCE = 20;

// Deterministic classification rules. Kept as one exported table so they can be
// unit-tested offline against fixture text, no network and no model call.
export const BREAKING_PATTERNS = [
  { id: "remove", label: "remove/removed/removal", re: /\bremov(e|es|ed|al)\b/i },
  { id: "deprecate", label: "deprecate/deprecated/deprecation", re: /\bdeprecat(e|es|ed|ion)\b/i },
  { id: "renamed", label: "renamed", re: /\brenamed\b/i },
  { id: "breaking-change", label: "breaking change", re: /\bbreaking changes?\b/i },
  { id: "no-longer", label: "no longer", re: /\bno longer\b/i },
  { id: "sunset", label: "sunset", re: /\bsunset\b/i },
  { id: "eol", label: "end of life / EOL", re: /\bend[- ]of[- ]life\b|\bEOL\b/ },
  { id: "not-supported", label: "not supported", re: /\bnot supported\b/i },
  { id: "migration-required", label: "migration required", re: /\bmigration (?:is )?required\b|\brequires? migration\b/i },
  {
    id: "auth-change",
    label: "auth/token change",
    re: /\b(auth(?:entication)?|tokens?)\b[^.\n]{0,60}\b(chang(?:e|ed|es|ing)|rotat(?:e|ed|ion)|expir(?:e|ed|ation)|revok(?:e|ed))\b/i,
  },
  { id: "requires-update", label: "requires an update", re: /\brequires? (?:an? )?(?:\w+\s){0,3}update\b/i },
  { id: "major-version", label: "major version bump", re: /\bmajor version\b/i },
];

function trimQuote(s) {
  const cleaned = s.replace(/^[\s#>*-]+/, "").replace(/⚠️|⚠/g, "").trim();
  return cleaned.length > 300 ? cleaned.slice(0, 300) : cleaned;
}

// Split title+body into line/sentence units and return the first one that matches
// a breaking pattern, in reading order. That unit, trimmed, is the receipt quote.
export function classify(title, body) {
  const text = `${title || ""}\n${body || ""}`;
  const units = text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((u) => u.trim())
    .filter(Boolean);
  for (const unit of units) {
    for (const pattern of BREAKING_PATTERNS) {
      if (pattern.re.test(unit)) {
        return { verdict: "breaking", reason: `matched pattern: ${pattern.label}`, quote: trimQuote(unit) };
      }
    }
  }
  const fallback = units[0] || title || "(no summary text available)";
  return { verdict: "non-breaking", reason: "no breaking pattern matched", quote: trimQuote(fallback) };
}

// ---- feed parsing (RSS 2.0 <item> and Atom <entry>, regex-based, no XML dep) ----

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeEntities(m[1]).trim() : "";
}

function extractLinkHref(block) {
  const m = block.match(/<link\b[^>]*href="([^"]+)"[^>]*\/?>/i);
  if (m) return m[1];
  const m2 = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  return m2 ? decodeEntities(m2[1]).trim() : "";
}

export function parseFeedText(text) {
  const blocks = text.match(/<item\b[\s\S]*?<\/item>/gi) || text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.map((block) => {
    const title = stripTags(extractTag(block, "title"));
    const url = extractLinkHref(block);
    const guid = extractTag(block, "guid") || extractTag(block, "id") || url;
    const body = stripTags(extractTag(block, "description") || extractTag(block, "content") || extractTag(block, "summary"));
    const publishedAt = extractTag(block, "pubDate") || extractTag(block, "updated") || extractTag(block, "published");
    return { id: guid || url || title, title, url, body, publishedAt };
  });
}

// ---- GitHub releases API (unauthenticated, JSON array) ----

export function parseGithubReleasesText(text) {
  const json = JSON.parse(text);
  if (!Array.isArray(json)) throw new Error("expected an array of releases");
  return json.map((r) => ({
    id: String(r.id ?? r.tag_name ?? r.name),
    title: r.name || r.tag_name || String(r.id),
    url: r.html_url || "",
    body: r.body || "",
    publishedAt: r.published_at || r.created_at || "",
  }));
}

// ---- npm registry (the `time` map has no changelog text, so we synthesize a
// factual one-line body from the real fields: package name, versions, dates.
// A major-version bump is a real, literal signal for the "major version bump"
// breaking pattern; a minor/patch bump reads as plainly non-breaking. ----

export function parseNpmRegistryText(text, pkgName) {
  const json = JSON.parse(text);
  const time = json.time || {};
  const versions = Object.keys(time)
    .filter((v) => v !== "created" && v !== "modified")
    .sort((a, b) => new Date(time[a]) - new Date(time[b]));
  const entries = [];
  for (let i = 1; i < versions.length; i++) {
    const prev = versions[i - 1];
    const cur = versions[i];
    const prevMajor = parseInt(prev.split(".")[0], 10);
    const curMajor = parseInt(cur.split(".")[0], 10);
    const publishedAt = time[cur];
    const body =
      curMajor > prevMajor
        ? `${pkgName} published ${cur} on ${publishedAt}, a major version bump from ${prev} to ${cur}.`
        : `${pkgName} published ${cur} on ${publishedAt} (previous ${prev}).`;
    entries.push({
      id: cur,
      title: `${pkgName}@${cur}`,
      url: `https://www.npmjs.com/package/${pkgName}/v/${cur}`,
      body,
      publishedAt,
    });
  }
  entries.reverse(); // most recent first
  return entries;
}

// One exported config table: name, kind (html | rss | json), the exact working
// URL, and the parser for that kind. Every URL here was fetched successfully
// (200, parseable) in the session that added it; see the PR body for the
// first-200-chars proof per source.
export const SOURCES = [
  { name: "Vercel Changelog", kind: "rss", url: "https://vercel.com/atom", parse: parseFeedText },
  { name: "Resend Changelog", kind: "rss", url: "https://resend.com/changelog/rss.xml", parse: parseFeedText },
  {
    name: "OpenAI Node SDK Releases",
    kind: "json",
    url: "https://api.github.com/repos/openai/openai-node/releases",
    parse: parseGithubReleasesText,
  },
  {
    name: "Stripe Node SDK Releases",
    kind: "json",
    url: "https://api.github.com/repos/stripe/stripe-node/releases",
    parse: parseGithubReleasesText,
  },
  {
    name: "npm: resend",
    kind: "json",
    url: "https://registry.npmjs.org/resend",
    parse: (text) => parseNpmRegistryText(text, "resend"),
  },
];

// One request per source per run, polite headers, bounded timeout. Returns
// null (never throws) on any network/HTTP/parse failure, so one bad source
// can't take down the run.
export async function fetchSourceEntries(source, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(source.url, {
      headers: { "User-Agent": USER_AGENT, Accept: source.kind === "json" ? "application/json" : "*/*" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    const entries = source.parse(text);
    return entries
      .slice()
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .slice(0, MAX_ENTRIES_PER_SOURCE);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- state + output ----

function loadState(stateFile) {
  if (!existsSync(stateFile)) return { seen: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    return { seen: parsed.seen || {} };
  } catch {
    return { seen: {} };
  }
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function renderMarkdown(dateStr, records, unreachable) {
  const rows = records
    .map((r) => `| ${r.source} | ${r.title.replace(/\|/g, "\\|")} | ${r.verdict} | ${r.reason} | [link](${r.url}) |`)
    .join("\n");
  const breaking = records.filter((r) => r.verdict === "breaking").length;
  const unreachableLine = unreachable.length
    ? `\nUnreachable sources: ${unreachable.join(", ")}.\n`
    : "";
  return (
    `# Changelog watch — ${dateStr}\n\n` +
    `| source | title | verdict | reason | link |\n` +
    `| --- | --- | --- | --- | --- |\n` +
    `${rows || "| (none) | | | | |"}\n\n` +
    `${records.length} new entries, ${breaking} breaking.\n` +
    unreachableLine
  );
}

// Main entry point. Accepts overrides so it's fully testable offline: pass a
// fake `sources` list and/or `fetchImpl`, and a `now` Date for deterministic
// file names.
export async function runWatch({
  repoRoot,
  sources = SOURCES,
  fetchImpl = fetch,
  now = new Date(),
  log = console.log,
} = {}) {
  const dataDir = join(repoRoot, "data");
  const docsDir = join(repoRoot, "docs");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });

  const stateFile = join(dataDir, "watch-state.json");
  const state = loadState(stateFile);
  const dateStr = formatDate(now);
  const fetchedAt = now.toISOString();

  const records = [];
  const unreachable = [];
  let breakingCount = 0;

  for (const source of sources) {
    const entries = await fetchSourceEntries(source, fetchImpl);
    if (entries === null) {
      log(`source unreachable: ${source.name} ${source.url}`);
      unreachable.push(source.name);
      continue;
    }
    for (const entry of entries) {
      const key = `${source.name}:${entry.id}`;
      if (state.seen[key]) continue; // already reported in a prior run

      const { verdict, reason, quote } = classify(entry.title, entry.body);
      const url = entry.url || source.url;
      const record = {
        source: source.name,
        id: entry.id,
        title: entry.title,
        url,
        verdict,
        reason,
        receipt: { url, quote, fetched_at: fetchedAt },
      };
      records.push(record);
      state.seen[key] = true;
      if (verdict === "breaking") breakingCount++;
      log(`[${verdict.toUpperCase()}] ${source.name}: ${entry.title}`);
    }
  }

  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  writeFileSync(
    join(dataDir, `receipts-${dateStr}.json`),
    JSON.stringify({ date: dateStr, generated_at: fetchedAt, sources_unreachable: unreachable, entries: records }, null, 2) + "\n"
  );
  writeFileSync(join(docsDir, `watcher-${dateStr}.md`), renderMarkdown(dateStr, records, unreachable));

  log(`${records.length} new, ${breakingCount} breaking`);
  return { newCount: records.length, breakingCount, unreachableCount: unreachable.length, records, exitCode: breakingCount > 0 ? 1 : 0 };
}

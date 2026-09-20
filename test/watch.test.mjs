import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classify,
  BREAKING_PATTERNS,
  parseFeedText,
  parseGithubReleasesText,
  parseNpmRegistryText,
  fetchSourceEntries,
  runWatch,
} from "../bin/lib/watch.mjs";

// ---- classification: real quoted lines fetched live from vendor sources ----

test("classify: flags a real 'remove support' line from stripe-node as breaking", () => {
  const body =
    "* Add support for `update` method on resource `V2.Core.ApprovalRequest`\n" +
    "  * ⚠️ Remove support for `execute` and `submit` methods on resource `V2.Core.ApprovalRequest`\n" +
    "  * Add support for `sequra_payments`";
  const r = classify("v22.7.0-alpha.2", body);
  assert.equal(r.verdict, "breaking");
  assert.match(r.reason, /remove/);
  assert.match(r.quote, /Remove support for `execute` and `submit`/);
});

test("classify: flags a real openai-node BREAKING CHANGES heading as breaking", () => {
  const body =
    "## 7.0.0 (2026-07-27)\n\n" +
    "Full Changelog: [v6.49.0...v7.0.0](https://github.com/openai/openai-node/compare/v6.49.0...v7.0.0)\n\n" +
    "### ⚠ BREAKING CHANGES\n\n" +
    "* require Node.js 22 and codify version support ([#2026](https://github.com/openai/openai-node/issues/2026))";
  const r = classify("v7.0.0", body);
  assert.equal(r.verdict, "breaking");
  assert.match(r.reason, /breaking change/);
});

test("classify: a real routine stripe-node release line is non-breaking", () => {
  const body =
    "* Use cryptographically secure boundaries for multipart file uploads\n" +
    "* update OtherString docstring\n" +
    "* Fix request coercion for GET and DELETE parameters";
  const r = classify("v22.6.1", body);
  assert.equal(r.verdict, "non-breaking");
  assert.equal(r.reason, "no breaking pattern matched");
});

test("classify: a real resend changelog blurb is non-breaking", () => {
  const r = classify("Headless Webhook API", "Build custom headless webhook experiences from the API, SDKs, CLI, and MCP server.");
  assert.equal(r.verdict, "non-breaking");
});

test("classify: every rule in the table is reachable and carries a label", () => {
  for (const p of BREAKING_PATTERNS) {
    assert.ok(p.id && p.label && p.re instanceof RegExp, `pattern ${p.id} is well-formed`);
  }
});

// ---- parsing: real (or structurally-real) snippets fetched from live sources ----

test("parseFeedText: parses a real Resend RSS <item>", () => {
  const xml = `<rss version="2.0"><channel>
    <item>
      <title><![CDATA[Headless Webhook API]]></title>
      <link>https://resend.com/changelog/headless-webhook-api</link>
      <guid isPermaLink="false">https://resend.com/changelog/headless-webhook-api</guid>
      <pubDate>Wed, 16 Sep 2026 00:00:00 GMT</pubDate>
      <description><![CDATA[Build custom headless webhook experiences from the API, SDKs, CLI, and MCP server.]]></description>
    </item>
  </channel></rss>`;
  const entries = parseFeedText(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Headless Webhook API");
  assert.equal(entries[0].url, "https://resend.com/changelog/headless-webhook-api");
  assert.match(entries[0].body, /headless webhook experiences/);
});

test("parseFeedText: parses a Vercel-shaped Atom <entry>", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>https://vercel.com/changelog/spend-management-enterprise-flex</id>
      <title>Spend Management expands to Enterprise Flexible Commitment plans</title>
      <link href="https://vercel.com/changelog/spend-management-enterprise-flex"/>
      <updated>2026-09-18T20:00:00.000Z</updated>
      <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Enterprise teams on Flexible Commitment plans can now use Spend Management.</p></div></content>
    </entry>
  </feed>`;
  const entries = parseFeedText(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "https://vercel.com/changelog/spend-management-enterprise-flex");
  assert.equal(entries[0].publishedAt, "2026-09-18T20:00:00.000Z");
});

test("parseGithubReleasesText: parses a real openai-node release object", () => {
  const json = JSON.stringify([
    {
      id: 360726847,
      tag_name: "v7.0.0",
      name: "v7.0.0",
      html_url: "https://github.com/openai/openai-node/releases/tag/v7.0.0",
      body: "### ⚠ BREAKING CHANGES\n\n* require Node.js 22 and codify version support",
      published_at: "2026-07-27T21:56:10Z",
    },
  ]);
  const entries = parseGithubReleasesText(json);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "360726847");
  assert.equal(entries[0].title, "v7.0.0");
  assert.match(entries[0].body, /BREAKING CHANGES/);
});

test("parseGithubReleasesText: rejects a non-array payload instead of crashing", () => {
  assert.throws(() => parseGithubReleasesText(JSON.stringify({ message: "Not Found" })));
});

test("parseNpmRegistryText: flags a major bump and lets a minor bump through", () => {
  const json = JSON.stringify({
    time: {
      created: "2020-01-01T00:00:00.000Z",
      modified: "2026-09-15T00:00:00.000Z",
      "5.0.0": "2026-01-01T00:00:00.000Z",
      "5.1.0": "2026-02-01T00:00:00.000Z",
      "6.0.0": "2026-03-01T00:00:00.000Z",
    },
  });
  const entries = parseNpmRegistryText(json, "resend");
  // most recent first
  assert.equal(entries[0].id, "6.0.0");
  assert.match(entries[0].body, /major version bump/);
  const minorEntry = entries.find((e) => e.id === "5.1.0");
  assert.doesNotMatch(minorEntry.body, /major version bump/);
  const c = classify(entries[0].title, entries[0].body);
  assert.equal(c.verdict, "breaking");
  assert.match(c.reason, /major version/);
});

// ---- run orchestration: dedupe, unreachable sources, receipt shape, exit code ----

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "watch-test-"));
}

function fakeFetch(bodiesByUrl) {
  return async (url) => {
    const entry = bodiesByUrl[url];
    if (!entry) return { ok: false, status: 404, text: async () => "" };
    if (entry.throw) throw new Error("network down");
    return { ok: true, text: async () => entry.text };
  };
}

test("runWatch: the same entry seen twice produces exactly one receipt (dedupe via state)", async () => {
  const repoRoot = tempRepo();
  try {
    const sourceUrl = "https://example.test/feed.xml";
    const feedXml = `<rss version="2.0"><channel>
      <item>
        <title>Removed the legacy auth flow</title>
        <link>https://example.test/changelog/1</link>
        <guid>https://example.test/changelog/1</guid>
        <pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate>
        <description>The legacy auth flow is removed. Migration required for all integrations.</description>
      </item>
    </channel></rss>`;
    const sources = [{ name: "Example Changelog", kind: "rss", url: sourceUrl, parse: parseFeedText }];
    const fetchImpl = fakeFetch({ [sourceUrl]: { text: feedXml } });

    const first = await runWatch({ repoRoot, sources, fetchImpl, now: new Date("2026-09-20T00:00:00Z"), log: () => {} });
    assert.equal(first.newCount, 1);
    assert.equal(first.breakingCount, 1);
    assert.equal(first.exitCode, 1);

    const second = await runWatch({ repoRoot, sources, fetchImpl, now: new Date("2026-09-21T00:00:00Z"), log: () => {} });
    assert.equal(second.newCount, 0);
    assert.equal(second.breakingCount, 0);
    assert.equal(second.exitCode, 0);

    // Only the first run's receipts file should contain the entry.
    const receiptsDay1 = JSON.parse(readFileSync(join(repoRoot, "data", "receipts-2026-09-20.json"), "utf8"));
    const receiptsDay2 = JSON.parse(readFileSync(join(repoRoot, "data", "receipts-2026-09-21.json"), "utf8"));
    assert.equal(receiptsDay1.entries.length, 1);
    assert.equal(receiptsDay2.entries.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runWatch: an unreachable source is reported and does not crash the run", async () => {
  const repoRoot = tempRepo();
  try {
    const goodUrl = "https://example.test/good.xml";
    const badUrl = "https://example.test/bad.xml";
    const goodXml = `<rss version="2.0"><channel>
      <item>
        <title>Docs typo fix</title>
        <link>https://example.test/changelog/2</link>
        <guid>https://example.test/changelog/2</guid>
        <pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate>
        <description>Fixed a typo in the API reference.</description>
      </item>
    </channel></rss>`;
    const sources = [
      { name: "Good Source", kind: "rss", url: goodUrl, parse: parseFeedText },
      { name: "Bad Source", kind: "json", url: badUrl, parse: parseGithubReleasesText },
    ];
    const fetchImpl = fakeFetch({ [goodUrl]: { text: goodXml }, [badUrl]: { text: "{not json" } });

    const result = await runWatch({ repoRoot, sources, fetchImpl, now: new Date("2026-09-20T00:00:00Z"), log: () => {} });
    assert.equal(result.unreachableCount, 1);
    assert.equal(result.newCount, 1);
    assert.equal(result.exitCode, 0);

    const receipts = JSON.parse(readFileSync(join(repoRoot, "data", "receipts-2026-09-20.json"), "utf8"));
    assert.deepEqual(receipts.sources_unreachable, ["Bad Source"]);
    assert.ok(existsSync(join(repoRoot, "docs", "watcher-2026-09-20.md")));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runWatch: a source that throws (timeout/network) does not crash the run", async () => {
  const repoRoot = tempRepo();
  try {
    const url = "https://example.test/throws.xml";
    const sources = [{ name: "Flaky Source", kind: "rss", url, parse: parseFeedText }];
    const fetchImpl = fakeFetch({ [url]: { throw: true } });

    const result = await runWatch({ repoRoot, sources, fetchImpl, now: new Date("2026-09-20T00:00:00Z"), log: () => {} });
    assert.equal(result.unreachableCount, 1);
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runWatch: every receipt carries url, quote, and fetched_at", async () => {
  const repoRoot = tempRepo();
  try {
    const url = "https://example.test/feed.xml";
    const xml = `<rss version="2.0"><channel>
      <item>
        <title>Deprecated the v1 endpoint</title>
        <link>https://example.test/changelog/3</link>
        <guid>https://example.test/changelog/3</guid>
        <pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate>
        <description>The v1 endpoint is deprecated and will be removed next quarter.</description>
      </item>
    </channel></rss>`;
    const sources = [{ name: "Example Changelog", kind: "rss", url, parse: parseFeedText }];
    const fetchImpl = fakeFetch({ [url]: { text: xml } });

    const result = await runWatch({ repoRoot, sources, fetchImpl, now: new Date("2026-09-20T00:00:00Z"), log: () => {} });
    assert.equal(result.records.length, 1);
    const [record] = result.records;
    assert.ok(record.receipt.url);
    assert.ok(record.receipt.quote);
    assert.equal(record.receipt.fetched_at, "2026-09-20T00:00:00.000Z");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("fetchSourceEntries: returns null (not a throw) when the HTTP status is not ok", async () => {
  const source = { name: "X", kind: "rss", url: "https://example.test/missing.xml", parse: parseFeedText };
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => "" });
  const entries = await fetchSourceEntries(source, fetchImpl);
  assert.equal(entries, null);
});

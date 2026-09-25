import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const examples = [
  {
    markdown: "[Query](https://example.invalid/search?first=1&second=2)",
    html: '<a href="https://example.invalid/search?first=1&amp;second=2">Query</a>',
  },
  {
    markdown: "[Underscores](https://example.invalid/a_b_c)",
    html: '<a href="https://example.invalid/a_b_c">Underscores</a>',
  },
  {
    markdown: "[Combined](https://example.invalid/a_b_c?first=d_e_f&second=2#part_one_two)",
    html: '<a href="https://example.invalid/a_b_c?first=d_e_f&amp;second=2#part_one_two">Combined</a>',
  },
  {
    markdown: `[Attributes](https://example.invalid/<br>?quote="a"&apostrophe='b')`,
    html: '<a href="https://example.invalid/&lt;br&gt;?quote=&quot;a&quot;&amp;apostrophe=&#39;b&#39;">Attributes</a>',
  },
  {
    markdown: "[**Bold** *italic* _also_ `code_snake` & <label>](https://example.invalid/a_b_c)",
    html: '<a href="https://example.invalid/a_b_c"><strong>Bold</strong> <em>italic</em> <em>also</em> <code>code_snake</code> &amp; &lt;label&gt;</a>',
  },
  {
    markdown:
      "`[Literal](https://example.invalid/a_b_c?first=1&second=2)` and [Actual](https://example.invalid/a_b_c)",
    html: '<code>[Literal](https://example.invalid/a_b_c?first=1&amp;second=2)</code> and <a href="https://example.invalid/a_b_c">Actual</a>',
  },
  {
    markdown:
      "**Before [bold](https://example.invalid/a_b_c) after** and *Before [italic](https://example.invalid/a_b_c) after*",
    html: '<strong>Before <a href="https://example.invalid/a_b_c">bold</a> after</strong> and <em>Before <a href="https://example.invalid/a_b_c">italic</a> after</em>',
  },
  {
    markdown: "@@ACPXLINK0@@ [Token](https://example.invalid/@@ACPXLINK0@@)",
    html: '@@ACPXLINK0@@ <a href="https://example.invalid/@@ACPXLINK0@@">Token</a>',
  },
  {
    markdown: "[Relative](plain.md#target)",
    html: '<a href="plain.html#target">Relative</a>',
  },
  {
    markdown: "[Parent](../link-fixture-parent.md#target)",
    html: '<a href="../link-fixture-parent.html#target">Parent</a>',
  },
  {
    markdown: "[Relative permalink](destination.md#target)",
    html: '<a href="../link-test-target/#target">Relative permalink</a>',
  },
  {
    markdown: "[Absolute permalink](/link-test-target/#target)",
    html: '<a href="../link-test-target/#target">Absolute permalink</a>',
  },
  {
    markdown: "[Local fragment](#local-target)",
    html: '<a href="#local-target">Local fragment</a>',
  },
];

test("docs site preserves link destinations, inline formatting, and page rewrites", (t) => {
  const repositoryRoot = process.cwd();
  const directory = mkdtempSync(path.join(os.tmpdir(), "acpx-docs-links-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const docsDirectory = path.join(directory, "docs");
  cpSync(path.join(repositoryRoot, "docs"), docsDirectory, { recursive: true });
  writeFileSync(path.join(docsDirectory, "CNAME"), "docs.example.invalid\n");
  writeFileSync(
    path.join(docsDirectory, "link-fixture-parent.md"),
    "# Parent target\n\n## Target\n",
  );
  const fixtureDirectory = path.join(docsDirectory, "link-fixtures");
  mkdirSync(fixtureDirectory);
  writeFileSync(
    path.join(fixtureDirectory, "source.md"),
    ["# Link fixtures", "## Local target", ...examples.map(({ markdown }) => markdown)].join(
      "\n\n",
    ) + "\n",
  );
  writeFileSync(path.join(fixtureDirectory, "plain.md"), "# Plain target\n\n## Target\n");
  writeFileSync(
    path.join(fixtureDirectory, "destination.md"),
    "---\npermalink: /link-test-target/\n---\n# Permalink target\n\n## Target\n",
  );

  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "build-docs-site.mjs")],
    { cwd: directory, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.error, undefined, "documentation builder must finish before the timeout");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const output = readFileSync(
    path.join(directory, "dist", "docs-site", "link-fixtures", "source.html"),
    "utf8",
  );
  const article = output.match(/<article class="doc">([\s\S]*?)<\/article>/);
  assert.ok(article, "built fixture must contain the documentation article");
  const paragraphs = [...article[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((match) => match[1]);
  assert.deepEqual(
    paragraphs,
    examples.map(({ html }) => html),
  );
});

const canonicalPages = [
  ["index.md", "index.html", "Home", "", "./"],
  ["install.md", "install.html", "Install", "install.html", "install.html"],
  ["quickstart.md", "quickstart.html", "Quickstart", "quickstart.html", "quickstart.html"],
  [
    "guide/deep/page.md",
    "guide/deep/page.html",
    "Nested page",
    "guide/deep/page.html",
    "page.html",
  ],
  ["guide/deep/README.md", "guide/deep/index.html", "Nested index", "guide/deep/", "./"],
  ["relocated.md", "reference/deep/topic/index.html", "Permalink", "reference/deep/topic/", "./"],
] as const;

const canonicalSites = [
  { name: "without a CNAME", origin: "" },
  {
    name: "with a root CNAME",
    rootCname: "root.example.invalid",
    origin: "https://root.example.invalid/",
  },
  {
    name: "with a docs CNAME overriding the root CNAME",
    rootCname: "root.example.invalid",
    docsCname: "docs.example.invalid",
    origin: "https://docs.example.invalid/",
  },
];

for (const site of canonicalSites) {
  test(`docs metadata resolves to its own page ${site.name}`, (t) => {
    const repositoryRoot = process.cwd();
    const directory = mkdtempSync(path.join(os.tmpdir(), "acpx-docs-canonical-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const docsDirectory = path.join(directory, "docs");
    mkdirSync(docsDirectory);

    for (const [source, , title] of canonicalPages) {
      const file = path.join(docsDirectory, source);
      mkdirSync(path.dirname(file), { recursive: true });
      const frontmatter =
        source === "relocated.md" ? "---\npermalink: /reference/deep/topic/\n---\n" : "";
      writeFileSync(file, `${frontmatter}# ${title}\n`);
    }
    if (site.rootCname) {
      writeFileSync(path.join(directory, "CNAME"), `${site.rootCname}\n`);
    }
    if (site.docsCname) {
      writeFileSync(path.join(docsDirectory, "CNAME"), `${site.docsCname}\n`);
    }

    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "build-docs-site.mjs")],
      { cwd: directory, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.error, undefined, "documentation builder must finish before the timeout");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const outputDirectory = path.join(directory, "dist", "docs-site");
    const llmsLines = readFileSync(path.join(outputDirectory, "llms.txt"), "utf8").split("\n");
    const mounts = [
      "https://preview.example.invalid/",
      "https://preview.example.invalid/acpx/",
      "https://preview.example.invalid/projects/acpx/docs/",
    ];

    for (const [, output, title, canonicalPath, samePage] of canonicalPages) {
      const html = readFileSync(path.join(outputDirectory, output), "utf8");
      const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
      const openGraph = html.match(/<meta property="og:url" content="([^"]+)">/)?.[1];
      assert.equal(canonical, site.origin ? `${site.origin}${canonicalPath}` : samePage);
      assert.equal(openGraph, canonical, `${output}: canonical and Open Graph URLs must agree`);
      assert.ok(canonical, `${output}: canonical metadata must be present`);

      const llmsHref = site.origin
        ? `${site.origin}${canonicalPath}`
        : canonicalPath || "index.html";
      assert.ok(llmsLines.includes(`- ${title}: ${llmsHref}`), `${output}: llms page link`);

      for (const mount of mounts) {
        const documentUrl = new URL(output, mount);
        const expectedCanonical = new URL(canonicalPath, site.origin || mount).href;
        assert.equal(new URL(canonical, documentUrl).href, expectedCanonical);
        const expectedLlms = site.origin
          ? expectedCanonical
          : new URL(canonicalPath || "index.html", mount).href;
        assert.equal(new URL(llmsHref, new URL("llms.txt", mount)).href, expectedLlms);
      }
    }

    const copiedCname = path.join(outputDirectory, "CNAME");
    if (site.docsCname || site.rootCname) {
      assert.equal(readFileSync(copiedCname, "utf8"), site.docsCname || site.rootCname);
    } else {
      assert.equal(existsSync(copiedCname), false);
    }
  });
}

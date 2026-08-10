import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const siteUrl = (process.env.SITE_URL || "https://sporadik.space").replace(/\/+$/, "");
const journalDir = path.resolve("src/content/journal");
const apiKey = process.env.BUTTONDOWN_API_KEY || "";
const changedOnly = process.argv.includes("--changed-only");
const dryRun = process.argv.includes("--dry-run");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function walk(dir) {
  const items = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      items.push(...walk(fullPath));
      continue;
    }

    if (/\.(md|mdx)$/i.test(entry.name)) {
      items.push(fullPath);
    }
  }

  return items;
}

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { data: {}, body: source.trim() };
  }

  const data = {};
  const lines = match[1].split(/\r?\n/);
  let currentKey = null;

  for (const rawLine of lines) {
    const listMatch = rawLine.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(unquote(listMatch[1].trim()));
      continue;
    }

    const kvMatch = rawLine.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kvMatch) continue;

    currentKey = kvMatch[1];
    const rawValue = kvMatch[2].trim();

    if (rawValue === "") {
      data[currentKey] = [];
      continue;
    }

    if (rawValue === "true" || rawValue === "false") {
      data[currentKey] = rawValue === "true";
      continue;
    }

    data[currentKey] = unquote(rawValue);
  }

  return {
    data,
    body: source.slice(match[0].length).trim()
  };
}

function unquote(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

function titleFromSlug(fileStem) {
  return fileStem
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function entryDateFromName(fileName, explicitDate) {
  if (explicitDate) {
    return new Date(`${explicitDate}T00:00:00.000Z`);
  }

  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})-/);
  if (!match) {
    throw new Error(`Missing date prefix in ${fileName}`);
  }

  return new Date(`${match[1]}T00:00:00.000Z`);
}

function absolutizeMarkdownUrls(markdown) {
  return markdown
    .replace(/!\[([^\]]*)\]\((\/[^)]+)\)/g, (_, alt, url) => `![${alt}](${siteUrl}${url})`)
    .replace(/\[([^\]]+)\]\((\/[^)]+)\)/g, (_, text, url) => `[${text}](${siteUrl}${url})`);
}

function summarize(body, fallback) {
  const compact = body
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) return fallback;
  return compact.slice(0, 220).trim();
}

function loadEntries() {
  return walk(journalDir)
    .map((fullPath) => {
      const source = readFileSync(fullPath, "utf8");
      const { data, body } = parseFrontmatter(source);
      const fileName = path.basename(fullPath);
      const fileStem = fileName.replace(/\.(md|mdx)$/i, "");
      const title = (data.title || "").trim() || titleFromSlug(fileStem);
      const entryDate = entryDateFromName(fileStem, data.date);
      const slug = fileStem;
      const description = (data.description || "").trim();
      const draft = Boolean(data.draft);
      const coverImage = typeof data.coverImage === "string" ? data.coverImage.trim() : "";

      return {
        fullPath,
        fileName,
        slug,
        title,
        date: entryDate,
        description,
        draft,
        body,
        coverImage
      };
    })
    .filter((entry) => !entry.draft)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

function changedJournalFiles() {
  const before = process.env.GITHUB_EVENT_BEFORE;
  const after = process.env.GITHUB_SHA;

  if (!before || !after || /^0+$/.test(before)) {
    return [];
  }

  const diffOutput = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=AMR", before, after, "--", "src/content/journal"],
    { encoding: "utf8" }
  );

  return diffOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((relativePath) => path.resolve(relativePath));
}

function selectEntry(entries) {
  if (!changedOnly) {
    return entries[0];
  }

  const changedSet = new Set(changedJournalFiles());
  const changedEntries = entries.filter((entry) => changedSet.has(entry.fullPath));

  return changedEntries[0];
}

async function buttondownRequest(endpoint, init = {}) {
  const response = await fetch(`https://api.buttondown.email/v1${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Buttondown API ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function findExistingEmail(slug) {
  const result = await buttondownRequest(`/emails?slug=${encodeURIComponent(slug)}`, {
    method: "GET",
    headers: {}
  });

  const candidates = Array.isArray(result?.results) ? result.results : Array.isArray(result) ? result : [];
  return candidates.find((item) => item.slug === slug) || null;
}

function buildEmailBody(entry) {
  const lines = [];

  if (entry.coverImage) {
    const coverUrl = entry.coverImage.startsWith("http")
      ? entry.coverImage
      : `${siteUrl}${entry.coverImage.startsWith("/") ? entry.coverImage : `/${entry.coverImage}`}`;
    lines.push(`![](${coverUrl})`, "");
  }

  lines.push(absolutizeMarkdownUrls(entry.body), "", `Okumak için: ${siteUrl}/journal/${entry.slug}/`);
  return lines.join("\n").trim();
}

async function main() {
  const entries = loadEntries();
  const selected = selectEntry(entries);

  if (!selected) {
    log("No publishable journal entry matched the current run.");
    return;
  }

  const payload = {
    subject: selected.title,
    slug: selected.slug,
    canonical_url: `${siteUrl}/journal/${selected.slug}/`,
    description: selected.description || summarize(selected.body, selected.title),
    body: buildEmailBody(selected),
    email_type: "public",
    metadata: {
      source_slug: selected.slug,
      source_path: path.relative(process.cwd(), selected.fullPath).replace(/\\/g, "/")
    }
  };

  if (dryRun) {
    log(JSON.stringify({ mode: "dry-run", payload }, null, 2));
    return;
  }

  if (!apiKey) {
    throw new Error("BUTTONDOWN_API_KEY is missing.");
  }

  const existing = await findExistingEmail(selected.slug);
  if (existing) {
    log(`Buttondown email already exists for ${selected.slug}; skipping.`);
    return;
  }

  const created = await buttondownRequest("/emails", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const emailId = created?.id;
  if (!emailId) {
    throw new Error("Buttondown email creation succeeded but no email id was returned.");
  }

  await buttondownRequest(`/emails/${emailId}/publish`, {
    method: "POST",
    body: JSON.stringify({})
  });

  log(`Published Buttondown email for ${selected.slug}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

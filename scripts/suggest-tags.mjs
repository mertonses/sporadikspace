import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import OpenAI from "openai";

const projectRoot = process.cwd();
const journalDir = path.join(projectRoot, "src", "content", "journal");
const defaultModel = process.env.TAG_SUGGESTION_MODEL || "gpt-5.6";

loadEnvFile(path.join(projectRoot, ".env"));

const args = process.argv.slice(2);
const shouldWrite = args.includes("--write");
const useLatest = args.includes("--latest");
const positional = args.filter((arg) => !arg.startsWith("--"));

const targetPath = await resolveTargetPath(positional[0], useLatest);
if (!targetPath) {
  console.error("Usage: npm run suggest-tags -- <entry-path> [--write]");
  console.error("   or: npm run suggest-tags -- --latest [--write]");
  process.exit(1);
}

const raw = await fs.readFile(targetPath, "utf8");
const parsed = parseDocument(raw, targetPath);
const suggestion = process.env.OPENAI_API_KEY
  ? await suggestTagsWithAI(parsed)
  : suggestTagsHeuristically(parsed);

const tags = normalizeTags(suggestion.tags);

console.log("");
console.log(`Entry: ${path.relative(projectRoot, targetPath)}`);
console.log(`Title: ${parsed.title}`);
console.log(`Date: ${parsed.date}`);
console.log(`Mode: ${suggestion.mode}`);
console.log(`Tags: ${tags.join(", ")}`);

if (suggestion.note) {
  console.log(`Note: ${suggestion.note}`);
}

if (shouldWrite) {
  const updated = updateFrontmatter(raw, parsed, tags);
  await fs.writeFile(targetPath, updated, "utf8");
  console.log("Status: tags written to frontmatter.");
}

async function resolveTargetPath(inputPath, latest) {
  if (inputPath) {
    return path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath);
  }

  if (!latest) {
    return null;
  }

  const candidates = (await fs.readdir(journalDir))
    .filter((file) => /\.(md|mdx)$/i.test(file))
    .sort()
    .reverse();

  if (candidates.length === 0) {
    throw new Error("No journal entries found in src/content/journal.");
  }

  return path.join(journalDir, candidates[0]);
}

function parseDocument(raw, filePath) {
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  const body = frontmatterMatch ? raw.slice(frontmatterMatch[0].length) : raw;
  const slug = path.basename(filePath).replace(/\.(md|mdx)$/i, "");
  const titleMatch = frontmatter.match(/^title:\s*["']?(.*?)["']?\s*$/m);
  const dateMatch = frontmatter.match(/^date:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m);
  const tagMatch = frontmatter.match(/^tags:\s*\r?\n((?:\s*-\s.*\r?\n?)*)/m);

  return {
    filePath,
    slug,
    frontmatter,
    body,
    title: titleMatch?.[1]?.trim() || titleFromSlug(slug),
    date: dateMatch?.[1] || dateFromSlug(slug),
    existingTags: tagMatch
      ? tagMatch[1]
          .split(/\r?\n/)
          .map((line) => line.replace(/^\s*-\s*/, "").trim())
          .filter(Boolean)
      : []
  };
}

async function suggestTagsWithAI(parsed) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const excerpt = stripMarkdown(parsed.body).slice(0, 6000);
  const existing = parsed.existingTags.length > 0 ? parsed.existingTags.join(", ") : "none";

  const response = await client.responses.create({
    model: process.env.TAG_SUGGESTION_MODEL || defaultModel,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You suggest concise reusable tags for a personal journal. Return only JSON in the shape {\"tags\":[...]}. Suggest 3 to 6 lowercase tags. Prefer short conceptual tags, avoid dates, avoid generic filler like writing or journal unless truly needed, and do not repeat near-duplicates."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Title: ${parsed.title}\nDate: ${parsed.date}\nExisting tags: ${existing}\n\nEntry:\n${excerpt}`
          }
        ]
      }
    ]
  });

  const payload = safeJsonParse(response.output_text);
  if (!payload || !Array.isArray(payload.tags)) {
    return {
      mode: "heuristic-fallback",
      note: "AI response was not valid JSON, so a local fallback was used.",
      tags: suggestTagsHeuristically(parsed).tags
    };
  }

  return {
    mode: "ai",
    tags: payload.tags
  };
}

function suggestTagsHeuristically(parsed) {
  if (parsed.existingTags.length > 0) {
    return {
      mode: "heuristic",
      note: "OPENAI_API_KEY was not found, so existing tags were kept as the fallback.",
      tags: parsed.existingTags
    };
  }

  const source = `${parsed.title} ${stripMarkdown(parsed.body)}`.toLowerCase();
  const words = source.match(/[a-zA-Z][a-zA-Z-]{2,}/g) ?? [];
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "about",
    "archive",
    "after",
    "again",
    "are",
    "around",
    "been",
    "being",
    "between",
    "could",
    "entry",
    "every",
    "first",
    "for",
    "from",
    "have",
    "into",
    "its",
    "journal",
    "just",
    "more",
    "much",
    "not",
    "now",
    "off",
    "often",
    "one",
    "onto",
    "our",
    "out",
    "point",
    "same",
    "still",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "thought",
    "into",
    "journal",
    "maybe",
    "notes",
    "only",
    "over",
    "really",
    "should",
    "since",
    "that",
    "their",
    "there",
    "these",
    "think",
    "this",
    "those",
    "through",
    "thoughts",
    "three",
    "two",
    "under",
    "until",
    "use",
    "very",
    "what",
    "when",
    "where",
    "which",
    "while",
    "with",
    "writing",
    "would"
  ]);

  const counts = new Map();
  for (const word of words) {
    if (stopwords.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([word]) => word);

  const combined = normalizeTags([...parsed.existingTags, ...ranked]).slice(0, 6);
  return {
    mode: "heuristic",
    note: "OPENAI_API_KEY was not found, so local keyword extraction was used.",
    tags: combined.length >= 2 ? combined : ["notes"]
  };
}

function normalizeTags(tags) {
  return [...new Set(
    tags
      .map((tag) => `${tag}`.trim().toLowerCase())
      .filter(Boolean)
      .map((tag) => tag.replace(/\s+/g, " "))
  )].slice(0, 6);
}

function updateFrontmatter(raw, parsed, tags) {
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const body = frontmatterMatch ? raw.slice(frontmatterMatch[0].length) : raw;
  const existing = frontmatterMatch?.[1] ?? "";
  const lines = existing
    ? existing.split(/\r?\n/).filter((line) => !/^tags:\s*$/.test(line) && !/^\s*-\s+/.test(line))
    : [
        `title: "${parsed.title.replace(/"/g, '\\"')}"`,
        `date: "${parsed.date}"`,
        `description: ""`,
        `draft: false`
      ];

  const cleanLines = [];
  let skippingTagBlock = false;
  for (const line of lines) {
    if (/^tags:\s*$/.test(line)) {
      skippingTagBlock = true;
      continue;
    }
    if (skippingTagBlock && /^\s*-\s+/.test(line)) {
      continue;
    }
    skippingTagBlock = false;
    cleanLines.push(line);
  }

  const nextFrontmatter = [
    ...cleanLines.filter(Boolean),
    "tags:",
    ...tags.map((tag) => `  - ${tag}`)
  ].join("\n");

  return `---\n${nextFrontmatter}\n---\n\n${body.replace(/^\s*/, "")}`;
}

function titleFromSlug(slug) {
  return slug
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function dateFromSlug(slug) {
  const match = slug.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date().toISOString().slice(0, 10);
}

function stripMarkdown(value) {
  return value
    .replace(/`{3}[\s\S]*?`{3}/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function loadEnvFile(filePath) {
  try {
    const source = requireEnvFile(filePath);
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/i);
      if (!match) continue;
      const key = match[1];
      const value = match[2].replace(/^["']|["']$/g, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    return;
  }
}

function requireEnvFile(filePath) {
  return fsSync.readFileSync(filePath, "utf8");
}

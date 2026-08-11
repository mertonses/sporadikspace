/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  ADMIN_SESSION_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH?: string;
}

type GitHubRefResponse = {
  object: {
    sha: string;
  };
};

type GitHubCommitResponse = {
  tree: {
    sha: string;
  };
};

type GitHubTreeResponse = {
  tree: Array<{
    path: string;
    type: "blob" | "tree";
  }>;
};

type GitHubContentFile = {
  name: string;
  path: string;
  sha: string;
  type: "file";
  download_url: string | null;
};

type EntryStatus = "draft" | "scheduled" | "published";

type EntryRecord = {
  path: string;
  filename: string;
  title: string;
  date: string;
  description: string;
  tags: string[];
  draft: boolean;
  status: EntryStatus;
  effectiveStatus: EntryStatus;
  publishAt: string;
  publishAtInput: string;
  body: string;
  coverImage: string;
  coverAlt: string;
  coverCaption: string;
  coverFocusX: number;
  coverFocusY: number;
  slug: string;
  entryUrl: string;
  wordCount: number;
  readingMinutes: number;
  revisionCount: number;
};

type RevisionRecord = {
  path: string;
  savedAt: string;
  savedAtLabel: string;
  reason: "update" | "delete" | "restore";
  entryPath: string;
  filename: string;
  title: string;
  date: string;
  status: EntryStatus;
  effectiveStatus: EntryStatus;
  wordCount: number;
  coverImage: string;
  excerpt: string;
  source: string;
};

const SESSION_COOKIE = "sporadik_admin";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const JOURNAL_DIRECTORY = "src/content/journal";
const REVISIONS_DIRECTORY = "src/data/revisions";
const ISTANBUL_OFFSET = "+03:00";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self' https://buttondown.com https://*.beehiiv.com https://*.convertkit.com;",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()"
};

const encoder = new TextEncoder();
const loginAttempts = new Map<string, { failures: number; windowStartedAt: number; blockedUntil: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/api/admin/session" && request.method === "GET") {
        return jsonResponse({ authenticated: await isAuthenticated(request, env) });
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        return handleLogin(request, env);
      }

      if (url.pathname === "/api/admin/logout" && request.method === "POST") {
        return handleLogout();
      }

      if (url.pathname === "/api/admin/entries" && request.method === "GET") {
        return handleEntries(request, env);
      }

      if (url.pathname === "/api/admin/entry" && request.method === "GET") {
        return handleEntry(request, env);
      }

      if (url.pathname === "/api/admin/entry" && request.method === "DELETE") {
        return handleDeleteEntry(request, env);
      }

      if (url.pathname === "/api/admin/revisions" && request.method === "GET") {
        return handleRevisions(request, env);
      }

      if (url.pathname === "/api/admin/revision/restore" && request.method === "POST") {
        return handleRestoreRevision(request, env);
      }

      if (url.pathname === "/api/admin/analytics" && request.method === "GET") {
        return handleAnalytics(request, env);
      }

      if (url.pathname === "/api/admin/tag-intelligence" && request.method === "POST") {
        return handleTagIntelligence(request, env);
      }

      if (url.pathname === "/api/admin/publish" && request.method === "POST") {
        return handlePublish(request, env);
      }

      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, { status: error.status });
      }

      console.error("sporadik worker request failed", {
        method: request.method,
        url: request.url,
        error: error instanceof Error ? error.stack || error.message : String(error)
      });

      return jsonResponse({ error: "Unexpected server error." }, { status: 500 });
    }
  }
};

async function handleLogin(request: Request, env: Env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return jsonResponse({ error: "Admin secrets are missing on the server." }, { status: 500 });
  }

  let payload: { password?: string };
  const clientKey = getClientKey(request);
  const retryAfter = loginRetryAfter(clientKey);
  if (retryAfter > 0) {
    return jsonResponse(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: { "retry-after": String(retryAfter) } }
    );
  }

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid login payload." }, { status: 400 });
  }

  if (!safeEquals(payload.password ?? "", env.ADMIN_PASSWORD)) {
    recordLoginFailure(clientKey);
    return jsonResponse({ error: "Password is incorrect." }, { status: 401 });
  }

  loginAttempts.delete(clientKey);

  const expiresAt = Date.now() + SESSION_MAX_AGE * 1000;
  const token = await createSessionToken(expiresAt, env.ADMIN_SESSION_SECRET);

  return jsonResponse(
    { authenticated: true },
    {
      headers: {
        "set-cookie": `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`
      }
    }
  );
}

async function handleLogout() {
  return jsonResponse(
    { authenticated: false },
    {
      headers: {
        "set-cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
      }
    }
  );
}

async function handleEntries(request: Request, env: Env) {
  await requireAuth(request, env);
  const entries = await listEntries(env);
  return jsonResponse({ entries });
}

async function handleEntry(request: Request, env: Env) {
  await requireAuth(request, env);
  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";

  if (!path.startsWith(`${JOURNAL_DIRECTORY}/`)) {
    throw new HttpError(400, "Invalid entry path.");
  }

  const revisionCounts = await getRevisionCounts(env);
  const text = await fetchRepoText(env, path);
  const entry = parseEntry(path, text, revisionCounts.get(revisionStemFromPath(path)) ?? 0);
  return jsonResponse({ entry });
}

async function handleDeleteEntry(request: Request, env: Env) {
  await requireAuth(request, env);

  let payload: { path?: string };

  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Invalid delete payload.");
  }

  const path = payload.path ?? "";
  if (!path.startsWith(`${JOURNAL_DIRECTORY}/`)) {
    throw new HttpError(400, "Invalid entry path.");
  }

  const branch = env.GITHUB_BRANCH || "main";
  const source = await fetchRepoText(env, path);
  const entry = parseEntry(path, source);
  const revisionFile = buildRevisionFile(path, source, "delete");

  const deletePaths = [path];
  if (entry.coverImage) {
    deletePaths.push(publicPathFromCover(entry.coverImage));
  }

  const commitSha = await createCommit(env, {
    branch,
    message: `Delete ${entry.filename}`,
    files: [revisionFile],
    deletePaths
  });

  return jsonResponse({ ok: true, deleted: entry.filename, commitSha });
}

async function handleRevisions(request: Request, env: Env) {
  await requireAuth(request, env);
  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";

  if (!path.startsWith(`${JOURNAL_DIRECTORY}/`)) {
    throw new HttpError(400, "Invalid entry path.");
  }

  const revisions = await listRevisionsForEntry(env, path);
  return jsonResponse({ revisions });
}

async function handleRestoreRevision(request: Request, env: Env) {
  await requireAuth(request, env);

  let payload: { revisionPath?: string };
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Invalid restore payload.");
  }

  const revisionPath = payload.revisionPath ?? "";
  if (!revisionPath.startsWith(`${REVISIONS_DIRECTORY}/`) || !revisionPath.endsWith(".json")) {
    throw new HttpError(400, "Invalid revision path.");
  }

  const revisionSource = await fetchRepoText(env, revisionPath);
  const revision = parseRevisionRecord(revisionPath, revisionSource);
  const branch = env.GITHUB_BRANCH || "main";
  const files: Array<{ path: string; buffer: ArrayBuffer }> = [
    {
      path: revision.entryPath,
      buffer: encoder.encode(revision.source).buffer
    }
  ];

  try {
    const currentText = await fetchRepoText(env, revision.entryPath);
    files.push(buildRevisionFile(revision.entryPath, currentText, "restore"));
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) {
      throw error;
    }
  }

  const commitSha = await createCommit(env, {
    branch,
    message: `Restore ${revision.filename} from revision`,
    files
  });

  return jsonResponse({
    ok: true,
    commitSha,
    entryPath: revision.entryPath,
    entryUrl: `/journal/${revision.filename.replace(/\.(md|mdx)$/i, "")}/`
  });
}

async function handleAnalytics(request: Request, env: Env) {
  await requireAuth(request, env);
  const entries = await listEntries(env);
  const revisions = await listAllRevisions(env);

  const counts = {
    total: entries.length,
    published: entries.filter((entry) => entry.effectiveStatus === "published").length,
    scheduled: entries.filter((entry) => entry.effectiveStatus === "scheduled").length,
    drafts: entries.filter((entry) => entry.effectiveStatus === "draft").length,
    revisions: revisions.length
  };

  const totalWords = entries.reduce((sum, entry) => sum + entry.wordCount, 0);
  const totalReadingMinutes = entries.reduce((sum, entry) => sum + entry.readingMinutes, 0);
  const tagCounts = new Map<string, number>();
  const statusTimeline = new Map<string, number>();

  for (const entry of entries) {
    const monthKey = entry.date.slice(0, 7);
    statusTimeline.set(monthKey, (statusTimeline.get(monthKey) ?? 0) + 1);
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "tr"))
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));

  const longestEntries = [...entries]
    .sort((a, b) => b.wordCount - a.wordCount || b.date.localeCompare(a.date))
    .slice(0, 5)
    .map((entry) => ({
      title: entry.title,
      date: entry.date,
      wordCount: entry.wordCount,
      readingMinutes: entry.readingMinutes,
      status: entry.effectiveStatus,
      path: entry.path
    }));

  const recentTimeline = [...statusTimeline.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6)
    .map(([month, count]) => ({ month, count }))
    .reverse();

  const imageCoverage = entries.length === 0
    ? 0
    : Math.round((entries.filter((entry) => Boolean(entry.coverImage)).length / entries.length) * 100);

  return jsonResponse({
    counts,
    totals: {
      words: totalWords,
      averageWords: entries.length === 0 ? 0 : Math.round(totalWords / entries.length),
      averageReadingMinutes: entries.length === 0 ? 0 : Number((totalReadingMinutes / entries.length).toFixed(1)),
      imageCoverage
    },
    topTags,
    longestEntries,
    recentTimeline
  });
}

async function handleTagIntelligence(request: Request, env: Env) {
  await requireAuth(request, env);

  let payload: {
    title?: string;
    description?: string;
    tags?: string[] | string;
    body?: string;
  };

  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Invalid tag intelligence payload.");
  }

  const title = `${payload.title ?? ""}`.trim();
  const description = `${payload.description ?? ""}`.trim();
  const body = `${payload.body ?? ""}`.trim();
  const tags = Array.isArray(payload.tags)
    ? payload.tags.map((tag) => `${tag}`.trim()).filter(Boolean)
    : `${payload.tags ?? ""}`
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);

  if (!title && !description && !body) {
    return jsonResponse({
      suggestedTags: [],
      recurringTerms: [],
      weakTags: [],
      duplicateTags: [],
      knownTags: []
    });
  }

  const entries = await listEntries(env);
  const siteTagCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      siteTagCounts.set(tag, (siteTagCounts.get(tag) ?? 0) + 1);
    }
  }

  const tokens = extractConceptTokens([title, title, description, description, body].join(" "));
  const phrases = extractConceptPhrases(tokens);
  const weakTags = tags.filter((tag) => isWeakTag(tag));
  const duplicateTags = findDuplicateTags(tags);
  const recurringTerms = phrases.slice(0, 6);

  const suggestedFromText = [...new Set([
    ...phrases.slice(0, 4),
    ...tokens.filter((token) => token.length >= 4).slice(0, 6)
  ])]
    .filter((tag) => !tags.some((existing) => normalizeTag(existing) === normalizeTag(tag)));

  const knownTags = [...siteTagCounts.entries()]
    .filter(([tag]) => {
      const normalizedTag = normalizeTag(tag);
      return phrases.some((phrase) => normalizeTag(phrase) === normalizedTag)
        || tokens.some((token) => normalizeTag(token) === normalizedTag);
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "tr"))
    .slice(0, 6)
    .map(([tag, count]) => ({ tag, count }));

  return jsonResponse({
    suggestedTags: suggestedFromText.slice(0, 6),
    recurringTerms,
    weakTags,
    duplicateTags,
    knownTags
  });
}

async function handlePublish(request: Request, env: Env) {
  await requireAuth(request, env);

  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    throw new HttpError(500, "GitHub publishing secrets are missing on the server.");
  }

  const formData = await request.formData();
  const originalPath = getText(formData, "originalPath").trim();
  const existingCoverImage = getText(formData, "existingCoverImage").trim();
  const removeCoverImage = getText(formData, "removeCoverImage") === "true";
  const intent = normalizeIntent(getText(formData, "intent"));

  const title = getText(formData, "title").trim();
  const date = normalizeDate(getText(formData, "date"));
  const description = getText(formData, "description").trim();
  const tags = getText(formData, "tags")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const body = getText(formData, "body").trim();
  const coverAlt = getText(formData, "coverAlt").trim();
  const coverCaption = getText(formData, "coverCaption").trim();
  const coverFocusX = normalizePercentage(getText(formData, "coverFocusX"), 50);
  const coverFocusY = normalizePercentage(getText(formData, "coverFocusY"), 50);
  const requestedStatus = normalizeStatus(getText(formData, "status"));
  let publishAt = normalizePublishAt(getText(formData, "publishAt"));

  if (!title) throw new HttpError(400, "Title is required.");
  if (!date) throw new HttpError(400, "Date is required.");
  if (!body) throw new HttpError(400, "Body is required.");

  const resolvedStatus = resolveRequestedStatus(intent, requestedStatus);
  const draft = resolvedStatus === "draft";
  if (resolvedStatus === "scheduled" && !publishAt) {
    publishAt = `${date}T09:00:00${ISTANBUL_OFFSET}`;
  }
  if (resolvedStatus !== "scheduled") {
    publishAt = "";
  }

  let currentEntry: EntryRecord | null = null;
  let currentSource = "";
  if (originalPath) {
    currentSource = await fetchRepoText(env, originalPath);
    currentEntry = parseEntry(originalPath, currentSource);
  }

  const branch = env.GITHUB_BRANCH || "main";
  const slug = currentEntry?.slug?.trim() || slugify(title);
  const assetSlug = slugify(slug);
  const filename = `${date}-${slug}.md`;
  const entryPath = `${JOURNAL_DIRECTORY}/${filename}`;

  if (!currentEntry || currentEntry.path !== entryPath) {
    await ensurePathMissing(env, branch, entryPath);
  }

  const imageFile = formData.get("image");
  let imageAsset:
    | {
        path: string;
        buffer: ArrayBuffer;
      }
    | undefined;

  if (imageFile instanceof File && imageFile.size > 0) {
    const extension = extensionForFile(imageFile);
    imageAsset = {
      path: `public/images/posts/${assetSlug}/cover.${extension}`,
      buffer: await imageFile.arrayBuffer()
    };
  }

  let coverImage = "";
  if (imageAsset) {
    coverImage = `/${imageAsset.path.replace(/^public\//, "")}`;
  } else if (!removeCoverImage) {
    coverImage = existingCoverImage || currentEntry?.coverImage || "";
  }

  const markdown = buildMarkdown({
    title,
    date,
    description,
    tags,
    body,
    coverImage,
    coverAlt,
    coverCaption,
    coverFocusX,
    coverFocusY,
    draft,
    status: resolvedStatus,
    publishAt
  });

  const files: Array<{ path: string; buffer: ArrayBuffer }> = [
    {
      path: entryPath,
      buffer: encoder.encode(markdown).buffer
    }
  ];

  if (imageAsset) {
    files.push(imageAsset);
  }

  const deletePaths: string[] = [];
  if (currentEntry) {
    files.push(buildRevisionFile(currentEntry.path, currentSource, "update"));
  }

  if (currentEntry && currentEntry.path !== entryPath) {
    deletePaths.push(currentEntry.path);
  }

  const previousCoverPath = existingCoverImage ? publicPathFromCover(existingCoverImage) : "";
  if (removeCoverImage && previousCoverPath) {
    deletePaths.push(previousCoverPath);
  }

  if (imageAsset && previousCoverPath && previousCoverPath !== imageAsset.path) {
    deletePaths.push(previousCoverPath);
  }

  const commitSha = await createCommit(env, {
    branch,
    message: `${currentEntry ? "Update" : resolvedStatus === "scheduled" ? "Schedule" : draft ? "Save draft" : "Publish"} ${filename}`,
    files,
    deletePaths
  });

  return jsonResponse({
    ok: true,
    mode: currentEntry ? "update" : "create",
    intent,
    slug,
    filename,
    commitSha,
    coverImage,
    entryUrl: `/journal/${date}-${slug}/`,
    path: entryPath,
    status: resolvedStatus,
    effectiveStatus: resolveEffectiveStatus({ draft, status: resolvedStatus, publishAt, date })
  });
}

async function requireAuth(request: Request, env: Env) {
  if (!(await isAuthenticated(request, env))) {
    throw new HttpError(401, "Authentication required.");
  }
}

async function isAuthenticated(request: Request, env: Env) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE];

  if (!token || !env.ADMIN_SESSION_SECRET) {
    return false;
  }

  return verifySessionToken(token, env.ADMIN_SESSION_SECRET);
}

async function createSessionToken(expiresAt: number, secret: string) {
  const signature = await hmac(`${expiresAt}`, secret);
  return `${expiresAt}.${toBase64Url(signature)}`;
}

async function verifySessionToken(token: string, secret: string) {
  const [expiresAtRaw, signature] = token.split(".");
  const expiresAt = Number(expiresAtRaw);

  if (!expiresAtRaw || !signature || !Number.isFinite(expiresAt)) return false;
  if (Date.now() >= expiresAt) return false;

  const expected = await hmac(expiresAtRaw, secret);
  return safeEquals(signature, toBase64Url(expected));
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

async function listEntries(env: Env) {
  const branch = env.GITHUB_BRANCH || "main";
  const contents = await githubJson<GitHubContentFile[]>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${JOURNAL_DIRECTORY}?ref=${encodeURIComponent(branch)}`
  );

  const files = contents
    .filter((item) => item.type === "file" && /\.(md|mdx)$/i.test(item.name))
    .sort((a, b) => b.name.localeCompare(a.name, "en"));

  const revisionCounts = await getRevisionCounts(env);
  const entries = await Promise.all(
    files.map(async (file) =>
      parseEntry(file.path, await fetchRepoText(env, file.path), revisionCounts.get(revisionStemFromPath(file.path)) ?? 0)
    )
  );

  return entries.sort((a, b) => {
    const publishedDiff = toDateForStatus(b.publishAt || b.date).getTime() - toDateForStatus(a.publishAt || a.date).getTime();
    return publishedDiff || b.filename.localeCompare(a.filename);
  });
}

async function fetchRepoText(env: Env, path: string) {
  const branch = env.GITHUB_BRANCH || "main";
  const response = await fetch(
    githubApiUrl(`/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`),
    { headers: githubHeaders(env.GITHUB_TOKEN) }
  );

  if (!response.ok) {
    throw await httpErrorFromGitHub(response);
  }

  const payload = (await response.json()) as { content?: string; encoding?: string };
  if (payload.encoding !== "base64" || !payload.content) {
    throw new HttpError(500, "Could not decode repository file.");
  }

  return decodeBase64Text(payload.content);
}

function parseEntry(path: string, source: string, revisionCount = 0): EntryRecord {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const frontmatter = match?.[1] ?? "";
  const body = (match?.[2] ?? source).trim();
  const fields = parseFrontmatter(frontmatter);
  const filename = path.split("/").pop() ?? path;
  const slug = filename.replace(/\.(md|mdx)$/i, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const date = fields.date || filename.slice(0, 10);
  const title = fields.title || slug;
  const wordCount = countWords(body);
  const effectiveStatus = resolveEffectiveStatus(fields);

  return {
    path,
    filename,
    title,
    date,
    description: fields.description || "",
    tags: fields.tags,
    draft: fields.draft,
    status: fields.status,
    effectiveStatus,
    publishAt: fields.publishAt,
    publishAtInput: toDatetimeLocalValue(fields.publishAt),
    body,
    coverImage: fields.coverImage || "",
    coverAlt: fields.coverAlt || "",
    coverCaption: fields.coverCaption || "",
    coverFocusX: fields.coverFocusX,
    coverFocusY: fields.coverFocusY,
    slug,
    entryUrl: `/journal/${filename.replace(/\.(md|mdx)$/i, "")}/`,
    wordCount,
    readingMinutes: readingMinutes(wordCount),
    revisionCount
  };
}

function parseFrontmatter(frontmatter: string) {
  const lines = frontmatter.split(/\r?\n/);
  const result = {
    title: "",
    date: "",
    description: "",
    coverImage: "",
    coverAlt: "",
    coverCaption: "",
    coverFocusX: 50,
    coverFocusY: 50,
    tags: [] as string[],
    draft: false,
    status: "published" as EntryStatus,
    publishAt: ""
  };

  let inTags = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (inTags) {
      if (trimmed.startsWith("- ")) {
        result.tags.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ""));
        continue;
      }
      inTags = false;
    }

    if (trimmed === "tags: []") {
      result.tags = [];
      continue;
    }

    if (trimmed.startsWith("tags: [") && trimmed.endsWith("]")) {
      const inner = trimmed.slice(7, -1).trim();
      result.tags = inner
        ? inner.split(",").map((item) => item.trim().replace(/^["']|["']$/g, ""))
        : [];
      continue;
    }

    if (trimmed === "tags:") {
      inTags = true;
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");

    switch (key) {
      case "title":
        result.title = unescapeYamlString(value);
        break;
      case "date":
        result.date = value;
        break;
      case "description":
        result.description = unescapeYamlString(value);
        break;
      case "coverImage":
        result.coverImage = unescapeYamlString(value);
        break;
      case "coverAlt":
        result.coverAlt = unescapeYamlString(value);
        break;
      case "coverCaption":
        result.coverCaption = unescapeYamlString(value);
        break;
      case "coverFocusX":
        result.coverFocusX = normalizePercentage(value, 50);
        break;
      case "coverFocusY":
        result.coverFocusY = normalizePercentage(value, 50);
        break;
      case "draft":
        result.draft = value === "true";
        break;
      case "status":
        result.status = normalizeStatus(value);
        break;
      case "publishAt":
        result.publishAt = normalizePublishAt(value);
        break;
    }
  }

  if (result.draft && result.status === "published") {
    result.status = "draft";
  }

  return result;
}

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function normalizeDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function normalizePublishAt(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) {
    return `${trimmed}:00${ISTANBUL_OFFSET}`;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function toDatetimeLocalValue(value: string) {
  if (!value) return "";
  const date = toDateForStatus(value);
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function normalizeStatus(value: string): EntryStatus {
  return value === "draft" || value === "scheduled" || value === "published" ? value : "published";
}

function normalizeIntent(value: string) {
  return value === "draft" || value === "scheduled" || value === "published" ? value : "published";
}

function resolveRequestedStatus(intent: string, requested: EntryStatus): EntryStatus {
  if (intent === "draft" || intent === "scheduled" || intent === "published") {
    return intent;
  }
  return requested;
}

function normalizePercentage(value: string, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function resolveEffectiveStatus(input: { draft: boolean; status: EntryStatus; publishAt?: string; date: string }) {
  const now = new Date();
  if (input.draft || input.status === "draft") {
    return "draft" as const;
  }

  const target = input.publishAt ? toDateForStatus(input.publishAt) : toDateForStatus(input.date);
  if ((input.status === "scheduled" || target.getTime() > now.getTime()) && target.getTime() > now.getTime()) {
    return "scheduled" as const;
  }

  return "published" as const;
}

function toDateForStatus(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function slugify(value: string) {
  return value
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function buildMarkdown(input: {
  title: string;
  date: string;
  description: string;
  tags: string[];
  body: string;
  coverImage: string;
  coverAlt: string;
  coverCaption: string;
  coverFocusX: number;
  coverFocusY: number;
  draft: boolean;
  status: EntryStatus;
  publishAt: string;
}) {
  const lines = ["---"];

  lines.push(`title: "${escapeYamlString(input.title)}"`);
  lines.push(`date: "${input.date}"`);
  lines.push(`description: "${escapeYamlString(input.description)}"`);

  if (input.coverImage) lines.push(`coverImage: "${escapeYamlString(input.coverImage)}"`);
  if (input.coverAlt) lines.push(`coverAlt: "${escapeYamlString(input.coverAlt)}"`);
  if (input.coverCaption) lines.push(`coverCaption: "${escapeYamlString(input.coverCaption)}"`);
  lines.push(`coverFocusX: ${input.coverFocusX}`);
  lines.push(`coverFocusY: ${input.coverFocusY}`);

  if (input.tags.length > 0) {
    lines.push("tags:");
    for (const tag of input.tags) {
      lines.push(`  - ${escapeYamlString(tag)}`);
    }
  } else {
    lines.push("tags: []");
  }

  lines.push(`draft: ${input.draft ? "true" : "false"}`);
  lines.push(`status: "${input.status}"`);
  if (input.publishAt) {
    lines.push(`publishAt: "${input.publishAt}"`);
  }
  lines.push("---", "", input.body.trim(), "");

  return lines.join("\n");
}

function escapeYamlString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeYamlString(value: string) {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function extensionForFile(file: File) {
  const fromName = file.name.includes(".") ? file.name.split(".").pop()?.toLowerCase() : "";

  if (fromName && ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(fromName)) {
    return fromName;
  }

  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  if (file.type === "image/gif") return "gif";
  if (file.type === "image/avif") return "avif";
  return "jpg";
}

function publicPathFromCover(coverImage: string) {
  return `public${coverImage.startsWith("/") ? coverImage : `/${coverImage}`}`;
}

function revisionStemFromPath(path: string) {
  return path
    .split("/")
    .pop()
    ?.replace(/\.(md|mdx)$/i, "") ?? "entry";
}

function revisionFilePath(entryPath: string) {
  const stem = revisionStemFromPath(entryPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${REVISIONS_DIRECTORY}/${stem}/${timestamp}.json`;
}

function buildRevisionFile(entryPath: string, source: string, reason: "update" | "delete" | "restore") {
  const entry = parseEntry(entryPath, source);
  const payload = {
    savedAt: new Date().toISOString(),
    reason,
    entryPath,
    filename: entry.filename,
    title: entry.title,
    date: entry.date,
    status: entry.status,
    effectiveStatus: entry.effectiveStatus,
    wordCount: entry.wordCount,
    coverImage: entry.coverImage,
    excerpt: summarize(entry.description, entry.body),
    source
  };

  return {
    path: revisionFilePath(entryPath),
    buffer: encoder.encode(JSON.stringify(payload, null, 2)).buffer
  };
}

function parseRevisionRecord(path: string, source: string): RevisionRecord {
  const payload = JSON.parse(source) as {
    savedAt: string;
    reason: "update" | "delete" | "restore";
    entryPath: string;
    filename: string;
    title: string;
    date: string;
    status: EntryStatus;
    effectiveStatus?: EntryStatus;
    wordCount?: number;
    coverImage?: string;
    excerpt?: string;
    source: string;
  };

  return {
    path,
    savedAt: payload.savedAt,
    savedAtLabel: formatIstanbulDateTime(payload.savedAt),
    reason: payload.reason,
    entryPath: payload.entryPath,
    filename: payload.filename,
    title: payload.title,
    date: payload.date,
    status: payload.status,
    effectiveStatus: payload.effectiveStatus ?? payload.status,
    wordCount: payload.wordCount ?? countWords(payload.source),
    coverImage: payload.coverImage ?? "",
    excerpt: payload.excerpt ?? "",
    source: payload.source
  };
}

async function ensurePathMissing(env: Env, branch: string, path: string) {
  const response = await fetch(
    githubApiUrl(`/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`),
    { headers: githubHeaders(env.GITHUB_TOKEN) }
  );

  if (response.status === 404) return;
  if (response.ok) throw new HttpError(409, "A post with the same filename already exists.");
  throw await httpErrorFromGitHub(response);
}

async function getRevisionCounts(env: Env) {
  const files = await listRepoFilesRecursive(env, REVISIONS_DIRECTORY);
  const counts = new Map<string, number>();

  for (const file of files) {
    const parts = file.path.split("/");
    const stem = parts[parts.length - 2];
    counts.set(stem, (counts.get(stem) ?? 0) + 1);
  }

  return counts;
}

async function listRevisionsForEntry(env: Env, entryPath: string) {
  const stem = revisionStemFromPath(entryPath);
  const files = await listRepoFilesRecursive(env, `${REVISIONS_DIRECTORY}/${stem}`);
  const revisions = await Promise.all(
    files
      .filter((file) => file.path.endsWith(".json"))
      .map(async (file) => parseRevisionRecord(file.path, await fetchRepoText(env, file.path)))
  );

  return revisions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

async function listAllRevisions(env: Env) {
  const files = await listRepoFilesRecursive(env, REVISIONS_DIRECTORY);
  const revisions = await Promise.all(
    files
      .filter((file) => file.path.endsWith(".json"))
      .map(async (file) => parseRevisionRecord(file.path, await fetchRepoText(env, file.path)))
  );

  return revisions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

async function listRepoFilesRecursive(env: Env, prefix: string) {
  const branch = env.GITHUB_BRANCH || "main";
  const ref = await githubJson<GitHubRefResponse>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/ref/heads/${branch}`
  );

  const commit = await githubJson<GitHubCommitResponse>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/commits/${ref.object.sha}`
  );

  const tree = await githubJson<GitHubTreeResponse>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/trees/${commit.tree.sha}?recursive=1`
  );

  return tree.tree.filter((item) => item.type === "blob" && item.path.startsWith(prefix));
}

async function createCommit(
  env: Env,
  input: {
    branch: string;
    message: string;
    files: Array<{
      path: string;
      buffer: ArrayBuffer;
    }>;
    deletePaths?: string[];
  }
) {
  const ref = await githubJson<GitHubRefResponse>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/ref/heads/${input.branch}`
  );

  const commit = await githubJson<GitHubCommitResponse>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/commits/${ref.object.sha}`
  );

  const tree: Array<Record<string, string | null>> = [];

  for (const file of input.files) {
    const blob = await githubJson<{ sha: string }>(
      env,
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/blobs`,
      {
        method: "POST",
        body: JSON.stringify({
          content: arrayBufferToBase64(file.buffer),
          encoding: "base64"
        })
      }
    );

    tree.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha
    });
  }

  for (const path of [...new Set(input.deletePaths ?? [])]) {
    tree.push({
      path,
      mode: "100644",
      type: "blob",
      sha: null
    });
  }

  const newTree = await githubJson<{ sha: string }>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({
        base_tree: commit.tree.sha,
        tree
      })
    }
  );

  const newCommit = await githubJson<{ sha: string }>(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        tree: newTree.sha,
        parents: [ref.object.sha]
      })
    }
  );

  await githubJson(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/refs/heads/${input.branch}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        sha: newCommit.sha,
        force: false
      })
    }
  );

  return newCommit.sha;
}

async function githubJson<T>(env: Env, path: string, init: RequestInit = {}) {
  const response = await fetch(githubApiUrl(path), {
    ...init,
    headers: {
      ...githubHeaders(env.GITHUB_TOKEN),
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    throw await httpErrorFromGitHub(response);
  }

  return (await response.json()) as T;
}

async function httpErrorFromGitHub(response: Response) {
  let message = `GitHub request failed with status ${response.status}.`;

  try {
    const payload = (await response.json()) as { message?: string };
    if (payload.message) {
      message = payload.message;
    }
  } catch {
    // ignore JSON parse failures
  }

  return new HttpError(response.status, message);
}

function githubApiUrl(path: string) {
  return `https://api.github.com${path}`;
}

function githubHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "sporadik-space-admin"
  };
}

function parseCookies(header: string | null) {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const item of header.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (!name) continue;
    cookies[name] = decodeURIComponent(value.join("="));
  }

  return cookies;
}

function decodeBase64Text(value: string) {
  const normalized = value.replace(/\n/g, "");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toBase64Url(buffer: ArrayBuffer) {
  return arrayBufferToBase64(buffer).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function safeEquals(left: string, right: string) {
  if (left.length !== right.length) return false;

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function jsonResponse(payload: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) {
  const headers = {
    ...JSON_HEADERS,
    ...SECURITY_HEADERS,
    ...(init.headers ?? {})
  };

  return new Response(JSON.stringify(payload), {
    ...init,
    headers
  });
}

function countWords(value: string) {
  const matches = value.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function readingMinutes(wordCount: number) {
  return Math.max(1, Math.round(wordCount / 225));
}

function stripMarkdown(source: string) {
  return source
    .replace(/^---[\s\S]*?---/, "")
    .replace(/`{3}[\s\S]*?`{3}/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(description: string, body: string) {
  const explicit = description.trim();
  if (explicit) return explicit;
  const plain = stripMarkdown(body);
  return plain.slice(0, 180).trim();
}

function formatIstanbulDateTime(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function normalizeForConcepts(value: string) {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("tr-TR")
    .replace(/['’`"]/g, "")
    .replace(/[^\p{L}0-9\s-]/gu, " ");
}

function getClientKey(request: Request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function loginRetryAfter(clientKey: string) {
  const attempt = loginAttempts.get(clientKey);
  if (!attempt) return 0;

  const now = Date.now();
  if (attempt.blockedUntil > now) return Math.ceil((attempt.blockedUntil - now) / 1000);
  if (now - attempt.windowStartedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(clientKey);
    return 0;
  }
  return 0;
}

function recordLoginFailure(clientKey: string) {
  const now = Date.now();
  const current = loginAttempts.get(clientKey);
  const attempt = !current || now - current.windowStartedAt >= LOGIN_WINDOW_MS
    ? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
    : current;

  attempt.failures += 1;
  if (attempt.failures >= LOGIN_MAX_FAILURES) {
    attempt.blockedUntil = now + LOGIN_BLOCK_MS;
  }
  loginAttempts.set(clientKey, attempt);
}

function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function normalizeTag(value: string) {
  return normalizeForConcepts(value).replace(/\s+/g, " ").trim();
}

function extractConceptTokens(source: string) {
  const stopwords = new Set([
    "acaba", "ait", "ama", "ancak", "arada", "artik", "aslinda", "az", "bana", "bazen",
    "bazi", "belki", "ben", "beni", "benim", "beri", "bile", "bilhassa", "bir", "biraz",
    "bircok", "biri", "birkac", "biz", "bize", "bizi", "bizim", "bu", "buna", "bunda",
    "bundan", "bunu", "bunun", "burada", "boyle", "butun", "cok", "cunku", "da", "daha",
    "dahi", "de", "defa", "degil", "demek", "diye", "dogru", "elbette", "en", "esas",
    "fakat", "gerek", "gibi", "gore", "hala", "hatta", "hem", "hep", "her", "hic", "icin",
    "icinde", "iken", "ile", "ilgili", "ise", "iste", "itibaren", "kadar", "karsi", "kendi",
    "kez", "ki", "kim", "kimi", "kimse", "mi", "mu", "nasil", "ne", "neden", "nerede",
    "nihayet", "olarak", "oldu", "oldugu", "olmak", "olsa", "olsun", "olup", "onu", "onun",
    "orada", "oyle", "pek", "ragmen", "sadece", "sanki", "sey", "simdi", "su", "suna", "sunu",
    "sonra", "tabii", "tam", "tum", "uzere", "var", "ve", "veya", "ya", "yahut", "yani",
    "yerine", "yine", "yok", "zaten", "zira"
  ]);

  const blockedConcepts = new Set([
    "ver", "kal", "yap", "bak", "gel", "git", "al", "et", "ol", "kukla", "kuklaci"
  ]);

  const counts = new Map<string, number>();
  const tokens = (normalizeForConcepts(source).match(/\p{L}[\p{L}-]{2,}/gu) ?? [])
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .map((token) => token.replace(/[0-9]+/g, ""))
    .map(normalizeConceptToken)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !stopwords.has(token))
    .filter((token) => !blockedConcepts.has(token))
    .filter((token) => !isNarrativeConcept(token))
    .filter((token) => !isRelationalConcept(token));

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "tr"))
    .map(([token]) => token);
}

function extractConceptPhrases(tokens: string[]) {
  const counts = new Map<string, number>();
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const pair = `${tokens[index]} ${tokens[index + 1]}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);

    if (tokens[index + 2]) {
      const triad = `${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`;
      counts.set(triad, (counts.get(triad) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "tr"))
    .map(([phrase]) => phrase)
    .filter((phrase, index, list) => !list.some((other, otherIndex) => otherIndex < index && other.includes(phrase)));
}

function normalizeConceptToken(token: string) {
  let value = token.normalize("NFC").replace(/^-+|-+$/g, "");

  const literalSuffixes = [
    "lerinizden", "larinizdan", "lerinizde", "larinizda", "lerinden", "larindan",
    "lerimiz", "larimiz", "lerden", "lardan", "lerde", "larda", "lerin", "larin",
    "lere", "lara", "deki", "daki", "teki", "taki", "ligin", "ligi", "lugu", "lugu",
    "lik", "lik", "luk", "luk", "maktan", "mekten", "makta", "mekte", "masi", "mesi",
    "mayi", "meyi", "mak", "mek"
  ];

  const suffix = literalSuffixes.find((item) => value.endsWith(item) && value.length - item.length >= 4);
  if (suffix) {
    value = value.slice(0, -suffix.length);
  }

  const patternSuffixes = [
    /(?:t|d)(?:a|e)y?(?:ken|im|ım|um|üm|sin|sın|sun|sün|iz|ız|uz|üz|dir|dır|dur|dür|dim|dım|dum|düm|tim|tım|tum|tüm|dik|dık|duk|dük|ler|lar)$/u,
    /(?:t|d)(?:a|e)$/u,
    /(?:y)?(?:dim|dım|dum|düm|tim|tım|tum|tüm|dik|dık|duk|dük|ken)$/u,
    /(?:y)?(?:im|ım|um|üm|sin|sın|sun|sün|iz|ız|uz|üz)$/u
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patternSuffixes) {
      const next = value.replace(pattern, "");
      if (next !== value && next.length >= 4) {
        value = next;
        changed = true;
        break;
      }
    }
  }

  const verbLikeSuffixes = [
    /(?:d|t)(?:i|ı|u|ü)$/u,
    /(?:m|n|k)?(?:s|y)?(?:mıs|mis|mus|müs|mış|miş|muş|müş)$/u,
    /(?:yor)$/u
  ];

  for (const pattern of verbLikeSuffixes) {
    const next = value.replace(pattern, "");
    if (next !== value && next.length >= 4) {
      value = next;
    }
  }

  if (value.endsWith("g") && value.length > 4) {
    value = `${value.slice(0, -1)}k`;
  }

  if (value.endsWith("gı") || value.endsWith("gi") || value.endsWith("gu") || value.endsWith("gü")) {
    value = `${value.slice(0, -1)}k`;
  }

  return value;
}

function simplifyConceptToken(token: string) {
  return token
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ö/g, "o")
    .replace(/ş/g, "s")
    .replace(/ü/g, "u")
    .toLocaleLowerCase("tr-TR");
}

function isNarrativeConcept(token: string) {
  const simplified = simplifyConceptToken(token);
  return new Set([
    "de", "di", "soyle", "ver", "verd", "kal", "yap", "bak", "gel", "git", "al",
    "et", "ol", "isit", "gor", "izle", "iste", "bil", "san", "bul", "dinle",
    "ogren", "takil", "acil", "kapan", "cik", "cevir", "seyret", "ded", "anla"
  ]).has(simplified);
}

function isRelationalConcept(token: string) {
  const simplified = simplifyConceptToken(token);
  return ["arasin", "arasi", "arasinda", "arasindan", "arasina"].includes(simplified);
}

function isWeakTag(value: string) {
  const normalized = normalizeTag(value);
  if (!normalized) return true;
  if (normalized.length <= 2) return true;
  if (/^(ve|ile|ama|gibi|icin|veya|bir|bu|su|o)$/.test(normalized)) return true;
  return false;
}

function findDuplicateTags(tags: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized) continue;
    if (seen.has(normalized)) {
      duplicates.add(tag);
    } else {
      seen.add(normalized);
    }
  }

  return [...duplicates];
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

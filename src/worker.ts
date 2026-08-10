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

type GitHubContentFile = {
  name: string;
  path: string;
  sha: string;
  type: "file";
  download_url: string | null;
};

type EntryRecord = {
  path: string;
  filename: string;
  title: string;
  date: string;
  description: string;
  tags: string[];
  draft: boolean;
  body: string;
  coverImage: string;
  coverAlt: string;
  coverCaption: string;
  slug: string;
  entryUrl: string;
};

const SESSION_COOKIE = "sporadik_admin";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const JOURNAL_DIRECTORY = "src/content/journal";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const encoder = new TextEncoder();

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

      if (url.pathname === "/api/admin/publish" && request.method === "POST") {
        return handlePublish(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, { status: error.status });
      }

      return jsonResponse({ error: "Unexpected server error." }, { status: 500 });
    }
  }
};

async function handleLogin(request: Request, env: Env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return jsonResponse({ error: "Admin secrets are missing on the server." }, { status: 500 });
  }

  let payload: { password?: string };

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid login payload." }, { status: 400 });
  }

  if (!safeEquals(payload.password ?? "", env.ADMIN_PASSWORD)) {
    return jsonResponse({ error: "Password is incorrect." }, { status: 401 });
  }

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

  const text = await fetchRepoText(env, path);
  const entry = parseEntry(path, text);
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

  const deletePaths = [path];
  if (entry.coverImage) {
    deletePaths.push(publicPathFromCover(entry.coverImage));
  }

  const commitSha = await createCommit(env, {
    branch,
    message: `Delete ${entry.filename}`,
    files: [],
    deletePaths
  });

  return jsonResponse({ ok: true, deleted: entry.filename, commitSha });
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
  const draft = getText(formData, "draft") === "true";

  if (!title) throw new HttpError(400, "Title is required.");
  if (!date) throw new HttpError(400, "Date is required.");
  if (!body) throw new HttpError(400, "Body is required.");

  const slug = slugify(title);
  const filename = `${date}-${slug}.md`;
  const entryPath = `${JOURNAL_DIRECTORY}/${filename}`;
  const branch = env.GITHUB_BRANCH || "main";

  let currentEntry: EntryRecord | null = null;
  if (originalPath) {
    const existingText = await fetchRepoText(env, originalPath);
    currentEntry = parseEntry(originalPath, existingText);
  }

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
      path: `public/images/posts/${slug}/cover.${extension}`,
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
    draft
  });

  const files = [
    {
      path: entryPath,
      buffer: encoder.encode(markdown).buffer
    }
  ];

  if (imageAsset) {
    files.push(imageAsset);
  }

  const deletePaths: string[] = [];

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
    message: `${currentEntry ? "Update" : "Publish"} ${filename}`,
    files,
    deletePaths
  });

  return jsonResponse({
    ok: true,
    mode: currentEntry ? "update" : "create",
    slug,
    filename,
    commitSha,
    coverImage,
    entryUrl: `/journal/${date}-${slug}/`,
    path: entryPath
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

  const entries = await Promise.all(
    files.map(async (file) => parseEntry(file.path, await fetchRepoText(env, file.path)))
  );

  return entries.sort((a, b) => b.date.localeCompare(a.date) || b.filename.localeCompare(a.filename));
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

function parseEntry(path: string, source: string): EntryRecord {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const frontmatter = match?.[1] ?? "";
  const body = (match?.[2] ?? source).trim();
  const fields = parseFrontmatter(frontmatter);
  const filename = path.split("/").pop() ?? path;
  const slug = filename.replace(/\.(md|mdx)$/i, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const date = fields.date || filename.slice(0, 10);
  const title = fields.title || slug;

  return {
    path,
    filename,
    title,
    date,
    description: fields.description || "",
    tags: fields.tags,
    draft: fields.draft,
    body,
    coverImage: fields.coverImage || "",
    coverAlt: fields.coverAlt || "",
    coverCaption: fields.coverCaption || "",
    slug,
    entryUrl: `/journal/${filename.replace(/\.(md|mdx)$/i, "")}/`
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
    tags: [] as string[],
    draft: false
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
      case "draft":
        result.draft = value === "true";
        break;
    }
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
  draft: boolean;
}) {
  const lines = ["---"];

  lines.push(`title: "${escapeYamlString(input.title)}"`);
  lines.push(`date: "${input.date}"`);
  lines.push(`description: "${escapeYamlString(input.description)}"`);

  if (input.coverImage) lines.push(`coverImage: "${escapeYamlString(input.coverImage)}"`);
  if (input.coverAlt) lines.push(`coverAlt: "${escapeYamlString(input.coverAlt)}"`);
  if (input.coverCaption) lines.push(`coverCaption: "${escapeYamlString(input.coverCaption)}"`);

  if (input.tags.length > 0) {
    lines.push("tags:");
    for (const tag of input.tags) {
      lines.push(`  - ${escapeYamlString(tag)}`);
    }
  } else {
    lines.push("tags: []");
  }

  lines.push(`draft: ${input.draft ? "true" : "false"}`);
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

async function ensurePathMissing(env: Env, branch: string, path: string) {
  const response = await fetch(
    githubApiUrl(`/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`),
    { headers: githubHeaders(env.GITHUB_TOKEN) }
  );

  if (response.status === 404) return;
  if (response.ok) throw new HttpError(409, "A post with the same filename already exists.");
  throw await httpErrorFromGitHub(response);
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
    ...(init.headers ?? {})
  };

  return new Response(JSON.stringify(payload), {
    ...init,
    headers
  });
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

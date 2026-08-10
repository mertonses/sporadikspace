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

const SESSION_COOKIE = "sporadik_admin";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
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

      if (url.pathname === "/api/admin/publish" && request.method === "POST") {
        return handlePublish(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, { status: error.status });
      }

      return jsonResponse(
        { error: "Unexpected server error." },
        { status: 500 }
      );
    }
  }
};

async function handleLogin(request: Request, env: Env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return jsonResponse(
      { error: "Admin secrets are missing on the server." },
      { status: 500 }
    );
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

async function handlePublish(request: Request, env: Env) {
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Authentication required." }, { status: 401 });
  }

  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    return jsonResponse(
      { error: "GitHub publishing secrets are missing on the server." },
      { status: 500 }
    );
  }

  const formData = await request.formData();

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

  if (!title) {
    return jsonResponse({ error: "Title is required." }, { status: 400 });
  }

  if (!date) {
    return jsonResponse({ error: "Date is required." }, { status: 400 });
  }

  if (!body) {
    return jsonResponse({ error: "Body is required." }, { status: 400 });
  }

  const slug = slugify(title);
  const filename = `${date}-${slug}.md`;
  const entryPath = `src/content/journal/${filename}`;
  const branch = env.GITHUB_BRANCH || "main";

  const imageFile = formData.get("image");
  let imageAsset:
    | {
        path: string;
        contentType: string;
        buffer: ArrayBuffer;
      }
    | undefined;

  if (imageFile instanceof File && imageFile.size > 0) {
    const extension = extensionForFile(imageFile);
    imageAsset = {
      path: `public/images/posts/${slug}/cover.${extension}`,
      contentType: imageFile.type || mimeTypeForExtension(extension),
      buffer: await imageFile.arrayBuffer()
    };
  }

  const coverImage = imageAsset ? `/${imageAsset.path.replace(/^public\//, "")}` : "";
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

  await ensurePathMissing(env, branch, entryPath);

  const files = [
    {
      path: entryPath,
      contentType: "text/markdown; charset=utf-8",
      buffer: encoder.encode(markdown).buffer
    }
  ];

  if (imageAsset) {
    files.push(imageAsset);
  }

  const commitSha = await createCommit(env, {
    branch,
    message: `Publish ${filename}`,
    files
  });

  return jsonResponse({
    ok: true,
    slug,
    filename,
    commitSha,
    coverImage,
    entryUrl: `/journal/${date}-${slug}/`
  });
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

  if (!expiresAtRaw || !signature || !Number.isFinite(expiresAt)) {
    return false;
  }

  if (Date.now() >= expiresAt) {
    return false;
  }

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

  if (input.coverImage) {
    lines.push(`coverImage: "${escapeYamlString(input.coverImage)}"`);
  }

  if (input.coverAlt) {
    lines.push(`coverAlt: "${escapeYamlString(input.coverAlt)}"`);
  }

  if (input.coverCaption) {
    lines.push(`coverCaption: "${escapeYamlString(input.coverCaption)}"`);
  }

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

function extensionForFile(file: File) {
  const fromName = file.name.includes(".")
    ? file.name.split(".").pop()?.toLowerCase()
    : "";

  if (fromName && ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(fromName)) {
    return fromName;
  }

  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  if (file.type === "image/gif") return "gif";
  if (file.type === "image/avif") return "avif";
  return "jpg";
}

function mimeTypeForExtension(extension: string) {
  switch (extension) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return "image/jpeg";
  }
}

async function ensurePathMissing(env: Env, branch: string, path: string) {
  const response = await fetch(githubApiUrl(`/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`), {
    headers: githubHeaders(env.GITHUB_TOKEN)
  });

  if (response.status === 404) {
    return;
  }

  if (response.ok) {
    throw new HttpError(409, "A post with the same filename already exists.");
  }

  throw await httpErrorFromGitHub(response);
}

async function createCommit(
  env: Env,
  input: {
    branch: string;
    message: string;
    files: Array<{
      path: string;
      contentType: string;
      buffer: ArrayBuffer;
    }>;
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

  const tree = [];

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
    const payload = await response.json<{ message?: string }>();
    if (payload.message) {
      message = payload.message;
    }
  } catch {
    // ignore JSON parse failures and keep fallback message
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

  if (!header) {
    return cookies;
  }

  for (const item of header.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (!name) continue;
    cookies[name] = decodeURIComponent(value.join("="));
  }

  return cookies;
}

function toBase64Url(buffer: ArrayBuffer) {
  return arrayBufferToBase64(buffer)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;

  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function jsonResponse(
  payload: unknown,
  init: ResponseInit & { headers?: Record<string, string> } = {}
) {
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

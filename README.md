# sporadikspace

Minimal Astro-based writing platform for [sporadik.space](https://sporadik.space).

It is designed as a private-feeling public journal: static, portable, markdown-first, and deployable without a database.

Brand description used across the site:

> notlar, denemeler, kısa yazılar ve kişisel gözlemler için sakin ve düzensiz bir yazı alanı.

## Stack

- Astro
- TypeScript
- Markdown content collections
- Static site generation
- Cloudflare deployment with Wrangler

## Project structure

```text
src/
  content/
    journal/
  components/
  layouts/
  lib/
  pages/
public/
.github/workflows/
```

## How to add a new journal entry

1. Create a new file in `src/content/journal/`
2. Use this naming pattern:

```text
YYYY-MM-DD-title.md
```

Example:

```text
2026-08-06-first-entry.md
```

3. Add frontmatter if you want full manual control:

```md
---
title: "First Entry"
date: "2026-08-06"
description: ""
tags:
  - thoughts
draft: false
---
```

4. Write the body in Markdown

The homepage, archive, search index, sitemap, and RSS feed update automatically on the next build.

### Faster writing flow

You can also keep it lightweight:

```md
---
draft: false
---

Your text here.
```

- `title` can be inferred from the filename
- `date` can be inferred from the filename
- `tags` can be suggested later with the helper script below

## AI-supported tag suggestions

There is a small local helper for suggesting tags from a journal entry.

### Setup

1. Put your OpenAI API key into `.env`
2. Optionally change the model:

```env
OPENAI_API_KEY=your_key_here
TAG_SUGGESTION_MODEL=gpt-5.6
```

### Suggest tags

For a specific file:

```bash
npm run suggest-tags -- src/content/journal/2026-08-06-first-entry.md
```

For the latest entry:

```bash
npm run suggest-tags:latest
```

To write the suggested tags into frontmatter automatically:

```bash
npm run suggest-tags:write
```

If `OPENAI_API_KEY` is missing, the script falls back to a simple local keyword heuristic.

## Local development

```bash
npm install
npm run dev
```

Open the local Astro dev server URL and write as usual.

## Build

```bash
npm run build
```

Output is generated in `dist/`.

## Deployment

This project is ready to deploy with Wrangler.

### First-time setup

```bash
npm install
npx wrangler login
```

### Deploy now

```bash
npm run deploy
```

This will:

1. build Astro into `dist/`
2. deploy the static output using `wrangler.jsonc`
3. publish it to the configured `sporadik.space` routes

### Auto deploy

If your GitHub workflow is connected, every push to `main` can deploy automatically.
If you are working locally only, deployment happens when you run `npm run deploy`.

## Custom domain

To connect `sporadik.space`:

1. Keep `sporadik.space` on Cloudflare nameservers
2. Make sure the Worker routes in `wrangler.jsonc` stay as:
   - `sporadik.space/*`
   - `www.sporadik.space/*`
3. Run `npm run deploy`

## Email subscriptions

The `/subscribe` page is ready for hosted providers without building a custom backend.

Copy `.env.example` to `.env` and set one of:

- `PUBLIC_BUTTONDOWN_ACTION`
- `PUBLIC_BEEHIIV_ACTION`
- `PUBLIC_CONVERTKIT_ACTION`

These values should be the hosted form action URLs from the provider.

If you already use Buttondown, the shortest path is:

```env
PUBLIC_DEFAULT_SUBSCRIBE_PROVIDER=buttondown
PUBLIC_BUTTONDOWN_USERNAME=sporadik
```

### Free Buttondown automation alternative

Buttondown's built-in RSS-to-email requires a paid plan.

This project now includes a simpler alternative:

- visitors subscribe through Buttondown
- GitHub Actions deploys the site on push
- after deploy, the latest changed journal entry is sent through the Buttondown API

Add this GitHub Actions secret:

- `BUTTONDOWN_API_KEY`

The workflow will then run:

```bash
npm run publish:latest-email -- --changed-only
```

You can also test locally without sending:

```bash
npm run publish:latest-email:dry-run
```

Or send the latest published entry manually:

```bash
npm run publish:latest-email
```

## RSS

The feed is generated at:

```text
/rss.xml
```

It is compatible with RSS readers, newsletter tools, and Substack import workflows.

## Publishing standards

- Canonical metadata included
- Open Graph metadata included
- Sitemap generated automatically
- `robots.txt` included
- Markdown files remain the source of truth
- Suggested tags are optional and generated locally on demand

## Notes

- No comments
- No likes
- No social feed logic
- No database
- No authentication

Just the writing.

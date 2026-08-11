import { getCollection } from "astro:content";
import { entryDate, entrySlug, entryTitle, publishedEntries, shortDate, stripMarkdown } from "../lib/journal";

export async function GET() {
  const entries = publishedEntries(await getCollection("journal"));

  const payload = entries.map((entry) => ({
    slug: entrySlug(entry),
    title: entryTitle(entry),
    description: entry.data.description,
    tags: entry.data.tags,
    date: shortDate(entryDate(entry)),
    body: stripMarkdown(entry.body ?? "")
  }));

  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });
}

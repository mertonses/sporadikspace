import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { entryDate, entrySlug, entryTitle, entryUrl, publishedEntries } from "../lib/journal";
import { siteConfig } from "../lib/site";

export async function GET(context: { site: string | undefined }) {
  const entries = publishedEntries(await getCollection("journal"));

  return rss({
    title: siteConfig.title,
    description: siteConfig.description,
    site: context.site ?? siteConfig.site,
    items: entries.map((entry) => ({
      title: entryTitle(entry),
      description: entry.data.description || entryTitle(entry),
      pubDate: entryDate(entry),
      link: entryUrl(entry),
      categories: entry.data.tags,
      customData: `<guid isPermaLink="false">${entrySlug(entry)}</guid>`
    })),
    customData: `<language>tr</language>`
  });
}

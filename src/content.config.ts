import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const journal = defineCollection({
  loader: glob({
    pattern: "**/*.{md,mdx}",
    base: "./src/content/journal"
  }),
  schema: z.object({
    title: z.string().optional(),
    date: z.coerce.date().optional(),
    description: z.string().default(""),
    coverImage: z.string().optional(),
    coverAlt: z.string().optional(),
    coverCaption: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false)
  })
});

export const collections = {
  journal
};

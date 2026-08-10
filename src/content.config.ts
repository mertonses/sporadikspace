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
    coverFocusX: z.coerce.number().min(0).max(100).default(50),
    coverFocusY: z.coerce.number().min(0).max(100).default(50),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    status: z.enum(["draft", "scheduled", "published"]).default("published"),
    publishAt: z.coerce.date().optional()
  })
});

export const collections = {
  journal
};

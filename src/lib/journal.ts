import type { CollectionEntry } from "astro:content";

export type JournalEntry = CollectionEntry<"journal">;
export type EntryStatus = "draft" | "scheduled" | "published";

export function entrySlug(entry: JournalEntry) {
  return entry.id.replace(/\.(md|mdx)$/i, "");
}

export function entryUrl(entry: JournalEntry) {
  return `/journal/${entrySlug(entry)}/`;
}

function slugStem(entry: JournalEntry) {
  return entrySlug(entry).replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

function titleCaseFromSlug(value: string) {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function entryTitle(entry: JournalEntry) {
  return entry.data.title?.trim() || titleCaseFromSlug(slugStem(entry));
}

export function entryDate(entry: JournalEntry) {
  if (entry.data.date instanceof Date && !Number.isNaN(entry.data.date.getTime())) {
    return entry.data.date;
  }

  const match = entrySlug(entry).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    throw new Error(`Entry ${entry.id} is missing a valid date and filename prefix.`);
  }

  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
}

export function entryPublishDate(entry: JournalEntry) {
  if (entry.data.publishAt instanceof Date && !Number.isNaN(entry.data.publishAt.getTime())) {
    return entry.data.publishAt;
  }

  return entryDate(entry);
}

export function entryStatus(entry: JournalEntry, now = new Date()): EntryStatus {
  if (entry.data.draft || entry.data.status === "draft") {
    return "draft";
  }

  const publishDate = entryPublishDate(entry);
  if ((entry.data.status === "scheduled" || publishDate.getTime() > now.getTime())) {
    return publishDate.getTime() <= now.getTime() ? "published" : "scheduled";
  }

  return "published";
}

export function sortEntries(entries: JournalEntry[]) {
  return [...entries].sort((a, b) => entryPublishDate(b).getTime() - entryPublishDate(a).getTime());
}

export function publishedEntries(entries: JournalEntry[], now = new Date()) {
  return sortEntries(entries.filter((entry) => entryStatus(entry, now) === "published"));
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "long",
    day: "2-digit"
  }).format(date);
}

export function shortDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function stripMarkdown(source: string) {
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

export function groupArchive(entries: JournalEntry[]) {
  const grouped = new Map<number, Map<number, { label: string; entries: JournalEntry[] }>>();

  for (const entry of entries) {
    const date = entryDate(entry);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const monthLabel = new Intl.DateTimeFormat("en-US", {
      month: "long",
      timeZone: "UTC"
    }).format(date);

    if (!grouped.has(year)) grouped.set(year, new Map());
    const yearMap = grouped.get(year)!;
    if (!yearMap.has(month)) {
      yearMap.set(month, { label: monthLabel, entries: [] });
    }
    yearMap.get(month)!.entries.push(entry);
  }

  return [...grouped.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({
      year,
      months: [...months.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, data]) => ({
          label: data.label,
          entries: sortEntries(data.entries)
        }))
    }));
}

export function yearlyCounts(entries: JournalEntry[]) {
  const counts = new Map<number, number>();
  for (const entry of entries) {
    const year = entryDate(entry).getUTCFullYear();
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, count]) => ({ year, count }));
}

export function tagCloud(entries: JournalEntry[]) {
  const unigramStopwords = new Set([
    "acaba", "ait", "ama", "ancak", "arada", "artik", "asil", "aslinda", "az", "bana", "bazen",
    "bazi", "belki", "ben", "bence", "beni", "benim", "beri", "bile", "bilhassa", "bir", "biraz",
    "bircok", "biri", "birkac", "birlikte", "biriyle", "biz", "bize", "bizi", "bizim", "bu", "buna",
    "bunda", "bundan", "bunu", "bunun", "burada", "boyle", "butun", "cok", "cunku", "da", "daha",
    "dahi", "de", "defa", "degil", "demek", "diye", "dolayi", "dogru", "durum", "elbette", "en",
    "esas", "fakat", "falan", "filan", "gerek", "gerekli", "gibi", "gore", "ha", "hala", "hani",
    "hatta", "hem", "hep", "hepsi", "her", "hic", "icin", "icinde", "iken", "ile", "ilgili", "ise",
    "iste", "itibaren", "kadar", "karsi", "kendi", "kez", "ki", "kim", "kimi", "kimse", "mi",
    "mu", "mu", "nasil", "ne", "neden", "nerede", "nereye", "nihayet", "olarak", "oldu", "oldugu",
    "olmak", "olsa", "olsun", "olup", "onu", "onun", "orada", "oyle", "pek", "ragmen", "sadece",
    "sanki", "sayet", "sey", "simdi", "su", "suna", "sunu", "sonra", "tabii", "tam", "tum", "uzere",
    "var", "ve", "veya", "ya", "yahut", "yani", "yerine", "yine", "yok", "zaten", "zira",
    "the", "and", "for", "from", "into", "that", "this", "with", "your", "have", "were", "they",
    "them", "their", "there", "then", "than", "when", "what", "which", "will", "would", "about",
    "just", "over", "more", "some", "such", "very", "been", "being", "also", "here", "keep", "hold",
    "not", "you", "our", "out", "all", "way"
  ]);

  const weakTerms = new Set([
    "arada", "arasında", "artik", "aslinda", "bazen", "belki", "çoktan", "dair", "defa", "derken",
    "elbette", "elinden", "esasen", "evvela", "galiba", "halde", "haliyle", "henuz", "icinden",
    "itibariyla", "kendi", "lakin", "mesela", "nihayet", "nispetle", "orada", "oteye", "pek",
    "sirf", "şimdi", "sipsak", "sozumona", "tabii", "tamamen", "vakit", "vaktiyle", "yalniz",
    "yegane", "yine", "zaten", "zira", "uzere", "ustelik", "kanaat", "getirmiş", "misali",
    "kalem", "kaleme", "kulak", "nezdinde", "hayli", "dogrusu", "nihai", "bizzat",
    "değil", "için", "olan", "olmak", "etmek", "etme", "olma", "misa", "aras", "ahal", "şimd", "elin"
  ]);

  const blockedTerms = new Set([
    "baki", "resul", "besir", "fuad", "muhterem", "ihsan", "oktay", "anar", "bey",
    "linguafraudator", "prosecutor", "franca", "rahmetli", "efendiler", "kulunuz", "bendeniz",
    "adamcagiz", "adamcagizin", "zavallim", "zavallimcagiz", "okurlarim", "dostunuz", "ahali",
    "et", "ol"
  ]);

  const unigramCounts = new Map<string, number>();
  const unigramDocCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  const phraseDocCounts = new Map<string, number>();

  for (const entry of entries) {
    const originalSource = [
      entryTitle(entry),
      entry.data.description ?? "",
      entry.body ?? "",
      entry.data.tags.join(" ")
    ]
      .filter(Boolean)
      .join(" ");

    const dynamicNameTerms = extractNameTerms(originalSource, entry.data.tags);

    const weightedSource = [
      entryTitle(entry),
      entryTitle(entry),
      entry.data.description ?? "",
      entry.data.description ?? "",
      entry.data.tags.join(" "),
      stripMarkdown(entry.body ?? "")
    ]
      .filter(Boolean)
      .join(" ");

    const tokens = tokenizeKeywords(weightedSource)
      .filter((token) => !unigramStopwords.has(token))
      .filter((token) => !weakTerms.has(token))
      .filter((token) => !blockedTerms.has(token))
      .filter((token) => !dynamicNameTerms.has(token))
      .filter((token) => token.length >= 4);

    const phrases = buildCandidatePhrases(tokens)
      .filter((phrase) => !hasBlockedWord(phrase, blockedTerms))
      .filter((phrase) => !hasWeakWord(phrase, weakTerms))
      .filter((phrase) => !isNameHeavyPhrase(phrase, dynamicNameTerms))
      .filter((phrase) => !isWeakPhrase(phrase));

    const seenTokens = new Set<string>();
    const seenPhrases = new Set<string>();

    for (const token of tokens) {
      unigramCounts.set(token, (unigramCounts.get(token) ?? 0) + 1);
      if (!seenTokens.has(token)) {
        unigramDocCounts.set(token, (unigramDocCounts.get(token) ?? 0) + 1);
        seenTokens.add(token);
      }
    }

    for (const phrase of phrases) {
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
      if (!seenPhrases.has(phrase)) {
        phraseDocCounts.set(phrase, (phraseDocCounts.get(phrase) ?? 0) + 1);
        seenPhrases.add(phrase);
      }
    }
  }

  const unigramItems = [...unigramCounts.entries()]
    .map(([tag, count]) => {
      const docs = unigramDocCounts.get(tag) ?? 1;
      return {
        tag,
        count,
        docs,
        score: count + docs * 3
      };
    })
    .filter((item) => item.docs >= 2 && item.count >= 4)
    .filter((item) => !weakTerms.has(item.tag));

  const phraseItems = [...phraseCounts.entries()]
    .map(([tag, count]) => {
      const docs = phraseDocCounts.get(tag) ?? 1;
      return {
        tag,
        count,
        docs,
        score: count * (tag.split(" ").length === 3 ? 3.25 : 2.8) + docs * 3.8
      };
    })
    .filter((item) => item.docs >= 2 && item.count >= 2);

  const items = [...phraseItems, ...unigramItems]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.tag.localeCompare(b.tag, "tr"))
    .filter((item, index, list) => {
      return !list.some((other, otherIndex) => {
        if (otherIndex >= index) return false;
        return other.tag.includes(item.tag) && other.tag !== item.tag;
      });
    })
    .slice(0, 18);

  const max = items[0]?.score ?? 1;
  const min = items[items.length - 1]?.score ?? 1;
  const span = Math.max(max - min, 1);

  return items.map((item) => ({
    tag: item.tag,
    count: item.docs,
    href: `/search?q=${encodeURIComponent(item.tag)}`,
    weight: 0.9 + ((item.score - min) / span) * 1.1
  }));
}

function normalizeForMatch(value: string) {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("tr-TR")
    .replace(/['’`"]/g, "")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/û/g, "u")
    .replace(/[^a-z0-9çğıöşü\s-]/g, " ");
}

function tokenizeKeywords(source: string) {
  const normalized = normalizeForMatch(source).replace(/[0-9]+/g, " ");

  return (normalized.match(/\p{L}[\p{L}-]{2,}/gu) ?? [])
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .map(normalizeTurkishToken)
    .filter((token) => token.length >= 3);
}

function normalizeTurkishToken(token: string) {
  let value = token.normalize("NFC").replace(/^-+|-+$/g, "");

  const suffixes = [
    "lerinizden", "larinizdan", "lerinizde", "larinizda", "lerinden", "larindan",
    "lerimiz", "larimiz", "lerden", "lardan", "lerde", "larda", "lerin", "larin",
    "lere", "lara", "deki", "daki", "teki", "taki", "ligin", "lığın", "luğun",
    "lüğün", "liği", "lığı", "luğu", "lüğü", "lik", "lık", "luk", "lük",
    "maktan", "mekten", "makta", "mekte", "masi", "mesi", "mayi", "meyi", "mak", "mek"
  ];

  const suffix = suffixes.find((item) => value.endsWith(item) && value.length - item.length >= 4);
  if (suffix) {
    value = value.slice(0, -suffix.length);
  }

  if (value.endsWith("g") && value.length > 4) {
    value = `${value.slice(0, -1)}k`;
  }

  if (value.endsWith("gı") || value.endsWith("gi") || value.endsWith("gu") || value.endsWith("gü")) {
    value = `${value.slice(0, -1)}k`;
  }

  return value;
}

function buildCandidatePhrases(tokens: string[]) {
  const phrases: string[] = [];

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const first = tokens[index];
    const second = tokens[index + 1];
    const third = tokens[index + 2];

    if (first && second && first !== second) {
      phrases.push(`${first} ${second}`);
    }

    if (first && second && third && first !== second && second !== third) {
      phrases.push(`${first} ${second} ${third}`);
    }
  }

  return phrases;
}

function hasBlockedWord(phrase: string, blockedTerms: Set<string>) {
  return phrase.split(" ").some((word) => blockedTerms.has(word));
}

function hasWeakWord(phrase: string, weakTerms: Set<string>) {
  return phrase.split(" ").some((word) => weakTerms.has(word));
}

function isNameHeavyPhrase(phrase: string, nameTerms: Set<string>) {
  const words = phrase.split(" ");
  const nameCount = words.filter((word) => nameTerms.has(word)).length;
  return nameCount >= 2;
}

function extractNameTerms(source: string, tags: string[]) {
  const names = new Set<string>();
  const titleCaseWords = source.normalize("NFC").match(/\b[A-ZÇĞİÖŞÜ][a-zçğıöşüâîû]+(?:['’][A-ZÇĞİÖŞÜa-zçğıöşüâîû]+)?\b/g) ?? [];

  for (const word of titleCaseWords) {
    const token = normalizeTurkishToken(normalizeForMatch(word).trim());
    if (token.length >= 4) {
      names.add(token);
    }
  }

  for (const tag of tags) {
    const token = normalizeTurkishToken(normalizeForMatch(tag).replace(/\s+/g, ""));
    if (
      token.endsWith("baki") ||
      token.endsWith("resul") ||
      token.endsWith("besir") ||
      token.endsWith("fuad") ||
      token.endsWith("ihsan") ||
      token.endsWith("oktay") ||
      token.endsWith("anar")
    ) {
      names.add(token);
    }
  }

  return names;
}

function isWeakPhrase(phrase: string) {
  const weakHeads = new Set([
    "dedi", "deyiver", "ol", "var", "et", "gel", "bir", "cok", "daha", "simdi",
    "vaktiyle", "kanaat", "sirf", "lakin", "yine", "pek"
  ]);

  const weakTails = new Set([
    "gibi", "kadar", "uzere", "icin", "ol", "var", "et", "dedi",
    "hal", "ic", "aras", "dair", "derken", "vaktiyle", "misali"
  ]);

  const words = phrase.split(" ");
  const first = words[0] ?? "";
  const last = words[words.length - 1] ?? "";

  return weakHeads.has(first) || weakTails.has(last);
}

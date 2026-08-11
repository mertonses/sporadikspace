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
  const grouped = new Map<number, Map<number, { label: string; month: number; entries: JournalEntry[] }>>();

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
      yearMap.set(month, { label: monthLabel, month, entries: [] });
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
  const stopwords = new Set([
    "acaba", "ait", "ama", "ancak", "arada", "artik", "asil", "aslinda", "az", "bana", "bazen",
    "bazi", "belki", "ben", "bence", "beni", "benim", "beri", "bile", "bilhassa", "bir", "biraz",
    "bircok", "biri", "birkac", "birlikte", "biz", "bize", "bizi", "bizim", "bu", "buna", "bunda",
    "bundan", "bunu", "bunun", "burada", "boyle", "butun", "cok", "cunku", "daha", "dahi", "defa",
    "degil", "demek", "diye", "dogru", "elbette", "elbet", "en", "esas", "fakat", "gibi", "gore", "hala",
    "hatta", "hem", "hep", "her", "hic", "icin", "icinde", "iken", "ile", "ilgili", "ise", "iste",
    "itibaren", "kadar", "karsi", "kendi", "kez", "ki", "kim", "kimi", "kimse", "mi", "mu", "ne",
    "neden", "nerede", "nereye", "nihayet", "olarak", "oldu", "oldugu", "olmak", "olsa", "olsun",
    "olup", "onu", "onun", "orada", "oyle", "pek", "ragmen", "sadece", "sanki", "sayet", "sey",
    "simdi", "sonra", "su", "tabii", "tam", "tum", "ustune", "uzere", "vakit", "vaktiyle", "var", "ve", "veya", "yahut", "yani",
    "yerine", "yine", "yok", "zaten", "zira", "the", "and", "for", "from", "into", "that", "this",
    "with", "your", "have", "were", "they", "them", "their", "there", "then", "than", "when", "what",
    "which", "will", "would", "about", "just", "over", "more", "some", "such", "very", "been", "being",
    "also", "here", "not", "you", "our", "out", "all", "way", "derken", "misali", "lakin", "gerek", "kulak"
  ]);

  const blocked = new Set([
    "baki", "resul", "besir", "fuad", "ihsan", "oktay", "anar", "linguafraudator", "prosecutor",
    "franca", "kukla", "kuklaci", "sir", "mr", "mrs", "allah", "yankee", "globemaster", "berlin",
    "ankara", "moskova", "ruslar", "ukrayna", "fransa", "davos", "negev", "muhterem"
  ]);

  const counts = new Map<string, number>();
  const docCounts = new Map<string, number>();
  const labels = new Map<string, string>();

  for (const entry of entries) {
    const source = [
      entryTitle(entry),
      entryTitle(entry),
      entry.data.description ?? "",
      entry.data.description ?? "",
      entry.data.tags.join(" "),
      stripMarkdown(entry.body ?? "")
    ]
      .filter(Boolean)
      .join(" ");

    const rawTokens = source.match(/\p{L}[\p{L}'’-]{2,}/gu) ?? [];
    const seen = new Set<string>();

    for (const rawToken of rawTokens) {
      const concept = normalizeConceptCandidate(rawToken);
      if (!concept) continue;

      const simple = simplifyTokenForFilter(concept.key);
      if (stopwords.has(simple)) continue;
      if (blocked.has(simple)) continue;
      if (isNarrativeVerbStem(concept.key)) continue;
      if (isRelationalFiller(concept.key)) continue;
      if (simple.length < 4) continue;

      counts.set(concept.key, (counts.get(concept.key) ?? 0) + 1);
      labels.set(concept.key, concept.display);

      if (!seen.has(concept.key)) {
        docCounts.set(concept.key, (docCounts.get(concept.key) ?? 0) + 1);
        seen.add(concept.key);
      }
    }
  }

  const items = [...counts.entries()]
    .map(([key, count]) => {
      const docs = docCounts.get(key) ?? 1;
      const score = count + docs * 4 + conceptBoost(key, count, docs) + (docs === 1 && count >= 8 ? 4 : 0);
      return {
        key,
        tag: labels.get(key) ?? key,
        count,
        docs,
        score
      };
    })
    .filter((item) => (item.docs >= 3 && item.count >= 3) || item.count >= 6)
    .filter((item) => {
      const excluded = new Set([
        "değil", "şimdi", "artık", "olan", "kuklacı", "beşir", "bendeniz", "geldi",
        "çoktan", "üstüne", "arasında", "dünyanın", "fuadın", "muhterem", "vaktiyle",
        "misali", "derken", "etme", "olma", "kulak", "lakin", "gerek", "elinden",
        "dair", "hakika", "hâliyle", "hayale", "verdim", "bütünüyle", "dışarı",
        "kaleme", "kanaat", "kendini"
      ]);
      return !excluded.has(item.tag);
    })
    .sort((a, b) => b.score - a.score || b.count - a.count || a.tag.localeCompare(b.tag, "tr"))
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
    .replace(/\u00e2/g, "a")
    .replace(/\u00ee/g, "i")
    .replace(/\u00fb/g, "u")
    .replace(/[^\p{L}0-9\s-]/gu, " ");
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
    "lere", "lara", "deki", "daki", "teki", "taki", "ligin", "ligi", "lugu", "lugu",
    "lik", "lik", "luk", "luk", "maktan", "mekten", "makta", "mekte", "masi", "mesi",
    "mayi", "meyi", "mak", "mek"
  ];

  const suffix = suffixes.find((item) => value.endsWith(item) && value.length - item.length >= 4);
  if (suffix) {
    value = value.slice(0, -suffix.length);
  }

  const patternSuffixes = [
    /(?:t|d)(?:a|e)y?(?:ken|im|\u0131m|um|\u00fcm|sin|s\u0131n|sun|s\u00fcn|iz|\u0131z|uz|\u00fcz|dir|d\u0131r|dur|d\u00fcr|dim|d\u0131m|dum|d\u00fcm|tim|t\u0131m|tum|t\u00fcm|dik|d\u0131k|duk|d\u00fck|ler|lar)$/u,
    /(?:t|d)(?:a|e)$/u,
    /(?:y)?(?:dim|d\u0131m|dum|d\u00fcm|tim|t\u0131m|tum|t\u00fcm|dik|d\u0131k|duk|d\u00fck|ken)$/u,
    /(?:y)?(?:im|\u0131m|um|\u00fcm|sin|s\u0131n|sun|s\u00fcn|iz|\u0131z|uz|\u00fcz)$/u
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
    /(?:d|t)(?:i|\u0131|u|\u00fc)$/u,
    /(?:m|n|k)?(?:s|y)?(?:m\u0131s|mis|mus|m\u00fcs|m\u0131\u015f|mi\u015f|mu\u015f|m\u00fc\u015f)$/u,
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

  if (value.endsWith(`g\u0131`) || value.endsWith("gi") || value.endsWith("gu") || value.endsWith(`g\u00fc`)) {
    value = `${value.slice(0, -1)}k`;
  }

  return value;
}

function simplifyTokenForFilter(token: string) {
  return normalizeForMatch(token)
    .replace(/\u00e7/g, "c")
    .replace(/\u011f/g, "g")
    .replace(/\u0131/g, "i")
    .replace(/\u00f6/g, "o")
    .replace(/\u015f/g, "s")
    .replace(/\u00fc/g, "u")
    .replace(/\s+/g, "");
}

function normalizeConceptCandidate(rawToken: string) {
  const base = rawToken
    .normalize("NFC")
    .toLocaleLowerCase("tr-TR")
    .replace(/^[^-\p{L}]+|[^-\p{L}]+$/gu, "")
    .replace(/['’`-]+/g, "");

  if (base.length < 4) return null;

  let display = base;
  const patterns = [
    /^(.*?)(?:t|d)(?:a|e)y?(?:im|\u0131m|um|\u00fcm|sin|s\u0131n|sun|s\u00fcn|iz|\u0131z|uz|\u00fcz|ydim|yd\u0131m|ydum|yd\u00fcm|yken|dir|d\u0131r|dur|d\u00fcr)$/u,
    /^(.*?)(?:d|t)(?:i|\u0131|u|\u00fc)(?:m|n|k|ler|lar)?$/u,
    /^(.*?)(?:m\u0131\u015f|mi\u015f|mu\u015f|m\u00fc\u015f)$/u,
    /^(.*?)(?:lar|ler)$/u
  ];

  for (const pattern of patterns) {
    const match = display.match(pattern);
    if (match?.[1] && match[1].length >= 4) {
      display = match[1];
    }
  }

  const key = display.normalize("NFC");
  return { key, display: key };
}


function isNarrativeVerbStem(token: string) {
  const simplified = simplifyTokenForFilter(token);
  const blockedRoots = new Set([
    "de", "di", "soyle", "ver", "verd", "kal", "yap", "bak", "gel", "geld", "git", "al",
    "et", "ol", "isit", "gor", "izle", "iste", "bil", "san", "bul", "dinle",
    "ogren", "takil", "acil", "kapan", "cik", "cevir", "seyret", "ded", "anla", "etme", "olma", "ettim"
  ]);

  return blockedRoots.has(simplified);
}

function isRelationalFiller(token: string) {
  const simplified = simplifyTokenForFilter(token);
  return ["arasin", "arasi", "arasinda", "arasindan", "arasina"].includes(simplified);
}

function conceptBoost(tag: string, count: number, docs: number) {
  const simplified = simplifyTokenForFilter(tag);
  let boost = 0;

  if (count >= 6) boost += 2;
  if (count >= 10) boost += 2;
  if (tag.length >= 6) boost += 0.8;
  if (docs >= 2) boost += 0.6;

  if (
    simplified.endsWith("lik") ||
    simplified.endsWith("luk") ||
    simplified.endsWith("culuk") ||
    simplified.endsWith("sizlik") ||
    simplified.endsWith("cilik") ||
    simplified.endsWith("iyet") ||
    simplified.endsWith("izm") ||
    simplified.endsWith("krit") ||
    simplified.endsWith("tecrit")
  ) {
    boost += 1.8;
  }

  return boost;
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
  const titleCaseWords = source.normalize("NFC").match(/\b\p{Lu}[\p{L}\u00e2\u00ee\u00fb]+(?:['’][\p{Lu}\p{L}\u00e2\u00ee\u00fb]+)?\b/gu) ?? [];

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

export const siteConfig = {
  title: "sporadikspace",
  description:
    "notlar, denemeler, kısa yazılar ve kişisel gözlemler için sakin ve düzensiz bir yazı alanı.",
  site: "https://sporadik.space",
  author: "Mert Gorkem Onses",
  email: "mrtonses@gmail.com",
  nav: [
    { href: "/", label: "latest" },
    { href: "/archive", label: "archive" },
    { href: "/search", label: "search" },
    { href: "/subscribe", label: "subscribe" }
  ]
} as const;

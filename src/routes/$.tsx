import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$")({
  loader: ({ params }) => {
    const path = (params._splat || "").replace(/\/+$/, "");
    if (!path) throw redirect({ href: "/index.html" });

    const segments = path.split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) throw notFound();
    if (segments.at(-1)?.includes(".")) throw notFound();

    throw redirect({ href: `/${segments.map(encodeURIComponent).join("/")}/index.html` });
  },
  head: () => ({
    meta: [
      { title: "Passport Room | Free Passport Photo Studio" },
      {
        name: "description",
        content: "Passport Room photo studio, guides, and visitor information.",
      },
      { property: "og:title", content: "Passport Room | Free Passport Photo Studio" },
      {
        property: "og:description",
        content: "Passport Room photo studio, guides, and visitor information.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => null,
});
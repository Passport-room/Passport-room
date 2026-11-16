import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  loader: () => {
    throw redirect({ href: "/index.html" });
  },
  head: () => ({
    meta: [
      { title: "Free Passport Photo Maker | Passport Room" },
      {
        name: "description",
        content:
          "Create passport and visa photos in your browser with Passport Room’s free photo studio.",
      },
      { property: "og:title", content: "Free Passport Photo Maker | Passport Room" },
      {
        property: "og:description",
        content: "Create passport and visa photos in your browser with Passport Room.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => null,
});

import { createFileRoute, redirect } from "@tanstack/react-router";

const pages = new Set([
  "about",
  "contact",
  "features",
  "privacy-policy",
  "terms-of-service",
]);

export const Route = createFileRoute("/$")({
  beforeLoad: ({ params }) => {
    const page = params._splat?.replace(/\/$/, "");
    if (!page || !pages.has(page)) return;
    throw redirect({ href: `/${page}/index.html` });
  },
  component: () => <div>Page not found</div>,
});
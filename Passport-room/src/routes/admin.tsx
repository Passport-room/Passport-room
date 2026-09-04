import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

const TITLE = "Admin Panel — Passport Room";
const DESCRIPTION = "Staff-only live customer analytics dashboard for Passport Room.";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "noindex, nofollow" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminRedirect,
});

function AdminRedirect() {
  useEffect(() => {
    window.location.replace("/admin/index.html");
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <p>Loading admin panel…</p>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

const TITLE = "Cubit.pics — AI Passport Photo Maker, Try-On & HD Enhance";
const DESCRIPTION =
  "Make print-ready passport & visa photos in seconds. On-device AI background removal, outfit try-on, face enhancement and a maximum-density A4 print sheet.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  useEffect(() => {
    // The studio is a static, self-contained page in /public. Replace (not
    // push) so the back button skips this shim entirely.
    window.location.replace("/index.html");
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
      <p>Loading Cubit.pics studio…</p>
    </div>
  );
}

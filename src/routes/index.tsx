import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AI Photo Studio — Virtual Try-On & HD Enhance" },
      {
        name: "description",
        content:
          "Change clothes on your photo with AI virtual try-on and enhance to HD while preserving facial identity. Free, no signup.",
      },
      {
        property: "og:title",
        content: "AI Photo Studio — Virtual Try-On & HD Enhance",
      },
      {
        property: "og:description",
        content:
          "Change clothes on your photo with AI virtual try-on and enhance to HD while preserving facial identity. Free, no signup.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  useEffect(() => {
    window.location.replace("/index.html");
  }, []);
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <p>Loading AI Photo Studio…</p>
    </div>
  );
}

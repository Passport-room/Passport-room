import { createFileRoute } from "@tanstack/react-router";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export const Route = createFileRoute("/api/public/assistant")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        try {
          const { prompt } = await request.json();
          if (!prompt || typeof prompt !== "string") {
            return json({ error: "Prompt string is required" }, 400);
          }

          const apiKey = process.env.GEMINI_API_KEY;
          if (!apiKey) {
            return json(
              {
                error: "GEMINI_API_KEY environment variable is not configured",
              },
              500,
            );
          }

          const ai = new GoogleGenAI({ apiKey });
          const response = await ai.models.generateContent({
            model: "gemini-3.1-pro-preview",
            config: {
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.HIGH,
              },
            },
            contents: prompt,
          });

          return json({ text: response.text });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[assistant] Error:", msg);
          return json({ error: msg }, 500);
        }
      },
    },
  },
});

import { env } from "../config/env.js";

export async function generateAnswer(prompt) {
  if (!env.AI_API_KEY || !env.AI_MODEL) {
    const error = new Error("AI is not configured. Set AI_API_KEY and AI_MODEL.");
    error.status = 503;
    error.codeName = "AI_NOT_CONFIGURED";
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.AI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.AI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800,
        temperature: 0.4
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error("AI provider request failed.");
      error.status = response.status === 429 ? 429 : 502;
      error.codeName = "AI_PROVIDER_ERROR";
      throw error;
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    if (err.name === "AbortError") {
      const error = new Error("AI request timed out.");
      error.status = 504;
      error.codeName = "AI_TIMEOUT";
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

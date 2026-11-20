// Supabase Edge Function: turns movie titles people type from memory ("star wars 1", "harry potter")
// into real films. The browser sends each typed line plus a few lookalike titles from Movi's database
// as hints; Claude answers with official titles and years, which the browser maps back to film ids.
//
// Deploy: Supabase dashboard -> Edge Functions -> Deploy a new function -> name it "match-films",
// paste this file. Then add the secret ANTHROPIC_API_KEY under Edge Functions -> Secrets.
import Anthropic from "npm:@anthropic-ai/sdk@1.9.0";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const MAX_LINES = 80;
const MAX_LINE_CHARS = 200;
const MAX_HINTS = 12;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FILM = {
  type: "object",
  properties: { title: { type: "string" }, year: { type: "integer" } },
  required: ["title", "year"],
  additionalProperties: false,
};

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "integer", description: "Index of the typed line this result is for" },
          films: { type: "array", items: FILM, description: "The film or films the person meant" },
          series: { type: "array", items: FILM, description: "Other main entries of the franchise, only when the line names a franchise without picking an entry" },
        },
        required: ["line", "films", "series"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const SYSTEM = `You match movie titles that people typed from memory to the real films they mean.
Each input line is something a person says they have watched, often misspelled, abbreviated, or numbered ("star wars 1", "lotr 2", "the godfather part two", "karate kid").

For every line, return the film or films they meant, using the official English title and the original theatrical release year, the way Wikipedia names the film.
- A number refers to the installment in the franchise's own numbering where one exists (Star Wars episodes: "star wars 1" is Star Wars: Episode I – The Phantom Menace, 1999; "star wars 4" is Star Wars, 1977), otherwise to release order ("toy story 2").
- If the line names a franchise without picking an entry ("harry potter"), put its first film in films and the franchise's other main entries in series, in release order.
- If a title has several versions (remakes), choose the best-known one unless the line gives a year or other detail.
- If a line lists several films, return each of them in films.
- If a line is not a film you can identify, return an empty films list rather than guessing.
- Each line comes with hints: titles from the app's own database that look similar. When a hint is the film meant, copy its exact title and year.
Return one result per input line, with the same line index.`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // Only signed-in members may use matching. Any project key works for checking the member's token;
  // newer projects may not set SUPABASE_ANON_KEY, so fall back to the service role key.
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseKey) return json({ error: "Supabase keys are not available to this function" }, 500);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in to use matching" }, 401);
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", supabaseKey, { auth: { persistSession: false } });
  const { data: userData } = await supabase.auth.getUser(token);
  if (!userData?.user) return json({ error: "Sign in to use matching" }, 401);

  let body: { lines?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) return json({ error: "lines must be a non-empty array" }, 400);
  if (body.lines.length > MAX_LINES) return json({ error: `Send at most ${MAX_LINES} lines at a time` }, 400);

  const lines = body.lines.map((raw, i) => {
    const item = raw as { text?: unknown; hints?: unknown };
    const hints = Array.isArray(item.hints) ? item.hints.slice(0, MAX_HINTS) : [];
    return {
      line: i,
      text: String(item.text ?? "").slice(0, MAX_LINE_CHARS),
      hints: hints.map((h) => {
        const hint = h as { title?: unknown; year?: unknown };
        return { title: String(hint.title ?? "").slice(0, 200), year: Number(hint.year) || 0 };
      }),
    };
  });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set for this function" }, 500);
  const client = new Anthropic({ apiKey });

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ lines }) }],
    });
    if (response.stop_reason === "refusal") return json({ results: [] });
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return json({ error: "No answer from the model" }, 502);
    const parsed = JSON.parse(text.text) as { results: unknown[] };
    return json({ results: parsed.results });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Matching is busy, try again in a minute" }, 429);
    if (err instanceof Anthropic.APIError) return json({ error: `Matching failed (${err.status})` }, 502);
    return json({ error: "Matching failed" }, 500);
  }
});

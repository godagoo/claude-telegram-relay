/**
 * Semantic Search Edge Function
 *
 * Generates an embedding for the query, then calls match_messages or
 * match_memory to find similar rows. This keeps the OpenAI key in Supabase
 * so the relay never needs it.
 *
 * POST body:
 *   { query: string, table?: "messages" | "memory", match_count?: number, match_threshold?: number }
 *
 * Returns: array of matching rows with similarity scores.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const {
      query,
      table = "messages",
      match_count = 10,
      match_threshold = 0.7,
      user_id,
    } = await req.json();

    if (!query) {
      return new Response("Missing query", { status: 400 });
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return new Response("OPENAI_API_KEY not configured", { status: 500 });
    }

    // Generate embedding for the search query
    const embeddingResponse = await fetch(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: query,
        }),
      }
    );

    if (!embeddingResponse.ok) {
      const err = await embeddingResponse.text();
      return new Response(`OpenAI error: ${err}`, { status: 500 });
    }

    const { data } = await embeddingResponse.json();
    const embedding = data[0].embedding;

    // Semantic search via Supabase RPC
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const rpcName = table === "memory" ? "match_memory" : "match_messages";

    const { data: results, error } = await supabase.rpc(rpcName, {
      query_embedding: embedding,
      match_threshold,
      match_count,
      p_user_id: user_id || null,
    });

    if (error) {
      return new Response(`Search error: ${error.message}`, { status: 500 });
    }

    return new Response(JSON.stringify(results || []), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(String(error), { status: 500 });
  }
});

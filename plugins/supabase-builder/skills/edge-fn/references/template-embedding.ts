// TEMPLATE: Embedding Generator
// Takes text (or a table row ID), generates a vector embedding, stores it
// in a `pgvector` column. Can be called on-demand or wired to a trigger.
//
// REPLACE:
//   TABLE_NAME          — table containing the source text + vector column
//   TEXT_COLUMN         — column holding the text to embed
//   VECTOR_COLUMN       — pgvector column to write to (e.g. `embedding vector(1536)`)
//   EMBEDDING_MODEL     — e.g. "text-embedding-3-small" (OpenAI) or "voyage-3" (Voyage AI)
//   EMBEDDING_DIMS      — 1536 for OpenAI small, etc.
//
// SECRETS:
//   OPENAI_API_KEY (or VOYAGE_API_KEY, adapt the fetch call)
//
// PREREQUISITE:
//   create extension if not exists vector;
//   alter table TABLE_NAME add column if not exists VECTOR_COLUMN vector(EMBEDDING_DIMS);

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })

interface RequestBody {
  // One of these two is required:
  text?: string        // embed this text directly, return the vector
  row_id?: string      // embed TABLE_NAME.TEXT_COLUMN for this row, store in VECTOR_COLUMN
}

async function generateEmbedding(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: "EMBEDDING_MODEL",
    }),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`Embedding API returned ${res.status}: ${detail.slice(0, 200)}`)
  }

  const data = await res.json()
  return data.data[0].embedding
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  const apiKey = Deno.env.get("OPENAI_API_KEY")
  if (!apiKey) return json({ error: "server_misconfigured" }, 500)

  let body: RequestBody
  try {
    body = await req.json()
  } catch (_e) {
    return json({ error: "invalid_json" }, 400)
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  )

  try {
    // Mode 1: embed supplied text, just return the vector
    if (body.text) {
      const embedding = await generateEmbedding(body.text, apiKey)
      return json({ ok: true, embedding, dims: embedding.length })
    }

    // Mode 2: embed a row's text column and store it
    if (body.row_id) {
      const { data: row, error: fetchErr } = await supabase
        .from("TABLE_NAME")
        .select("TEXT_COLUMN")
        .eq("id", body.row_id)
        .single()

      if (fetchErr || !row) {
        return json({ error: "row_not_found", row_id: body.row_id }, 404)
      }

      const text = row["TEXT_COLUMN"]
      if (!text || typeof text !== "string") {
        return json({ error: "empty_text_column", row_id: body.row_id }, 422)
      }

      const embedding = await generateEmbedding(text, apiKey)

      const { error: updateErr } = await supabase
        .from("TABLE_NAME")
        .update({ VECTOR_COLUMN: embedding })
        .eq("id", body.row_id)

      if (updateErr) {
        console.error("Failed to store embedding:", updateErr)
        return json({ error: "db_write_failed", detail: updateErr.message }, 500)
      }

      console.log(`Embedded row ${body.row_id}, ${embedding.length} dims`)
      return json({ ok: true, row_id: body.row_id, dims: embedding.length })
    }

    return json({ error: "missing_field", expected: "text or row_id" }, 400)
  } catch (e) {
    console.error("Embedding generation failed:", e)
    return json({ error: "embedding_failed", detail: String(e) }, 500)
  }
})

/*
Similarity search example:

select id, TEXT_COLUMN, 1 - (VECTOR_COLUMN <=> $1) as similarity
from TABLE_NAME
where VECTOR_COLUMN is not null
order by VECTOR_COLUMN <=> $1
limit 10;
*/

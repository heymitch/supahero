// TEMPLATE: AI Task Wrapper
// Receives a prompt + optional context, calls Anthropic (Claude) from inside
// Supabase (not the Cowork VM — the VM can't reach arbitrary APIs).
// Returns structured JSON. Logs inputs/outputs to a table for observability.
//
// REPLACE:
//   MODEL         — e.g. "claude-sonnet-4-5" or "claude-opus-4-5"
//   SYSTEM_PROMPT — the default system prompt for this skill
//   LOG_TABLE     — (optional) table to store prompt + completion for later analysis
//
// SECRETS:
//   ANTHROPIC_API_KEY
//   (optional) ALLOWED_CALLER_SECRET — shared bearer token if you want to restrict callers

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
  prompt: string
  context?: string
  max_tokens?: number
  response_format?: "text" | "json"
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  // Optional caller auth
  const allowedSecret = Deno.env.get("ALLOWED_CALLER_SECRET")
  if (allowedSecret) {
    const auth = req.headers.get("authorization") ?? ""
    if (auth !== `Bearer ${allowedSecret}`) {
      return json({ error: "unauthorized" }, 401)
    }
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
  if (!apiKey) {
    console.error("Missing ANTHROPIC_API_KEY")
    return json({ error: "server_misconfigured" }, 500)
  }

  let body: RequestBody
  try {
    body = await req.json()
  } catch (_e) {
    return json({ error: "invalid_json" }, 400)
  }

  if (!body.prompt) {
    return json({ error: "missing_field", field: "prompt" }, 400)
  }

  const systemPrompt = "SYSTEM_PROMPT"
  const userMessage = body.context
    ? `${body.context}\n\n---\n\n${body.prompt}`
    : body.prompt

  const started = Date.now()

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "MODEL",
        max_tokens: body.max_tokens ?? 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    })

    if (!res.ok) {
      const detail = await res.text()
      console.error(`Anthropic returned ${res.status}:`, detail.slice(0, 500))
      return json({ error: "upstream_failed", status: res.status }, 502)
    }

    const data = await res.json()
    const completion = data.content?.[0]?.text ?? ""
    const durationMs = Date.now() - started

    // Optional: log to table for observability / later analysis
    const logTable = "LOG_TABLE"
    if (logTable && logTable !== "LOG_TABLE") {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      )
      await supabase.from(logTable).insert({
        prompt: body.prompt,
        context: body.context ?? null,
        completion,
        duration_ms: durationMs,
        input_tokens: data.usage?.input_tokens,
        output_tokens: data.usage?.output_tokens,
      })
    }

    // Parse JSON response if requested
    if (body.response_format === "json") {
      try {
        const parsed = JSON.parse(completion)
        return json({ result: parsed, usage: data.usage, duration_ms: durationMs })
      } catch (_e) {
        return json(
          { error: "llm_returned_invalid_json", raw: completion },
          502,
        )
      }
    }

    return json({ result: completion, usage: data.usage, duration_ms: durationMs })
  } catch (e) {
    console.error("AI wrapper failed:", e)
    return json({ error: "exception", detail: String(e) }, 500)
  }
})

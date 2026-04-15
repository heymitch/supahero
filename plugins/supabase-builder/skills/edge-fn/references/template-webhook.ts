// TEMPLATE: Webhook Receiver
// Receives POST from an external service, verifies HMAC, upserts to a table.
// Idempotent via stable key. Returns typed JSON errors.
//
// REPLACE these placeholders:
//   TABLE_NAME       — the Postgres table to upsert into
//   STABLE_KEY       — column name that identifies a unique submission (for upsert)
//   HMAC_HEADER      — the header the external service signs (e.g. "x-signature")
//   HMAC_SECRET_ENV  — env var holding the shared secret (e.g. "STRIPE_WEBHOOK_SECRET")

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, HMAC_HEADER",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })

async function verifyHmac(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody))
  const computed = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  // Constant-time compare
  if (computed.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

serve(async (req) => {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405)
  }

  // Read body for both HMAC verify and parse
  const rawBody = await req.text()

  // Verify signature
  const secret = Deno.env.get("HMAC_SECRET_ENV")
  if (!secret) {
    console.error("Missing HMAC_SECRET_ENV — refusing to process")
    return json({ error: "server_misconfigured" }, 500)
  }

  const signature = req.headers.get("HMAC_HEADER")
  const valid = await verifyHmac(rawBody, signature, secret)
  if (!valid) {
    console.warn("Invalid signature from", req.headers.get("user-agent"))
    return json({ error: "invalid_signature" }, 401)
  }

  // Parse and validate payload
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch (_e) {
    return json({ error: "invalid_json" }, 400)
  }

  const stableKey = payload["STABLE_KEY"]
  if (!stableKey) {
    return json({ error: "missing_stable_key", field: "STABLE_KEY" }, 400)
  }

  // UPSERT into table
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  )

  const { error } = await supabase
    .from("TABLE_NAME")
    .upsert(
      {
        STABLE_KEY: stableKey,
        payload,
        received_at: new Date().toISOString(),
      },
      { onConflict: "STABLE_KEY" },
    )

  if (error) {
    console.error("DB upsert failed:", error)
    return json({ error: "db_write_failed", detail: error.message }, 500)
  }

  console.log("Received and stored", stableKey)
  return json({ ok: true, stable_key: stableKey })
})

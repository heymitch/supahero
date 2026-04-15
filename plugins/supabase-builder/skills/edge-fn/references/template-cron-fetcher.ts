// TEMPLATE: Scheduled Data Fetcher
// Called by pg_cron on a schedule. Fetches from an external API, upserts rows.
// Handles rate limits with a simple retry + pagination if the API supports it.
//
// REPLACE:
//   API_URL          — the endpoint to fetch
//   API_KEY_ENV      — env var with the API key (e.g. "LINEAR_API_KEY")
//   TABLE_NAME       — target Postgres table
//   STABLE_KEY       — upsert key column
//   CRON_SECRET_ENV  — env var with a shared secret to authenticate the cron caller

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, init)
    if (res.status !== 429) return res
    // Rate limited — respect Retry-After or back off
    const retryAfter = Number(res.headers.get("retry-after") ?? 2 ** attempt)
    console.warn(`Rate limited, retrying in ${retryAfter}s (attempt ${attempt + 1})`)
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
  }
  throw new Error("Exceeded max retries after rate limiting")
}

serve(async (req) => {
  // Authenticate the cron caller via a shared secret header
  const cronSecret = Deno.env.get("CRON_SECRET_ENV")
  const provided = req.headers.get("x-cron-secret")
  if (!cronSecret || provided !== cronSecret) {
    return json({ error: "unauthorized" }, 401)
  }

  const apiKey = Deno.env.get("API_KEY_ENV")
  if (!apiKey) {
    console.error("Missing API_KEY_ENV")
    return json({ error: "server_misconfigured" }, 500)
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  )

  let fetchedCount = 0
  let upsertedCount = 0
  const errors: string[] = []

  try {
    const res = await fetchWithRetry("API_URL", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`API returned ${res.status}: ${body.slice(0, 200)}`)
      return json({ error: "upstream_failed", status: res.status }, 502)
    }

    const data = await res.json()
    const rows = Array.isArray(data) ? data : (data.items ?? data.data ?? [])
    fetchedCount = rows.length

    // Upsert in batches of 500 to stay within Postgres param limits
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500).map((row: Record<string, unknown>) => ({
        STABLE_KEY: row["STABLE_KEY"],
        data: row,
        synced_at: new Date().toISOString(),
      }))

      const { error } = await supabase
        .from("TABLE_NAME")
        .upsert(batch, { onConflict: "STABLE_KEY" })

      if (error) {
        errors.push(`batch ${i}: ${error.message}`)
      } else {
        upsertedCount += batch.length
      }
    }
  } catch (e) {
    console.error("Fetcher failed:", e)
    return json({ error: "fetcher_exception", detail: String(e) }, 500)
  }

  console.log(`Fetched ${fetchedCount}, upserted ${upsertedCount}, errors: ${errors.length}`)

  return json({
    ok: errors.length === 0,
    fetched: fetchedCount,
    upserted: upsertedCount,
    errors,
  })
})

/*
Wire the cron in SQL:

select cron.schedule(
  'fetch-TABLE_NAME-hourly',
  '0 * * * *',
  $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/<function-name>',
      headers := jsonb_build_object(
        'x-cron-secret', current_setting('app.cron_secret'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    ) as request_id;
  $$
);
*/

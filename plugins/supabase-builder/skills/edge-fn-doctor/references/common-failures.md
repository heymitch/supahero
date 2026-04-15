# Common Edge Function Failure Modes

The 10 patterns that account for >90% of Supabase edge function failures. Match logs against signatures, apply the specific fix.

---

## 1. CORS preflight missing

**Signature in logs:**
- OPTIONS request returning 4xx
- "CORS" or "preflight" in browser console errors (user-reported)
- Function works via curl but not from a browser

**Root cause:** Browsers send an OPTIONS request before the real POST to check CORS permissions. If your function doesn't handle OPTIONS, the browser aborts and never sends the POST.

**Fix:** Add this at the top of your serve handler:

```typescript
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }
  // ... rest of handler, return responses with corsHeaders spread in
})
```

Tighten `Access-Control-Allow-Origin` to your specific domain in production instead of `*`.

---

## 2. Missing env secret

**Signature in logs:**
- `Deno.env.get("X")` returns undefined, followed by downstream null-deref
- Error messages like "cannot read properties of undefined"
- Function worked locally but fails on deploy

**Root cause:** Secrets defined locally in `.env` are not automatically deployed. Supabase edge functions read env vars from the project's Secrets configuration.

**Fix:**

```bash
# Via CLI
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# Via MCP (from Cowork)
# There's no direct set_secret MCP tool yet — use the dashboard:
# Project → Settings → Edge Functions → Secrets → add each one
```

Verify the function sees the secret by adding a one-time log line:
```typescript
console.log("Has key:", !!Deno.env.get("ANTHROPIC_API_KEY"))
```

---

## 3. HMAC verification failing

**Signature in logs:**
- Custom logs say "invalid_signature" or "signature mismatch"
- Consistent 401 responses to signed requests
- External service's webhook delivery UI shows 401 responses

**Root cause:** One of:
- Secret doesn't match between external service and Supabase env
- HMAC algorithm mismatch (SHA-256 vs SHA-1)
- Body is being parsed before being signed (JSON reserialization breaks byte-match)
- Missing signature header, or reading the wrong header name

**Fix checklist:**
1. Verify the secret is identical on both sides (paste value, compare length if you can't eyeball).
2. Confirm the external service uses SHA-256 (read their docs — most do, but Twilio and a few use SHA-1).
3. Read the raw body for signing BEFORE parsing JSON:
   ```typescript
   const rawBody = await req.text()  // not req.json()
   const valid = await verifyHmac(rawBody, sig, secret)
   const payload = JSON.parse(rawBody)  // only after verify
   ```
4. Log the signature header name: `console.log("Sig:", req.headers.get("x-signature"))`. Compare to docs.

---

## 4. RLS blocking insert/update

**Signature in logs:**
- "new row violates row-level security policy for table X"
- 403 from the DB client, even when service role key is used
- Worked in local dev, fails in prod

**Root cause:** RLS is enabled on the table but no policy allows the operation. Or the function uses the anon key instead of the service role key.

**Fix:**
1. Confirm the function creates its Supabase client with `SUPABASE_SERVICE_ROLE_KEY`, not `SUPABASE_ANON_KEY`. Service role bypasses RLS.
   ```typescript
   const supabase = createClient(
     Deno.env.get("SUPABASE_URL") ?? "",
     Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
   )
   ```
2. If you MUST use anon key (e.g., acting as a specific user), write an explicit policy:
   ```sql
   create policy "Allow inserts from authenticated users"
     on your_table for insert
     with check (auth.uid() is not null);
   ```
3. Verify RLS is actually enabled: `select rowsecurity from pg_tables where tablename = 'your_table';`

---

## 5. Function timeout (>60s execution)

**Signature in logs:**
- "exceeded maximum execution time"
- Requests that hang then return 504 around the 60-second mark
- Function works on small inputs, fails on large ones

**Root cause:** Supabase edge functions have a 60-second execution limit (was 150s in some plans; check current). Your function is doing too much per request.

**Fix:**
1. **Paginate external API calls.** Don't fetch 10,000 records in one call.
2. **Batch inserts.** Upsert in groups of 500, not all at once.
3. **Offload long work.** If the work is genuinely long, write a row to a queue table and have a separate scheduled function drain it. Don't try to do it synchronously.
4. **Remove `await` in loops** where possible. Use `Promise.all` for parallel work.

If the work can't be shortened, an edge function is the wrong tool. Use a queue + worker pattern.

---

## 6. Deno import error

**Signature in logs:**
- "failed to resolve module"
- "cannot find import"
- Deploy appears to succeed but cold starts fail

**Root cause:** Deno imports must be fully-qualified URLs, and version pins matter. Common mistakes:
- `import { foo } from "supabase-js"` → fails (Deno isn't Node)
- `import { foo } from "https://esm.sh/@supabase/supabase-js"` → works but floating version
- Package is ESM-only but imported with older syntax

**Fix:** Use version-pinned imports from `esm.sh` or `deno.land/std`:

```typescript
import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
```

Redeploy. Deno caches modules — first cold start after deploy will pull them fresh.

---

## 7. Invalid JWT / expired token

**Signature in logs:**
- "JWT expired"
- "invalid token"
- Works for a while, then fails

**Root cause:** If your function authenticates callers with a user JWT (not a service role), JWTs expire (usually 1 hour). Callers must refresh.

**Fix:**
- **If caller is a web app:** use Supabase's auto-refresh in the client SDK. Set `autoRefreshToken: true`.
- **If caller is a server process:** either use the service role key (no expiry) or implement token refresh logic.
- **If this is an external service (webhook):** don't use Supabase JWT at all — use HMAC signature verification (see pattern #3).

---

## 8. External API rate limit

**Signature in logs:**
- 429 status codes from the upstream API
- "rate limit" or "too many requests" in error bodies
- Bursts of failures followed by recoveries

**Root cause:** The API you're calling limits requests per minute/second, and your function is firing faster than the limit.

**Fix:** Implement retry with backoff on 429 (see `template-cron-fetcher.ts` for the pattern):

```typescript
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, init)
    if (res.status !== 429) return res
    const retryAfter = Number(res.headers.get("retry-after") ?? 2 ** attempt)
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
  }
  throw new Error("Exceeded max retries")
}
```

For sustained high-volume workloads, you need a queue + rate-limited worker, not a retry loop.

---

## 9. Deploy / bundle failure

**Signature in logs:**
- No recent invocations despite visible deploy activity
- "module not found" on cold start
- Deploy command returned success but function doesn't respond

**Root cause:**
- Syntax error only caught at runtime (Deno doesn't type-check by default)
- Import from a non-public URL
- File > 10MB (edge function size limit)

**Fix:**
1. **Test locally first:** `supabase functions serve <name>` and hit it with curl. Syntax errors show immediately.
2. **Type-check before deploy:** `deno check index.ts`
3. **Check size:** `du -sh supabase/functions/<name>/`
4. **Re-deploy with verbose logging:** `supabase functions deploy <name> --debug`

---

## 10. 404 on function URL

**Signature in logs:**
- Requests arrive at the Supabase domain but hit "function not found"
- URL looks correct but returns 404

**Root cause:** One of:
- Function name mismatch (URL says `my-fn` but deployed as `myFn`)
- Function was deleted but URL is cached in caller
- Hitting the wrong project's URL
- Function deployed to a branch, not production

**Fix:**
1. List deployed functions to confirm the name:
   ```
   list_edge_functions(project_id=<ref>)
   ```
2. Verify the URL template: `https://<project-ref>.supabase.co/functions/v1/<function-name>` — exact match matters.
3. If using branches, confirm you're hitting the right branch URL.
4. Check the caller isn't caching an old URL (curl it directly to rule out caching).

---

## When none of these match

Be honest. Say: "This doesn't match any known pattern. Want to dig into the logs manually?"

Fabricating a pattern is worse than admitting the limits. Common next steps:
- Look for the specific error message in Supabase's GitHub issues
- Add verbose `console.log` to narrow down where execution stops
- Temporarily return diagnostic info in the response (strip before prod)

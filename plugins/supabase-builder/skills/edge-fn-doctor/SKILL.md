---
name: edge-fn-doctor
description: Diagnose a failing Supabase edge function. Pulls recent logs via the Supabase MCP, pattern-matches against 10 common failure modes, and proposes a specific fix. Triggered by "edge function is broken", "edge function not working", "diagnose my edge function", "why is my edge function failing", "debug edge function", "edge function error".
user-invocable: true
---

# Edge Function Doctor

Supabase edge function failures come from a short list of causes. This skill reads your logs, matches the symptom to one of ten known patterns, and tells you exactly what to fix.

## Preflight

1. Check `.coworker/supabase-config.json` for `project_ref`.
2. Verify Supabase MCP is connected (list_edge_functions works).

If either fails, say: "I need the Supabase MCP connected and a project ref saved. Run `/supabase-setup` or paste your project ref."

## Step 1: Identify the Function

If the user named a function, use it. Otherwise:

```
list_edge_functions(project_id=<ref>)
```

Show the list and ask which one's broken.

## Step 2: Pull Recent Logs

```
get_logs(project_id=<ref>, service="edge-function")
```

Filter logs for the specific function name. Grab the last 50 entries (or the last 10 minutes, whichever is more).

If logs are empty:
- The function may never have been called. Say: "No log entries yet. Has this function been invoked since deploy? Try sending a test request first."

## Step 3: Pattern Match

Read `references/common-failures.md` — it contains the 10 patterns with symptom → cause → fix.

For each failure mode, check the log output for the pattern signature:

| # | Pattern | Signature in logs |
|---|---|---|
| 1 | CORS preflight missing | "CORS", "preflight", OPTIONS request with 4xx |
| 2 | Missing env secret | `Deno.env.get` returning undefined, "secret not set" |
| 3 | HMAC verification fail | "signature mismatch", "invalid signature", 401 on signed requests |
| 4 | RLS blocking insert | "new row violates row-level security policy", 403 |
| 5 | Function timeout | "exceeded maximum execution time", timeouts around 60s |
| 6 | Deno import error | "failed to resolve module", "cannot find import" |
| 7 | Invalid JWT | "JWT expired", "invalid token" |
| 8 | External API rate limit | 429 status codes from calling APIs |
| 9 | Deploy / bundle failure | no recent logs despite deploy, or "module not found" on cold start |
| 10 | 404 on function URL | requests hitting the domain but returning "function not found" |

Match the most recent failure in logs to the most likely pattern. If multiple match, list them in order of likelihood.

## Step 4: Diagnose

Present the diagnosis in this format:

```
⚠️ Diagnosis: <pattern name>

Symptom:      <what I saw in logs>
Root cause:   <why it happens>
Fix:          <specific, step-by-step>

Confidence:   High / Medium / Low
```

For medium or low confidence, show top 2-3 candidate patterns and ask the user which symptom matches their experience.

## Step 5: Propose the Fix

For each failure mode, the fix has a specific form:

- **Code change:** show the diff against the current function. Offer to redeploy after approval.
- **Config change:** specific env var or secret to set. Provide the exact MCP call or dashboard click path.
- **SQL change:** show the migration needed (e.g., RLS policy adjustment). Ask before `apply_migration`.
- **External change:** Something on another service (Stripe webhook URL, form webhook, etc.). Explain where and what.

Never apply a fix silently. Always show what's changing and ask.

## Step 6: Verify After Fix

After applying:

1. Ask the user to trigger the function again (or do it via MCP if the function is callable directly).
2. Pull logs again via `get_logs`.
3. Report: fixed, partially fixed (new error), or still broken.

If still broken after one fix attempt, re-run Step 3 with the updated logs. Patterns often stack (fix #1 reveals #2).

## Step 7: Log the Session

Append to `.coworker/logs/supabase-activity.md`:

```
### YYYY-MM-DD
- Debugged: <function-name>
- Pattern: <pattern name>
- Fix applied: <short description>
- Status: resolved | pending | unresolved
```

## Rules

- **Always pull fresh logs first.** Stale logs send you chasing yesterday's bug.
- **Match the MOST RECENT failure**, not the first one. Older errors may already be fixed.
- **Pattern match before guessing.** The 10 patterns cover >90% of real failures. Guessing invents problems.
- **Show the log snippet that triggered the match.** The user sees the evidence, not just the conclusion.
- **Low confidence?** Ask. Don't fabricate certainty.
- **Never modify code without approval**, even for "obvious" fixes.
- **If it's not one of the 10 patterns**, say so. "This doesn't match any known pattern — want me to dig into the logs manually?" is honest. Fabricating a pattern is harmful.

## When to Escalate Out

Some failures aren't patterns — they're architecture problems:
- Function consistently timing out on legitimate work → probably should be a queued job, not an edge function. Flag to user.
- RLS policy is genuinely wrong for the business logic → not a fix, it's a design question. Surface it.
- External API is just down → not the user's bug. Say so, don't fix-shop.

Honesty about the limits of the tool beats invented fixes.

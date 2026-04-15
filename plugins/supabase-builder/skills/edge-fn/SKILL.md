---
name: edge-fn
description: Build and deploy a Supabase edge function from a five-field spec. Picks the right production template (webhook, cron fetcher, AI wrapper, embedding generator, notification dispatcher), customizes it to the spec, and deploys via the Supabase MCP. Returns a live function URL and a test command. Triggered by "build an edge function", "deploy an edge function", "ship a supabase function", "new edge function", "I need an edge function that", "spec an edge function".
user-invocable: true
---

# Edge Function Builder

Spec it, ship it. The whole point of this skill is to teach you to think in the five-field spec — once you do, every future edge function takes three minutes to ship.

## Preflight

1. Check `.coworker/supabase-config.json` for `project_ref`.
   - If missing, say: "Before I can deploy, I need your Supabase project ref. Run `/supabase-setup` first, or paste your project ref (e.g., `abc123def456`) and I'll save it."
2. Verify the Supabase MCP connector is connected by listing functions:
   - Call `list_edge_functions(project_id=<ref>)`.
   - If it errors with auth, say: "The Supabase MCP connector isn't connected. Customize → Connectors → Supabase → Connect. Then rerun."

## Step 1: Collect the Spec

Ask for each field one at a time. Offer a template shortcut early — most functions fit a known pattern.

> "What's this function for? You can pick a template to start from, or describe something custom:
>
> 1. **Webhook receiver** — external service POSTs here, you save to a table
> 2. **Scheduled fetcher** — pg_cron calls this, it pulls from an API, saves results
> 3. **AI wrapper** — takes a prompt, calls an LLM, returns response
> 4. **Embedding generator** — takes text, generates a vector, stores it
> 5. **Notification dispatcher** — triggered on a DB event, sends to Slack/email/SMS
> 6. **Custom** — you describe what it does"

If they pick 1-5, load the matching template from `references/template-<name>.ts`. Then ask only the fields that vary for that template (the rest are set by defaults).

If custom, walk through the full 5-field spec:

```
PURPOSE:      [one sentence]
INPUT:        [POST body shape, query params, headers]
OUTPUT:       [success response, status codes]
SIDE EFFECTS: [writes to table X, calls API Y, notifies Z]
SECRETS:      [names only — I'll never ask for values, you set them via MCP or dashboard]
AUTH:         [bearer / HMAC / public — and what identity you check]
ERRORS:       [bad input, missing secret, API failure — what to return for each]
```

**One question at a time.** No form-dumping.

## Step 2: Clarify the Table (if applicable)

If the function writes to a Postgres table, check if it exists:

```
list_tables(project_id=<ref>)
```

- **Exists:** confirm shape matches what the function will write. Use `get_table_schema` or `execute_sql` to fetch columns.
- **Doesn't exist:** propose a migration. Show the SQL and ask for approval before running `apply_migration`.

Default table shape for a webhook receiver:

```sql
create table <name> (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz default now(),
  source text not null,
  payload jsonb not null,
  processed boolean default false
);
```

Use this shape unless the user specifies otherwise. Keep it simple — they can add columns later.

## Step 3: Generate the Code

1. Start from the matching template in `references/template-<name>.ts`.
2. Substitute the spec values:
   - Table name, column names
   - Secret names (as `Deno.env.get('SECRET_NAME')`)
   - Auth check (HMAC header name, bearer token format)
   - External URL if calling an API
3. If custom, assemble from scratch using the same pattern as the templates.

**Show the full code for approval before deploying.** No silent deploys.

## Step 4: Set Secrets (if needed)

If the function references secrets the user hasn't set, list them and say:

> "This function needs these secrets set: `STRIPE_KEY`, `HMAC_SECRET`. I can set them if you paste the values (I won't log them), or you can set them yourself via `supabase secrets set KEY=value` or the dashboard Secrets tab."

Never write secret values to logs, files, or the activity record.

## Step 5: Deploy

Call the MCP:

```
deploy_edge_function(
  project_id=<ref>,
  name=<function-name>,
  files=[{ name: "index.ts", content: <generated code> }]
)
```

Catch failures:
- **Deploy syntax/bundle error:** show the error, offer to fix. Route to `/edge-fn-doctor` if complex.
- **Name collision:** ask if they want to replace or rename.

## Step 6: Return the Deliverables

Show:

```
✓ Deployed: <function-name>
URL: https://<ref>.supabase.co/functions/v1/<function-name>

Test it:
curl -X POST 'https://<ref>.supabase.co/functions/v1/<function-name>' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <anon-key>' \
  -d '<sample-payload>'

Secrets needed: <list>
External setup: <e.g., "Paste the URL into your Typeform webhook field">

If it fails, run /edge-fn-doctor <function-name>.
```

## Step 7: Log the Build

Append to `.coworker/logs/supabase-activity.md`:

```
### YYYY-MM-DD
- Deployed: <function-name> (template: <which>)
- Purpose: <one line>
- Table(s): <any>
- Status: deployed
```

## Rules

- **NEVER deploy without approval.** Show the code first, every time.
- **NEVER log secret values.** Secret names are fine; values are not.
- **Prefer templates over bespoke.** 90% of edge functions fit one of the 5 patterns. If the user is inventing something novel, ask "is this really different from a webhook receiver?" twice.
- **Enforce HMAC on public-facing functions by default.** Public functions with no auth are a liability.
- **Use UPSERT for webhook receivers** on a stable key, not INSERT. Replayed webhooks should be idempotent.
- **Always include CORS preflight** for functions called from browsers. Pattern is in every template.
- **Include logging** for inputs, errors, and key decision points. Makes `/edge-fn-doctor` work.
- **Return typed errors.** Status codes + JSON `{ error, reason }`, never raw stack traces.
- **Keep functions under 60s execution time.** Anything longer should be a queued job, not an edge function.
- **Flag scope creep.** If the spec grows beyond "one clear purpose," suggest splitting into two functions.

## The 5-Field Spec as a Teaching Tool

If this is the user's first function, at the end say:

> "Remember the pattern:
> PURPOSE / INPUT / OUTPUT / SIDE EFFECTS / SECRETS / AUTH / ERRORS.
> Every future function you build fills these same fields. That's the whole skill."

The pattern is more valuable than any individual function they'll deploy.

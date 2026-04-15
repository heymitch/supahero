# Supahero

Supabase superpowers for Claude Cowork. A plugin marketplace for builders who want real infrastructure without the DevOps ceremony.

## Install the marketplace

```
/plugin marketplace add heymitch/supahero
```

Then install plugins individually from the Cowork UI, or the full marketplace at once.

## What's in the marketplace

### `supabase-builder` v1.0.0

Production-ready Supabase edge function templates + intelligent diagnostics.

**Skills:**
- **`/edge-fn`** — Spec an edge function in five fields, pick a template (webhook receiver, scheduled fetcher, AI wrapper, embedding generator, notification dispatcher), deploy via Supabase MCP. Returns a live URL and test command.
- **`/edge-fn-doctor`** — Diagnose a failing edge function. Pulls logs via MCP, pattern-matches against 10 common failure modes, proposes specific fixes.

**Templates included** (in `plugins/supabase-builder/skills/edge-fn/references/`):
- `template-webhook.ts` — HMAC-verified webhook receiver with upsert idempotency
- `template-cron-fetcher.ts` — pg_cron-triggered external API fetcher with retry/backoff
- `template-ai-wrapper.ts` — Anthropic/OpenAI wrapper with optional observability logging
- `template-embedding.ts` — pgvector-backed embedding generator (text or row-based)
- `template-notification.ts` — Slack/SMS/email dispatcher with retry + delivery logging

**Requires:** Supabase MCP connector connected in Cowork. Plugin verifies on first use.

## Repo structure

```
supahero/
├── .claude-plugin/marketplace.json       # marketplace manifest
├── plugins/
│   └── supabase-builder/
│       ├── .claude-plugin/plugin.json
│       ├── skills/
│       │   ├── edge-fn/
│       │   │   ├── SKILL.md
│       │   │   └── references/            # 5 production templates
│       │   └── edge-fn-doctor/
│       │       ├── SKILL.md
│       │       └── references/            # 10 failure patterns
│       ├── build.sh
│       ├── LICENSE.md
│       └── dist/supabase-builder.zip
└── README.md
```

## For bootcamp VIP members

This marketplace is paired with the 60-minute VIP walkthrough: "Build Real Infrastructure with Cowork + Supabase." Install the marketplace, run `/edge-fn`, and ship your first production edge function in under 20 minutes.

## The five-field spec (memorize this)

Every edge function you'll ever build fills these same fields:

```
PURPOSE:      One sentence
INPUT:        POST body / query params
OUTPUT:       Response shape
SIDE EFFECTS: Tables written, APIs called, notifications sent
SECRETS:      Names only (never values in chat)
AUTH:         Bearer / HMAC / public
ERRORS:       What to return on bad input, missing secret, API failure
```

The skill is the spec, not the code. Code is generated. Specs are learned.

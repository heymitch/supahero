// TEMPLATE: Notification Dispatcher
// Triggered by a DB event (via pg_net from a trigger) or direct call.
// Routes to Slack, Gmail, or SMS based on the `channel` field.
// Retries failed sends once. Logs delivery status to a table.
//
// REPLACE:
//   LOG_TABLE             — table to track delivery attempts (e.g. notification_log)
//
// SECRETS (set only the ones you use):
//   SLACK_BOT_TOKEN       — xoxb-... for Slack
//   SLACK_DEFAULT_CHANNEL — e.g. "C012345"
//   GMAIL_* or similar    — Gmail connector is usually easier; this template leaves that stub
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER — for SMS
//
// EXAMPLE INPUT:
//   { "channel": "slack", "to": "#alerts", "text": "Webhook failed for order 123" }
//   { "channel": "sms",   "to": "+15551234567", "text": "Your order shipped" }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

interface NotificationInput {
  channel: "slack" | "sms" | "email"
  to: string          // #channel or user id for Slack, phone for SMS, email for email
  text: string
  title?: string      // used as subject for email, header block for Slack
  metadata?: Record<string, unknown>
}

async function sendSlack(to: string, text: string, title?: string) {
  const token = Deno.env.get("SLACK_BOT_TOKEN")
  if (!token) throw new Error("SLACK_BOT_TOKEN not set")

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel: to,
      text: title ? `*${title}*\n${text}` : text,
    }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`Slack error: ${data.error}`)
  return data.ts
}

async function sendSms(to: string, text: string) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")
  const token = Deno.env.get("TWILIO_AUTH_TOKEN")
  const from = Deno.env.get("TWILIO_FROM_NUMBER")
  if (!sid || !token || !from) throw new Error("Twilio env vars missing")

  const creds = btoa(`${sid}:${token}`)
  const body = new URLSearchParams({ To: to, From: from, Body: text })

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  )
  const data = await res.json()
  if (data.error_code) throw new Error(`Twilio error ${data.error_code}: ${data.message}`)
  return data.sid
}

async function sendEmail(_to: string, _text: string, _title?: string) {
  // Gmail connector is usually the cleanest path — call it from the Cowork side.
  // If you need this to run from the edge function directly, wire up a Resend / Postmark
  // API key and replace this stub. Left minimal to avoid baking in a vendor.
  throw new Error("Email sending not implemented in this template — use Gmail connector from Cowork, or replace this stub with Resend/Postmark")
}

async function attempt(input: NotificationInput): Promise<string> {
  switch (input.channel) {
    case "slack":
      return await sendSlack(input.to, input.text, input.title)
    case "sms":
      return await sendSms(input.to, input.text)
    case "email":
      return await sendEmail(input.to, input.text, input.title)
    default:
      throw new Error(`unknown_channel: ${input.channel}`)
  }
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  let input: NotificationInput
  try {
    input = await req.json()
  } catch (_e) {
    return json({ error: "invalid_json" }, 400)
  }

  if (!input.channel || !input.to || !input.text) {
    return json(
      { error: "missing_field", required: ["channel", "to", "text"] },
      400,
    )
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  )

  let ref = ""
  let status = "failed"
  let errorMsg: string | null = null

  try {
    ref = await attempt(input)
    status = "delivered"
  } catch (e) {
    errorMsg = String(e)
    console.warn("First send failed, retrying:", errorMsg)
    // Retry once after a short delay
    await new Promise((r) => setTimeout(r, 1000))
    try {
      ref = await attempt(input)
      status = "delivered_on_retry"
      errorMsg = null
    } catch (e2) {
      errorMsg = String(e2)
      console.error("Retry also failed:", errorMsg)
    }
  }

  // Log delivery attempt
  const logTable = "LOG_TABLE"
  if (logTable && logTable !== "LOG_TABLE") {
    await supabase.from(logTable).insert({
      channel: input.channel,
      to_address: input.to,
      text: input.text,
      title: input.title ?? null,
      metadata: input.metadata ?? null,
      status,
      provider_ref: ref || null,
      error: errorMsg,
    })
  }

  if (status === "failed") {
    return json({ ok: false, error: errorMsg }, 502)
  }

  return json({ ok: true, status, ref })
})

/*
Wire a DB trigger to call this on row insert:

create or replace function notify_on_insert()
returns trigger as $$
begin
  perform net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/<function-name>',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := jsonb_build_object(
      'channel', 'slack',
      'to', '#alerts',
      'text', 'New row in SOURCE_TABLE: ' || new.id
    )
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger SOURCE_TABLE_notify
after insert on SOURCE_TABLE
for each row execute function notify_on_insert();
*/

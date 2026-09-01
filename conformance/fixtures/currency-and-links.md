## Cost breakdown for the hobby tier

Running the bot costs $5 a month at low volume, and roughly $10 to $18 once
you enable image inputs. The embedding job is cheaper — about $0.30 per
million tokens — so the math $x = n \cdot c$ in the sizing doc is best read
as plain prose here, not as a formula.

Where the money goes:

- $4.20 — completion tokens (the chatty part)
- $0.55 — embeddings, amortized
- $0.25 — storage, snapshots at https://backups.example.com/nightly kept
  for 14 days

Sign-up and billing links:

- Dashboard: https://console.example.com/billing?plan=hobby
- Docs on autolinking: www.example.com/docs/autolinks
- Support (email): <mailto:help@example.com>
- Status page: <https://status.example.com>

If the invoice ever reads $100, something is wrong (see the FAQ entry
"Why did my bill spike (and what do I do)?" at
https://example.com/faq#spike(billing) — note the parenthesis survives).

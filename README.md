# WhatsApp link-token harness

A local rig for testing the pre-auth flow: a WhatsApp CTA carries a token, the token
mints a **scoped session**, and the session — not the token — is what actually does work.

```bash
npm install
npm start      # http://localhost:3000
```

Sign in as `ops@test.local` / `ops1234`.

## Three seller logins, isolated

| Login | Password | Sees |
|---|---|---|
| `ramesh@test.local` | `test1234` | only L-1001, L-1002, bid B-2001, KYC K-s1 |
| `sunita@test.local` | `test1234` | only L-1003, bid B-2002, KYC K-s2 |
| `iqbal@test.local` | `test1234` | only L-1004, bid B-2003, KYC K-s3 |
| `ops@test.local` | `ops1234` | everything, plus the clock and reset |

Isolation is enforced server-side, not in the browser: a seller's bearer token gets
`not_your_resource` / `not_your_profile` / `not_your_token` on anyone else's data, and
`ops_only` on the clock and reset. Hand-made requests don't get further than the UI does.

## Permanent campaign links

Each seller has one token that **never expires** and opens their whole portal rather
than a single task. They're on the console's first panel, ready to copy.

They are *derived*, not random — `HMAC(CAMPAIGN_SECRET, "campaign:v1:<seller_id>")` — so
the identical URL comes back after a restart, a redeploy, or a wiped database. That
matters because Render's free disk is erased on every restart, which would otherwise
kill a campaign mid-flight. See [src/campaign.js](src/campaign.js).

Set `CAMPAIGN_SECRET` once before a campaign goes out. Changing it later invalidates
every link already sent.

A campaign session can reach everything that seller owns and nothing else, and KYC still
demands a fresh OTP. Task links stay narrower — pinned to their one resource.

## The two credentials, deliberately separate

| | Bearer JWT | Link token → session cookie |
|---|---|---|
| Who holds it | ops / test users | the seller |
| How you get it | `POST /api/auth/login` | tapping the WhatsApp button |
| Lifetime | 12h | ceiling (token) + 15 min idle (session) |
| Scope | whole API | one intent, one resource |

The bearer token is real: `curl -s localhost:3000/api/state -H "Authorization: Bearer $T"`.
The console has **copy bearer** / **copy curl** buttons in the header.

## What the harness enforces

- **128-bit token from `crypto.randomBytes`**, base64url, 22 chars. Only its SHA-256 is
  stored — the raw value exists once, on its way into the message.
- **Absolute ceiling, written at issue, never extended.** Redeeming does *not* push it out.
- **Unlimited reuse inside the ceiling** — double-taps, reloads and link scanners cost nothing.
- **Use counter as a tripwire, not a turnstile.** Past 10 uses the row is flagged; it still works.
- **Sliding idle session (15 min)** with an 8h hard cap above it. Only non-GET requests
  slide the window, so polling can't keep a session alive forever.
- **Kill switch:** issuing a link for the same seller/intent/resource supersedes the older one.
- **Revoke on state change:** publish a listing, settle a bid, submit KYC → live tokens die.
- **Step-up:** KYC needs a fresh OTP (5 min) regardless of how the seller arrived.
- **Dead-link page** with exactly one button — *Send me a new link* — wired to a real reissue.

### Intent ceilings

| Intent | Ceiling | Reuse | Step-up |
|---|---|---|---|
| Resume a listing draft | 7 days | unlimited until ceiling | — |
| Confirm a pickup slot | the slot time | unlimited until ceiling | — |
| Accept / reject a bid | 3 hours | unlimited until ceiling | — |
| KYC / bank details | 15 min | **single use** | OTP |

Edit these in [src/intents.js](src/intents.js).

## Template URL constraint

Meta only allows the variable at the **end** of a template URL, so the route is
`/s/{{1}}` and nothing follows it — no path segments after the token, no fragment.
See [src/whatsapp.js](src/whatsapp.js).

## Sending through Gupshup for real

`cp .env.example .env`, fill in your Enterprise userid/password, set the mode, restart.
The header badge shows the active mode and turns red listing anything missing.

| Mode | What it does | Needs |
|---|---|---|
| `simulate` | console only, no network call | nothing |
| `enterprise_text` | `msg_type=TEXT` free-form with the link inline | the recipient messaged you in the last 24h |
| `enterprise_template` | `msg_type=HSM` | an approved template **and** a permanent origin |

Start with `enterprise_text`. It needs no template and no Meta approval, so a tunnel
URL is fine — enough to answer "does the link actually arrive and open".

**Set a real phone number first.** Each test user has an editable number in the console
(seed values are fake). It must be a number that has opted in to your WhatsApp business
account, or Gupshup accepts the call and never delivers.

Two traps this code handles, both of which look like success if you don't check:

- Enterprise answers **HTTP 200 with `status:"error"` in the body**. Verdict comes from
  parsing the body, never the status code — see `interpretEnterprise` in [src/gupshup.js](src/gupshup.js).
- Every message row stores the raw request (password redacted) and raw response, shown
  under the bubble in the console. When delivery silently fails, that payload is the
  only evidence you have.

If you get error 106 `method not supported` with valid credentials, try
`GUPSHUP_HTTP_METHOD=GET`, then `GUPSHUP_EXTRA_PARAMS` for any params your account
demands. Enterprise accounts differ, and neither needs a code change.

### Why templates force a permanent origin

A dynamic URL button's base is frozen when Meta approves the template; only the `{{1}}`
suffix varies, and it must sit at the very end of the URL. Approve against a tunnel
hostname and the template dies with the tunnel. That's the only reason to deploy — see
`wrangler.toml` and `schema.sql`, which are written but not wired up.

## Testing without waiting

Every time read goes through `now()` in [src/clock.js](src/clock.js). The console header
has `+1m / +16m / +3h / +8d` buttons that shift the whole world forward, so you can watch a
7-day ceiling lapse in a second. `reset clock` puts it back.

To play the **forwarded link** case: copy a message's button URL and open it in a private
window. Inside the ceiling it works (correct — that's a different device, not a different
person, as far as the system can tell). After the ceiling it's dead, which is the property
the design is actually buying.

## Layout

```
server.js              express wiring
src/clock.js           virtual clock
src/db.js              JSON store + seed data
src/intents.js         ceilings, renewability, step-up, thresholds
src/tokens.js          issue / redeem / revoke / kill switch
src/auth.js            bearer JWT + scoped sliding session
src/whatsapp.js        simulated template send
src/routes/api.js      ops console API (bearer)
src/routes/link.js     /s/:token, resend, dead-link context
src/routes/seller.js   scoped seller actions (session cookie)
public/                console, landing page, dead-link page
```

## API quick reference

```
POST /api/auth/login          {email,password} -> {token,user}
GET  /api/state               bearer; whole world incl. token ledger (hashes never returned)
POST /api/links               bearer; {intent,resource_id} -> issues + "sends"
POST /api/tokens/:id/revoke   bearer
POST /api/dev/clock           bearer; {advance_ms} | {reset:true}
POST /api/dev/reset           bearer; reseed

GET  /s/:token                redeem -> 302 /land.html or /expired.html
GET  /api/link/context?t=     dead-link page copy
POST /api/link/resend         {t} -> new token for the same task

GET  /api/session             session cookie; scope + time left (does not slide)
POST /api/seller/listings/:id/draft|publish|pickup
POST /api/seller/bids/:id/accept|reject
POST /api/seller/kyc/:id/otp|verify|submit
```

## Not production

Plaintext passwords, a JSON file for storage, OTP codes returned in the response body,
`secure: false` cookies, and a clock anyone with a bearer token can move. All of that is
deliberate — it's a harness for feeling the flow, not a service.

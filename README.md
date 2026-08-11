# WhatsApp link-token harness

A local rig for testing the pre-auth flow: a WhatsApp CTA carries a token, the token
mints a **scoped session**, and the session — not the token — is what actually does work.

```bash
npm install
npm start      # http://localhost:3000
```

Sign in as `ops@test.local` / `ops1234`. New buyers come in at
[`/join`](#the-onboarding-funnel), which needs no login at all.

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

## The onboarding funnel

A second way in, for people who are not seeded test users and have never messaged
you: **`/join`**, a public page with no token and no session. Four screens —
name and number, OTP, business name and documents, done.

The last screen has **no login button**. There is nothing to sign in to yet, and
the next thing that happens is a message from us:

> Your part is done. We'll get back to you as soon as your account is approved.
> You can close WhatsApp now.

**The number is captured when the OTP checks out, not at the end.** Someone who
verifies and then abandons the documents screen is still a lead, and dropping
them would waste the only expensive part of the funnel. The set is deduplicated
by number — `+91 98123 45670`, `9812345670` and `919812345670` are one row.

The OTP is a fixed mock (`987654`, override with `SIGNUP_OTP`). A real one needs
an approved authentication template *and* a number already opted in, which would
dead-end every demo at the second screen.

### A signup is a user

Each one gets a real user row and the same derived permanent tokens as `s1`–`s3`,
so the whole existing machine — `/s/{{1}}`, `/lots/{{1}}`, the provider adapters,
the scoped sessions, the token ledger — works on them with no special case. They
are kept out of the *Test users* and *Campaign links* panels and given their own
**Signups** panel, because those two lists would otherwise grow without limit.

### Three broadcasts, fired by hand

The Signups panel has checkboxes and three buttons. Each sends one message per
recipient, sequentially, through whichever provider and mode is set above — so
every recipient gets their own ledger row with its own raw request and response.
A provider will happily accept nine and drop one, and per-recipient evidence is
the only way to see it.

| Button | Intent / base | Template | What it does |
|---|---|---|---|
| Approve & notify | `seller_portal` → `/s/{{1}}` | `omp_test_buyer_newlyonboard` | flips the signup to **approved**, but only after the send succeeds |
| Send lots | `lot_select` → `/lots/{{1}}` | `omp_test_buyer_check_lots` | the existing lot deck |
| Send price nudge | `seller_portal` → `/s/{{1}}` | `omp_test_token_buyer1` | the daily nudge |

Approval and the nudge share one base and one intent, because both open the price
screen — only the words differ, and the copy lives in
[src/broadcasts.js](src/broadcasts.js) rather than in the console.

The nudge needs **nothing new approved**: the rate-confirmation template already
in use reads as a daily nudge almost word for word — *"your recent {{mat}} buying
rate was Rs {{price}} per kg, confirm rate change if any"* — and `{{rate}}` now
falls back to the buyer's last posted price, which a signup has and a listing
doesn't. Names are editable per broadcast in the panel.

The approval template declares three named variables and one frozen base:

```
omp_test_buyer_newlyonboard        UTILITY
  Hi {{1}}, Your onboarding with Recykal.Market is complete -
  {{2}} is your customer ID.
  button "Start Buying" -> https://whatsapp-link-harness.onrender.com/s/{{1}}
  names: name -> body {{1}} · custID -> body {{2}} · 1 -> the button
```

`custID` is why a signup carries a `cust_id` (`RM10001`, `RM10002`, …) alongside
its internal `sg1`: the message shows it to the buyer as their customer ID, and
`sg1` does not read like one. It's on each row in the Signups panel.

Note the button base — a template's URL is frozen at approval, so this one only
works from `whatsapp-link-harness.onrender.com`. Sending it from a tunnel or from
localhost still delivers, but the button lands on the deployed origin.

### First run in the portal

A buyer who arrived this way has `material: null`, so the portal opens on a
material picker instead of the price screen — asking *"at what price will you buy
___"* needs something in the blank. Only **PET Bottle Scrap Baled - Clear** is
selectable; the rest of the catalogue is shown greyed as *coming soon*, because
the catalogue is the point. Everything else (location, payment days, need-by, min
rating) is defaulted and editable inline on the price screen, so the first run is
one tap plus a price.

The greyed cards are a courtesy, not the control: `POST /api/seller/profile`
validates against [src/materials.js](src/materials.js), so a hand-made request
cannot set a material we don't trade.

### The whole loop

```
/join  → number captured → docs → "we'll get back to you"
       → ops: Approve & notify  → WhatsApp → /s/<token> → pick PET Clear → post price
       → ops: Send lots         → WhatsApp → /lots/<token> → approve lots → order
       → ops: Send price nudge  → WhatsApp → /s/<token> → confirm or change the price
```

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

## Three providers, chosen per send

Gupshup, WATI and MSG91 are all wired. You pick **provider**, **mode** and **template**
in the console's Send settings panel at the moment you send, so you can fire the same
link at each in turn and compare the raw responses side by side.

| Mode | What goes out | Needs |
|---|---|---|
| `text` | the whole URL, inline | the customer messaged you in the last 24h |
| `template` | only the 22-char token, into the frozen URL base | an approved template |

Adapters live in [src/providers/](src/providers/) behind one interface —
`sendText` and `sendTemplate`, both returning `{ok, status, response, request}`. Adding a
fourth provider is one file plus its env vars, no changes anywhere else.

Every send stores the raw request (secrets redacted) and raw response, shown under the
bubble in the console. Providers routinely accept a message and then never deliver it, so
that payload is the only real evidence.

### WATI

Shapes taken from the official collection, [ClareAI/wati-postman-collection](https://github.com/ClareAI/wati-postman-collection):

```
POST {base}/api/v1/sendTemplateMessage?whatsappNumber=91…      Bearer token
     { template_name, broadcast_name, parameters: [{name, value}] }

POST {base}/api/v1/sendSessionMessage/91…                      multipart: messageText
```

Two things that will bite you:

- **Parameters are matched by name, not position.** The names are whatever you called
  them in the template builder. A dynamic URL button's variable is just another named
  parameter — mark it `"button": true` in the console so MSG91 and Gupshup, which are
  positional, know which one it is.
- **`sendSessionMessage` takes multipart form-data**, not JSON and not a query string.
  Set `WATI_SESSION_VIA_QUERY=1` if your tenant expects `?messageText=` instead.

`WATI_BASE_URL` is per-tenant — copy it from WATI's own API docs page. The published
environment file says `app-server.wati.io`, but live tenants are usually
`live-mt-server.wati.io/<tenantId>` or `live-server-<id>.wati.io`. Guessing gives a 404.

The console has a **pull WATI templates** button (ops only) that lists your templates and
the variable names each declares — worth using before the first template send, since a
wrong name is the usual reason one fails.

**WATI has no URL-button interactive message.** Its `sendInteractiveButtonsMessage` only
does quick replies (`buttons: [{text}]`). So inside the 24h window the link has to travel
as plain text; a tappable URL button needs an approved template.

### The part that differs between them

How the dynamic URL button's suffix is passed alongside body variables:

- **MSG91** follows Meta's component model: `button_1: {subtype:'url', type:'text', value}`.
- **WATI** uses *named* parameters, so the button's variable name is whatever you called
  it when you built the template — set `WATI_BUTTON_PARAM` to match.
- **Gupshup Enterprise** has no params array at all; HSM takes the fully rendered text.

Verified live that all three adapters reach their real endpoints and return clean `401`s
with invalid keys. The component shapes themselves are only provable with real keys.

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
src/signup.js          the captured set: capture, dedupe, documents, approval
src/materials.js       what we trade, and a new buyer's defaults
src/broadcasts.js      the three onboarding messages and their copy
src/routes/api.js      ops console API (bearer)
src/routes/link.js     /s/:token, resend, dead-link context
src/routes/seller.js   scoped seller actions (session cookie)
src/routes/signup.js   /join's API - public, unauthenticated
public/                console, onboarding, portal, lot deck, dead-link page
```

## API quick reference

```
POST /api/auth/login          {email,password} -> {token,user}
GET  /api/state               bearer; whole world incl. token ledger (hashes never returned)
POST /api/links               bearer; {intent,resource_id} -> issues + "sends"
POST /api/tokens/:id/revoke   bearer
POST /api/dev/clock           bearer; {advance_ms} | {reset:true}
POST /api/dev/reset           bearer; reseed

POST /api/campaign/broadcast  bearer, ops; {broadcast,seller_ids[]} -> one send each

POST /api/signup/otp          public; {phone} -> mock code
POST /api/signup/verify       public; {phone,code,name} -> captures the number
POST /api/signup/documents    public; {id,ticket,company,docs} -> KYC submitted
GET  /api/signup/status       public; ?phone= -> has this handset been through?

GET  /s/:token                redeem -> 302 /land.html or /expired.html
GET  /api/link/context?t=     dead-link page copy
POST /api/link/resend         {t} -> new token for the same task

GET  /api/session             session cookie; scope + time left (does not slide)
POST /api/seller/profile      session; {material} -> first-run material
POST /api/seller/listings/:id/draft|publish|pickup
POST /api/seller/bids/:id/accept|reject
POST /api/seller/kyc/:id/otp|verify|submit
```

## Not production

Plaintext passwords, a JSON file for storage, OTP codes returned in the response body,
`secure: false` cookies, and a clock anyone with a bearer token can move. All of that is
deliberate — it's a harness for feeling the flow, not a service.

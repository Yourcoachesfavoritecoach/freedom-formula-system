# Freedom Formula Client Management System

**The Coaching Dept. | Built for Dave and Heather**

Complete client lifecycle management from payment to graduation or cancellation. Scores every Freedom Formula client weekly, delivers branded reports, triggers milestone reviews, and flags danger zones automatically.

---

## Handoff Document

### Environment Variables

| Variable | What It Is | Where to Get It |
|----------|-----------|-----------------|
| `FBS_AGENCY_API_KEY` | Fit Biz Solutions agency-level API key | GHL > Settings > Business Profile > API Key (logged in as Fit Biz Solutions agency owner) |
| `GHL_AGENCY_ID` | Fit Biz Solutions agency ID | GHL > Agency Settings > Agency ID (visible in URL or settings panel) |
| `COACHING_DEPT_LOCATION_ID` | The Coaching Dept. sub-account location ID | GHL > Sub-Accounts > The Coaching Dept. > Settings > Business Info > Location ID |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API developer token | Google Ads API Center > credentials (requires approved developer account) |
| `GOOGLE_ADS_CLIENT_ID` | Google Ads OAuth client ID | Google Cloud Console > APIs & Services > Credentials > OAuth 2.0 Client |
| `GOOGLE_ADS_CLIENT_SECRET` | Google Ads OAuth client secret | Same location as Client ID |
| `GOOGLE_ADS_REFRESH_TOKEN` | Google Ads OAuth refresh token | Generated via OAuth flow using the client credentials above |
| `META_ACCESS_TOKEN` | Meta long-lived access token | Meta Business Suite > Business Settings > System Users > Generate Token (ads_read permission) |
| `GHL_REENGAGEMENT_WORKFLOW_ID` | GHL workflow ID for re-engagement sequence | **Usman provides this** after building the 3-email re-engagement workflow in GHL |
| `FORM_BASE_URL` | Public URL where the weekly form is hosted | Your hosting provider (e.g. `https://yourdomain.com/forms/weekly-performance-form.html`) |
| `SENDER_EMAIL` | Email sender address | `team@thecoachingdept.com` or whatever is configured in GHL |
| `SENDER_NAME` | Email sender name | `The Coaching Dept.` |
| `DAVE_EMAIL` | Dave's email for internal summaries | Dave's email address |
| `HEATHER_EMAIL` | Heather's email for internal summaries | Heather's email address |

---

### Placeholders Usman Must Fill Before Go-Live

1. **Client Registry** (`setup/client-registry.json`)
   - Every Freedom Formula and Black Circle client needs an entry
   - Each entry requires all 7 fields populated:
     - `name` — client's name
     - `program` — "Freedom Formula" or "Black Circle"
     - `ghl_location_id` — their individual sub-account location ID
     - `google_ads_customer_id` — no dashes (e.g. `1234567890`)
     - `meta_ad_account_id` — with `act_` prefix (e.g. `act_1234567890`)
     - `ff_contact_id` — their contact ID inside their own sub-account
     - `coaching_dept_mirror_contact_id` — their mirror contact ID inside The Coaching Dept.

2. **GHL_REENGAGEMENT_WORKFLOW_ID** — Usman builds the re-engagement workflow (3 emails over 7 days, system sender, reply-to Heather) and provides the workflow ID

3. **Custom fields standardized** across all client sub-accounts — same field names as defined in `setup/create-custom-fields.js`

4. **Mirror contacts created** — each client needs a contact record inside The Coaching Dept. sub-account

---

### Cron Schedule

| Job | Schedule | Timezone | File |
|-----|----------|----------|------|
| Scoring Engine | Sunday 11:00pm | America/New_York | `engine/scoring-engine.js` |
| Monday Delivery | Monday 7:00am | America/New_York | `engine/monday-delivery.js` |
| Milestone Check | Daily 8:00am | America/New_York | `engine/milestone-check.js` |

All three run from a single process: `node engine/cron-scheduler.js`

---

### Setup Order (Run Once Before Activating Cron)

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill environment variables
cp .env.example .env
# Edit .env with all real values

# 3. Run setup scripts in this order
npm run setup:pipeline    # Creates the 11-stage Freedom Formula pipeline
npm run setup:fields      # Creates all 29 custom fields
npm run setup:tags        # Creates all 67 tags (9 status + 52 weekly + 6 cycle)
npm run setup:smart-lists # Creates FF Dashboard and BC Dashboard

# 4. Verify in GHL
# - Check pipeline exists with all 11 stages
# - Check custom fields exist on contact records
# - Check tags are available
# - Check both smart lists appear

# 5. Have Usman populate client-registry.json

# 6. Deploy the weekly performance form
# - Host forms/weekly-performance-form.html on your domain
# - Set up a backend proxy endpoint (/api/form-submit) that accepts
#   the form POST and writes to GHL using the agency API key
# - Update FORM_BASE_URL in .env

# 7. Start the cron scheduler
npm start
# Or use a process manager:
# pm2 start engine/cron-scheduler.js --name ff-system
```

---

### GHL API Permission Scopes Required

The agency API key (`FBS_AGENCY_API_KEY`) must have these scopes:

- `contacts.readonly` — read contact data from any sub-account
- `contacts.write` — update contact fields, tags, notes
- `opportunities.readonly` — read pipeline/opportunity data
- `opportunities.write` — create and update opportunities
- `locations/customFields.readonly` — read custom field definitions
- `locations/customFields.write` — create custom fields
- `locations/tags.readonly` — read tags
- `locations/tags.write` — create tags
- `conversations.readonly` — read conversation/message data
- `conversations/message.write` — send emails
- `calendars/events.readonly` — read appointment data
- `contacts/tasks.write` — create tasks
- `workflows.readonly` — trigger workflows

---

### Adding a New Client

When a new client joins Freedom Formula or Black Circle:

1. **Create their sub-account** under Fit Biz Solutions in GHL (Usman handles this)

2. **Standardize custom fields** on the new sub-account to match the field names in this system (Usman handles this)

3. **Create a mirror contact** inside The Coaching Dept. sub-account with the client's name and email

4. **Add to client registry** — open `setup/client-registry.json` and add:
```json
{
  "name": "New Client Name",
  "program": "Freedom Formula",
  "ghl_location_id": "their_location_id",
  "google_ads_customer_id": "their_google_ads_id",
  "meta_ad_account_id": "act_their_meta_id",
  "ff_contact_id": "their_contact_id_in_their_subaccount",
  "coaching_dept_mirror_contact_id": "their_mirror_contact_id_in_coaching_dept"
}
```

5. **Set onboarding fields** on their contact record:
   - `FF Monthly Revenue Baseline` — their starting monthly revenue
   - `FF Revenue Tier` — "Under 20k", "20k-50k", or "50k+"
   - `FF Cycle Start Date` — the date they enter Stage 4 (Active)
   - `FF Current Cycle Number` — 1
   - `FF Program` — "Freedom Formula" or "Black Circle"

6. **Apply initial tags**: `FF-Active` and `FF-Cycle-1`

7. **Create pipeline opportunity** in The Coaching Dept. for the mirror contact, starting at Stage 1

The engine picks up the new client on its next Sunday run automatically.

---

### File Structure

```
/freedom-formula-system
  /forms
    weekly-performance-form.html    # Mobile-responsive data collection form
  /engine
    scoring-engine.js               # Sunday 11pm — calculates all scores
    monday-delivery.js              # Monday 7am — sends score emails
    milestone-check.js              # Daily 8am — checks 30/60/90 day marks
    cron-scheduler.js               # Single process running all three crons
  /templates
    score-email.html                # Monday score delivery email
    milestone-email.html            # 30/60/90 day milestone email
    internal-summary.html           # Dave and Heather's weekly summary table
  /utils
    ghl-api.js                      # GHL API wrapper (agency-level auth)
    google-ads-api.js               # Google Ads data pulls
    meta-ads-api.js                 # Meta Ads data pulls
    score-calculator.js             # 11-metric scoring model (0-100)
    rolling-averages.js             # 4-week rolling average calculations
  /setup
    create-pipeline.js              # Creates FF pipeline with 11 stages
    create-custom-fields.js         # Creates all 29 custom fields
    create-tags.js                  # Creates all 67 tags
    create-smart-lists.js           # Creates FF and BC dashboards
    client-registry.json            # Master client registry (Usman populates)
  .env.example                      # Environment variable template
  package.json                      # Dependencies and scripts
  README.md                         # This file
```

---

### Black Circle Architecture

The system is built to support Black Circle clients now:

- `client-registry.json` accepts `"program": "Black Circle"` entries
- BC tags are created (`BC-Active`, `BC-Danger`, `BC-Graduated`, `BC-Cancelled`)
- Black Circle Dashboard smart list is created
- Mirror records update `FF Program` field to distinguish programs

To add Black Circle scoring:
1. Create a new scoring model in `utils/score-calculator.js` (e.g. `calculateBlackCircleScore`)
2. Add a Black Circle branch in `engine/scoring-engine.js` that routes BC clients to the new model
3. No changes needed to the registry, tags, smart lists, or delivery infrastructure

---

### Form Deployment Note

The weekly performance form (`forms/weekly-performance-form.html`) needs a backend proxy to avoid exposing the agency API key in client-side code. Set up a simple endpoint:

```
POST /api/form-submit
```

That endpoint should:
1. Accept the JSON body from the form
2. Authenticate with `FBS_AGENCY_API_KEY`
3. Write custom fields to the contact via GHL API
4. Log a note to the contact activity
5. Return 200 on success

The form handles localStorage retry if the API call fails.

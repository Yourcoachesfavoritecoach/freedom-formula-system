# Freedom Formula: Danger Zone Re-engagement Workflow

## Workflow Spec for GHL Build

**Workflow Name:** FF Danger Zone Re-engagement
**Location:** The Coaching Dept. (FeySgmJup9wqIQhhJomk)
**Built by:** Usman
**Requested by:** Dave Dunham

---

## Overview

This workflow fires when a client enters the "Danger Zone" based on their weekly health score. The scoring engine calls this workflow via the GHL API when danger zone conditions are met. The goal is to immediately alert Dave and Heather, create accountability, and follow up if the client doesn't recover within 3 days.

## Danger Zone Triggers (handled by scoring engine, not this workflow)

A client enters the danger zone when ANY of these conditions are true:
- Health score drops below 40 (Red zone)
- Health score drops 20+ points in one week
- 2 consecutive missed weekly check-in forms
- 2 consecutive missed coaching calls
- Revenue drops 25%+ below baseline for 2+ weeks

When triggered, the scoring engine calls this workflow via the GHL API endpoint.

---

## Workflow Trigger

**Type:** Workflow Trigger (API call)
- The scoring engine calls: `POST /contacts/{contactId}/workflow/{workflowId}`
- This means the workflow receives the contact who triggered the danger zone

---

## Workflow Actions (in order)

### Action 1: Wait 1 Minute
- Type: Wait
- Duration: 1 minute
- Reason: Buffer to prevent duplicate fires if scoring engine processes multiple triggers

### Action 2: Add Tag
- Type: Add Tag
- Tag: `ff-danger`
- This tag is used by the Sunday nudge system and the follow-up check below

### Action 3: Internal Notification Email to Dave
- Type: Send Email (Internal Notification)
- To: dave@fitbizva.com
- Subject: `DANGER ZONE: {{contact.name}} needs attention`
- Body:

```
{{contact.name}} has entered the Danger Zone.

This means one or more of the following happened:
- Health score dropped below 40
- Score dropped 20+ points in one week
- 2+ consecutive missed check-in forms
- 2+ consecutive missed coaching calls
- Revenue dropped 25%+ below baseline for 2+ weeks

ACTION REQUIRED:
1. Review their score breakdown in GHL (check the contact's custom fields)
2. Check their recent notes for context
3. Reach out today — call or text

Their contact record has been tagged "ff-danger" and a task has been created on your dashboard.
```

### Action 4: Internal Notification Email to Heather
- Type: Send Email (Internal Notification)
- To: heather@fitbizva.com
- Subject: `DANGER ZONE: {{contact.name}} — Flag for Dave`
- Body:

```
Heads up — {{contact.name}} just triggered the Danger Zone in the Freedom Formula scoring system.

Dave has been notified and a task was created. Please flag this in your next check-in with Dave if he hasn't addressed it by EOD.
```

### Action 5: Create Task for Dave
- Type: Create Task
- Assigned to: Dave Dunham
- Title: `Danger Zone outreach: {{contact.name}}`
- Due date: Same day
- Description: `Client entered danger zone. Check their score breakdown and recent notes. Reach out today via call or text.`
- Priority: High

### Action 6: Send SMS to Client (Optional — Dave can toggle on/off)
- Type: Send SMS
- To: {{contact.phone}}
- Message: `Hey {{contact.first_name}}, just checking in. Got a minute to talk this week? I want to make sure we're locked in. - Dave`
- NOTE: This step should be togglable. If Dave doesn't want auto-SMS, disable this action but leave it in the workflow so it can be turned on later.

### Action 7: Wait 3 Days
- Type: Wait
- Duration: 3 days

### Action 8: If/Else — Check if still in danger zone
- Type: If/Else
- Condition: Contact has tag `ff-danger`
  - **YES (still in danger zone):** Go to Action 9
  - **NO (recovered):** End workflow

### Action 9: Follow-up Notification to Dave
- Type: Send Email (Internal Notification)
- To: dave@fitbizva.com
- Subject: `FOLLOW-UP: {{contact.name}} still in Danger Zone after 3 days`
- Body:

```
{{contact.name}} has been in the Danger Zone for 3 days and has NOT recovered.

The "ff-danger" tag is still on their contact, which means:
- They haven't submitted a new check-in, OR
- Their score hasn't improved above the threshold

This needs escalation. Consider:
1. Direct phone call
2. Adjusting their program or expectations
3. Having a candid conversation about their commitment level

The scoring engine will automatically remove the "ff-danger" tag when the client's next score clears the danger zone.
```

### Action 10: Create Follow-up Task
- Type: Create Task
- Assigned to: Dave Dunham
- Title: `ESCALATE: {{contact.name}} — 3 days in Danger Zone`
- Due date: Same day
- Description: `Client has been in danger zone for 3 days with no recovery. Needs direct outreach and possible program adjustment.`
- Priority: Urgent

---

## How Danger Zone Clears

The scoring engine handles this automatically. When a client's next weekly score:
- Rises above 40, AND
- No longer meets any danger trigger conditions

The engine will:
1. Remove the `ff-danger` tag via API
2. Update the `FF Danger Zone Active` custom field to "No"
3. This causes the If/Else in Action 8 to exit the workflow

---

## After Build

Once this workflow is built and published in GHL:
1. Copy the Workflow ID from the URL (it's in the URL when you open the workflow)
2. Send the Workflow ID to Dave
3. Dave will add it to the system config as `GHL_REENGAGEMENT_WORKFLOW_ID`

---

## Tags Used

| Tag | Purpose |
|-----|---------|
| `ff-danger` | Active danger zone flag. Added by workflow, removed by scoring engine. |
| `ff-danger-resolved` | Historical flag (optional). Added when danger clears for tracking. |

---

## Questions for Usman

1. Do you want the SMS in Action 6 enabled by default, or should it start disabled?
2. Should there be a second follow-up at 7 days if the client still hasn't recovered?
3. Any additional internal notifications needed (Slack, etc.)?

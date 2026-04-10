/**
 * ClickUp API Utility
 * Creates tasks for Usman when new clients need sub-account setup.
 */

const axios = require('axios');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const API_BASE = 'https://api.clickup.com/api/v2';
const API_TOKEN = process.env.CLICKUP_API_TOKEN;

// Usman's ClickUp user ID
const USMAN_USER_ID = '101113413';

// Coaching Dept list for onboarding tasks
const ONBOARDING_LIST_ID = process.env.CLICKUP_ONBOARDING_LIST_ID || '901712137896';

async function apiRequest(method, endpoint, data = null) {
  if (!API_TOKEN) {
    console.log('  Warning: CLICKUP_API_TOKEN not set, skipping ClickUp task creation');
    return null;
  }

  const config = {
    method,
    url: `${API_BASE}${endpoint}`,
    headers: {
      Authorization: API_TOKEN,
      'Content-Type': 'application/json',
    },
  };

  if (data) config.data = data;

  const response = await axios(config);
  return response.data;
}

/**
 * Create an onboarding task for Usman when a new client signs up.
 * Includes step-by-step instructions for setting up the GHL sub-account.
 */
async function createOnboardingTask(clientName, program, adminPageUrl) {
  const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
  const dueDateStr = dueDate.toISOString().split('T')[0];

  const description = `## New ${program} Client: ${clientName}

### What happened
${clientName} signed their agreement and payment was received. Their GHL sub-account needs to be created and registered in the Freedom Formula system.

### Steps to complete

1. **Create GHL sub-account** for ${clientName}
   - Go to Agency Dashboard > Sub-Accounts > Create New
   - Name it: "${clientName}"
   - Copy the **Location ID** from the sub-account URL

2. **Generate a Private Integration Token (PIT)**
   - In the new sub-account: Settings > Business Profile > Integrations
   - Create a new PIT with **all scopes enabled**
   - Copy the PIT (starts with "pit-")

3. **Create a contact** in the client's sub-account
   - Add a new contact for the business owner
   - Fill in: name, email, phone
   - Copy the **Contact ID** from the contact URL

4. **Register in the Freedom Formula system**
   - Go to: ${adminPageUrl}
   - Enter:
     - Client Name: ${clientName}
     - Program: ${program}
     - GHL Location ID: (from step 1)
     - GHL API Key: (PIT from step 2)
     - Contact ID: (from step 3)
     - Google Ads ID: (if available, no dashes)
     - Meta Ad Account ID: (if available, starts with act_)
   - Click "Onboard Client"

5. **Verify** the system confirms onboarding was successful

### What the system does automatically after you submit
- Creates mirror contact in The Coaching Dept
- Places client in the Freedom Formula pipeline at "Payment Received"
- Applies program tags (${program === 'Black Circle' ? 'BC-Active' : 'FF-Active'})
- Sets initial field values and cycle start date
- Provisions all custom fields on their sub-account
- Client starts receiving weekly scores after their first full week

### Deadline
Complete within 24 hours of receiving this task.`;

  try {
    const task = await apiRequest('POST', `/list/${ONBOARDING_LIST_ID}/task`, {
      name: `Onboard New Client: ${clientName} (${program})`,
      markdown_description: description,
      assignees: [parseInt(USMAN_USER_ID)],
      priority: 2, // High priority
      due_date: dueDate.getTime(),
      due_date_time: true,
    });

    if (task) {
      console.log(`  ClickUp task created for Usman: ${task.id} - ${clientName}`);
      return task;
    }
  } catch (err) {
    console.log(`  Warning: Could not create ClickUp task - ${err.message}`);
  }

  return null;
}

/**
 * Create a task notifying Usman that a client's intake form was submitted.
 */
async function createIntakeReceivedTask(clientName, contactId, locationId) {
  try {
    const task = await apiRequest('POST', `/list/${ONBOARDING_LIST_ID}/task`, {
      name: `Intake Form Received: ${clientName}`,
      markdown_description: `## ${clientName} submitted their onboarding intake form

The client's baseline data has been written to their GHL contact record.

**Contact ID:** ${contactId}
**Location ID:** ${locationId}

### Next steps
- Review the intake note on the client's contact record in GHL
- Confirm baseline revenue and member count look accurate
- No further action needed unless data looks off`,
      assignees: [parseInt(USMAN_USER_ID)],
      priority: 3, // Normal priority
    });

    if (task) {
      console.log(`  ClickUp intake task created: ${task.id} - ${clientName}`);
      return task;
    }
  } catch (err) {
    console.log(`  Warning: Could not create ClickUp intake task - ${err.message}`);
  }

  return null;
}

module.exports = {
  createOnboardingTask,
  createIntakeReceivedTask,
  USMAN_USER_ID,
};

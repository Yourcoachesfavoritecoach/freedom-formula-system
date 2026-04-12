/**
 * Post-Call Breakdown Webhook
 * Receives call breakdown + action items from Cowork scheduled task.
 *
 * 1. Writes the full call breakdown as a GHL contact note
 * 2. Pushes each action item to Base44 ClientAction (checklist in app)
 *
 * Endpoint: POST /api/webhook/post-call
 * Auth: Bearer DASHBOARD_TOKEN
 *
 * Email structure (from Cowork "Post Call Breakdown"):
 *   Header: date, program, call_type, client name
 *   Intro: call context/summary paragraphs
 *   Numbered action sections (1-N), each with:
 *     - title: "INCIDENT REPORTING — HANDLE TODAY"
 *     - deadline: "today", "this week", "by Friday", "90 days"
 *     - context: why it matters
 *     - steps: specific things to do
 *   Closing: priority order, coach sign-off
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const ghl = require('../utils/ghl-api');
const base44 = require('../utils/base44-api');
const path = require('path');
const fs = require('fs');

const COACHING_DEPT_ID = process.env.COACHING_DEPT_LOCATION_ID;

function loadRegistry() {
  const registryPath = path.resolve(__dirname, '../setup/client-registry.json');
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);
  for (const client of registry.clients) {
    if (client.ghl_api_key && client.ghl_location_id) {
      ghl.registerLocationKey(client.ghl_location_id, client.ghl_api_key);
    }
  }
  return registry.clients.filter(c => c.ghl_location_id !== 'USMAN_FILLS_THIS');
}

function findClientByName(clients, name) {
  if (!name) return null;
  return clients.find(c => c.name.toLowerCase() === name.toLowerCase());
}

/**
 * POST /api/webhook/post-call
 *
 * Body (matches the email structure Cowork generates):
 * {
 *   client_email: "mayeisha.parker@gmail.com",
 *   client_name: "Mayeisha Parker",
 *   call_date: "2026-04-08",
 *   program: "Freedom Formula",
 *   call_type: "Coaching Call",
 *   coach_name: "Dave Dunham",
 *
 *   // Full intro/summary paragraphs from the email
 *   call_summary: "Good call today. Real decisions got made...",
 *
 *   // Each numbered section from the email becomes an action item
 *   action_items: [
 *     {
 *       title: "Incident Reporting",
 *       deadline: "today",
 *       priority: 1,
 *       context: "A client fainted in one of your fitness classes and no incident report was filed...",
 *       steps: [
 *         "Have direct conversation with the coach on the floor — clear correction, not soft",
 *         "Send memorandum to ALL fitness staff reminding them of the protocol",
 *         "Get the AC fixed this week",
 *         "Document this incident retroactively, right now, today"
 *       ]
 *     },
 *     {
 *       title: "KPIs — Build the Framework",
 *       deadline: "this week",
 *       priority: 2,
 *       context: "You have directors with titles, no standards attached...",
 *       steps: [
 *         "Fitness and cheer director KPIs due by Friday",
 *         "Dance follows the week after",
 *         "Submit department expense breakdown by Friday",
 *         "Submit teal/blue tier staff assessments by Friday"
 *       ]
 *     }
 *   ],
 *
 *   // Optional: closing remarks
 *   closing: "Work the list in order. Incident reporting comes first..."
 * }
 */
router.post('/', async (req, res) => {
  try {
    const {
      client_email,
      client_name,
      call_date,
      program,
      call_type,
      call_summary,
      action_items,
      coach_name,
      closing,
    } = req.body;

    if (!client_email && !client_name) {
      return res.status(400).json({ error: 'client_email or client_name is required.' });
    }
    if (!call_summary && (!action_items || action_items.length === 0)) {
      return res.status(400).json({ error: 'call_summary or action_items required.' });
    }

    const clients = loadRegistry();
    const dateStr = call_date || new Date().toISOString().split('T')[0];
    let resolvedEmail = client_email || null;
    let resolvedName = client_name || null;
    let mirrorContactId = null;

    // --- Resolve client ---
    const registryClient = findClientByName(clients, client_name);
    if (registryClient) {
      resolvedName = registryClient.name;
      mirrorContactId = registryClient.coaching_dept_mirror_contact_id;

      if (!resolvedEmail) {
        try {
          const contactRes = await ghl.getContact(
            registryClient.ghl_location_id,
            registryClient.ff_contact_id
          );
          const contact = contactRes.contact || contactRes;
          resolvedEmail = contact.email;
        } catch (e) {
          console.log(`Post-call: Could not get email for ${resolvedName}: ${e.message}`);
        }
      }
    }

    // Try by email via GHL search if no registry match
    if (!registryClient && client_email) {
      try {
        const search = await ghl.searchContacts(COACHING_DEPT_ID, { query: client_email });
        const contacts = search.contacts || [];
        if (contacts.length > 0) {
          mirrorContactId = contacts[0].id;
          resolvedName = resolvedName || `${contacts[0].firstName || ''} ${contacts[0].lastName || ''}`.trim();
          resolvedEmail = client_email;
        }
      } catch (e) {
        console.log(`Post-call: GHL search failed for ${client_email}: ${e.message}`);
      }
    }

    if (!resolvedEmail && !mirrorContactId) {
      return res.status(404).json({
        error: `Could not find client. Tried name: "${client_name}", email: "${client_email}"`,
      });
    }

    const results = { ghl_note: false, actions_pushed: 0, errors: [] };

    // --- 1. Write full call breakdown to GHL as a contact note ---
    if (mirrorContactId) {
      try {
        const noteLines = [
          `=== ACTION ITEMS — ${dateStr.toUpperCase()} ===`,
          program ? `Program: ${program}` : null,
          call_type ? `Type: ${call_type}` : null,
          coach_name ? `Coach: ${coach_name}` : null,
          ``,
        ];

        // Intro/summary
        if (call_summary) {
          noteLines.push(call_summary, ``);
        }

        // Each numbered action section
        if (action_items && action_items.length > 0) {
          for (let i = 0; i < action_items.length; i++) {
            const item = action_items[i];
            const isObject = typeof item === 'object';

            if (isObject) {
              const deadlineStr = item.deadline ? ` — ${item.deadline.toUpperCase()}` : '';
              noteLines.push(`${i + 1}. ${(item.title || 'Action Item').toUpperCase()}${deadlineStr}`);

              if (item.context) {
                noteLines.push(``, item.context);
              }

              if (item.steps && item.steps.length > 0) {
                noteLines.push(``);
                for (const step of item.steps) {
                  noteLines.push(`  • ${step}`);
                }
              }
              noteLines.push(``);
            } else {
              // Simple string action item
              noteLines.push(`${i + 1}. ${item}`, ``);
            }
          }
        }

        // Closing
        if (closing) {
          noteLines.push(`---`, ``, closing);
        }

        const noteBody = noteLines.filter(l => l !== null).join('\n');
        await ghl.addContactNote(COACHING_DEPT_ID, mirrorContactId, noteBody);
        results.ghl_note = true;
        console.log(`Post-call: GHL note written for ${resolvedName}`);
      } catch (noteErr) {
        results.errors.push(`GHL note failed: ${noteErr.message}`);
        console.error(`Post-call: GHL note failed for ${resolvedName}: ${noteErr.message}`);
      }
    }

    // --- 2. Push each action item to Base44 ClientAction (checklist) ---
    if (action_items && action_items.length > 0 && resolvedEmail) {
      for (let i = 0; i < action_items.length; i++) {
        const item = action_items[i];
        const isObject = typeof item === 'object';
        const actionId = `postcall-${dateStr}-${crypto.randomUUID().slice(0, 8)}`;

        // Build the action text: title is the checklist item label
        // Steps become the detail the client sees when they expand the item
        let actionText, actionDetails, deadline, actionType;

        if (isObject) {
          actionText = item.title || item.text || 'Action Item';
          deadline = item.deadline || '';
          actionType = item.type || 'homework';

          // Combine context + steps into details for the expandable view
          const detailParts = [];
          if (item.context) detailParts.push(item.context);
          if (item.steps && item.steps.length > 0) {
            detailParts.push(item.steps.map(s => `• ${s}`).join('\n'));
          }
          actionDetails = detailParts.join('\n\n');
        } else {
          actionText = item;
          actionDetails = '';
          deadline = '';
          actionType = 'homework';
        }

        try {
          await base44.pushClientAction(actionId, {
            client_email: resolvedEmail,
            client_name: resolvedName || '',
            action_text: actionText,
            action_type: actionType,
            status: 'pending',
            priority: isObject ? (item.priority || i + 1) : i + 1,
            deadline: deadline,
            due_date: isObject && item.due_date ? item.due_date : '',
            details: actionDetails,
            coach_notes: coach_name ? `${coach_name} — ${dateStr} ${call_type || 'call'}` : `${dateStr} call`,
            call_date: dateStr,
            created_at: new Date().toISOString(),
          });
          results.actions_pushed++;
        } catch (actionErr) {
          results.errors.push(`Action push failed: ${actionText.slice(0, 50)} — ${actionErr.message}`);
        }
      }
      console.log(`Post-call: ${results.actions_pushed}/${action_items.length} actions pushed for ${resolvedName}`);
    }

    // --- 3. Save to local coach-actions.json for dashboard ---
    if (action_items && action_items.length > 0) {
      try {
        const actionsPath = path.resolve(__dirname, '../setup/coach-actions.json');
        const existing = fs.existsSync(actionsPath)
          ? JSON.parse(fs.readFileSync(actionsPath, 'utf8'))
          : [];

        for (let i = 0; i < action_items.length; i++) {
          const item = action_items[i];
          const isObject = typeof item === 'object';

          existing.push({
            id: crypto.randomUUID(),
            clientName: resolvedName || client_name || client_email,
            coachName: coach_name || 'Cowork',
            action: isObject ? item.title || item.text : item,
            type: isObject && item.type ? item.type : 'homework',
            details: isObject ? (item.context || '') : '',
            steps: isObject && item.steps ? item.steps : [],
            deadline: isObject && item.deadline ? item.deadline : '',
            priority: isObject ? (item.priority || i + 1) : i + 1,
            assignedTo: resolvedName || client_name || '',
            timestamp: new Date().toISOString(),
            completed: false,
            source: 'post-call-breakdown',
            callDate: dateStr,
            program: program || '',
          });
        }

        fs.writeFileSync(actionsPath, JSON.stringify(existing, null, 2) + '\n');
      } catch (fileErr) {
        results.errors.push(`Local save failed: ${fileErr.message}`);
      }
    }

    res.json({
      success: true,
      client: resolvedName,
      email: resolvedEmail,
      call_date: dateStr,
      program: program || null,
      ghl_note_written: results.ghl_note,
      actions_pushed: results.actions_pushed,
      total_actions: action_items ? action_items.length : 0,
      errors: results.errors.length > 0 ? results.errors : undefined,
    });

  } catch (err) {
    console.error('Post-call webhook failed:', err.message);
    res.status(500).json({ error: 'Post-call processing failed: ' + err.message });
  }
});

module.exports = router;

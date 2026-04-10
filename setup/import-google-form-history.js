const fs = require('fs');
const { parse } = require('csv-parse/sync');

const CSV_PATH = '/Users/daviddunham/Downloads/Weekly Coaching Check-In — The Coaching Dept. (Responses) - Form Responses 1.csv';

const CONTACT_MAP = {
  'travis@truvineproperties.com': '48SJB3dzkgz5767STxwP',
  'mayeisha.parker@gmail.com': '4ZMwAyu6WPd0jGB2Y7My',
  'david@e3fitology.com': 'ab1mAoGGnWg9RqqVw5Bc',
};

const API_BASE = 'https://services.leadconnectorhq.com';
const API_TOKEN = 'pit-8fcda97d-b8c9-4463-bd36-1553df77d257';
const API_VERSION = '2021-07-28';

function buildNote(row) {
  const [timestamp, name, email, q1, q2, q3, q4, q5, q6, q7, q8, q9, q10] = row;

  return `Weekly Reflection Submission - ${timestamp}

Q1: What was your biggest priority last week?
${q1 || ''}

Q2: Rate last week on a scale of 1-10
${q2 || ''}/10

Q3: Did you accomplish it? If not, why not?
${q3 || ''}

Q4: What did you learn last week?
${q4 || ''}

Q5: What was your biggest business highlight last week?
${q5 || ''}

Q6: What was your biggest personal highlight last week?
${q6 || ''}

Q7: What was your biggest obstacle last week?
${q7 || ''}

Q8: What 2-3 big priorities need to happen this week to make it a success?
${q8 || ''}

Q9: What do you need to solve it?
${q9 || ''}

Q10: What do you need help with, and who do you need to contact?
${q10 || ''}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function postNote(contactId, noteBody, name, timestamp) {
  const url = `${API_BASE}/contacts/${contactId}/notes`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Version': API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: noteBody }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status} for ${name}: ${text}`);
  }

  console.log(`Wrote note for ${name} - ${timestamp}`);
  return res.json();
}

async function main() {
  const csvData = fs.readFileSync(CSV_PATH, 'utf-8');
  const records = parse(csvData, {
    relax_column_count: true,
    skip_empty_lines: false,
  });

  // First row is header
  const dataRows = records.slice(1);
  console.log(`Found ${dataRows.length} rows in CSV\n`);

  let written = 0;
  let skipped = 0;

  for (const row of dataRows) {
    const timestamp = (row[0] || '').trim();
    const name = (row[1] || '').trim();
    const email = (row[2] || '').trim().toLowerCase();

    if (!timestamp || !email) {
      console.log(`Skipping empty row`);
      skipped++;
      continue;
    }

    const contactId = CONTACT_MAP[email];
    if (!contactId) {
      console.log(`Skipping unknown email: ${email} (${name})`);
      skipped++;
      continue;
    }

    const noteBody = buildNote(row);
    await postNote(contactId, noteBody, name, timestamp);
    written++;

    // 500ms delay between calls
    await sleep(500);
  }

  console.log(`\nDone. Wrote ${written} notes, skipped ${skipped} rows.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

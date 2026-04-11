# Coaching Dept. App - Base44 Build Prompts

Paste each prompt into Base44 sequentially. Wait for each to finish before pasting the next.

**API Base URL:** `https://freedom-formula-system-production.up.railway.app`
**Dashboard Token:** `b58d4c3120bb6c8b67f232c11c6d3f617586b11386c1e8a56785111869cbe6f1`

---

## Prompt 1: App Setup, Auth, Theme, API Connection

```
Build an internal dashboard app called "Coaching Dept. App" for a coaching business that manages gym owner clients.

AUTHENTICATION:
- Google sign-in only
- Restrict access to these email domains: fitbizva.com, coachingdept.com
- After login, show the user's name and avatar in the top-right corner
- Add a logout button

THEME (dark mode):
- Background: #1A1A1A
- Card/surface background: #252525
- Primary accent color: #F56600 (Clemson Orange)
- Secondary accent: #009CA6 (teal)
- Text: white (#FFFFFF) for primary, #999999 for secondary
- All cards should have subtle rounded corners (8px) and no visible borders
- Font: system sans-serif

ENTITIES:
Create these entities to store API data locally:

1. Client
   - name (string)
   - program (string: "Freedom Formula" or "Black Circle")
   - ghl_location_id (string)
   - ff_contact_id (string)
   - coaching_dept_mirror_contact_id (string)
   - google_ads_customer_id (string)
   - meta_ad_account_id (string)

2. ScoreSnapshot
   - client_name (string)
   - score (number)
   - last_week_score (number)
   - status_label (string: Green/Yellow/Orange/Red)
   - status_description (string: Thriving/Watch/At Risk/Danger Zone)
   - danger_active (boolean)
   - breakdown (JSON object)
   - pulled_at (datetime)

3. ScoreHistory
   - week (string, date format)
   - client_name (string)
   - score (number)
   - status_label (string)

API CONNECTION:
Create a service module that connects to our Railway API. All requests need this header:
Authorization: Bearer b58d4c3120bb6c8b67f232c11c6d3f617586b11386c1e8a56785111869cbe6f1

Base URL: https://freedom-formula-system-production.up.railway.app

Endpoints to wrap:
- GET /api/dashboard/clients -> returns { clients: [...] }
- GET /api/dashboard/scores -> returns { scores: {clientName: {...}}, lastRun: "ISO date" }
- GET /api/dashboard/scores/live -> returns { scores: {clientName: {score, lastWeekScore, scoreStatus, dangerActive, ...}}, pulledAt: "ISO date" }
- GET /api/dashboard/history?weeks=12&client=Name -> returns { history: [{week, scores: {...}}], weeks: number }

Create a "Refresh Scores" function that calls /api/dashboard/scores/live and upserts the results into the ScoreSnapshot entity. This should run automatically when the app loads and also be triggerable via a button.

LAYOUT:
- Left sidebar with navigation: Dashboard, Clients (just placeholder pages for now)
- Top bar with app name "Coaching Dept." and user info
- Main content area
- The sidebar should show "CD" as a small logo/icon at the top
```

---

## Prompt 2: Dashboard Overview Page

```
Build the main Dashboard page that shows an overview of all clients and their scores.

SUMMARY CARDS (top row, 4 cards):
1. "Total Clients" - count of all clients
2. "Average Score" - mean of all client scores, colored by status tier:
   - 80+ green (#22C55E), 60-79 yellow (#EAB308), 40-59 orange (#F97316), below 40 red (#EF4444)
3. "Danger Zone" - count of clients with dangerActive === true, red background if > 0
4. "Last Updated" - shows the pulledAt timestamp from the most recent score refresh, formatted as relative time ("2 min ago")

Each card should have the label in small gray text (#999) on top and the value large and bold below.

CLIENT TABLE:
Below the cards, show a table of all clients with these columns:
- Status (colored dot: green/yellow/orange/red based on status_label)
- Client Name (bold)
- Program (Freedom Formula or Black Circle, shown as a small pill/badge: orange for FF, teal for BC)
- Score (large number, colored by tier)
- Trend (arrow up/down/neutral comparing score to last_week_score, green arrow if up, red if down, gray dash if same)
- Change (+/- number from last week)
- Danger (red "DANGER" badge if dangerActive, otherwise empty)

TABLE BEHAVIOR:
- Default sort: worst score first (ascending by score)
- Clickable column headers to sort by any column
- Clicking a client row navigates to their detail page (build the route, content comes in Prompt 3)
- Add a search/filter input above the table
- Add a "Refresh" button with a spinning icon that calls the live scores endpoint

EMPTY STATE:
If no scores are loaded yet, show a centered message: "No score data available. Click Refresh to pull live scores." with the Refresh button.

REFRESH BUTTON:
- Shows a loading spinner while fetching
- After fetch completes, update all cards and table rows
- Show a small toast/notification: "Scores updated" with timestamp
```

---

## Prompt 3: Client Detail Page

```
Build the Client Detail page that shows when you click a client from the dashboard table.

PAGE HEADER:
- Back arrow to return to Dashboard
- Client name (large, bold)
- Program badge (same pill style as dashboard: orange for FF, teal for BC)
- Status badge (Green/Yellow/Orange/Red with matching background color)
- Danger zone alert banner: if dangerActive is true, show a full-width red banner at top: "DANGER ZONE - This client needs immediate attention" with a warning icon

SCORE CIRCLE (left side, large):
- A circular progress indicator showing the current score out of 100
- Number displayed large in the center
- Circle color matches status tier (green/yellow/orange/red)
- Below the circle: "Last week: [lastWeekScore]" with trend arrow

METRIC BREAKDOWN (right side):
Show all individual metric scores from the breakdown object as horizontal progress bars grouped by category.

For Freedom Formula clients, group these metrics:
ENGAGEMENT (3 metrics):
- formSubmission (max 10) - "Weekly Check-In"
- coachingCall (max 15) - "Coaching Call"
- outreachResponse (max 5) - "Response Time"

OPERATIONS (4 metrics):
- orgChart (max 10) - "Org Chart Rating"
- weeklyKPIs (max 5) - "KPI Completeness"
- coachingDirective (max 5) - "Coaching Directive"
- hoursReclaimed (max 10) - "Hours Reclaimed"

PERFORMANCE (4 metrics):
- revenue (max 15) - "Revenue vs Avg"
- leadVolume (max 10) - "Lead Volume"
- conversionRate (max 10) - "Conversion Rate"
- blendedCPL (max 5) - "Cost Per Lead"

For each metric:
- Show the label on the left
- Horizontal bar showing points earned vs max possible
- Points displayed as "X/Y" on the right
- Bar color: green if >= 70% of max, yellow if >= 40%, orange if >= 20%, red if < 20%
- Group headers in teal (#009CA6) with the group name

Below the breakdown, show:
- Score: X/100
- Status: [label] - [description]
- "Scores calculated every Sunday at 11pm ET"
```

---

## Prompt 4: Score History and Charts

```
Add score history visualization to the app.

DASHBOARD PAGE - ADD SPARKLINES:
In the client table on the dashboard, add a "Trend" column that shows a small sparkline chart (last 8 weeks of scores). Use the history data from GET /api/dashboard/history?weeks=8&client=ClientName.
- Sparkline color should match current status tier color
- If no history data exists yet, show a gray dashed line

CLIENT DETAIL PAGE - ADD HISTORY SECTION:
Below the metric breakdown, add a "Score History" section with:

1. LINE CHART (main visualization):
   - X-axis: weeks (date labels)
   - Y-axis: score 0-100
   - Line color: #F56600 (orange)
   - Data points as small circles on the line
   - Background color zones:
     - 80-100: faint green band
     - 60-80: faint yellow band
     - 40-60: faint orange band
     - 0-40: faint red band
   - Tooltip on hover showing exact score and date
   - Default to last 12 weeks

2. HISTORY TABLE (below chart):
   - Columns: Week (date), Score, Status, Change from previous week
   - Sorted newest first
   - Change column: green positive numbers with up arrow, red negative with down arrow
   - Status column: colored dot matching tier

3. CONTROLS:
   - Dropdown to select time range: 4 weeks, 8 weeks, 12 weeks, 26 weeks, 52 weeks
   - The chart and table should update when range changes

Fetch history data from: GET /api/dashboard/history?weeks=N&client=ClientName
Parse the response: each entry has { week, scores: { clientName: { score, status, ... } } }
```

---

## Prompt 5: Polish, Mobile, Loading States

```
Polish the app for production use.

LOADING STATES:
- When fetching scores on initial load, show skeleton loaders (gray pulsing rectangles) for all cards and table rows
- When refreshing, show a subtle loading bar at the top of the page
- All API calls should have a 10-second timeout with error handling
- On API error, show a red toast: "Failed to fetch data. Please try again."

EMPTY STATES:
- If a client has no score history, show "No history yet - scores populate after the first Sunday scoring run" with a calendar icon
- If sparklines have no data, show a flat gray dashed line

MOBILE RESPONSIVE:
- On mobile (< 768px): stack summary cards in a 2x2 grid
- Client table becomes cards stacked vertically, each card showing: name, score circle, status dot, program badge, danger flag
- Sidebar collapses to a hamburger menu
- Score circle and metric breakdown stack vertically on client detail
- Charts should be full-width and scrollable horizontally if needed

NAVIGATION:
- Update sidebar: "Dashboard" shows the overview, "Clients" shows a simple list view of all clients (name, program, score, status) as cards
- Active page highlighted in sidebar with orange left border
- Breadcrumb trail on client detail: Dashboard > Client Name

FOOTER:
- Small footer at bottom: "Coaching Dept. App v1.0 - Data refreshes every Sunday at 11pm ET"
- Footer text in #666666

FINAL TOUCHES:
- Add page title that updates: "Dashboard - Coaching Dept." or "Client Name - Coaching Dept."
- Smooth transitions when navigating between pages (fade in)
- Table rows should have a subtle hover effect (slightly lighter background)
- All numbers should be formatted with commas where appropriate
- Dates should be formatted as "Mon DD, YYYY" (e.g., "Apr 06, 2026")
```

---

## Build Instructions

1. Go to https://app.base44.com
2. Create a new app
3. Paste Prompt 1, wait for it to finish building
4. Paste Prompt 2, wait for it to finish
5. Paste Prompt 3, wait for it to finish
6. Paste Prompt 4, wait for it to finish
7. Paste Prompt 5, wait for it to finish
8. Test: login with your Google account, click Refresh, verify client data loads

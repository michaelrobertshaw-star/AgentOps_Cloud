# Real-World Example: Monthly NEMT Trip Report Generator

## The Scenario (This is Real)

**You are OneOps, a NEMT (Non-Emergency Medical Transport) company in Grand Junction, CO.**

Every month you must submit trip documentation to Medicaid/insurance for reimbursement.
Each completed trip needs a **per-trip PDF** with driver name, patient name, pickup/dropoff,
mileage, signature proof, and fare. The state requires a specific file naming convention.

Today this takes a staff member **6-8 hours per month** — pulling trips from iCabbi,
cross-referencing signatures, calculating connected-trip mileage, generating individual
documents, naming files correctly, and compiling the batch.

**With Agent Workspace, it takes 30 seconds.**

---

## What Gets Exercised (Every Moving Part)

| Component | How It's Used | Status |
|-----------|--------------|--------|
| **Connector** | iCabbi REST API (rest_api type, basic auth) | Already built in AgentOps |
| **Tool: get_trips** | Pulls completed trips from iCabbi `/bookings/index/{trip_id}` | Already built |
| **Tool: save_memory** | Agent learns from errors during execution | Already built |
| **Smart Query Builder** | "Get all Trips from iCabbi where Status is Completed and Distance is over 5 miles" | New — "Human SQL" |
| **Upload (CSV)** | Alternate: user uploads CSV of trip IDs exported from dispatch | Bookr batch-lookup has this |
| **Upload (PDF template)** | Trip report template uploaded for document generation | New — uses PDFMe |
| **Product: Bookr** | Trip data cross-referenced with Bookr's booking records | Bookr has iCabbi client |
| **Natural language** | User describes the full workflow in English | New — NLP parser |
| **Pipeline steps** | 8-step pipeline: pull → filter → transform → sort → generate → name → export | New — executor |
| **Table display** | Interactive results table with sort/filter/search | Bookr batch-lookup has this |
| **PDF generation** | One trip report PDF per qualifying trip | New — PDFMe |
| **File naming** | `UTESH17-SMITH-JOHN-2026-03-15-D1.pdf` pattern | New — naming engine |
| **AI Notes** | Anomaly detection, missing data flags, summary stats | New — LLM post-analysis |
| **Shared Brain** | Agent saves learnings (e.g., "iCabbi returns null signature for unsigned trips") | Already built |
| **Batch ZIP** | Download all generated PDFs as single ZIP | New |

---

## The User Experience (Step by Step)

### Step 0: Setup (One-Time)

The agent already has:
- **iCabbi connector** attached (rest_api, basic auth, base_url: `https://api.icabbi.us/v2`)
- **Tools**: `get_trips` (GET `/bookings/index/{trip_id}?signature=true`)
- Bookr product linked (cross-references booking data)

### Step 1: User Opens Workspace Tab

Goes to Agent Profile → **Workspace** tab. Sees empty workspace with input area.

### Step 2: User Describes the Workflow

Types in the natural language input box:

```
Pull all March 2026 completed trips from iCabbi. I'm uploading a CSV
of trip IDs from dispatch. For each trip, include: patient name,
driver name, pickup address, dropoff address, service date, total
miles (for connected trips use start mileage from first leg and end
mileage from last leg), fare amount, and signature image (mark
"UNSIGNED" if missing).

Filter to only trips over 5 miles (Medicaid minimum).

Sort by service date ascending, then by patient last name.

Generate one Trip Report PDF per trip using the uploaded template.

File naming: {company_code}-{patient_last}-{patient_first}-{service_date}-D{sequence}.pdf

Example: UTESH17-SMITH-JOHN-2026-03-15-D1.pdf
```

### Step 3: User Chooses Data Source + Attaches Resources

The workspace offers **3 ways to get data** — pick whichever fits:

#### Option A: Smart Query Builder ("Human SQL")

Build a plain-English query using dropdowns and value inputs. Reads like a sentence, executes like a database query:

```
┌─ DATA SOURCE ──────────────────────────────────────────────────────────────┐
│                                                                            │
│  Get all  [ Trips          ▼]  from  [ iCabbi API     ▼]                  │
│                                                                            │
│  WHERE                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  [ Status     ▼]  [ is            ▼]  [ Completed       ▼]         │  │
│  │                                                                      │  │
│  │  AND                                                                 │  │
│  │                                                                      │  │
│  │  [ Trip Type  ▼]  [ is            ▼]  [ One Way         ▼]         │  │
│  │                                                                      │  │
│  │  AND                                                                 │  │
│  │                                                                      │  │
│  │  [ Distance   ▼]  [ is over       ▼]  [ 5            ] miles       │  │
│  │                                                                      │  │
│  │  AND                                                                 │  │
│  │                                                                      │  │
│  │  [ Date       ▼]  [ is between    ▼]  [2026-03-01] and [2026-03-31]│  │
│  │                                                                      │  │
│  │  [+ Add Condition]                    [+ Add OR Group]               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  Include:  ☑ Signature  ☑ Driver  ☑ Fare  ☐ Notes  ☐ Vehicle              │
│                                                                            │
│  ┌─ Reads as: ──────────────────────────────────────────────────────────┐  │
│  │ "Get all Trips from iCabbi API where Status is Completed and        │  │
│  │  Trip Type is One Way and Distance is over 5 miles and Date         │  │
│  │  is between March 1 and March 31, 2026.                             │  │
│  │  Include signature, driver, and fare."                               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

**How dropdowns auto-populate from the connector:**
- **Resource** ("Trips") → from tool `displayName` on the selected connector
- **Field names** ("Status", "Distance", "Date") → from tool's `input_schema` + `response_mapping`
- **Operators** → auto-matched to field type: string→is/contains, number→is over/under/between, date→before/after/between, enum→is/is not
- **Values** ("Completed") → from `input_schema` enum values; numbers get free input; dates get date picker
- **Include checkboxes** → from tool's response fields (optional extras like signature, driver)

#### Option B: Upload a CSV

```
┌─ OR: Upload CSV ───────────────────────────────────────────────────────┐
│  Drop a CSV file here or click to browse               [ Choose File ] │
│  File: march-2026-trip-ids.csv (247 rows)                              │
│  Column containing IDs: [ trip_id ▼ ]                                  │
└────────────────────────────────────────────────────────────────────────┘
```

#### Option C: Just Describe It

```
┌─ OR: Natural Language ─────────────────────────────────────────────────┐
│  "Pull all completed one-way trips from March 2026 over 5 miles"       │
└────────────────────────────────────────────────────────────────────────┘
```

**All 3 produce the same result** — a set of records to process through the pipeline. Query builder is the most precise, natural language is the fastest, CSV is for when you have a specific list from dispatch.

#### Additional Resources Attached:

| Resource | Selection |
|----------|----------|
| **Connector** | iCabbi API (selected in query builder or auto-detected) |
| **Tool** | get_trips (matched to "Trips" resource) |
| **Upload: Template** | `medicaid-trip-report.html` — HTML template for trip report PDFs |

### Step 4: AI Parses → Pipeline Appears

User clicks **"Parse & Build Pipeline"**. The AI extracts 8 steps:

```
┌─────────────────────────────────────────────────────────────────────┐
│ PIPELINE (8 steps)                                     [Edit JSON] │
│                                                                     │
│  ● Step 1: Load CSV Data                              [VALUE] (red) │
│    Source: march-2026-trip-ids.csv (247 trip IDs)                   │
│    ↓                                                                │
│  ● Step 2: Pull Trip Data                           [ACTION] (green)│
│    Tool: get_trips | Per row: GET /bookings/index/{trip_id}        │
│    Include signature: true                                          │
│    ↓                                                                │
│  ● Step 3: Transform — Select & Compute Fields     [ACTION] (green)│
│    Select: patient_name, driver.name, address.formatted,            │
│            destination.formatted, pickup_date, distance,            │
│            payment.total, payment.signature                         │
│    Compute: signature_display = signature ?? "UNSIGNED"             │
│    Compute: total_miles = connected ? (last_leg.end_miles -         │
│             first_leg.start_miles) : distance                       │
│    ↓                                                                │
│  ● Step 4: Filter — Medicaid Minimum               [VALUE] (red)   │
│    total_miles > 5                                                   │
│    ↓                                                                │
│  ● Step 5: Sort                                     [ACTION] (green)│
│    By: service_date ASC, patient_last_name ASC                      │
│    ↓                                                                │
│  ● Step 6: Generate PDFs                            [ACTION] (green)│
│    Template: medicaid-trip-report.html | Per row: Yes               │
│    ↓                                                                │
│  ● Step 7: Name Files                               [ACTION] (green)│
│    Pattern: {company_code}-{patient_last|upper}-{patient_first|     │
│             upper}-{service_date|YYYY-MM-DD}-D{sequence}.pdf        │
│    ↓                                                                │
│  ● Step 8: Display Results                          [ACTION] (green)│
│    Table + Download All as ZIP                                       │
│                                                                     │
│  [+ Add Step]                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Step 5: User Adds Notes for AI

In the **Notes for AI** section:

```
- Company code is "UTESH17"
- For connected trips (same patient, same day, round trip): combine into one
  record using the start odometer from leg 1 and end odometer from leg 2
- If a trip has status "cancelled" or "no-show", skip it even if it's in the CSV
- Flag any trips where the fare is $0.00 — these need manual review
- If driver name is missing, use "UNASSIGNED" in the report
```

### Step 6: User Clicks "Run Workflow"

Execution streams in real-time:

```
⏳ Step 1/8: Loading CSV...
   ✅ Loaded 247 trip IDs from march-2026-trip-ids.csv

⏳ Step 2/8: Pulling trip data from iCabbi...
   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░ 182/247 (73%)
   ✅ Retrieved 247 trips (3 failed: #34801 not found, #34955 not found, #35012 API timeout)
   ⚠️ 3 trips had errors — see AI Notes

⏳ Step 3/8: Transforming fields...
   ✅ 244 rows transformed, 12 connected trips merged into 6 records

⏳ Step 4/8: Filtering (miles > 5)...
   ✅ 198 trips qualify (40 under 5 miles removed, 6 cancelled/no-show removed)

⏳ Step 5/8: Sorting by date, then patient name...
   ✅ Sorted 198 rows

⏳ Step 6/8: Generating PDFs...
   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 198/198 (100%)
   ✅ 198 PDFs generated (avg 0.3s each)

⏳ Step 7/8: Naming files...
   ✅ 198 files named with pattern

⏳ Step 8/8: Building results table...
   ✅ Done — 198 rows, 198 files, 47.2 seconds total
```

### Step 7: Results Table

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Search: [________________]     │ Export CSV │ Export JSON │ Download All ZIP │
├───────┬──────────┬──────────┬───────────┬──────────┬───────┬──────┬────────┤
│ Trip  │ Patient  │ Driver   │ Pickup    │ Dropoff  │ Miles │ Fare │  PDF   │
├───────┼──────────┼──────────┼───────────┼──────────┼───────┼──────┼────────┤
│ 34742 │ SMITH,J  │ Martinez │ 123 Main  │ St. Mary │ 24.5  │$45.00│  📄   │
│       │          │          │ Grand Jct │ Hospital │       │      │        │
├───────┼──────────┼──────────┼───────────┼──────────┼───────┼──────┼────────┤
│ 34750 │ JONES,M  │ Davis    │ 456 Oak   │ VA Clinic│ 31.2  │$58.50│  📄   │
│ 34751 │ (merged) │          │ VA Clinic │ 456 Oak  │       │      │        │
├───────┼──────────┼──────────┼───────────┼──────────┼───────┼──────┼────────┤
│ 34801 │ DAVIS,R  │ UNASSIGN │ 789 Elm   │ Mesa Cty │ 22.8  │$42.00│  📄   │
│       │          │          │ Fruita    │ Medical  │       │      │ ⚠️     │
├───────┼──────────┼──────────┼───────────┼──────────┼───────┼──────┼────────┤
│  ...  │   ...    │   ...    │    ...    │   ...    │  ...  │ ...  │  ...   │
├───────┴──────────┴──────────┴───────────┴──────────┴───────┴──────┴────────┤
│  Showing 1-25 of 198 trips  │  ← 1  2  3  4  5  6  7  8  →              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Table features (from Bookr batch-lookup, already built):**
- Click column header to sort
- Search across all fields
- Click 📄 to download individual PDF
- ⚠️ icon on rows with issues (no signature, $0 fare, etc.)
- "Download All ZIP" for the full batch

### Step 8: AI Notes (Auto-Generated)

```
┌─ AI NOTES ──────────────────────────────────────────────────────────────────┐
│                                                                              │
│  Summary:                                                                    │
│  • 198 of 247 trips qualified for Medicaid submission                       │
│  • Total mileage: 4,847.3 miles across 198 trips                           │
│  • Total fares: $9,128.50                                                   │
│  • Date range: March 1-31, 2026                                             │
│                                                                              │
│  Issues Found:                                                               │
│  • 3 trips not found in iCabbi (#34801, #34955, #35012) — may have been     │
│    deleted or entered incorrectly in the CSV                                 │
│  • 7 trips had UNSIGNED signatures — marked as "UNSIGNED" per your          │
│    instructions. Files: UTESH17-JONES-MARY-2026-03-08-D4.pdf, ...           │
│  • 2 trips had $0.00 fare (⚠️ flagged for manual review):                   │
│    - Trip #35189 (WILLIAMS, JAMES) — 15.3 miles, no fare recorded           │
│    - Trip #35204 (BROWN, SARAH) — 8.7 miles, no fare recorded              │
│  • 1 driver missing: Trip #34801 had no assigned driver — used "UNASSIGNED" │
│  • 12 connected trips (6 round-trips) were merged using start/end odometer  │
│                                                                              │
│  Connected Trip Pairs Merged:                                                │
│  • #34750 + #34751 (JONES, M) — 31.2 combined miles                        │
│  • #34890 + #34891 (GARCIA, L) — 28.4 combined miles                       │
│  • #35001 + #35002 (WILSON, T) — 19.7 combined miles                       │
│  • #35078 + #35079 (TAYLOR, K) — 33.1 combined miles                       │
│  • #35150 + #35151 (ANDERSON, P) — 25.8 combined miles                     │
│  • #35199 + #35200 (THOMAS, D) — 27.3 combined miles                       │
│                                                                              │
│  Recommendation:                                                             │
│  Review the 2 zero-fare trips before submitting. The unsigned trips are      │
│  valid per your instructions but may need follow-up signatures for some      │
│  payers. All other 189 trips are complete and ready for submission.          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Step 9: Agent Auto-Learns (Brain)

During execution, the agent calls `save_memory` for insights it discovered:

| Memory Saved | Category | What It Learned |
|-------------|----------|-----------------|
| "iCabbi returns null for signature field on unsigned trips" | api_quirk | Signature is null, not empty string — check with `=== null` not `=== ""` |
| "Connected iCabbi trips share trip_id prefix — detect with first 7 digits" | tool_tip | Round trips have IDs like 34750/34751 — sequential IDs on same day = connected |
| "iCabbi /bookings/index/ returns 404 for deleted trips, not empty body" | error_fix | Handle 404 gracefully, don't crash batch |
| "Medicaid requires minimum 5 miles — filter AFTER mileage calculation" | learning | Connected trip mileage must be computed before the filter step, not after |

**Next time ANY agent in the org runs a similar workflow, it already knows these quirks.**

### Step 10: Save as Reusable Workflow

User clicks **"Save as Template"**:
- Name: `Monthly Medicaid Trip Report`
- Description: `Generate per-trip PDFs for Medicaid submission from iCabbi dispatch data`
- Next month: Open workspace → select saved workflow → upload new CSV → Run → Done

---

## The PDF Template (What Gets Uploaded)

`medicaid-trip-report.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 10px; }
    .company { font-size: 24px; font-weight: bold; }
    .trip-id { font-size: 14px; color: #666; }
    .section { margin: 20px 0; }
    .section-title { font-size: 14px; font-weight: bold; color: #333; text-transform: uppercase; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .field-row { display: flex; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
    .field-label { width: 160px; font-weight: 600; color: #555; font-size: 13px; }
    .field-value { flex: 1; font-size: 13px; }
    .signature-box { border: 1px solid #ddd; padding: 10px; text-align: center; margin-top: 10px; }
    .signature-box img { max-width: 300px; max-height: 100px; }
    .unsigned { color: #cc0000; font-weight: bold; font-size: 18px; padding: 20px; }
    .footer { margin-top: 40px; font-size: 10px; color: #999; text-align: center; }
    .mileage-highlight { background: #f0f7ff; padding: 4px 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="company">{{company_name}}</div>
      <div>NEMT Trip Report</div>
    </div>
    <div style="text-align: right;">
      <div class="trip-id">Trip #{{trip_id}}</div>
      <div>{{service_date}}</div>
      <div>File: {{filename}}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Patient Information</div>
    <div class="field-row">
      <div class="field-label">Patient Name</div>
      <div class="field-value">{{patient_last}}, {{patient_first}}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Phone</div>
      <div class="field-value">{{patient_phone}}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Trip Details</div>
    <div class="field-row">
      <div class="field-label">Pickup Address</div>
      <div class="field-value">{{pickup_address}}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Dropoff Address</div>
      <div class="field-value">{{dropoff_address}}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Service Date/Time</div>
      <div class="field-value">{{service_date}} at {{pickup_time}}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Driver</div>
      <div class="field-value">{{driver_name}}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Trip Type</div>
      <div class="field-value">{{trip_type}}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Mileage & Fare</div>
    <div class="field-row">
      <div class="field-label">Total Miles</div>
      <div class="field-value"><span class="mileage-highlight">{{total_miles}} mi</span></div>
    </div>
    <div class="field-row">
      <div class="field-label">Start Odometer</div>
      <div class="field-value">{{start_odometer}}</div>
    </div>
    <div class="field-row">
      <div class="field-label">End Odometer</div>
      <div class="field-value">{{end_odometer}}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Fare Amount</div>
      <div class="field-value">${{fare_amount}}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Patient Signature</div>
    <div class="signature-box">
      {{#if signature_image}}
        <img src="{{signature_image}}" alt="Patient Signature" />
      {{else}}
        <div class="unsigned">UNSIGNED</div>
      {{/if}}
    </div>
  </div>

  <div class="footer">
    Generated by AgentOps on {{generated_date}} | {{company_name}} | Confidential
  </div>
</body>
</html>
```

---

## Technical Execution Map

This is exactly how each system talks to each other during the run:

```
USER INPUT (natural language + CSV + template)
     │
     ▼
┌─────────────────────────────────────────────────┐
│  NLP PARSER (Claude API — already integrated)   │
│  Extracts 8 pipeline steps from natural language│
│  Identifies: tools needed, filters, transforms  │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  WORKSPACE EXECUTOR (new — based on Bookr       │
│  workflow engine pattern)                        │
│                                                  │
│  Step 1: CSV Parser ─────────── Bookr has this  │
│    → Parse march-2026-trip-ids.csv               │
│    → Extract 247 trip IDs                        │
│                                                  │
│  Step 2: Tool Executor ──────── AgentOps has    │
│    → For each trip_id:                           │
│      → toolExecutionService.executeTool()        │
│      → GET iCabbi /bookings/index/{trip_id}     │
│      → Basic auth (encrypted secrets)            │
│      → Response → flat object                    │
│    → Bookr batch-lookup pattern (parallel,       │
│      progress tracking, error per row)           │
│                                                  │
│  Step 3: Transformer ───────── Bookr has this   │
│    → data_transform node pattern                 │
│    → pick/rename/compute fields                  │
│    → Connected trip merge logic (NEW)            │
│                                                  │
│  Step 4: Filter ─────────────── NEW (simple)    │
│    → total_miles > 5                             │
│    → status !== 'cancelled'                      │
│                                                  │
│  Step 5: Sort ───────────────── NEW (simple)    │
│    → Array.sort() by service_date, last_name    │
│                                                  │
│  Step 6: PDF Generator ──────── NEW (PDFMe or   │
│    Puppeteer)                                    │
│    → Load HTML template from upload              │
│    → For each row: inject variables → render PDF │
│    → Store in S3/MinIO (storageService — exists) │
│                                                  │
│  Step 7: File Namer ─────────── NEW (regex)     │
│    → Apply pattern to each generated file        │
│    → UTESH17-SMITH-JOHN-2026-03-15-D1.pdf       │
│                                                  │
│  Step 8: Display ────────────── Bookr has this  │
│    → Results table (sort, filter, search, export)│
│    → Per-row PDF download links                  │
│    → Batch ZIP download                          │
│                                                  │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  AI NOTES GENERATOR (Claude API)                │
│  → Analyze full dataset for anomalies           │
│  → Count: unsigned, $0 fares, missing drivers   │
│  → List connected trip merges                   │
│  → Recommendations for submission               │
│  → Append below table                           │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  BRAIN / AUTO-LEARN (save_memory tool)          │
│  → Agent evaluates: did I learn anything?       │
│  → Saves API quirks, error resolutions          │
│  → Dedup check (no repeat memories)             │
│  → Next run benefits from shared knowledge      │
└─────────────────────────────────────────────────┘
```

---

## What Already Exists vs What's New

| Component | Source | Effort |
|-----------|--------|--------|
| CSV parser | Bookr batch-lookup `parseCSV()` | ✅ Copy |
| iCabbi API client | Bookr `icabbi.ts` + AgentOps `toolExecutionService.ts` | ✅ Exists |
| Batch execution with progress | Bookr batch-lookup (Step 5: Running) | ✅ Copy |
| Results table with sort/filter/export | Bookr batch-lookup (Step 6: Results) | ✅ Copy |
| Data transform (pick/rename/omit) | Bookr workflow engine `data_transform` | ✅ Copy |
| Encrypted credential loading | Both systems have this | ✅ Exists |
| S3/MinIO file storage | AgentOps `storageService.ts` | ✅ Exists |
| Tool execution with field mapping | AgentOps `toolExecutionService.ts` | ✅ Exists |
| Shared Brain / save_memory | AgentOps `agentRunWorker.ts` | ✅ Exists |
| NLP pipeline parser | **New** — Claude API call to extract steps | ~2 hours |
| Pipeline executor (orchestrator) | **New** — but mirrors Bookr engine.ts | ~3 hours |
| Filter step | **New** — trivial (Array.filter) | ~30 min |
| Sort step | **New** — trivial (Array.sort) | ~30 min |
| PDF generation (per-row) | **New** — Puppeteer + HTML template | ~3 hours |
| File naming engine | **New** — regex pattern replacer | ~1 hour |
| AI Notes generator | **New** — Claude API + dataset summary | ~2 hours |
| Connected trip merge logic | **New** — domain-specific transform | ~2 hours |
| Workspace tab UI | **New** — but reuses Bookr components | ~4 hours |
| Batch ZIP download | **New** — archiver npm package | ~1 hour |
| Save/load workflow templates | **New** — CRUD on workspace_workflows | ~2 hours |

**Total new build: ~20 hours**
**Reused from existing: ~60% of the system**

---

## The File Structure (Where It Lives)

```
apps/server/src/
  ├── routes/
  │   └── workspace.ts              ← NEW: parse, execute, templates CRUD
  ├── services/
  │   ├── workspaceExecutor.ts      ← NEW: pipeline step runner
  │   ├── pdfGenerator.ts           ← NEW: HTML template → PDF via Puppeteer
  │   ├── fileNamer.ts              ← NEW: pattern-based file naming
  │   ├── toolExecutionService.ts   ← EXISTS: tool HTTP calls
  │   └── storageService.ts         ← EXISTS: S3/MinIO
  └── workers/
      └── workspaceWorker.ts        ← NEW: BullMQ worker for async execution

apps/web/src/app/(dashboard)/agents/[id]/
  └── AgentDetailClient.tsx         ← MODIFY: add Workspace tab
```

---

## Sample CSV Input File

`march-2026-trip-ids.csv`:
```csv
trip_id
34742
34750
34751
34801
34890
34891
34955
35001
35002
35012
35078
35079
35150
35151
35189
35199
35200
35204
... (247 rows total)
```

---

## Why This Example Proves Everything

1. **Smart Query Builder** — "Get all Trips from iCabbi where Status is Completed and Distance is over 5 miles" — dropdowns + value inputs that read like English
2. **Natural Language** — Alternative: describe the same query in free text
3. **Upload (CSV)** — Alternative: paste a list of specific trip IDs from dispatch
4. **Connector** — iCabbi REST API with encrypted basic auth credentials
5. **Tool** — `get_trips` called per-trip with progress tracking
6. **Upload (Template)** — Custom HTML template for Medicaid-compliant trip reports
7. **Product (Bookr)** — iCabbi client and batch execution pattern reused directly
8. **Pipeline** — 8 distinct steps: query/load → pull → transform → filter → sort → generate → name → display
9. **Action steps** (green) — Pull data, transform, generate PDFs, name files
10. **Value steps** (red) — Query conditions (status=completed, distance>5), field selection, file naming pattern
11. **Table display** — Interactive results with sort, filter, search, per-row download
12. **PDF generation** — 198 individual trip report PDFs from HTML template
13. **File naming** — `UTESH17-SMITH-JOHN-2026-03-15-D1.pdf` pattern engine
14. **AI Notes** — Anomaly detection, missing data flags, connected trip analysis, recommendations
15. **Brain/Memories** — Agent auto-saves 4 learnings for future runs
16. **Batch export** — Download all 198 PDFs as single ZIP
17. **Reusable template** — Save workflow, re-run next month with new query or CSV

**Every single moving part from the PRD. Real data. Real connectors. 3 data source options. Buildable now.**

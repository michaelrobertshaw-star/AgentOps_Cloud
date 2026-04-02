# PRD: Agent Workspace — Multi-Step Universal Workflow Engine

**Version:** 1.0
**Date:** 2026-04-01
**Author:** AgentOps Engineering
**Status:** Design Complete — Ready for Build

---

## 1. Executive Summary

Agent Workspace is a new tab on the Agent Profile page that gives every agent the ability to execute **multi-step data workflows** defined in natural language. Users describe what they want in plain English — mixing actions (green) and value pulls (red) — and the system parses, executes, and renders results as interactive tables, downloadable PDFs, or templated documents.

**The iCabbi Example (from whiteboard):**
> "Take all completed trips (one way), over 20 miles, including signature and name (or true if missing). Create one trip log PDF per 1-way trip. For connected trips, use start & end miles driven. File name: UTESH17-SMITH-JOHN-2026-08-31-D2.PDF"

The workspace turns this into a structured pipeline: **Pull Data** → **Filter** → **Transform** → **Generate Documents** → **Display Table** → **Export**

---

## 2. Problem Statement

Today, agents can execute single prompts and call tools, but there's no way to:
- Chain multiple data operations together in a reusable workflow
- Pull structured data from APIs and render it as tables
- Generate batch documents (PDFs, reports) from query results
- Save and re-run common data workflows
- Mix natural language with data-driven actions

Operations teams (like transport/logistics using iCabbi) need to run the same multi-step processes daily — pull trips, filter by criteria, generate per-trip documents, name files systematically. Today this is manual spreadsheet work.

---

## 3. User Stories

| # | As a... | I want to... | So that... |
|---|---------|-------------|------------|
| 1 | Operations Manager | Describe a data workflow in plain English | The agent builds and executes it automatically |
| 2 | Agent User | Chain actions: pull data → filter → transform → output | I can build complex reports without coding |
| 3 | Agent User | See results in an interactive table | I can sort, filter, and review before exporting |
| 4 | Agent User | Generate PDFs from templates for each row | I get batch documents with consistent formatting |
| 5 | Agent User | Upload custom document templates | Documents match my company's branding |
| 6 | Agent User | Save workflows as reusable templates | I don't re-describe the same process every day |
| 7 | Agent User | Add notes that the AI considers | Context and edge cases are handled intelligently |
| 8 | Admin | Manage a template library | Teams use consistent, approved formats |

---

## 4. Architecture Overview

### 4.1 System Diagram

```
                    AGENT WORKSPACE
                    ===============

User Input (Natural Language)
        |
        v
  +-----------+     +-----------+     +-----------+
  |  STEP 1   | --> |  STEP 2   | --> |  STEP 3   | --> ... --> DISPLAY
  +-----------+     +-----------+     +-----------+
       |                 |                 |
   [ACTION]          [VALUE]           [ACTION]
   Pull data         Filter            Generate
   from tool         by criteria       documents
       |                 |                 |
    (green)           (red)            (green)
                                           |
                                           v
                                   +--------------+
                                   | TABLE VIEW   |
                                   | + PDF Export  |
                                   | + Batch Docs  |
                                   +--------------+
                                           |
                                           v
                                   +--------------+
                                   |  AI NOTES    |
                                   | (appended)   |
                                   +--------------+
```

### 4.2 Step Types

Every step in the pipeline is one of two types:

| Type | Color | Description | Examples |
|------|-------|-------------|----------|
| **ACTION** | Green | Does something — calls a tool, creates, transforms, generates | "Pull all trips", "Create PDF", "Save to workspace", "Sort by date" |
| **VALUE** | Red | Pulls or filters data — references fields, applies conditions | "Over 20 miles", "Status = completed", "Include driver name", "One-way only" |

Steps can appear in any order and any combination:
- `[ACTION] → [VALUE] → [ACTION]` — Pull data, filter it, generate output
- `[VALUE] → [ACTION] → [VALUE]` — Define criteria, execute query, extract fields
- `[ACTION] → [VALUE] → text → [ACTION]` — Mixed with free-text instructions

### 4.3 Pipeline Stages

```
PARSE → PLAN → EXECUTE → RENDER → EXPORT
```

| Stage | What Happens |
|-------|-------------|
| **PARSE** | NLP extracts steps from user's natural language input. Identifies actions vs values. |
| **PLAN** | AI builds a structured execution plan — which tools to call, in what order, with what params |
| **EXECUTE** | Runs each step sequentially. Output of step N feeds into step N+1 |
| **RENDER** | Results displayed as interactive table with sort/filter/search |
| **EXPORT** | Generate PDFs, CSVs, or batch documents from template |

---

## 5. Data Model

### 5.1 New Tables

```sql
-- Workspace workflow definitions
CREATE TABLE workspace_workflows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  agent_id      UUID NOT NULL REFERENCES agents(id),
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  -- The raw natural language input
  natural_input TEXT NOT NULL,
  -- Parsed structured pipeline (JSON)
  pipeline      JSONB NOT NULL DEFAULT '[]',
  -- Execution config
  config        JSONB DEFAULT '{}',
  -- Status
  status        VARCHAR(20) DEFAULT 'draft',
  -- Scheduling
  schedule_cron VARCHAR(100),
  last_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Workflow execution history
CREATE TABLE workspace_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   UUID NOT NULL REFERENCES workspace_workflows(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL,
  agent_id      UUID NOT NULL,
  -- Execution data
  status        VARCHAR(20) DEFAULT 'running',  -- running, completed, failed, cancelled
  input_params  JSONB DEFAULT '{}',
  -- Step-by-step results
  step_results  JSONB DEFAULT '[]',
  -- Final output table data
  output_data   JSONB,
  output_columns JSONB,
  -- AI notes appended at end
  ai_notes      TEXT,
  -- Generated files
  generated_files JSONB DEFAULT '[]',
  -- Metrics
  rows_processed INTEGER DEFAULT 0,
  files_generated INTEGER DEFAULT 0,
  duration_ms   INTEGER,
  error         TEXT,
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- Document templates (uploaded or from library)
CREATE TABLE workspace_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  -- Template type
  type          VARCHAR(20) NOT NULL, -- 'pdf', 'docx', 'html', 'csv'
  -- Template source
  source        VARCHAR(20) DEFAULT 'custom', -- 'custom', 'library', 'ai_generated'
  -- Template content (HTML for PDF, or storage key for uploaded files)
  content       TEXT,
  storage_key   VARCHAR(500),
  -- Schema: what variables this template expects
  variable_schema JSONB DEFAULT '{}',
  -- Preview thumbnail
  thumbnail_url VARCHAR(500),
  -- Metadata
  tags          TEXT[] DEFAULT '{}',
  is_default    BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_workspace_workflows_agent ON workspace_workflows(agent_id);
CREATE INDEX idx_workspace_workflows_company ON workspace_workflows(company_id);
CREATE INDEX idx_workspace_runs_workflow ON workspace_runs(workflow_id);
CREATE INDEX idx_workspace_templates_company ON workspace_templates(company_id);
```

### 5.2 Pipeline JSON Schema

Each workflow's `pipeline` field contains an array of steps:

```typescript
interface WorkflowStep {
  id: string;                    // unique step ID (step_1, step_2, ...)
  order: number;                 // execution order
  type: "action" | "value";     // green or red
  label: string;                 // human-readable label

  // What this step does
  operation:
    | "pull_data"        // Call a tool/API to fetch data
    | "filter"           // Filter rows by condition
    | "transform"        // Map/rename/compute columns
    | "sort"             // Sort by field(s)
    | "group"            // Group by field
    | "aggregate"        // Sum, count, avg, min, max
    | "generate_doc"     // Generate document per row (or batch)
    | "name_files"       // Apply naming pattern to generated files
    | "merge"            // Combine datasets
    | "deduplicate"      // Remove duplicate rows
    | "enrich"           // Call another tool to add data to each row
    | "custom";          // Free-text instruction for AI to interpret

  // Operation-specific config
  config: {
    // For pull_data
    tool_name?: string;
    tool_params?: Record<string, unknown>;

    // For filter
    field?: string;
    operator?: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "between";
    value?: unknown;

    // For transform
    mappings?: Array<{ from: string; to: string; transform?: string }>;
    computed?: Array<{ name: string; expression: string }>;

    // For sort
    sort_by?: Array<{ field: string; direction: "asc" | "desc" }>;

    // For generate_doc
    template_id?: string;
    output_format?: "pdf" | "docx" | "csv";
    per_row?: boolean;           // true = one doc per row, false = one doc for all

    // For name_files
    pattern?: string;            // e.g. "{company}-{last_name}-{first_name}-{date}-{trip_id}.pdf"

    // For custom
    instruction?: string;        // free-text AI instruction
  };

  // Natural language source (what the user originally said for this step)
  source_text: string;
}
```

### 5.3 Output Data Schema

```typescript
interface WorkflowOutput {
  columns: Array<{
    key: string;
    label: string;
    type: "string" | "number" | "date" | "boolean" | "link" | "file";
    sortable: boolean;
    width?: number;
  }>;
  rows: Array<Record<string, unknown>>;
  summary?: {
    totalRows: number;
    filteredRows: number;
    aggregates?: Record<string, number>;
  };
  generatedFiles?: Array<{
    filename: string;
    url: string;
    size: number;
    rowIndex: number;
  }>;
  aiNotes?: string;
}
```

---

## 6. Feature Specification

### 6.1 Natural Language Input

The workspace accepts free-form text that mixes actions and values:

```
"Take all completed trips from iCabbi where distance is over 20 miles,
one-way only. Include driver name, pickup address, dropoff address,
distance, and signature (mark 'true' if signature is missing).
Sort by date descending. Generate one trip log PDF per trip using the
'Trip Report' template. File name format:
{company_code}-{last_name}-{first_name}-{date}-D{sequence}.pdf"
```

**The AI parser extracts:**

| Step | Type | Operation | Config |
|------|------|-----------|--------|
| 1 | ACTION | pull_data | tool: get_trips, params: { status: "completed" } |
| 2 | VALUE | filter | field: distance, operator: gt, value: 20 |
| 3 | VALUE | filter | field: trip_type, operator: eq, value: "one_way" |
| 4 | ACTION | transform | select columns: driver, pickup, dropoff, distance, signature |
| 5 | VALUE | transform | computed: signature fallback to "true" if null |
| 6 | ACTION | sort | sort_by: [{ field: date, direction: desc }] |
| 7 | ACTION | generate_doc | template: "Trip Report", per_row: true, format: pdf |
| 8 | ACTION | name_files | pattern: {company}-{last}-{first}-{date}-D{seq}.pdf |

### 6.2 Step Builder UI

Visual pipeline builder with drag-and-drop steps:

```
  [+ Add Step]

  ┌──────────────────────────────────────────────┐
  │ Step 1: Pull Data                     [ACTION]│
  │ ┌──────────────────────────────────────────┐ │
  │ │ Tool: get_completed_trips               │ │
  │ │ Source: "Take all completed trips"       │ │
  │ └──────────────────────────────────────────┘ │
  └──────────────────────────────────────────────┘
          │
          ▼
  ┌──────────────────────────────────────────────┐
  │ Step 2: Filter                        [VALUE] │
  │ ┌──────────────────────────────────────────┐ │
  │ │ distance > 20 miles, trip_type = one_way │ │
  │ │ Source: "over 20 miles, one-way only"    │ │
  │ └──────────────────────────────────────────┘ │
  └──────────────────────────────────────────────┘
          │
          ▼
  ┌──────────────────────────────────────────────┐
  │ Step 3: Generate Documents            [ACTION]│
  │ ┌──────────────────────────────────────────┐ │
  │ │ Template: Trip Report | Per Row: Yes     │ │
  │ │ Source: "one trip log PDF per trip"       │ │
  │ └──────────────────────────────────────────┘ │
  └──────────────────────────────────────────────┘
          │
          ▼
  ┌──────────────────────────────────────────────┐
  │ DISPLAY: Table + Generated Files              │
  └──────────────────────────────────────────────┘
```

### 6.3 Table Display

Interactive data table with:
- **Column sorting** (click header)
- **Column filtering** (dropdown per column)
- **Search** across all fields
- **Pagination** (25/50/100 rows per page)
- **Column reorder** (drag headers)
- **Row selection** (checkboxes for batch operations)
- **Export** (CSV, JSON, PDF of table)
- **Generated file links** (download individual or batch ZIP)

### 6.4 Document Generation

**Template Engine:** PDFMe (primary) + Puppeteer/HTML fallback

**Per-row generation:**
- Each row in the result set generates one document
- Template variables are populated from row data
- Files named according to the naming pattern

**Batch generation:**
- All rows rendered into a single document
- Table layout within the PDF

**Template upload:**
- Upload `.html`, `.pdf` (as base), or `.docx` templates
- Template designer for creating new templates in-browser
- Variable placeholders: `{{field_name}}`, `{{date | format:"YYYY-MM-DD"}}`

### 6.5 Template Library

Pre-built templates from open-source:

| Template | Type | Use Case |
|----------|------|----------|
| Trip Report | PDF | Per-trip transport log with signature field |
| Invoice | PDF | Line-item invoice with totals |
| Manifest | PDF | Batch document listing all items |
| Daily Summary | PDF | Aggregated daily stats table |
| Driver Log | PDF | Per-driver activity sheet |
| Compliance Report | PDF | Regulatory submission format |
| Custom Table | PDF | Generic table layout for any data |
| Letter | PDF | Business letter with header/footer |

### 6.6 AI Notes

After execution, the AI appends contextual notes:

```
--- AI Notes ---
- 3 trips had missing signatures — marked as "true" per your instruction
- Trip #34742 had 0.0 miles recorded despite having pickup/dropoff — possible GPS issue
- Connected trip pair (34750/34751) shared start mileage — used 34750 start, 34751 end as requested
- Total distance across all trips: 847.3 miles
- Date range: 2026-03-01 to 2026-03-31
```

These notes are:
- Auto-generated based on data anomalies, edge cases, and summary stats
- Appended to the output below the table
- Stored in `workspace_runs.ai_notes`
- Injected as context if the user asks follow-up questions

---

## 7. API Design

### 7.1 Workspace Workflow Routes

```
POST   /api/agents/:agentId/workspace/parse
  Body: { input: string }
  Returns: { pipeline: WorkflowStep[], preview: string }
  → NLP parses natural language into structured pipeline

POST   /api/agents/:agentId/workspace/workflows
  Body: { name, description?, natural_input, pipeline, config? }
  Returns: { id, ... }
  → Save a workflow

GET    /api/agents/:agentId/workspace/workflows
  Returns: WorkflowSummary[]
  → List saved workflows

GET    /api/agents/:agentId/workspace/workflows/:id
  Returns: Workflow with full pipeline
  → Get workflow detail

PATCH  /api/agents/:agentId/workspace/workflows/:id
  Body: Partial<Workflow>
  → Update workflow (edit steps, rename)

DELETE /api/agents/:agentId/workspace/workflows/:id
  → Delete workflow

POST   /api/agents/:agentId/workspace/workflows/:id/run
  Body: { params?: Record<string, unknown> }
  Returns: { runId } + SSE stream
  → Execute workflow (streamed step-by-step)

GET    /api/agents/:agentId/workspace/runs
  Returns: WorkspaceRun[]
  → List past runs

GET    /api/agents/:agentId/workspace/runs/:runId
  Returns: WorkspaceRun with output_data
  → Get run results (table data, files, notes)
```

### 7.2 Template Routes

```
GET    /api/workspace/templates
  Query: ?type=pdf&source=library
  Returns: Template[]
  → List templates (company + library)

POST   /api/workspace/templates
  Body: { name, type, content?, file? (multipart) }
  Returns: Template
  → Create/upload template

GET    /api/workspace/templates/:id
  Returns: Template with content
  → Get template detail

PATCH  /api/workspace/templates/:id
  Body: Partial<Template>
  → Update template

DELETE /api/workspace/templates/:id
  → Delete template

GET    /api/workspace/templates/library
  Returns: LibraryTemplate[]
  → Browse built-in template library
```

### 7.3 Document Generation Routes

```
POST   /api/workspace/generate
  Body: { templateId, data: Record<string, unknown>[], format, namingPattern? }
  Returns: { files: [{ url, filename }] } or ZIP stream
  → Generate documents from template + data
```

---

## 8. Frontend Design

### 8.1 New Tab: "Workspace"

Added to AgentDetailClient.tsx tab bar between "tools" and "memories":

```
details | run | usage | skills | knowledge | tools | workspace | memories | mcp
```

### 8.2 Workspace Tab Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  WORKSPACE                                           [Saved ▼]  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Describe your workflow in plain English...                │  │
│  │                                                            │  │
│  │  "Take all completed trips from iCabbi, over 20 miles,    │  │
│  │   one-way only. Include signature. Generate trip log PDF   │  │
│  │   per trip. Name: {CO}-{LAST}-{FIRST}-{DATE}-D{#}.pdf"   │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  [Parse & Build Pipeline]                                        │
│                                                                  │
│  ┌─ PIPELINE ──────────────────────────────────────────────────┐ │
│  │                                                              │ │
│  │  ● Step 1: Pull Data          [ACTION]    [Edit] [Remove]   │ │
│  │    Tool: get_completed_trips                                 │ │
│  │    ↓                                                         │ │
│  │  ● Step 2: Filter             [VALUE]     [Edit] [Remove]   │ │
│  │    distance > 20, type = one_way                             │ │
│  │    ↓                                                         │ │
│  │  ● Step 3: Transform          [ACTION]    [Edit] [Remove]   │ │
│  │    Select: driver, pickup, dropoff, distance, signature      │ │
│  │    ↓                                                         │ │
│  │  ● Step 4: Generate PDFs      [ACTION]    [Edit] [Remove]   │ │
│  │    Template: Trip Report | Per row | Custom naming           │ │
│  │                                                              │ │
│  │  [+ Add Step]                                                │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─ NOTES FOR AI ──────────────────────────────────────────────┐ │
│  │  "If signature is missing, mark as 'true'. For connected    │ │
│  │   trips, use the start mileage from first leg and end       │ │
│  │   mileage from last leg."                                   │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  [Run Workflow]               [Save as Template]                 │
│                                                                  │
│  ┌─ RESULTS ───────────────────────────────────────────────────┐ │
│  │  ┌────────────────────────────────────────────────────────┐ │ │
│  │  │ Search...    │ Export CSV │ Export PDF │ Download All │ │ │
│  │  ├──────┬───────┬──────────┬──────────┬─────────┬───────┤ │ │
│  │  │ Trip │Driver │ Pickup   │ Distance │ Sig.    │  PDF  │ │ │
│  │  ├──────┼───────┼──────────┼──────────┼─────────┼───────┤ │ │
│  │  │34742 │Smith  │ 123 Main │ 24.5 mi  │  Yes    │  📄  │ │ │
│  │  │34750 │Jones  │ 456 Oak  │ 31.2 mi  │  true   │  📄  │ │ │
│  │  │34801 │Davis  │ 789 Elm  │ 22.8 mi  │  Yes    │  📄  │ │ │
│  │  └──────┴───────┴──────────┴──────────┴─────────┴───────┘ │ │
│  │                                                              │ │
│  │  Showing 3 of 47 trips | Page 1 of 2                       │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─ AI NOTES ──────────────────────────────────────────────────┐ │
│  │  - 3 trips had missing signatures — marked as "true"        │ │
│  │  - Trip #34742 had 0.0 miles — possible GPS issue           │ │
│  │  - Total distance: 847.3 miles across 47 trips              │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 8.3 Template Manager (Sub-view)

```
┌──────────────────────────────────────────────────────────────────┐
│  TEMPLATE LIBRARY                              [Upload Template] │
│                                                                  │
│  ┌─ Built-in ──────────────────────────────────────────────────┐ │
│  │  📄 Trip Report       PDF  [Preview] [Use]                  │ │
│  │  📄 Invoice           PDF  [Preview] [Use]                  │ │
│  │  📄 Daily Manifest    PDF  [Preview] [Use]                  │ │
│  │  📄 Compliance Form   PDF  [Preview] [Use]                  │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─ Custom (your uploads) ─────────────────────────────────────┐ │
│  │  📄 OneOps Trip Log   PDF  [Preview] [Edit] [Delete]        │ │
│  │  📄 Client Invoice    DOCX [Preview] [Edit] [Delete]        │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## 9. Execution Engine

### 9.1 Workflow Executor (Server-Side)

```typescript
// Pseudocode for workspace workflow executor
async function executeWorkflow(workflow: Workflow, params: Record<string, unknown>) {
  const run = await createWorkspaceRun(workflow);
  let dataset: Row[] = [];

  for (const step of workflow.pipeline) {
    emitProgress(run.id, step);

    switch (step.operation) {
      case "pull_data":
        // Call the agent's attached tool
        dataset = await executeTool(step.config.tool_name, step.config.tool_params);
        break;

      case "filter":
        dataset = dataset.filter(row =>
          evaluateCondition(row[step.config.field], step.config.operator, step.config.value)
        );
        break;

      case "transform":
        dataset = dataset.map(row => applyTransformations(row, step.config));
        break;

      case "sort":
        dataset = sortBy(dataset, step.config.sort_by);
        break;

      case "generate_doc":
        const template = await getTemplate(step.config.template_id);
        const files = await generateDocuments(template, dataset, step.config);
        run.generatedFiles.push(...files);
        break;

      case "name_files":
        run.generatedFiles = applyNamingPattern(run.generatedFiles, dataset, step.config.pattern);
        break;

      case "custom":
        // Send to LLM with dataset context for AI-interpreted step
        dataset = await aiProcessStep(step.config.instruction, dataset);
        break;
    }

    await saveStepResult(run.id, step.id, { rowCount: dataset.length });
  }

  // Generate AI notes
  const aiNotes = await generateAiNotes(dataset, workflow, run);

  // Save final output
  await completeRun(run.id, {
    output_data: dataset,
    output_columns: inferColumns(dataset),
    ai_notes: aiNotes,
    generated_files: run.generatedFiles,
  });
}
```

### 9.2 NLP Pipeline Parser

```typescript
async function parseNaturalLanguage(input: string, agentTools: Tool[]): Promise<WorkflowStep[]> {
  const systemPrompt = `You are a workflow pipeline parser. Given natural language, extract a structured multi-step pipeline.

Available tools for this agent: ${JSON.stringify(agentTools.map(t => ({ name: t.name, description: t.description })))}

Classify each step as:
- "action" (green) — actively does something: pull data, create, generate, sort, save
- "value" (red) — passive filtering/selection: field conditions, thresholds, includes/excludes

Return JSON array of WorkflowStep objects.`;

  const result = await callLLM(systemPrompt, input);
  return JSON.parse(result);
}
```

---

## 10. Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| PDF Generation | **PDFMe** (primary) | WYSIWYG template designer, JSON templates, Node+browser, tables |
| HTML→PDF fallback | **Puppeteer** | Complex layouts, CSS support, headless Chrome |
| DOCX Generation | **docx** npm package | Programmatic Word doc creation, no templates needed |
| Table UI | **Custom React** (existing patterns) | Consistent with AgentOps design system |
| Template Storage | **S3/MinIO** (existing) | Already configured for workspace files |
| NLP Parsing | **Claude API** (existing) | Already integrated, understands domain context |
| Execution Engine | **BullMQ** (existing) | Already running agent runs, add workflow queue |

---

## 11. Implementation Phases

### Phase 1: Foundation (Sprint 1) — Core Pipeline
- [ ] Database tables (workspace_workflows, workspace_runs, workspace_templates)
- [ ] NLP parser endpoint (`POST /parse`) — natural language → pipeline steps
- [ ] Step executor engine (pull_data, filter, transform, sort)
- [ ] Workspace tab on agent detail page
- [ ] Natural language input + pipeline visualization
- [ ] Basic table display for results
- [ ] AI notes generation

### Phase 2: Documents (Sprint 2) — Template System
- [ ] Template CRUD API
- [ ] Template upload (HTML, PDF base, DOCX)
- [ ] PDFMe integration for per-row document generation
- [ ] File naming pattern engine
- [ ] Batch ZIP download
- [ ] Built-in template library (trip report, invoice, manifest)
- [ ] Template preview in UI

### Phase 3: Power Features (Sprint 3) — Workflows & Polish
- [ ] Save/load workflows (reusable pipelines)
- [ ] Step editor modal (edit individual step config)
- [ ] Drag-and-drop step reordering
- [ ] Workflow history (past runs with results)
- [ ] Scheduled workflows (cron-based recurring runs)
- [ ] CSV/JSON export from table
- [ ] Column customization (hide/show/reorder)

### Phase 4: Advanced (Sprint 4) — Intelligence
- [ ] Step chaining with data enrichment (call tool per row)
- [ ] Merge/join datasets from multiple tools
- [ ] Conditional branching (if/else steps)
- [ ] Aggregation steps (sum, count, avg by group)
- [ ] Real-time streaming of step progress via SSE
- [ ] Workspace templates marketplace (share across agents)

---

## 12. File Naming Pattern Engine

Supports variables in curly braces with optional formatting:

```
{company_code}-{last_name|upper}-{first_name|upper}-{service_date|YYYY-MM-DD}-D{sequence|pad:2}.pdf
```

| Variable | Description |
|----------|------------|
| `{field_name}` | Direct field value from row |
| `{field\|upper}` | Uppercase transform |
| `{field\|lower}` | Lowercase transform |
| `{field\|YYYY-MM-DD}` | Date format |
| `{field\|pad:N}` | Zero-pad to N digits |
| `{sequence}` | Auto-increment per batch |
| `{total}` | Total row count |
| `{timestamp}` | Current timestamp |

**Example:** `UTESH17-SMITH-JOHN-2026-08-31-D2.PDF`
- `UTESH17` = company code
- `SMITH` = last name (upper)
- `JOHN` = first name (upper)
- `2026-08-31` = service date
- `D2` = sequence number

---

## 13. Security & Permissions

| Concern | Mitigation |
|---------|-----------|
| Data access | Workflows scoped to company_id — can only access own data |
| Tool execution | Only tools attached to the agent can be called |
| File access | Generated files stored in company-scoped S3 paths |
| Template injection | Template variables sanitized before rendering |
| Rate limiting | Max 10 concurrent workflow runs per company |
| Data size | Max 10,000 rows per workflow result set |
| File generation | Max 500 documents per batch |

---

## 14. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Workflow creation time | < 2 minutes from description to first run | Time from input to results |
| Parse accuracy | > 85% of natural language inputs correctly parsed | Manual review of 100 inputs |
| Document generation speed | < 5 seconds per document | Server-side timing |
| User adoption | 50% of active agents have workspace workflows | DB query |
| Reuse rate | 60% of runs use saved workflows | Saved vs one-off ratio |

---

## 15. Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| Agent tools system | ✅ Built | Tools marketplace + execution pipeline |
| S3/MinIO file storage | ✅ Built | Workspace file routes exist |
| BullMQ job queue | ✅ Built | Agent run worker pattern |
| Claude API integration | ✅ Built | For NLP parsing + AI notes |
| SSE streaming | ✅ Built | For real-time execution progress |
| PDFMe | 🔲 Install | `npm install @pdfme/common @pdfme/generator` |
| Puppeteer | 🔲 Install | `npm install puppeteer` (fallback) |

---

## 16. Open Questions

| # | Question | Decision Needed By |
|---|----------|-------------------|
| 1 | Should workflows be shared across agents or agent-specific? | Phase 1 |
| 2 | Max rows before forcing pagination/streaming? | Phase 1 |
| 3 | Should we support real-time data refresh (live table)? | Phase 3 |
| 4 | Template designer in-browser or upload-only? | Phase 2 |
| 5 | Should AI auto-suggest workflow improvements after each run? | Phase 4 |

---

## 17. Workspace Inputs Panel — Connectors, Tools, Uploads & Products

The Workspace must allow the user to **attach resources** to a workflow before or during execution. This is not just about natural language — the workspace needs access points.

### 17.1 Resource Attachments Panel

The workspace input area includes a collapsible **"Attach Resources"** panel:

```
┌─ ATTACH RESOURCES ─────────────────────────────────────────────┐
│                                                                 │
│  CONNECTORS          TOOLS              UPLOADS     PRODUCTS   │
│  ┌──────────────┐    ┌──────────────┐   ┌────────┐  ┌───────┐ │
│  │ ● iCabbi API │    │ ● get_trips  │   │ + PDF  │  │Bookr  │ │
│  │ ○ Stripe     │    │ ● create_job │   │ + DOCX │  │       │ │
│  │ ○ Twilio     │    │ ● update_trip│   │ + CSV  │  │       │ │
│  └──────────────┘    └──────────────┘   └────────┘  └───────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

| Resource | What It Provides | How It's Used |
|----------|-----------------|---------------|
| **Connectors** | API connections (iCabbi, Stripe, etc.) | Workflow can call any tool on attached connectors |
| **Tools** | Specific API actions from connectors | Steps reference tools by name for data pull/push |
| **Uploads** | PDFs, CSVs, DOCX files uploaded to the workflow | Used as templates, data sources, or reference docs |
| **Products** | Linked product instances (e.g., Bookr) | Product-specific data and actions become available |

### 17.2 Smart Query Builder — "Human SQL"

Instead of (or in addition to) uploading a CSV, users can construct queries visually using plain-English sentence fragments with dropdowns and value inputs. The query reads like a sentence but constructs structured API calls or database lookups.

#### How It Reads

The user builds a sentence like this:

```
Get all [Trips ▼] from [iCabbi API ▼] where [Status ▼] is [Completed ▼]
and [Distance ▼] is greater than [20] [Miles ▼]
and [Date ▼] is between [2026-03-01] and [2026-03-31]
```

Each `[bracketed item]` is either a **dropdown select** or a **value input**.

#### UI Layout

```
┌─ DATA SOURCE ──────────────────────────────────────────────────────────────────┐
│                                                                                │
│  ┌─ Option A: Query ──────────────────────────────────────────────────────┐   │
│  │                                                                        │   │
│  │  Get all  [ Trips          ▼]  from  [ iCabbi API     ▼]              │   │
│  │                                                                        │   │
│  │  ┌─ WHERE ────────────────────────────────────────────────────────┐   │   │
│  │  │                                                                │   │   │
│  │  │  [ Status     ▼]  [ is            ▼]  [ Completed       ▼]   │   │   │
│  │  │                                              [+ add value]     │   │   │
│  │  │                                                                │   │   │
│  │  │  AND                                                           │   │   │
│  │  │                                                                │   │   │
│  │  │  [ Distance   ▼]  [ is over       ▼]  [ 20          ] miles  │   │   │
│  │  │                                                                │   │   │
│  │  │  AND                                                           │   │   │
│  │  │                                                                │   │   │
│  │  │  [ Date       ▼]  [ is between    ▼]  [2026-03-01] [2026-03-31]│  │   │
│  │  │                                                                │   │   │
│  │  │  [+ Add Condition]                                             │   │   │
│  │  └────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                        │   │
│  │  Include:  ☑ Signature  ☑ Driver  ☑ Fare  ☐ Notes  ☐ Vehicle          │   │
│  │                                                                        │   │
│  │  Reads as: "Get all Trips from iCabbi API where Status is Completed   │   │
│  │            and Distance is over 20 miles and Date is between            │   │
│  │            March 1 and March 31, 2026. Include signature and driver."  │   │
│  │                                                                        │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│  ── OR ──                                                                      │
│                                                                                │
│  ┌─ Option B: Upload CSV ─────────────────────────────────────────────────┐   │
│  │  Drop a CSV file here or click to browse               [ Choose File ] │   │
│  │  Column containing IDs: [ trip_id ▼ ]                                  │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│  ── OR ──                                                                      │
│                                                                                │
│  ┌─ Option C: Just describe it ───────────────────────────────────────────┐   │
│  │  "Pull all completed March trips over 20 miles with signatures"        │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### How Dropdowns Are Populated

The dropdowns auto-populate from the selected connector's tools and their schemas:

| Dropdown | Source | Example Values |
|----------|--------|----------------|
| **Resource type** (Trips, Bookings, Drivers...) | Tool `displayName` values on the connector | Trips, Drivers, Vehicles, Zones |
| **From** (connector) | Agent's attached connectors | iCabbi API, Stripe, Twilio |
| **Field** (Status, Distance, Date...) | Tool's `input_schema` properties + `response_mapping` fields | status, distance, pickup_date, driver.name, payment.total |
| **Operator** (is, is over, contains, between...) | Inferred from field type | string → is/contains/starts with; number → is/is over/is under/between; date → is/before/after/between; enum → is/is not |
| **Value** (Completed, 20, date...) | enum → dropdown of known values; number → free input; date → date picker | Completed/Cancelled/NoShow for status; free number for distance |

#### Query Clause Schema

```typescript
interface QueryClause {
  field: string;           // "status", "distance", "pickup_date"
  field_type: "string" | "number" | "date" | "boolean" | "enum";
  operator:
    | "eq" | "neq"         // is / is not
    | "gt" | "gte"         // is over / is at least
    | "lt" | "lte"         // is under / is at most
    | "between"            // is between X and Y
    | "contains"           // contains (string)
    | "starts_with"        // starts with
    | "in";                // is one of (multi-select)
  value: unknown;           // single value or [min, max] for between
  unit?: string;            // "miles", "minutes", "dollars" (display only)
}

interface SmartQuery {
  resource: string;         // "trips", "bookings", "drivers"
  connector_id: string;     // which connector to query
  tool_name: string;        // which tool to call
  clauses: QueryClause[];   // WHERE conditions
  includes: string[];       // extra fields to fetch ("signature", "driver")
  // Human-readable sentence (auto-generated)
  readable: string;
}
```

#### Operator Labels (Human-Readable)

| Operator | For Numbers | For Strings | For Dates | For Enums |
|----------|------------|-------------|-----------|-----------|
| `eq` | is exactly | is | is on | is |
| `neq` | is not | is not | is not on | is not |
| `gt` | is over | — | is after | — |
| `gte` | is at least | — | is on or after | — |
| `lt` | is under | — | is before | — |
| `lte` | is at most | — | is on or before | — |
| `between` | is between X and Y | — | is between X and Y | — |
| `contains` | — | contains | — | — |
| `in` | — | — | — | is one of |

Every query auto-generates a readable English sentence at the bottom so the user can verify what they're asking for before running.

#### How Query Executes

1. **Single-call APIs** (API supports filtering): Query params are passed directly
   - `GET /bookings?status=completed&min_distance=20&date_from=2026-03-01`

2. **Per-ID APIs** (API only supports single lookups — like iCabbi):
   - First: call a "list" endpoint to get matching IDs
   - Then: batch-call the detail endpoint per ID (using Bookr's batch pattern)
   - If no list endpoint: user must provide CSV of IDs + workspace filters client-side

3. **Hybrid**: Query builder generates the list, filters apply post-fetch
   - Pull all trips → filter where distance > 20 locally

---

### 17.3 Upload Handling

Users can upload files directly into a workspace workflow:

- **PDF templates** — Used as document generation templates (trip logs, invoices)
- **CSV data** — Used as input data source (import rows to process)
- **DOCX templates** — Word templates with `{{variable}}` placeholders
- **Reference docs** — Attached for AI context (e.g., "refer to this policy document")

Uploads are stored in the existing workspace file system (S3/MinIO) and linked to the workflow via `workspace_workflow_files` junction table:

```sql
CREATE TABLE workspace_workflow_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   UUID NOT NULL REFERENCES workspace_workflows(id) ON DELETE CASCADE,
  file_id       UUID REFERENCES workspace_files(id),
  -- For direct uploads (not yet in workspace_files)
  filename      VARCHAR(255),
  storage_key   VARCHAR(500),
  content_type  VARCHAR(100),
  size_bytes    INTEGER,
  -- How this file is used in the workflow
  usage_type    VARCHAR(20) NOT NULL, -- 'template', 'data_source', 'reference', 'output'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### 17.3 Product Integration

Products (like Bookr) can expose their own data sources and actions to the workspace:

```typescript
interface ProductWorkspaceIntegration {
  product_id: string;
  product_name: string;
  // Data sources the product exposes
  data_sources: Array<{
    name: string;       // e.g. "bookings", "customers", "invoices"
    description: string;
    schema: Record<string, string>;  // field name → type
  }>;
  // Actions the product can perform
  actions: Array<{
    name: string;       // e.g. "create_booking", "send_confirmation"
    description: string;
    input_schema: Record<string, unknown>;
  }>;
}
```

This allows workspace workflows to pull data from products and push actions back — exactly like the Bookr pilot.

---

## 18. Bookr Pilot Reference

**Note from product owner:** The "extract" feature already exists as a pilot in Bookr. The workspace system should generalize this pattern so any product (Bookr, iCabbi, custom) can expose data extraction + document generation through the same universal workflow engine.

**Bookr pilot capabilities to replicate:**
- Extract booking data based on filters (date range, status, customer)
- Generate per-booking documents (confirmation PDFs, invoices)
- Batch export with naming conventions
- Summary statistics and anomaly notes

**Migration path:** The Bookr extract feature should be refactored to use the workspace pipeline engine rather than custom code, making it a "workspace workflow template" that any Bookr-connected agent can use.

---

## Appendix A: iCabbi Trip Report Workflow (Reference Implementation)

This is the first workflow to build as proof-of-concept:

**Natural Language Input:**
```
Take all completed trips from iCabbi, one-way, over 20 miles.
Include driver name, signature (true if missing), pickup address,
dropoff address, distance. Sort by date. Generate one trip log
PDF per trip. File name: {company}-{last_name}-{first_name}-{date}-D{seq}.pdf
```

**Expected Pipeline:**
1. `pull_data` → tool: `get_trips`, params: `{ status: "completed" }`
2. `filter` → field: `trip_type`, operator: `eq`, value: `one_way`
3. `filter` → field: `distance_miles`, operator: `gt`, value: `20`
4. `transform` → select: `driver_name, signature, pickup, dropoff, distance`
5. `transform` → computed: `signature = signature ?? "true"`
6. `sort` → sort_by: `[{ field: "service_date", direction: "desc" }]`
7. `generate_doc` → template: `trip_report`, per_row: true, format: pdf
8. `name_files` → pattern: `{company_code}-{last_name|upper}-{first_name|upper}-{service_date|YYYY-MM-DD}-D{sequence}.pdf`

**Expected Output:**
- Table with 47 rows
- 47 PDF files, each named like `UTESH17-SMITH-JOHN-2026-08-31-D2.PDF`
- AI Notes about missing signatures, GPS anomalies, total distance

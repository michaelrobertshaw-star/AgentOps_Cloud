# browser-use

> Web browser automation for AI agents — drive a real Chromium browser to navigate pages, fill forms, extract data, and complete multi-step web tasks.

## When to use this skill

Use browser-use when you need to:
- Automate web workflows (login, navigate, click, fill forms)
- Scrape or extract data from websites that require JavaScript rendering
- Run end-to-end browser-based QA tests
- Perform any task that requires interacting with a live browser

## Installation

**Requires Python 3.11+**

```bash
# Install via uv (recommended)
uv add browser-use

# Install Playwright browser (first time only)
uvx browser-use install
# or: playwright install chromium
```

Or via pip:
```bash
pip install browser-use
playwright install chromium
```

## Environment variables

Set one of the following depending on your LLM choice:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # for Claude (recommended with AgentOps)
BROWSER_USE_API_KEY=...         # for the hosted ChatBrowserUse model
GOOGLE_API_KEY=...              # for Gemini models
```

## Basic usage

```python
import asyncio
from browser_use import Agent, Browser
from langchain_anthropic import ChatAnthropic

async def run_task(task: str) -> str:
    browser = Browser()
    agent = Agent(
        task=task,
        llm=ChatAnthropic(model="claude-sonnet-4-6"),
        browser=browser,
    )
    result = await agent.run()
    await browser.close()
    return result

# Example
asyncio.run(run_task("Go to example.com and return the page title"))
```

## Usage with Claude (AgentOps environment)

Since `ANTHROPIC_API_KEY` is already configured in AgentOps:

```python
import asyncio
from browser_use import Agent, Browser
from langchain_anthropic import ChatAnthropic

async def browser_task(task: str):
    """Run a browser-use task. Returns the agent result."""
    browser = Browser()
    try:
        agent = Agent(
            task=task,
            llm=ChatAnthropic(model="claude-sonnet-4-6"),
            browser=browser,
        )
        return await agent.run()
    finally:
        await browser.close()

# Usage in a heartbeat
result = asyncio.run(browser_task("Navigate to the AgentOps dashboard and screenshot the overview page"))
```

## Key Agent parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | `str` | Yes | Natural language description of what to do |
| `llm` | LLM instance | Yes | Language model driver |
| `browser` | `Browser` | Yes | Playwright browser instance |
| `max_steps` | `int` | No | Max browser actions before stopping (default: 100) |
| `tools` | `Tools` | No | Custom tool extensions |

## Custom tools

```python
from browser_use import Agent, Browser, Tools
from langchain_anthropic import ChatAnthropic

tools = Tools()

@tools.action(description="Save extracted data to a file")
def save_data(filename: str, content: str) -> str:
    with open(filename, "w") as f:
        f.write(content)
    return f"Saved to {filename}"

agent = Agent(
    task="Extract all product prices from example.com/products and save to prices.txt",
    llm=ChatAnthropic(model="claude-sonnet-4-6"),
    browser=Browser(),
    tools=tools,
)
asyncio.run(agent.run())
```

## Common patterns for QA agents

```python
# Form fill and submit
task = "Go to https://app.example.com/login, enter email 'qa@test.com' and password 'testpass', click login, then confirm the dashboard loads"

# Data extraction
task = "Navigate to https://example.com/report, extract the table data from the main content area, and return it as JSON"

# Screenshot verification
task = "Go to https://app.example.com, take a screenshot of the homepage, and return the page title and any visible error messages"
```

## Source

- GitHub: https://github.com/browser-use/browser-use
- skills.sh: https://skills.sh/browser-use/browser-use

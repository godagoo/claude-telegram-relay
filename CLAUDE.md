# Personal Claude Code Preferences

This file contains cross-project preferences for working with Claude Code. These instructions apply to all projects and help maintain a consistent development experience.

## Communication Style

- **Verbosity**: Balanced approach - explain key decisions and approaches, but stay focused on the task
- **Explanations**: Walk through important reasoning, mention alternatives when relevant, but avoid over-explaining simple changes
- **Tone**: Professional and objective. No unnecessary superlatives or excessive praise

## Planning & Implementation

- **Planning**: Always use plan mode for non-trivial tasks
  - Enter plan mode before implementing new features, refactors, or complex changes
  - Get explicit approval before writing code
  - Only skip planning for simple, single-step tasks
- **Decision-making**: Ask questions when multiple valid approaches exist rather than assuming preferences

## Code Quality

- **Testing**: Always write tests
  - Every feature should include appropriate tests
  - Run tests after making changes to verify functionality
  - Include unit tests for business logic, integration tests where appropriate
- **Code Style**:
  - Follow existing patterns in the codebase
  - Avoid over-engineering - keep solutions simple and focused
  - Only make changes directly requested or clearly necessary
  - Don't add features, refactoring, or "improvements" beyond what was asked
  - No unnecessary comments or docstrings on unchanged code

## Version Control

- **Commit Style**: Conventional Commits format
  - Use prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
  - Write clear, concise commit messages
  - Focus on the "why" rather than the "what"
  - Always include: `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`
- **Commit Timing**: Only create commits when explicitly requested
- **Safety**: Never use `--force`, `--amend`, or skip hooks unless explicitly asked

## Task Management

- **Todo Lists**: Use TodoWrite for complex, multi-step tasks
  - Create todos at the start of non-trivial work
  - Update status in real-time as work progresses
  - Mark tasks complete immediately after finishing them
  - Keep exactly one task as in_progress at a time

## Available Tools & Extensions

### Agent Skills (Auto-activated)

The following skills are globally available and will auto-activate based on task context:

**Frontend & Design (3):**
- `frontend-design` - Distinctive, beautiful frontend designs with thoughtful typography and themes
- `algorithmic-art` - Generative art using p5.js with seeded randomness and particle systems
- `canvas-design` - Professional visual art in PNG/PDF formats

**Web Development (3):**
- `web-artifacts-builder` - React apps with Tailwind & shadcn/ui bundled as single HTML files
- `webapp-testing` - Playwright-based automated testing for local web applications
- `slack-gif-creator` - Animated GIFs optimized for Slack (1MB limit)

**Document Skills (4):**
- `docx` - Word document creation, editing, and analysis with tracked changes
- `pdf` - PDF extraction, creation, merging, splitting, and form handling
- `pptx` - PowerPoint presentations with layouts and professional formatting
- `xlsx` - Excel spreadsheets with formulas, formatting, and data analysis

**Code Quality (2):**
- `code-review` - Comprehensive code reviews for best practices, security, and performance
- `commit-message-helper` - Generate conventional commit messages from git diffs

**Enterprise & Communication (3):**
- `brand-guidelines` - Apply Anthropic's official brand colors and typography
- `internal-comms` - Write internal communications, reports, and announcements
- `theme-factory` - Apply professional themes to artifacts (10 presets available)

**Development Tools (4):**
- `mcp-builder` - Guide for creating Model Context Protocol (MCP) servers
- `skill-creator` - Guide for developing new Agent Skills
- `pod-manager` - Manage Podman/Docker containers and pods
- `perplexity-research` - Research integration capabilities

**Meta (1):**
- `template-skill` - Starting template for creating new skills

### Specialized Agents (Task Tool)

The following agents are available via the Task tool for complex, multi-step work:

**Orchestrators (3) - Start Here:**
- `tech-lead-orchestrator` - Analyzes complex projects and coordinates multi-step tasks
- `project-analyst` - Detects technology stack for intelligent agent routing
- `team-configurator` - Sets up optimal agent mappings for projects

**Core Team (4) - Cross-cutting Concerns:**
- `code-archaeologist` - Explores and documents unfamiliar/legacy codebases
- `code-reviewer` - Rigorous security-aware reviews with severity-tagged reports
- `performance-optimizer` - Identifies bottlenecks and optimizes for scale
- `documentation-specialist` - Creates comprehensive technical documentation

**Universal Experts (5) - Framework-Agnostic:**
- `api-architect` - RESTful design, GraphQL schemas, and API contracts
- `backend-developer` - Polyglot backend development across languages
- `frontend-developer` - Modern web technologies and responsive design
- `tailwind-css-expert` - Tailwind CSS styling and utility-first development
- `serverless-edge-expert` - Serverless and edge computing patterns

**Specialized - Database (1):**
- `drizzle-orm-expert` - Drizzle ORM for type-safe database access in TypeScript

**Specialized - Python (9):**
- `python-expert` - Modern Python 3.12+ development
- `django-expert` - Complete Django 5.0+ web development
- `fastapi-expert` - FastAPI 0.115+ high-performance APIs
- `ml-data-expert` - Machine Learning, data science, and AI with Python
- `devops-cicd-expert` - Python DevOps, CI/CD, and deployment automation
- `performance-expert` - Python performance optimization and profiling
- `security-expert` - Python security, cryptography, and vulnerability assessment
- `testing-expert` - Python testing, test automation, and QA strategies
- `web-scraping-expert` - Web scraping, data extraction, and automation

**Specialized - Django (3):**
- `django-backend-expert` - Models, views, services, Django conventions
- `django-api-developer` - Django REST Framework and GraphQL
- `django-orm-expert` - Query optimization and database performance

**Specialized - Laravel (2):**
- `laravel-backend-expert` - Laravel MVC, services, and Eloquent patterns
- `laravel-eloquent-expert` - Advanced ORM optimization and queries

**Specialized - Rails (3):**
- `rails-backend-expert` - Full-stack Rails development
- `rails-api-developer` - RESTful APIs and GraphQL with Rails
- `rails-activerecord-expert` - Complex queries and database optimization

**Specialized - React (2):**
- `react-component-architect` - Modern React patterns, hooks, and component design
- `react-nextjs-expert` - Next.js SSR, SSG, ISR, and full-stack applications

**Specialized - Vue (3):**
- `vue-component-architect` - Vue 3 Composition API and component patterns
- `vue-nuxt-expert` - Nuxt SSR, SSG, and full-stack applications
- `vue-state-manager` - Pinia and Vuex state architecture

**Usage Note:** For complex tasks, start with `tech-lead-orchestrator` to get proper agent routing and task coordination.

### Model Selection for Subagents

When using the Task tool to invoke subagents, choose the appropriate model based on task complexity:

**Opus (claude-opus-4-5) - Complex Problem Solving:**
- Deep architectural decisions requiring extensive reasoning
- Complex refactoring across multiple files
- Debugging intricate, multi-layered issues
- Novel algorithm design or optimization
- Security audits requiring thorough analysis
- Performance optimization with multiple trade-offs

**Sonnet (claude-sonnet-4-5) - General Orchestration (Preferred):**
- Standard feature implementation
- Code reviews and analysis
- API design and implementation
- Database schema design
- General development tasks
- Coordinating multi-step workflows
- **This is the preferred model for most orchestration and development work**

**Haiku (claude-haiku-4) - Straightforward Tasks:**
- Simple CRUD operations
- Straightforward bug fixes
- Code formatting and linting
- File organization and renaming
- Documentation generation
- Basic testing tasks
- Quick analysis of small code sections

**Model Selection Examples:**
- Complex optimization → `model: "opus"` with `performance-optimizer`
- Standard feature → `model: "sonnet"` with `django-backend-expert` (default, preferred)
- Simple fix → `model: "haiku"` with `code-reviewer`

**Cost Consideration:** Use Haiku for simple tasks to optimize costs, Sonnet for most work, and reserve Opus for genuinely complex problems requiring deep reasoning.

### Ralph - Autonomous Development Loop

Ralph is a globally installed system that enables continuous autonomous development cycles with Claude Code. It's available as a set of CLI commands from any directory.

**Core Commands:**
- `ralph` - Main autonomous development loop with intelligent exit detection
- `ralph-setup <project>` - Initialize new Ralph projects with templates
- `ralph-import <file> [project]` - Convert PRD/specs to Ralph format
- `ralph-monitor` - Live monitoring dashboard for tracking progress

**Key Features:**
- **Autonomous loops** - Continuously executes Claude Code until project completion
- **Intelligent exit detection** - Automatically stops when objectives are complete
- **Rate limiting** - Built-in API call management (100 calls/hour, configurable)
- **Circuit breaker** - Prevents runaway loops with advanced error detection
- **Session continuity** - Preserves context across loop iterations
- **Live monitoring** - Real-time tmux dashboard showing status and logs
- **5-hour API limit handling** - Detects Claude's usage limit and prompts for action

**Common Usage:**
```bash
# Create new Ralph project
ralph-setup my-project
cd my-project
# Edit PROMPT.md with requirements
ralph --monitor

# Import existing PRD
ralph-import requirements.md my-app
cd my-app
ralph --monitor

# Advanced options
ralph --calls 50 --timeout 30 --verbose
ralph --no-continue  # Start fresh without session context
ralph --reset-session  # Reset session state manually
```

**Project Structure:**
- `PROMPT.md` - Main development instructions for Ralph
- `@fix_plan.md` - Prioritized task list
- `specs/` - Project specifications
- `logs/` - Execution logs

**Installation Location:** `~/.ralph/` and `~/.local/bin/`

**Note:** Ralph requires tmux for integrated monitoring. Test coverage: 276 tests, 100% pass rate.

## Project-Specific Information

When starting work in a new project, **always consult these files first** to understand the project structure and requirements. Do not assume - read before acting.

**Standard Project Files (in order of reading):**

1. **README.md** - Project purpose, architecture, and setup instructions
   - What the project does and why it exists
   - High-level architecture overview
   - Technology stack and dependencies
   - Setup, build, and deployment instructions
   - File structure and organization
   - Contribution guidelines

2. **project-config.json** - Machine-readable project metadata
   - Tech stack (backend, frontend, infrastructure)
   - Recommended agents for different tasks
   - Test, build, and dev commands
   - Testing requirements and frameworks
   - Primary language and tooling

3. **.claude/rules.md** - Project-specific Claude instructions (if present)
   - Architecture patterns specific to this project
   - Important conventions and requirements
   - Testing and quality requirements
   - Agent usage recommendations
   - Special workflows or processes

4. **.claude/settings.json** - Technical configuration (auto-loaded by Claude Code)
   - Permissions (allowed/denied tools and commands)
   - Environment variables
   - Hooks (pre/post command execution)
   - Project announcements

**File Purpose Summary:**

| File                      | Purpose                              | Format     | Audience        |
|---------------------------|--------------------------------------|------------|-----------------|
| `CLAUDE.md`               | Cross-project preferences & routing  | Markdown   | Claude (global) |
| `README.md`               | Project overview & architecture      | Markdown   | Humans & Claude |
| `project-config.json`     | Structured project metadata          | JSON       | Claude (routing)|
| `.claude/rules.md`        | Project-specific instructions        | Markdown   | Claude (local)  |
| `.claude/settings.json`   | Technical configuration              | JSON       | Claude Code     |

**Workflow:**
1. Read README.md to understand what the project is
2. Check project-config.json to know which agents to use
3. Review .claude/rules.md for project-specific patterns (if it exists)
4. Reference .claude/settings.json for permissions and environment (auto-loaded)

**Templates Available:**
See the `templates/` directory in the [LTLClaude repository](https://github.com/Little-Town-Labs/LTLClaude) for starter templates for these files.

## General Principles

- **Read before editing**: Always read files before modifying them
- **Prefer editing over creating**: Modify existing files rather than creating new ones when possible
- **Security**: Watch for common vulnerabilities (XSS, SQL injection, command injection, etc.)
- **Simplicity**: The right amount of complexity is the minimum needed for the current task
- **No time estimates**: Never provide time estimates or predictions for how long work will take

## Active Technologies
- TypeScript 5.9+ on Node.js 18+ + grammy 1.21+, pino 9.5+, zod 3.24+ (001-modular-service-layer)
- Local JSON files (`~/.claude-relay/session.json`, `~/.claude-relay/memory.json`) (001-modular-service-layer)
- TypeScript 5.9+ on Node.js 18+ + grammy 1.21+, pino 9.5+, zod 3.24+ (no new deps) (002-secondbrain-integration)
- Local markdown files with YAML frontmatter in `~/.claude-relay/secondbrain/` (002-secondbrain-integration)
- Bash 5.x (setup script), YAML (podmgr config), Python 3.12 + podmgr (Little-Town-Labs/podman-systemd-manager), Podman (003-secondbrain-infra)
- `/var/lib/secondbrain/` (service account home), `/mnt/fileshare/` (003-secondbrain-infra)
- TypeScript 5.9+ on Node.js 18 + grammy 1.21+, pino 9.5+, zod 3.24+, Node.js `fs/promises`, `path`, `fs` (no new npm deps) (004-file-access)
- In-memory snapshot for share watcher state; no new persistent files for this feature (004-file-access)

## Recent Changes
- 001-modular-service-layer: Added TypeScript 5.9+ on Node.js 18+ + grammy 1.21+, pino 9.5+, zod 3.24+

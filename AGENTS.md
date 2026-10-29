# AGENTS.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (Redis + BullMQ) → durable video processing jobs
- **Email Service** (SMTP) → account confirmation and password recovery

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Video Pipeline

- Video uploads use S3 multipart URLs: the client transfers parts directly to MinIO; the API creates the draft, authorizes parts, verifies completion, and queues processing. The API does not receive the video body.
- The maximum accepted upload is exactly `10,000,000,000` bytes. Larger values return `413 VIDEO_UPLOAD_TOO_LARGE`. Parts are `64 MiB`, with up to 100 signed URLs per request.
- Redis/BullMQ carries processing jobs. A transactional database outbox supports publication recovery. The `video-worker` downloads the source to temporary disk, inspects it with `ffprobe`, creates a thumbnail with FFmpeg, and records ready/error state.
- Keep enough free disk for MinIO's stored source and the worker's temporary source copy. The API container is limited to 1 GiB; the worker is limited to 2 GiB and Node's old-space heap to 512 MiB.
- Containers must use `minio`, `redis`, and `db` as service hosts. `S3_PUBLIC_ENDPOINT` is the client-reachable signed-URL host; use an address reachable by the uploader (for container-based tests, `http://minio:9000`).

Operational details and reproducible video acceptance commands live in [nestjs-project/AGENTS.md](nestjs-project/AGENTS.md).

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring,
reviewing, etc.), decompose the request into its underlying subtasks and
concerns, then identify which available skills match any of them and activate
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.

## Project Rules

Before working on relevant files, read and apply the applicable instructions in `.agents/rules/`. These rules are shared with `.claude/rules/`. Skills are available in `.agents/skills/`. Claude-specific settings and agent definitions are not automatically Codex configuration.

## Codex Compatibility

The shared skills and agent instructions were authored for Claude Code. Interpret references to Claude tools using the equivalent tools available in the current Codex session; if a required tool or integration is unavailable, report the limitation rather than claiming the step was completed. The Markdown files in `.agents/agents/` are reusable task instructions, not automatically registered Codex agent types: when delegation is available and authorized, provide the relevant file to the subagent; otherwise perform the applicable work directly. Claude hooks and enabled plugins in `.claude/settings.json` do not configure Codex. Check that required MCP servers and plugins are actually available before using them.

See [docs/codex-setup.md](docs/codex-setup.md) for the verified Codex CLI setup, skill and subagent mapping, and reproducible MCP instructions. For Codex sessions, treat this `AGENTS.md` as the repository instruction source; do not assume `.mcp.json` or Claude settings configure Codex.

---
name: code-review
description: Use when reviewing code for correctness, security, design, performance, SQL quality, testing, and readability. Trigger on any code review request, PR review, or pre-push validation.
roles: [conductor, reviewer, worker]
---

# Code Review

Review code in priority order. Catching a fundamentally wrong design early avoids wasted effort reviewing implementation details that will be restructured.

Before starting, check whether the target repository has its own coding standards or contributing guidelines (e.g., `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, linter configs, style guides). Repository-specific conventions take precedence over general best practices: a review that flags code for violating a pattern the project explicitly chose against is noise, not value.

---

## 1. Design and Architecture

- Does the change belong in this codebase, or should it be a library/dependency?
- Do component interactions make sense? Is the abstraction level appropriate?
- Is the approach over-engineered for speculative future needs?
- Does it integrate well with the rest of the system?

## 2. Correctness and Logic

- Does the code do what the author intended?
- Edge cases: nulls, empty collections, boundary values, off-by-one errors
- Race conditions, deadlocks, time-of-check-time-of-use bugs
- State management: does mutating state here have unintended effects elsewhere?
- Error handling at every boundary: does the caller handle the error? Does the error propagate correctly?

## 3. Security

Check for OWASP top 10 and common vulnerabilities:

- Injection flaws (SQL, command, eval)
- Cross-site scripting (reflected, stored, DOM-based)
- Authentication and authorization logic (privilege escalation, broken access control)
- Hardcoded secrets, API keys, credentials
- Input validation and sanitization
- Insecure defaults, missing security headers, permissive CORS
- Insecure deserialization

## 4. Performance

- N+1 database queries
- Unbounded collections or missing pagination
- Algorithmic complexity mismatches (O(n^2) where O(n) is achievable)
- Missing size limits on caches/buffers (memory exhaustion risk)
- Unnecessary allocations in hot paths
- Blocking I/O on main/event threads
- Missing indexes for new query patterns

## 5. SQL and Data Transformations

- **Joins**: are they correct? Are filters applied at the right stage?
- **Edge cases**: NULL handling, empty result sets, duplicate rows
- **Type safety**: are type conversions explicit and safe?
- **Aggregations**: are GROUP BY clauses complete? Are aggregation functions semantically correct?
- **Window functions**: are partitions and ordering correct?
- **Temporal logic**: are date/time calculations correct? Are timezones handled?

## 6. Testing

- If the repository has a test suite, build pipeline, or formatting/linting checks, run them if possible or parts of them. Static reading catches logic errors; execution catches environment, dependency, and integration issues that are invisible on paper. When running is not feasible (no test harness, destructive side effects, missing credentials), note it as a review limitation.
- Are there tests for the new/changed behavior? Would the tests actually fail if the code broke?
- Are edge cases tested, not just the happy path?
- Are assertions meaningful and specific (not just `toBeTruthy()`)?
- Test isolation: do tests depend on external state or ordering?

## 7. Readability

- Can another developer understand this code without the PR description?
- Are names descriptive? Do comments explain "why," not "what"?
- Is complexity justified, or could the logic be simplified?
- No commented-out code left behind.

---

## Feedback Format

Label every review comment with its type and severity:

| Label | Meaning | Blocking? |
| ----- | ------- | --------- |
| `issue:` | Bug, security flaw, or functional problem | Yes |
| `suggestion:` | Specific improvement | Usually yes |
| `question:` | Request for clarification | No |
| `nitpick:` | Minor, trivial (style, naming) | No |
| `praise:` | Something done well | No |

Good feedback is specific ("line 42: this ternary fails when `user` is null because..."), explains why it matters ("this will crash in production when..."), and suggests a concrete alternative ("consider using Optional chaining instead"). Do not reject work for minor style issues when the analysis is sound: style enforcement belongs to linters, not reviewers.

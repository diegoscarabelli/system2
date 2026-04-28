# Bounded Inter-Agent Deliveries Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the size of every inter-agent delivery and every knowledge-file injection so a single oversized payload cannot trigger 413/429 cascades, OAuth misclassification, or unbounded session bloat.

**Architecture:** Two layers of size enforcement, plus three correctness fixes that make oversized failures degrade gracefully:

1. **Producer-side budget** — `buildAndDeliverDailySummary` truncates oldest entries to fit a `CATCH_UP_BUDGET_BYTES` cap before delivery.
2. **Transport cap** — `AgentHost.deliverMessage` throws if content exceeds `MAX_DELIVERY_BYTES`. Loud-fail boundary so any future producer that bypasses the budget surfaces immediately.
3. **`stripSessionEntry`** truncates `custom_message.content` to a fixed budget so accumulation in recipient JSONLs is bounded retroactively.
4. **`retry.ts`** classifies 413 / "exceeds the maximum size" / "input size exceeds 8 MB" AND 429 / "Extra usage is required for long context requests" / "long context" as `context_overflow` so the existing compact-and-retry path recovers in place instead of cooldowning the credential.
5. **`host.ts`** skips `pendingDeliveries` replay on `context_overflow` failover (switching providers can't shrink an oversized message; replay just duplicates it across providers).
6. **`loadKnowledgeContext`** uses an activity-log-aware truncation strategy for `log.md` and daily summaries: preserves YAML frontmatter, keeps the newest content, drops oldest. Other knowledge files (`infrastructure.md`, `user.md`, `memory.md`, role files) keep their existing first-N truncation since they self-heal via Narrator condensation.

**Tech Stack:** TypeScript, vitest. No new dependencies.

---

## File Structure

**Modified:**
- `src/server/agents/host.ts` — add `MAX_DELIVERY_BYTES` constant + size check in `deliverMessage`; activity-log-aware truncation in `loadKnowledgeContext`; skip pendingDeliveries replay on `context_overflow` in failover path.
- `src/server/agents/host.test.ts` — tests for the above.
- `src/server/agents/retry.ts` — extend `isContextOverflow()` patterns: 413/wire-size and 429/long-context.
- `src/server/agents/retry.test.ts` — tests for new patterns.
- `src/server/scheduler/jobs.ts` — add `CATCH_UP_BUDGET_BYTES`; `truncateOldestToFit` helper; refactor `collectAgentActivity` (or add a sibling) to return timestamped entries; budget enforcement + `[NOTE: dropped...]` annotation in `buildAndDeliverDailySummary`.
- `src/server/scheduler/jobs.test.ts` — tests for the above.

---

## Task 1: `MAX_DELIVERY_BYTES` transport cap in `deliverMessage`

**Files:** `src/server/agents/host.ts`, `src/server/agents/host.test.ts`

- [ ] Step 1 — write failing test in `host.test.ts` asserting that `deliverMessage` rejects/throws when `content.length > MAX_DELIVERY_BYTES`. Use the existing test harness pattern.

- [ ] Step 2 — add the constant near the top of `host.ts`:

  ```typescript
  /** Hard cap on inter-agent delivery content. Producers should self-bound; this is the loud-fail
   *  boundary against accidental large deliveries (catch-up payloads, tool result dumps, etc.). */
  export const MAX_DELIVERY_BYTES = 1024 * 1024; // 1 MB (implemented; original plan said 512 KB)
  ```

- [ ] Step 3 — in `deliverMessage()` (around line 1280), after the `isReinitializing` check and before the `pendingDeliveries.push`, reject when oversized:

  ```typescript
  if (Buffer.byteLength(content, 'utf8') > MAX_DELIVERY_BYTES) {
    return Promise.reject(
      new Error(
        `Delivery content exceeds MAX_DELIVERY_BYTES (${MAX_DELIVERY_BYTES} bytes). ` +
          `Producer should pre-bound. Receiver=${details.receiver}, sender=${details.sender}.`
      )
    );
  }
  ```

  Use `Buffer.byteLength` (not `.length`) because `MAX_DELIVERY_BYTES` is a wire-size budget; multi-byte UTF-8 chars matter.

- [ ] Step 4 — run test, confirm pass. Run `pnpm typecheck && pnpm check && pnpm test`.

- [ ] Step 5 — commit: `feat(host): cap deliverMessage content at MAX_DELIVERY_BYTES`.

---

## Task 2: `stripSessionEntry` truncates `custom_message.content`

**Files:** `src/server/scheduler/jobs.ts`, `src/server/scheduler/jobs.test.ts`

- [ ] Step 1 — add a constant near the top of `jobs.ts`:

  ```typescript
  /** Per-custom_message content cap when feeding catch-up activity into the Narrator. */
  export const NARRATOR_MESSAGE_EXCERPT_BYTES = 16 * 1024; // 16 KB (implemented; original plan said 4 KB as CUSTOM_MESSAGE_CONTENT_BUDGET)
  ```

  > **Note (post-implementation):** Originally named `CUSTOM_MESSAGE_CONTENT_BUDGET = 4 * 1024`. Renamed to `NARRATOR_MESSAGE_EXCERPT_BYTES` and raised to 16 KB to capture most legitimate inter-agent payloads while bounding pathological cases. The TOML key changed from `custom_message_content_budget_bytes` to `narrator_message_excerpt_bytes`.

- [ ] Step 2 — failing test in `jobs.test.ts` that calls `stripSessionEntry` on a `custom_message` with a 10 KB string content and asserts the returned entry's `content` is truncated to ≤ 16 KB (implemented default; original plan said 4 KB) with a "[truncated]" suffix.

- [ ] Step 3 — update `stripSessionEntry` (around line 181):

  ```typescript
  if (type === 'custom_message') {
    const { details: _d, ...rest } = entry;
    if (typeof rest.content === 'string' && Buffer.byteLength(rest.content, 'utf8') > NARRATOR_MESSAGE_EXCERPT_BYTES) {
      // Iterative truncation to handle multi-byte UTF-8 characters safely
      let truncated = rest.content.slice(0, NARRATOR_MESSAGE_EXCERPT_BYTES);
      while (Buffer.byteLength(truncated, 'utf8') > NARRATOR_MESSAGE_EXCERPT_BYTES) {
        truncated = truncated.slice(0, -1);
      }
      rest.content =
        truncated +
        `\n\n[...truncated: narrator message excerpt exceeded ${NARRATOR_MESSAGE_EXCERPT_BYTES}-byte budget]`;
    }
    return rest;
  }
  ```

  > **Note (post-implementation):** `CUSTOM_MESSAGE_CONTENT_BUDGET` was renamed to `NARRATOR_MESSAGE_EXCERPT_BYTES` and the default was raised to 16 KB to capture most legitimate inter-agent payloads while still bounding pathological cases.

  Truncate from the end (drop the tail). Inter-agent message bodies are typically structured: tag at the top, then content; truncating the tail loses the latter half of the body but preserves the agent-readable header. If a future case needs whole-message context, the producer should pre-summarize before sending.

- [ ] Step 4 — run all tests; commit: `feat(scheduler): truncate custom_message content in stripSessionEntry`.

---

## Task 3: `retry.ts categorizeError` extends `isContextOverflow` patterns

**Files:** `src/server/agents/retry.ts`, `src/server/agents/retry.test.ts`

- [ ] Step 1 — failing tests in `retry.test.ts`:
  1. `categorizeError` on `{ message: '413 ... "Request exceeds the maximum size"' }` returns `context_overflow`.
  2. Same for `'400 ... input size exceeds 8 MB'`.
  3. Same for `'429 ... "Extra usage is required for long context requests"'` (the OAuth misclassifier).
  4. Same for `'long context request rejected'` (a more generic phrasing for resilience).

- [ ] Step 2 — extend `isContextOverflow()` (around line 91) to add three new regex patterns:

  ```typescript
  function isContextOverflow(message: string): boolean {
    return (
      // existing patterns...
      /input token count.*exceeds.*maximum/.test(message) ||
      /maximum context length/.test(message) ||
      /prompt is too long.*tokens/.test(message) ||
      // NEW: wire-size-too-large (413 from Anthropic, 400 from some providers)
      /request exceeds the maximum size/.test(message) ||
      /input size exceeds.*mb/.test(message) ||
      // NEW: Anthropic OAuth long-context misclassifier (Pro/Max bug post-March-2026)
      /extra usage is required for long context/.test(message) ||
      /long context request/.test(message)
    );
  }
  ```

- [ ] Step 3 — run tests; commit: `fix(retry): classify wire-size-too-large and long-context-misclassifier errors as context_overflow`.

---

## Task 4: Skip `pendingDeliveries` replay on `context_overflow`

**Files:** `src/server/agents/host.ts`, `src/server/agents/host.test.ts`

- [ ] Step 1 — failing test: simulate `handlePotentialError` with `category === 'context_overflow'` AND `pendingDeliveries.length > 0`. Assert `reinitializeWithProvider` is NOT called with a non-empty deliveries array (or the equivalent observable: replays are skipped). The exact assertion shape depends on the existing test harness in `host.test.ts`; use the closest pattern.

- [ ] Step 2 — locate the failover path inside `handlePotentialError` (around line 700+). Where `pendingDeliveries` are passed to `reinitializeWithProvider` for replay, add a guard:

  ```typescript
  // Replaying pending deliveries on context_overflow is futile: the message itself is
  // over wire-size, and switching providers won't change that. Drop them with an explicit
  // log so the agent can resync via the next normal turn.
  const deliveriesToRetry = category === 'context_overflow' ? [] : [...this.pendingDeliveries];
  if (category === 'context_overflow' && this.pendingDeliveries.length > 0) {
    log.warn(
      `[AgentHost] Dropping ${this.pendingDeliveries.length} pending delivery(ies) on context_overflow ` +
        `(re-sending oversized message would just duplicate the failure).`
    );
    // Reject the promises so callers (scheduler jobs, message_agent) don't hang
    for (const d of this.pendingDeliveries) {
      d.reject(new Error('Delivery dropped: message exceeded wire-size limits across all providers.'));
    }
    this.pendingDeliveries = [];
  }
  ```

  Adapt to the surrounding code style — there may already be a `deliveriesToRetry` snapshot in scope.

- [ ] Step 3 — run tests; commit: `fix(host): drop pending deliveries on context_overflow failover instead of duplicating across providers`.

---

## Task 5: Activity-log-aware truncation in `loadKnowledgeContext`

**Files:** `src/server/agents/host.ts`, `src/server/agents/host.test.ts`

- [ ] Step 1 — failing tests:
  1. A `log.md` of 50 KB with frontmatter and chronological entries: `loadKnowledgeContext` returns content where the frontmatter is verbatim, the *newest* trailing chunk is preserved, and the *oldest* middle chunk is dropped with a `[...truncated: dropped N oldest characters...]` notice.
  2. A `daily_summaries/2026-04-28.md` of 50 KB: same behavior.
  3. An `infrastructure.md` of 50 KB: keeps existing first-N truncation (drops tail). This is the regression guard — curated files keep their old behavior.

- [ ] Step 2 — add a new helper in `host.ts` near `loadKnowledgeContext`:

  ```typescript
  /**
   * Truncate an activity-log file (chronologically appended) keeping the YAML frontmatter
   * and the newest trailing content. Drops the oldest middle content with a marker.
   */
  private readActivityLogWithBudget(filePath: string, budget: number): string {
    const raw = readFileSync(filePath, 'utf-8');
    if (raw.length <= budget) return raw;

    // Preserve frontmatter (the leading `---\n...\n---\n` block, if any)
    let frontmatter = '';
    let body = raw;
    const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
    if (fmMatch) {
      frontmatter = fmMatch[0];
      body = raw.slice(fmMatch[0].length);
    }

    const notice = `\n\n[...truncated: dropped oldest content from this activity log to fit ${budget.toLocaleString()}-char budget; newest entries below]\n\n`;
    const tailBudget = budget - frontmatter.length - notice.length;
    if (tailBudget <= 0) {
      // Frontmatter alone exceeds budget; return frontmatter truncated.
      return raw.slice(0, budget) + `\n\n[...truncated: file exceeds ${budget.toLocaleString()} char budget]`;
    }

    const tail = body.slice(-tailBudget);
    return frontmatter + notice + tail;
  }
  ```

- [ ] Step 3 — in `loadKnowledgeContext` (around line 1142), use the activity-log helper for `log.md` and `daily_summaries/*.md`, leaving the existing `readWithBudget` for everything else:

  ```typescript
  // Project-scoped agents get their project log; system-wide agents get daily summaries.
  if (this.agentProject !== null && this.agentProjectDirName) {
    const projectLogPath = join(SYSTEM2_DIR, 'projects', this.agentProjectDirName, 'log.md');
    if (existsSync(projectLogPath)) {
      addSection(projectLogPath, this.readActivityLogWithBudget(projectLogPath, MAX_KNOWLEDGE_CHARS));
    }
  } else {
    const summariesDir = join(knowledgeDir, 'daily_summaries');
    if (existsSync(summariesDir)) {
      const summaryFiles = readdirSync(summariesDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 2)
        .reverse();
      for (const file of summaryFiles) {
        const filePath = join(summariesDir, file);
        addSection(filePath, this.readActivityLogWithBudget(filePath, MAX_KNOWLEDGE_CHARS));
      }
    }
  }
  ```

- [ ] Step 4 — run tests; commit: `fix(host): preserve newest content when truncating activity logs (log.md, daily summaries)`.

---

## Task 6: Producer-side catch-up budget with oldest-first dropping

**Files:** `src/server/scheduler/jobs.ts`, `src/server/scheduler/jobs.test.ts`

This is the largest task. It has two sub-deliverables: a `truncateOldestToFit` helper, and integration into `buildAndDeliverDailySummary`.

- [ ] Step 1 — add constant + types:

  ```typescript
  /** Producer-side budget for a single inter-agent delivery (half of MAX_DELIVERY_BYTES,
   *  leaving room for headers, DB-changes section, and SDK request overhead). */
  export const CATCH_UP_BUDGET_BYTES = 512 * 1024; // 512 KB (implemented; original plan said 256 KB)

  export interface TimestampedEntry {
    timestamp: string;
    rendered: string; // pre-stripped, JSON-encoded line
  }
  ```

- [ ] Step 2 — failing tests for `truncateOldestToFit`:
  1. Empty input → `{ kept: [], droppedCount: 0 }`.
  2. Total under budget → all kept, none dropped.
  3. Total over budget → drops oldest first; returned `kept` size ≤ budget; `droppedRange = { from, to }` reflects dropped span.
  4. Single entry over budget on its own → `kept = []` and `droppedCount = 1` (degenerate but well-defined).

- [ ] Step 3 — implement helper:

  ```typescript
  export interface TruncateResult {
    kept: TimestampedEntry[];
    droppedCount: number;
    droppedRange: { from: string; to: string } | null;
  }

  export function truncateOldestToFit(
    entries: TimestampedEntry[],
    budget: number
  ): TruncateResult {
    if (entries.length === 0) return { kept: [], droppedCount: 0, droppedRange: null };
    const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let total = sorted.reduce((s, e) => s + e.rendered.length, 0);
    if (total <= budget) return { kept: sorted, droppedCount: 0, droppedRange: null };

    const dropped: TimestampedEntry[] = [];
    while (total > budget && sorted.length > 0) {
      const e = sorted.shift();
      if (e) {
        dropped.push(e);
        total -= e.rendered.length;
      }
    }
    return {
      kept: sorted,
      droppedCount: dropped.length,
      droppedRange:
        dropped.length > 0
          ? { from: dropped[0].timestamp, to: dropped[dropped.length - 1].timestamp }
          : null,
    };
  }
  ```

- [ ] Step 4 — refactor `collectAgentActivity` (around line 143) to ALSO return timestamps. Either change its return type to `TimestampedEntry[]` or add a sibling `collectAgentActivityWithTimestamps` and adapt callers. Whichever is less invasive — for the catch-up path, the strings need timestamps; for any other callers, a pure-string view via `.map(e => e.rendered).join('\n')` is fine.

- [ ] Step 5 — in `buildAndDeliverDailySummary` (around line 488), after collecting the per-project and non-project activities, apply `truncateOldestToFit` per delivery. Prepend an annotation when truncation occurs:

  ```typescript
  function annotateTruncation(result: TruncateResult): string {
    if (result.droppedCount === 0 || !result.droppedRange) return '';
    return (
      `\n\n[NOTE: dropped ${result.droppedCount} oldest entries spanning ` +
      `${result.droppedRange.from} → ${result.droppedRange.to} ` +
      `to fit ${CATCH_UP_BUDGET_BYTES.toLocaleString()}-byte delivery budget]\n\n`
    );
  }
  ```

  Use this in both the per-project log message and the overall daily-summary message. Cursor still advances to `newRunTs` (dropped entries are gone, not deferred).

- [ ] Step 6 — integration test: build a synthetic 100-entry stream where the total is 1 MB; confirm the resulting delivered message body is ≤ `MAX_DELIVERY_BYTES`, contains the dropped-range note, and the cursor advances normally.

- [ ] Step 7 — run full suite; commit: `feat(scheduler): bound catch-up deliveries via oldest-first truncation`.

---

## Self-review checklist

- All 5 retry-pattern test cases pass.
- `MAX_DELIVERY_BYTES` thrown when oversized; existing deliveries that fit are unaffected.
- `CATCH_UP_BUDGET_BYTES` (512 KB) < `MAX_DELIVERY_BYTES` (1 MB) so producer-bounded deliveries always pass transport.
- Activity-log-truncation preserves frontmatter byte-for-byte; newest-first; dropped-notice present.
- Curated knowledge files (`infrastructure.md`, `user.md`, `memory.md`, role) keep first-N truncation for back-compat.
- 413, 429-long-context, and existing token-overflow patterns all categorize as `context_overflow`.
- Pending deliveries dropped on `context_overflow` failover (not replayed); promises rejected with clear error so callers (`message_agent`, scheduler) don't hang.
- `pnpm check && pnpm typecheck && pnpm build && pnpm test` all green.

## Out of scope

- Changing the on-disk JSONL format (compaction-driven prune of old custom_messages from disk). Existing 84 MB Narrator session will rotate naturally on next start since it exceeds the 10 MB rotation threshold.
- Filing the Anthropic support ticket about the Max-plan long-context misclassification (separate workstream — the user is doing this).
- Reducing `knowledge.budget_chars` default. Activity-log truncation makes the existing 20K cap behave correctly for the chronological files; curated files don't benefit from a smaller cap.

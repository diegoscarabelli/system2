/**
 * Format the message shown when an OAuth provider needs browser auth.
 *
 * Some providers (Anthropic, Codex) use a localhost callback flow and only
 * supply `url`; others (GitHub Copilot) use the device flow and supply an
 * `instructions` string with the user code that must be entered manually.
 * Returning a single formatted string lets every CLI surface that triggers
 * OAuth (today: `system2 config`'s OAuth submenu, also reachable via the
 * fresh-install chain `system2 init` → `system2 config`) share the wording,
 * and gives us a small testable surface for "don't drop the device code".
 */
export function formatOAuthAuthMessage(url: string, instructions?: string): string {
  const detail = instructions ? `\n${instructions}` : '';
  return `Open this URL to authenticate (browser should open automatically):\n${url}${detail}`;
}

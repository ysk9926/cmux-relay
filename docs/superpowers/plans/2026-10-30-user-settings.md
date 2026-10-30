# User routing settings

Personal routing belongs in `RELAY_HOME/config.json` (default `~/.agent-relay/config.json`), outside the installed skill. No config preserves existing routing. Settings cover enabled agents, a default agent for default/plan/work/review/verify, per-agent model names, and per-kind agent preferences for normal task kinds. Enabled agents are a hard boundary, including quota fallback and explicit `--agent`. Per-kind preferences precede the personal default, which precedes bundled choices. Explicit agents still take precedence within the enabled set.

`relay config show|set|reset` reads, validates, atomically saves, and resets these settings. Set merges supplied options and supports dry-run. Narrowing enabled agents prunes obsolete preferences. Invalid or unknown settings fail before launching any child. Model identifiers are passed to official CLIs without maintaining a changing model catalog.

Workflow review uses the opposite provider when enabled and a separate same-provider review task otherwise; its state records the review mode. An explicit cross-check/quota route with no eligible other provider fails clearly. Already created tasks keep their dispatch/session settings for follow-ups.

## Tasks

1. Add CLI behavior tests for persistence, merging, dry-run/reset, invalid data, single-provider routing, models, preferences, explicit pins, and quota exhaustion. Observe failures first.
2. Implement the config module/command and apply preferences when reading routing for new tasks and route previews. Preserve existing behavior without a personal config.
3. Test and implement single-provider workflow review with recorded mode. Verify both providers independently, then existing workflow behavior.
4. Add the configuration mode to the main skill and its focused reference; update README/changelog. Behaviorally check that the skill can fulfill a Codex-only setup request without editing distributed files.
5. Run the full Node test suite and diff checks. Back up the installed skill, copy changed skill files, and compare hashes. Leave personal settings unchanged.

## Verification

`node --test skills/cmux-relay/tests/*.test.mjs` and `git diff --check`. Only fake official CLIs and temporary settings are used; no live subscription calls.

## Review focus

- Disabled providers cannot reappear in quota candidates or explicit-agent calls.
- Model overrides affect all tier candidates, and explicit agents as well.
- Malformed config must not silently fall back or be overwritten by set.
- Single-provider review must not be labeled a cross-provider review.
- Default behavior and installed personal configuration survive the change.

## Completed validation

- All five tasks completed. Full suite: 168 tests passed, zero failures; `git diff --check` passed. Skill frontmatter validation passed using an existing environment with PyYAML.
- The behavioral baseline could not fulfill durable Codex-only configuration. After the update, an independent skill check successfully configured Codex-only and mixed-provider profiles in separate temporary homes, confirmed persisted values and routing, and removed the temporary data. No live provider calls were made.
- Backed up the installed skill to `~/.agents/skill-backups/cmux-relay-20261030T145519490320`, updated 15 files, and verified all 65 source/installed file SHA-256 hashes. Both host symlinks resolve to the shared installation. No personal preference file was created or changed.

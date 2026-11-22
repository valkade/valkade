---
name: model-routing
description: Select the preferred T3 Code provider, model, and effort/thinking options when delegating tasks with delegate_task or launching threads for browser work, small tasks, bigger changes, or hard tasks. Do not override explicit user-specified models.
---

# Model Routing

Route delegated tasks and newly launched threads to the preferred provider, model, and effort/thinking level based on task type.

## Routing Table

| Task Type | When to Use | `providerInstanceId` | `model` | `options` |
| :--- | :--- | :--- | :--- | :--- |
| **Browser work** | Web browsing, UI inspection/testing, `preview_*` automation | `codex` | `gpt-6.2-astra` | `{"reasoningEffort": "high"}` |
| **Small tasks** | Quick fixes, single-file edits, focused lookups, lightweight refactors | `codex` | `gpt-6.1-terra` | *(default; omit `options`)* |
| **Bigger changes** | Multi-file features, substantial refactors, broader implementation work | `claudeAgent` | `claude-opus-5-5` | `{"effort": "high"}` |
| **Hard tasks** | Complex architecture, deep debugging, tricky cross-system problems, high-stakes analysis | `antigravity` | `gemini-4-neon` | `{"thought_level": "high"}` |

## Usage Rules

1. **Respect explicit overrides:** If the user names a specific provider, model, or reasoning level for a request, follow the user's choice instead of this table.
2. **Verify availability:** Call `orchestrator_capabilities` once per thread before the first `delegate_task` call. If the routed provider or model is disabled or unavailable, report that to the user rather than silently switching models.
3. **Pass exact target fields:**
   - For `delegate_task`, set `target.providerInstanceId`, `target.model`, and (when listed) `target.options`.
   - For `t3_thread_launch` or `t3_thread_configure`, map the same values into `modelSelection` (`provider` / `instanceId`, `model`, `options`).
4. **Resolve overlaps by primary bottleneck:** If a task fits more than one row, choose the row matching the dominant constraint (for example, use `gpt-6.2-astra` (`high`) when browser interaction is the core work, or `gemini-4-neon` (`high`) when problem complexity dominates).
5. **Avoid unnecessary delegation:** If the current session already runs on the routed provider, model, and option level and does not need isolation or parallel delegation, do the work directly.

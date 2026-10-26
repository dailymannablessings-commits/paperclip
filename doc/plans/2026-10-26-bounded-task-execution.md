# Bounded task execution

Status: source implementation under review. Do not install or enable it until the exact source, integration results, and concurrent-work-safe rollout have been reviewed.

A board operator can request one task run without globally resuming a paused agent. An eligible idle agent can use the same task-bound path. The agent keeps its model, budget, reporting chain, permissions and heartbeat controls. Existing queued user messages remain intact.

## API and admission

`POST /api/agents/:id/task-execution-lease` requires a board user, same-company access, `agent:wake`, the existing company agent-management permission, and `issue:mutate` for the selected task. The request schema and TypeScript type are exported from the shared package. It accepts an exact 40-character source head, current control hash (including role, capabilities, pause reason and pause timestamp), inherited model, task description, strict transport profile, idempotency key, and expiry. The expiry must be within thirty minutes.

The task must be an unassigned backlog task with no override, execution policy, checkout or active execution. Admission locks the agent and task, checks organization eligibility, and creates the wake receipt, canonical run, strict task scope/profile and activity record in one transaction. A repeated request recovers that exact receipt; it cannot renew the expiry or create another run. A different concurrent request cannot assign another task while the first lease is queued or running.

The task profile may bind an absolute executable and a restricted argument list. It cannot change the role model or role-level configuration. The source head is part of the board-approved scope, not a server-side claim that a remote repository has been reviewed.

## Execution and revocation

Claim, native PRP preparation and native semantic reads recheck the canonical run, linked board-authored wake, current task scope/profile, agent controls and expiry. A cancelled wake or terminal canonical run revokes authority even when a caller holds an old object. Normal budget, daily-cap, task-hold, dependency, scheduling-suppression and concurrency gates remain in the heartbeat path.

A paused agent stays paused. Only its exact leased run can cross that status gate. The ordinary queue stays closed. An idle agent uses its ordinary eligible status. The finalizer clears only execution pointers owned by the terminal run; the strict task profile remains available for reconciliation. It does not promote old messages or clear another run's pointers.

A lease cannot create retry children or gain authority from a copied context. Ordinary wake inputs lose reserved lease fields. Generic retry counters revoke the receipt. Native restart can reattach an existing runner; it cannot launch another provider attempt under the same run ID. Expiry has an in-process cancellation timer and persisted reaper recovery. Physical process ownership checks still control cancellation and cleanup.

## Verification and rollout constraints

Tests use synthetic identifiers and disposable PostgreSQL clusters. They include lost responses, concurrent requests, audit rollback, control/profile changes, canonical revocation, foreign queues, real native PRP and semantic reads, full harmless process execution for paused and idle agents, daily caps, scheduling suppression, and expiry recovery.

Source tests do not prove deployment. Before adoption, independently review the exact commit and build results, verify installed-version provenance, record a rollback, inspect current service work, and coordinate a safe service transition. Do not modify the installed bundle, role controls, live receipts or service process as part of source review. Verify the first real task, its original role status, and preserved foreign requests before declaring this operational issue resolved.

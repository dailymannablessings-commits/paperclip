/** Shared terminal-task rule. Queue age alone never authorizes discarding input. */
export function isStaleTerminalAssigneeWake(
  issue: { status: string; assigneeAgentId: string | null },
  wake: { agentId: string },
  shouldReopen: boolean,
): boolean {
  return !shouldReopen && (issue.status === 'done' || issue.status === 'cancelled') &&
    issue.assigneeAgentId !== null && wake.agentId === issue.assigneeAgentId;
}


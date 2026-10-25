import { describe, expect, it } from 'vitest';
import { isStaleTerminalAssigneeWake } from './terminal-wake.js';
describe('terminal assignee wake rule shared by queue recovery', () => {
  it('retains authorized reopening and foreign assignee input', () => {
    expect(isStaleTerminalAssigneeWake({status:'done',assigneeAgentId:'owner'}, {agentId:'owner'}, true)).toBe(false);
    expect(isStaleTerminalAssigneeWake({status:'done',assigneeAgentId:'owner'}, {agentId:'delegate'}, false)).toBe(false);
  });
  it('retains nonterminal and unassigned tasks', () => {
    for(const status of ['backlog','todo','in_progress','blocked','in_review'])
      expect(isStaleTerminalAssigneeWake({status,assigneeAgentId:'owner'}, {agentId:'owner'}, false)).toBe(false);
    expect(isStaleTerminalAssigneeWake({status:'done',assigneeAgentId:null}, {agentId:'owner'}, false)).toBe(false);
  });
  it('recognizes only terminal original assignee work with no reopen authority', () => {
    for(const status of ['done','cancelled'])
      expect(isStaleTerminalAssigneeWake({status,assigneeAgentId:'owner'}, {agentId:'owner'}, false)).toBe(true);
  });
});

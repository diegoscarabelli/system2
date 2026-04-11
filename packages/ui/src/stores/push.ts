/**
 * Push Store
 *
 * Lightweight Zustand store for WebSocket push notifications.
 * Each version counter is bumped when the server broadcasts a change.
 * UI components subscribe to the relevant counter and refetch data when it changes.
 */

import { create } from 'zustand';

interface AgentBusyState {
  busy: boolean;
  contextPercent: number | null;
}

interface PushStore {
  /** Incremented on board_changed (projects/tasks/links/comments). */
  boardVersion: number;
  /** Incremented on agents_changed (spawn/terminate/resurrect). */
  agentsVersion: number;
  /** Incremented on artifacts_changed. */
  artifactsVersion: number;
  /** Incremented on job_executions_changed. */
  jobsVersion: number;
  /** Per-agent busy state updated inline from agent_busy_changed (no refetch needed). */
  agentBusy: Map<number, AgentBusyState>;

  bumpBoard: () => void;
  bumpAgents: () => void;
  bumpArtifacts: () => void;
  bumpJobs: () => void;
  bumpAll: () => void;
  setAgentBusy: (agentId: number, busy: boolean, contextPercent: number | null) => void;
}

export const usePushStore = create<PushStore>((set) => ({
  boardVersion: 0,
  agentsVersion: 0,
  artifactsVersion: 0,
  jobsVersion: 0,
  agentBusy: new Map(),

  bumpBoard: () => set((s) => ({ boardVersion: s.boardVersion + 1 })),
  bumpAgents: () => set((s) => ({ agentsVersion: s.agentsVersion + 1 })),
  bumpArtifacts: () => set((s) => ({ artifactsVersion: s.artifactsVersion + 1 })),
  bumpJobs: () => set((s) => ({ jobsVersion: s.jobsVersion + 1 })),
  bumpAll: () =>
    set((s) => ({
      boardVersion: s.boardVersion + 1,
      agentsVersion: s.agentsVersion + 1,
      artifactsVersion: s.artifactsVersion + 1,
      jobsVersion: s.jobsVersion + 1,
    })),
  setAgentBusy: (agentId, busy, contextPercent) =>
    set((s) => {
      const next = new Map(s.agentBusy);
      next.set(agentId, { busy, contextPercent });
      return { agentBusy: next };
    }),
}));

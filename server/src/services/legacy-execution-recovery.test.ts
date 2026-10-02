import { expect, it } from "vitest";
import { issueHandoffStillOwned, legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

const committedHandoff = {
  id: "run-1", companyId: "company-1", agentId: "reviewer-1",
  runtimeMode: "legacy", status: "cancelled", errorCode: "issue_reassigned",
  contextSnapshot: { issueId: "issue-1" },
  resultJson: {
    reassignmentStopConfirmed: true,
    executionCancellation: { state: "acknowledged" },
    issueHandoff: { runId: "run-1", companyId: "company-1", agentId: "reviewer-1", issueId: "issue-1" },
  },
};

const handoffIssue = {
  id: "issue-1", companyId: "company-1", status: "in_review", statusVersion: 3,
  assigneeAgentId: "reviewer-1", assigneeUserId: null,
  executionState: { currentStageId: "review", roundCount: 1 }, executionPolicy: null,
  executionRunId: "run-1", checkoutRunId: "run-1",
};

it("allows its confirmed stop to clear only the source issue locks", () => {
  expect(issueHandoffStillOwned(handoffIssue, {
    ...handoffIssue, executionRunId: null, checkoutRunId: null,
  }, "run-1")).toBe(true);
});

it.each([
  { statusVersion: 4 }, { status: "blocked" }, { assigneeAgentId: "successor" },
  { assigneeUserId: "operator" }, { executionState: { currentStageId: "qa", roundCount: 1 } },
  { executionPolicy: { stages: [] } }, { executionRunId: "successor-run" },
  { checkoutRunId: "successor-run" },
])("rejects a stale handoff, including an A-to-B-to-A ownership change: %j", (change) => {
  expect(issueHandoffStillOwned(handoffIssue, { ...handoffIssue, ...change }, "run-1")).toBe(false);
});

it("does not replay or reconcile a confirmed run-authored handoff committed with the issue", () => {
  expect(legacyExecutionNeedsReconciliation(committedHandoff)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...committedHandoff, scheduledRetryAttempt: 8 })).toBe(false);
});

it.each([
  { runId: "another-run" }, { companyId: "another-company" },
  { agentId: "another-agent" }, { issueId: "another-issue" },
])("keeps mismatched handoff evidence held: %j", (mismatch) => {
  expect(legacyExecutionNeedsReconciliation({ ...committedHandoff, resultJson: {
    ...committedHandoff.resultJson,
    issueHandoff: { ...committedHandoff.resultJson.issueHandoff, ...mismatch },
  } })).toBe(true);
});

it("keeps reassignment held until both provider stop and committed handoff are recorded", () => {
  expect(legacyExecutionNeedsReconciliation({ ...committedHandoff, resultJson: {
    ...committedHandoff.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...committedHandoff, resultJson: {
    reassignmentStopConfirmed: true,
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...committedHandoff, resultJson: {
    ...committedHandoff.resultJson, reassignmentStopConfirmed: false,
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...committedHandoff, errorCode: "process_lost" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...committedHandoff, status: "failed" })).toBe(true);
});

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated"])("does not invent unknown provider actions after exhausted %s bootstrap retries", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "setup_failed" })).toBe(true);
});

it("permits subscription waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 12,
    resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
  } })).toBe(true);
});

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});

 it("continues a conversation without requiring receipts, even after automatic attempts are exhausted", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("retries a busy AI subscription only when no provider work started", () => {
   const waiting = { runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 10,
     resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } };
   expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
 });

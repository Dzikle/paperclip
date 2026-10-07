import { describe, expect, it } from "vitest";
import { projectTaskIntakeDefaults } from "../services/project-task-intake.js";
import { assertIssueUpdateVersion } from "../services/issue-update-version.js";

const lead = { id: "lead", companyId: "company", status: "idle", metadata: { taskIntake: true } };
const input = {
  companyId: "company",
  actorType: "user",
  body: { projectId: "project", status: "todo" },
  lead,
};

describe("opt-in project task intake", () => {
  it("assigns an unassigned board task before native creation/dispatch", () => {
    expect(projectTaskIntakeDefaults(input)).toEqual({ assigneeAgentId: "lead" });
  });
  it("keeps backlog work unassigned until it is started", () => {
    expect(projectTaskIntakeDefaults({
      ...input,
      body: { ...input.body, status: "backlog" },
    })).toEqual({});
  });
  it("does not change explicit assignments, children, policies or agent-created tasks", () => {
    for (const body of [{ assigneeAgentId: null }, { assigneeAgentId: "other" },
      { assigneeUserId: "owner" }, { parentId: "parent" }, { executionPolicy: { mode: "normal" } }]) {
      expect(projectTaskIntakeDefaults({ ...input, body: { ...input.body, ...body } })).toEqual({});
    }
    expect(projectTaskIntakeDefaults({ ...input, actorType: "agent" })).toEqual({});
  });
  it("is inert without opt-in and rejects foreign/archived/non-invokable leads", () => {
    expect(projectTaskIntakeDefaults({ ...input, lead: { ...lead, metadata: null } })).toEqual({});
    for (const changed of [{ companyId: "other" }, { status: "paused" }, { status: "error" },
      { metadata: { taskIntake: true, archived: true } }]) {
      expect(() => projectTaskIntakeDefaults({ ...input, lead: { ...lead, ...changed } })).toThrow();
    }
  });
});

describe("conditional issue update", () => {
  it("accepts omitted/current versions and rejects stale snapshots", () => {
    expect(() => assertIssueUpdateVersion(3, undefined)).not.toThrow();
    expect(() => assertIssueUpdateVersion(3, 3)).not.toThrow();
    expect(() => assertIssueUpdateVersion(3, 2)).toThrow("changed");
  });
});

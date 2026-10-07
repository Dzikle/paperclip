import { conflict } from "../errors.js";

export function assertIssueUpdateVersion(current: number, expected?: number): void {
  if (expected !== undefined && current !== expected) {
    throw conflict("Task ownership or status changed; refresh before updating", {
      code: "issue_update_version_conflict", expectedStatusVersion: expected, statusVersion: current,
    });
  }
}

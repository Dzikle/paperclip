type IntakeAgent = {
  id: string;
  companyId: string;
  status: string;
  metadata: Record<string, unknown> | null;
};

/** Opt-in project leads receive otherwise unassigned board work before dispatch. */
export function projectTaskIntakeDefaults(input: {
  companyId: string;
  actorType: string;
  body: Record<string, unknown>;
  lead: IntakeAgent | null;
}): { assigneeAgentId?: string } {
  const { body, lead } = input;
  if (
    input.actorType !== "user" ||
    !body.projectId ||
    body.status !== "todo" ||
    body.parentId ||
    body.executionPolicy ||
    Object.hasOwn(body, "assigneeAgentId") ||
    Object.hasOwn(body, "assigneeUserId") ||
    lead?.metadata?.taskIntake !== true
  )
    return {};
  if (
    lead.companyId !== input.companyId ||
    lead.metadata.archived === true ||
    lead.metadata.runtimeBindingHidden === true ||
    !["active", "idle", "running"].includes(lead.status)
  ) {
    throw new Error("The project task intake agent is unavailable; resume or configure its lead before starting work");
  }
  return { assigneeAgentId: lead.id };
}

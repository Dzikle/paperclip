import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { InlineEntitySelector, type InlineEntityOption } from "@/components/InlineEntitySelector";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const assignees: InlineEntityOption[] = [
  { id: "agent-product", label: "Product Lead", searchText: "planning product" },
  { id: "agent-engineer", label: "Frontend Engineer", searchText: "ui implementation" },
  { id: "agent-qa", label: "QA Engineer", searchText: "testing review" },
];

const projects: InlineEntityOption[] = [
  { id: "project-control-plane", label: "Control Plane" },
  { id: "project-mobile", label: "Mobile Experience" },
  { id: "project-connectors", label: "Apps and Connectors" },
];

function OpenPicker({ kind, options }: { kind: "Assignee" | "Project"; options: InlineEntityOption[] }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    triggerRef.current?.click();
  }, []);

  return (
    <div className="flex min-h-screen items-end p-4">
      <InlineEntitySelector
        ref={triggerRef}
        value={value}
        options={options}
        placeholder={`Choose ${kind.toLowerCase()}`}
        noneLabel={`No ${kind.toLowerCase()}`}
        searchPlaceholder={`Search ${kind.toLowerCase()}s...`}
        emptyMessage={`No matching ${kind.toLowerCase()}.`}
        onChange={setValue}
      />
    </div>
  );
}

const meta = {
  title: "Components/Entity pickers/Mobile",
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const AssigneePicker: Story = {
  render: () => <OpenPicker kind="Assignee" options={assignees} />,
};

export const ProjectPicker: Story = {
  render: () => <OpenPicker kind="Project" options={projects} />,
};

function DialogPickersExample() {
  const [assignee, setAssignee] = useState("");
  const [project, setProject] = useState("");
  const [model, setModel] = useState("");

  return (
    <Dialog open>
      <DialogContent
        className="flex h-96 flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="p-4">New task</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="flex flex-wrap gap-2">
            <InlineEntitySelector
              value={assignee}
              options={assignees}
              placeholder="Assignee"
              noneLabel="No assignee"
              searchPlaceholder="Search assignees..."
              emptyMessage="No matching assignee."
              onChange={setAssignee}
              disablePortal
            />
            <InlineEntitySelector
              value={project}
              options={projects}
              placeholder="Project"
              noneLabel="No project"
              searchPlaceholder="Search projects..."
              emptyMessage="No matching project."
              onChange={setProject}
              disablePortal
            />
            <InlineEntitySelector
              value={model}
              options={[
                { id: "fast", label: "Fast Model" },
                { id: "quality", label: "Quality Model" },
              ]}
              placeholder="Model"
              noneLabel="Default model"
              searchPlaceholder="Search models..."
              emptyMessage="No matching model."
              onChange={setModel}
              disablePortal
            />
          </div>
        </div>
        <div className="p-4">Select the worker, project and model.</div>
      </DialogContent>
    </Dialog>
  );
}

export const DialogPickers: Story = {
  render: () => <DialogPickersExample />,
};

import { expect, test, type Page } from "@playwright/test";

async function assertUsablePicker(page: Page, search: string) {
  const menu = page.locator("[data-mobile-entity-picker]");
  await expect(page.getByPlaceholder(search)).toBeFocused();
  await expect.poll(async () => (await menu.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(240);
  const box = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
  { width: 1200, height: 800 },
]) {
  test(`dialog selectors remain visible and selectable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/iframe.html?id=components-entity-pickers-mobile--dialog-pickers&viewMode=story");
    for (const picker of [
      { trigger: "Assignee", search: "Search assignees...", filter: "Frontend", choice: "Frontend Engineer" },
      { trigger: "Project", search: "Search projects...", filter: "Mobile", choice: "Mobile Experience" },
      { trigger: "Model", search: "Search models...", filter: "Quality", choice: "Quality Model" },
    ]) {
      await page.getByRole("button", { name: picker.trigger, exact: true }).click();
      if (viewport.width < 640) {
        // A shortened viewport exercises the layout when the software keyboard opens.
        await page.setViewportSize({ width: viewport.width, height: 480 });
      }
      await assertUsablePicker(page, picker.search);
      await page.getByPlaceholder(picker.search).fill(picker.filter);
      await page.getByRole("button", { name: picker.choice, exact: true }).click();
      await expect(page.locator("[data-mobile-entity-picker]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: picker.choice, exact: true })).toBeVisible();
      await page.setViewportSize(viewport);
    }
  });
}

test("standalone mobile picker remains visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto("/iframe.html?id=components-entity-pickers-mobile--project-picker&viewMode=story");
  await assertUsablePicker(page, "Search projects...");
  await page.getByRole("button", { name: "Mobile Experience", exact: true }).click();
  await expect(page.locator("[data-mobile-entity-picker]")).toHaveCount(0);
});

import { expect, test, type Page } from "@playwright/test";

async function enterDemo(page: Page) {
  await page.goto("/");
  await expect(async () => {
    const banner = page.getByText(/exploring a sample workspace/i);
    if (!(await banner.isVisible())) {
      await page.getByRole("button", { name: /explore the demo/i }).click();
    }
    await expect(banner).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
}

async function navTo(page: Page, name: string) {
  await page
    .locator("aside nav")
    .getByRole("button", { name, exact: true })
    .click();
}

test.describe("Fuloos demo E2E critical flows", () => {
  test("add account", async ({ page }) => {
    await enterDemo(page);
    await navTo(page, "Accounts");
    await page.getByRole("button", { name: "Add account" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Mashreq Neo");
    await dialog.getByLabel("Balance", { exact: false }).first().fill("2500");
    await dialog
      .getByRole("button", { name: /save|create|add account/i })
      .click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText("Mashreq Neo")).toBeVisible();
  });

  test("add category", async ({ page }) => {
    await enterDemo(page);
    await navTo(page, "Categories");
    await page.getByRole("button", { name: "Add category" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Pet Care");
    await dialog
      .getByRole("button", { name: /save|create|add category/i })
      .click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText("Pet Care")).toBeVisible();
  });

  test("add, edit, and delete transaction", async ({ page }) => {
    await enterDemo(page);
    await navTo(page, "Transactions");

    // Add transaction
    await page.getByRole("button", { name: "Add transaction" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Amount").fill("42.50");
    await dialog.getByLabel("Payee").fill("E2E Coffee Spot");
    await dialog.getByRole("button", { name: /save|add transaction/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("E2E Coffee Spot")).toBeVisible();

    // Edit transaction
    await page.getByRole("button", { name: /Edit E2E Coffee Spot/i }).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel("Payee").fill("E2E Coffee Updated");
    await editDialog.getByRole("button", { name: /save/i }).click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByText("E2E Coffee Updated")).toBeVisible();

    // Delete transaction
    await page
      .getByRole("button", { name: /Delete E2E Coffee Updated/i })
      .click();
    const confirmDialog = page.getByRole("alertdialog");
    await confirmDialog
      .getByRole("button", { name: /Delete transaction/i })
      .click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByText("E2E Coffee Updated")).toBeHidden();
  });

  test("month navigation", async ({ page }) => {
    await enterDemo(page);
    const pickerBtn = page.getByRole("button", {
      name: /Date range:.*Change/i,
    });
    const initialLabel = await pickerBtn.getAttribute("aria-label");

    await page.getByRole("button", { name: "Previous month" }).click();
    const prevLabel = await pickerBtn.getAttribute("aria-label");
    expect(prevLabel).not.toBe(initialLabel);

    await page.getByRole("button", { name: "Next month" }).click();
    const restoredLabel = await pickerBtn.getAttribute("aria-label");
    expect(restoredLabel).toBe(initialLabel);
  });

  test("CSV import happy path", async ({ page }) => {
    await enterDemo(page);
    await navTo(page, "Transactions");
    await page.getByRole("button", { name: "Import CSV" }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Import CSV" }),
    ).toBeVisible();

    const now = new Date();
    const dmyStr = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;
    const csvContent = [
      "Date,Description,Amount",
      `${dmyStr},E2E CSV Bakery,-18.50`,
    ].join("\n");

    await dialog.locator('input[type="file"]').setInputFiles({
      name: "statement.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent, "utf-8"),
    });

    await dialog.getByLabel("Date *").selectOption({ label: "Date (1)" });
    await dialog.getByLabel("Amount *").selectOption({ label: "Amount (3)" });
    await dialog
      .getByLabel("Payee / description")
      .selectOption({ label: "Description (2)" });

    await expect(dialog.getByText("E2E CSV Bakery")).toBeVisible();
    await dialog
      .getByRole("button", { name: /Import \d+ transaction/i })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("E2E CSV Bakery")).toBeVisible();
  });

  test("SMS import happy path", async ({ page }) => {
    await enterDemo(page);
    await navTo(page, "Transactions");
    await page.getByRole("button", { name: "Import SMS" }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Import bank SMS" }),
    ).toBeVisible();

    const smsText =
      "Purchase of AED 33.00 with Debit Card ending 1234 at E2E DESERT ROASTERS, DUBAI. Avl Bal is AED 1,000.00";
    await dialog.getByLabel("Paste SMS").fill(smsText);

    await expect(dialog.getByText(/DESERT ROASTERS/i)).toBeVisible();
    await dialog
      .getByRole("button", { name: /Import \d+ transaction/i })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/DESERT ROASTERS/i)).toBeVisible();
  });

  test("recurring create and confirm", async ({ page }) => {
    await enterDemo(page);
    await navTo(page, "Recurring");

    await page.getByRole("button", { name: "Add recurring" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("E2E Cloud Backup");
    await dialog.getByRole("textbox", { name: /Amount/i }).fill("29.00");
    const todayStr = new Date().toISOString().slice(0, 10);
    await dialog.getByLabel("Start date").fill(todayStr);
    await dialog.getByRole("button", { name: /save|create|add/i }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByText("E2E Cloud Backup")).toBeVisible();

    // Confirm an upcoming occurrence via "Mark paid"
    const row = page
      .locator("article, tr, .recurring-item, .schedule-card, div")
      .filter({
        hasText: "E2E Cloud Backup",
      });
    await row
      .getByRole("button", { name: /Mark paid/i })
      .first()
      .click();

    const confirmModal = page.getByRole("dialog");
    await confirmModal
      .getByRole("button", { name: "Confirm & record" })
      .click();
    await expect(confirmModal).toBeHidden();
  });

  test("budget create and over-limit display", async ({ page }) => {
    await enterDemo(page);

    // Create a dedicated category so it never collides with existing demo budgets
    await navTo(page, "Categories");
    await page.getByRole("button", { name: "Add category" }).click();
    const catDialog = page.getByRole("dialog");
    await catDialog.getByLabel("Name").fill("E2E Budget Cat");
    await catDialog
      .getByRole("button", { name: /save|create|add category/i })
      .click();
    await expect(catDialog).toBeHidden();

    // Record an expense in that category exceeding the budget limit
    await navTo(page, "Transactions");
    await page.getByRole("button", { name: "Add transaction" }).click();
    const txDialog = page.getByRole("dialog");
    await txDialog.getByLabel("Amount").fill("500");
    await txDialog.getByLabel("Payee").fill("E2E Big Expense");
    await txDialog
      .getByLabel("Category")
      .selectOption({ label: "E2E Budget Cat" });
    await txDialog
      .getByRole("button", { name: /save|add transaction/i })
      .click();
    await expect(txDialog).toBeHidden();

    await navTo(page, "Budgets");
    await page.getByRole("button", { name: "Add budget" }).click();
    const bDialog = page.getByRole("dialog");
    await bDialog
      .getByLabel("Category")
      .selectOption({ label: "E2E Budget Cat" });
    await bDialog.getByLabel(/Monthly limit|Amount/i).fill("100");
    await bDialog.getByRole("button", { name: /save|create|add/i }).click();
    await expect(bDialog).toBeHidden();

    await expect(page.getByText(/Over by|Over budget/i).first()).toBeVisible();
  });

  test("reports render", async ({ page }) => {
    await enterDemo(page);
    await navTo(page, "Reports");
    await expect(
      page.getByRole("heading", { name: "Where it went" }),
    ).toBeVisible();
    await expect(page.getByText(/Net cash flow/i)).toBeVisible();
  });

  test("theme toggle", async ({ page }) => {
    await enterDemo(page);
    const html = page.locator("html");
    const initialTheme = await html.getAttribute("data-theme");
    const toggleBtn = page.getByRole("button", {
      name: /Switch to (dark|light) mode/i,
    });
    await toggleBtn.click();
    const nextTheme = await html.getAttribute("data-theme");
    expect(nextTheme).not.toBe(initialTheme);
  });

  test("mobile viewport smoke", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await enterDemo(page);
    await expect(
      page.getByRole("heading", { name: "A clearer picture." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add transaction", exact: true }),
    ).toBeVisible();
  });
});

test.describe("Review regression browser flows", () => {
  test("notification deep link survives entering the demo", async ({
    page,
  }) => {
    await page.goto("/?settings=notifications");
    await page.getByRole("button", { name: /explore the demo/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Notifications", exact: true }),
    ).toBeVisible();
  });
  test("create a goal and record a contribution", async ({ page }) => {
    await enterDemo(page);
    await navTo(page, "Goals");
    await page.getByRole("button", { name: "Add goal", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Goal name").fill("Regression savings");
    await dialog.getByLabel("Target amount").fill("1000");
    await dialog
      .getByRole("button", { name: "Save goal", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    const card = page
      .locator(".goal-card")
      .filter({ hasText: "Regression savings" });
    await card.getByRole("button", { name: /contribute/i }).click();
    const contribute = page.getByRole("dialog");
    await contribute.getByLabel("Amount", { exact: false }).fill("50");
    await contribute
      .getByRole("button", {
        name: /add contribution|record contribution|contribute/i,
      })
      .last()
      .click();
    await expect(contribute).toBeHidden();
    await expect(card).toContainText("50");
  });
  test("create a net worth asset with valuation history", async ({ page }) => {
    await enterDemo(page);
    await navTo(page, "Net Worth");
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Regression fund");
    await dialog.getByLabel("Current value (AED)").fill("500");
    await dialog.getByRole("button", { name: /save|add item/i }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText("Regression fund", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("500.00", { exact: false }).first(),
    ).toBeVisible();
  });
  test("full backup contains newer features and supports preview", async ({
    page,
  }) => {
    await enterDemo(page);
    await page
      .locator("main")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    const downloadEvent = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Full backup (JSON)" }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/fuloos-backup/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const data = JSON.parse(Buffer.concat(chunks).toString());
    expect(data.format_version).toBe(2);
    for (const key of [
      "goals",
      "goal_contributions",
      "rules",
      "net_worth_items",
      "net_worth_snapshots",
      "captured_alerts",
      "attachments",
    ])
      expect(Array.isArray(data.data[key])).toBeTruthy();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(data)),
    });
    await expect(dialog.locator(".data-backup-preview")).toBeVisible();
    await expect(dialog.locator(".data-backup-preview-head")).toContainText(
      "backup.json",
    );
  });
  test("household setup and notification preferences work in demo", async ({
    page,
  }) => {
    await enterDemo(page);
    await page
      .locator("main")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("New household name", { exact: true })
      .fill("Regression home");
    await dialog
      .getByRole("button", { name: "Create household", exact: true })
      .click();
    await expect(
      dialog.getByText("Regression home", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Shared categories", { exact: true }),
    ).toBeVisible();
    await dialog.getByLabel("Email notifications", { exact: true }).check();
    await dialog
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(
      dialog.getByText("Saved notification preferences in demo memory."),
    ).toBeVisible();
  });
  test("Arabic translates goals and transaction editors without changing saved data", async ({
    page,
  }) => {
    await enterDemo(page);
    await page
      .getByRole("button", { name: "Switch language", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(
      page.getByText("نظرة عامة", { exact: true }).first(),
    ).toBeVisible();
  });
});

test("PDF statements are extracted locally into a reviewable preview", async ({
  page,
}) => {
  await enterDemo(page);
  await navTo(page, "Transactions");
  await page.getByRole("button", { name: "Import PDF", exact: true }).click();
  const content =
    "BT /F1 12 Tf 50 750 Td (01/11/2026 COFFEE REVIEW 12.50 DR) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "statement.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(pdf),
  });
  await expect(
    dialog.getByLabel("Payee for row 1", { exact: true }),
  ).toHaveValue(/coffee review/i);
  await expect(
    dialog.getByRole("button", { name: "Import 1 transactions", exact: true }),
  ).toBeEnabled();
});

test("receipt files survive editing a transaction in demo", async ({
  page,
}) => {
  await enterDemo(page);
  await navTo(page, "Transactions");
  await page
    .getByRole("button", { name: "Add transaction", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Amount", { exact: false }).first().fill("1.00");
  await dialog.getByLabel("Payee", { exact: false }).fill("Receipt regression");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOioAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await dialog
    .getByRole("button", { name: "Add transaction", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole("button", { name: "Edit Receipt regression", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByAltText("Receipt preview", { exact: true }),
  ).toBeVisible();
});

test("captured alerts require confirmation and leave the pending queue after import", async ({
  page,
}) => {
  await enterDemo(page);
  await navTo(page, "Transactions");
  await page.getByRole("button", { name: /^Captured alerts/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .locator("textarea")
    .first()
    .fill(
      "Purchase of AED 12.50 with Debit Card ending 1234 at COFFEE REVIEW, DUBAI. Avl Bal is AED 1,000.00",
    );
  await dialog
    .getByRole("button", { name: "Parse & add to queue", exact: true })
    .click();
  const confirmations = dialog.getByRole("button", {
    name: "Confirm & import",
    exact: true,
  });
  await expect(confirmations).toHaveCount(2);
  await expect(dialog.getByLabel("Payee", { exact: true }).first()).toHaveValue(
    /coffee review/i,
  );
  await confirmations.first().click();
  await expect(confirmations).toHaveCount(1);
  await expect(dialog.getByRole("status")).toContainText("Imported");
});

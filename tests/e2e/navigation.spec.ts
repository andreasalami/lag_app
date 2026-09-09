import { expect, test } from "@playwright/test";

test("la home e le destinazioni pubbliche principali sono raggiungibili", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "L'Agro ai Giovani" })).toBeVisible();
  await page.goto("./#tabellone");
  await expect(page.locator("main")).toBeVisible();
});

test("le pagine operative rifiutano un visitatore anonimo", async ({ page }) => {
  for (const [route, title] of [["cassa", "Casse"], ["cucina", "Cucina"], ["bar", "Bar"]]) {
    await page.goto(`./#${route}`);
    await expect(page.getByRole("heading", { name: `${title}: accesso riservato` })).toBeVisible();
  }
});

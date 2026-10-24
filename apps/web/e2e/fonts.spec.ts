import { expect, test } from "./fixtures";

// The app uses Roboto (self-hosted by next/font) for our own text AND for React Suite components.
test("Roboto is the font of the page and of React Suite components", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle").catch(() => {});
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const family = (el: Element | null) => (el ? getComputedStyle(el).fontFamily : "");
    return {
      body: family(document.body),
      heading: family(document.querySelector("h1")),
      rsuiteButton: family(document.querySelector(".rs-btn")),
      rsuiteInput: family(document.querySelector(".rs-input")),
      loaded: document.fonts.check('16px Roboto') && [...document.fonts].some((f) => f.family.includes("Roboto") && f.status === "loaded"),
    };
  });
  for (const k of ["body", "heading", "rsuiteButton", "rsuiteInput"] as const) expect(fonts[k], k).toMatch(/Roboto|--font-roboto|__Roboto/i);
  expect(fonts.loaded, "the Roboto font files were downloaded and are in use").toBe(true);
});

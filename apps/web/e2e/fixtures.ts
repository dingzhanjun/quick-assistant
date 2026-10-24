import { test as base, expect } from "@playwright/test";

export { expect };

// Next streams the content of Suspense boundaries into `<div hidden id="S:n">` placeholders and only removes them a moment
// after the `load` event. Until then the page holds a HIDDEN COPY of its text, and Playwright's strict locators such as
// getByText(...) see two elements and fail at once (it does not retry a strict-mode violation). The effect depends on speed:
// invisible on a fast laptop, constant on a CI runner. So navigation in every spec waits for the placeholders to be gone.
const settled = () => !document.querySelector('div[hidden][id^="S:"]');

export const test = base.extend({
  page: async ({ page }, provide) => {
    const wait = () => page.waitForFunction(settled, undefined, { timeout: 15_000 }).catch(() => {});
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (url, options) => {
      const res = await goto(url, options);
      await wait();
      return res;
    };
    page.reload = async (options) => {
      const res = await reload(options);
      await wait();
      return res;
    };
    await provide(page);
  },
});

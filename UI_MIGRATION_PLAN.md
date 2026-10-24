# Plan: replace shadcn/ui with React Suite (rsuite)

Status: **ALL PHASES (0-7) DONE on branch `ui/rsuite` (2026-10-20).**
Only the decision to merge `ui/rsuite` into `dev` is left. Numbers below were counted from
the code on 2026-10-20.

## Decisions (from the owner, 2026-10-20)

- **Why:** rsuite's rich components (pickers, toaster, modal, ...).
- **Dark mode: required.** Light / dark / follow the system; implemented in the spike (next-themes + `CustomProvider`).
- **Tailwind: keep it** for layout (it coexists, see the spike result).
- **No native `<select>`:** use rsuite `SelectPicker` (searchable off for short lists) everywhere; the 6 remaining native selects are
  converted in phase 4 and the e2e `selectOption` calls become click-the-picker helpers.
- Theme: rsuite's own look (blue primary) in light and dark; not re-skinned to the old monochrome unless asked later.

## Phase 0 result (spike), what was learned

Built on the branch: `Providers` (next-themes + rsuite `CustomProvider`), CSS layering, adapters for `Button`, `Input`,
`Textarea`, `Switch`, `Dialog`, `ConfirmButton` (rsuite `Modal` with `role="alertdialog"`), a `toast` shim on rsuite
`toaster`/`Message`, and `SelectPicker` for the printer paper/copies. The e2e suite, the visual baseline (32 screenshots, light and
dark) and `next build` all run on it. Findings:

1. **CSS layer order matters.** `@layer theme, base, rsuite, components, utilities;` with
   `@import "rsuite/dist/rsuite-no-reset.min.css" layer(rsuite);`. rsuite must sit ABOVE Tailwind `base` (preflight's
   `button { background: none }` otherwise wipes its styles: the first attempt rendered unstyled buttons and an unpositioned
   modal) and BELOW `utilities` (so `w-full`, `mt-2` etc. still win). **Tailwind is compatible.**
2. **Dark mode works** for rsuite components and our Tailwind tokens together: next-themes sets the `dark` class on `<html>`,
   `CustomProvider theme` follows it (light before hydration, so no mismatch). A visible theme switch is still to be added (phase 1).
3. **Server / client boundary:** every rsuite component ships `"use client"` and per-component imports (`rsuite/Button`) work in
   the App Router. A helper that server components call must NOT live in a `"use client"` file (`buttonVariants` in the audit page
   broke this way): such helpers are now plain modules (`ui/button-variants.ts`).
4. **`Toggle` names itself.** It overrides `aria-label` / external `<label for>`; give it rsuite's `label` prop (visible), or a
   visually hidden `label` for switches without a caption. The adapter does this; 5 call sites changed from `Switch + Label` to
   `Switch label=...`. Also: Toggle is `inline-flex`, so wrap it in a block when a button follows.
5. **Modal supports `role="alertdialog"`**, focus return and Escape: all 20 e2e `alertdialog` assertions keep passing.
6. **Bundle (gzipped, all chunks):** JS 320 KB -> 337 KB (+16 KB), CSS 10 KB -> 66 KB (+56 KB): about +72 KB in total. The CSS can
   shrink later with per-component style imports if needed.
7. **Test fallout was small:** `getByText("Burger X")` also matched the new hidden switch label (use `exact`); a streamed
   server-rendered message can briefly exist twice (hidden copy), so `.first()` on those assertions. Everything else (59 button
   role selectors, 21 `getByLabel`, tabs, rows, the real Go agent spec) passed unchanged.
8. Playwright cannot click a `Toggle`'s real input (the visible track sits on top of it; users click the track, which works): the
   e2e uses `click({ force: true })` on switches.
9. Machine load makes the live-board timing test flaky (unrelated to the UI library).

**Go / no-go: GO.** No blocker found; the adapter strategy works.

## Phase 1 result (foundation), done

- Adapters on rsuite: `Button`, `Input`, `Textarea`, `Switch` (Toggle), `Card` (Panel), `Dialog` / `ConfirmButton` (Modal), `Select`
  (SelectPicker, the only select component: no native `<select>`), `toast` shim (toaster + Message). `Label` and `Table` stay plain
  styled elements (see the mapping).
- **Theme switch** in the user menu (`ThemeToggle`: Light / Dark / System, remembered, applied before first paint); e2e covers it.
- Tailwind's accent tokens (`--primary`, `--destructive`) now come from rsuite's variables, so `text-primary` / `border-primary`
  match the components in light and dark.
- Removed now-unused packages and files: `shadcn`, `@base-ui/react`, `class-variance-authority`, `sonner`, `tw-animate-css`,
  `lucide-react` (215 packages less in the lockfile), `components.json`, the shadcn / animate CSS imports.
- Top navs wrap on phones (the theme switch made them overflow at 375 px).
- Bundle (gzipped, all chunks): JS 320 KB -> 371 KB, CSS 10 KB -> 65 KB; the extra JS is Panel, Dropdown and SelectPicker.
- Checks: unit 81/81, e2e 15/15, lint, tsc, build.
- (done in phase 4, see below) Remaining native selects were: audit filters (3), hours (2), LLM settings, menu editor, restaurant switcher; plus radio /
  checkbox / `<details>` controls.

## 0. Why, and what it costs (read first)

shadcn/ui is not a dependency: its components are copied into `apps/web/src/components/ui` (10 files, about 750 lines,
built on `@base-ui/react` + Tailwind + `class-variance-authority`) and **we own them**. React Suite is a real dependency
(`rsuite` 6.2.5, peers `react >= 18`, so React 19 is fine) with its own look, its own CSS and its own API.

Possible gains: a bigger ready-made set (DatePicker / TimeRangePicker for opening hours, SelectPicker, Table, Notification,
Steps, Uploader), one maintained theme system, less UI code of our own. Real costs: a visibly different look (blue,
rounded, denser) unless themed, a CSS-in-addition to Tailwind, a heavier bundle, a different accessibility / DOM structure
that the e2e tests depend on, and 6-9 working days. **If the reason is "I like the look / need pickers", this is worth
it; if the reason is "shadcn is a pain", fixing the 10 files is cheaper.** Confirm the reason before starting (section 9).

## 1. What there is to migrate

| Thing | Count |
|---|---|
| Files importing `components/ui/*` | 21 (auth pages 4, dashboard 8, admin 5, shared components 4) |
| `button` / `input` / `label` / `switch` / `table` / `card` / `dialog` / `textarea` / `alert-dialog` / `sonner` | 20 / 13 / 9 / 4 / 4 / 2 / 2 / 1 / 1 / 1 files |
| `ConfirmButton` (our wrapper on alert-dialog) | used in 8 places |
| `toast.*` calls (sonner) | 39 calls in 13 files |
| Plain HTML controls that are not shadcn (`select`, radio, checkbox, `details`) | 13 (audit filters 3, printing 5, hours 2, menu editor 1, LLM settings 1, restaurant switcher 1) |
| Tailwind `className=` usages (layout, spacing, colour) | 374 |
| Dark mode | tokens exist in `globals.css` but **nothing ever sets `.dark`**: the app is effectively light-only |
| e2e selectors that depend on roles / labels | 59 `button`, 21 `getByLabel`, 20 `alertdialog`, 5 `heading`, 3 `tab`, 2 `row`, 1 `switch`, 1 `cell` |
| Other UI deps to drop at the end | `@base-ui/react`, `class-variance-authority`, `shadcn`, `sonner`, `tw-animate-css`, `lucide-react` (only used inside `ui/`) |

## 2. Strategy: an adapter layer, not a big-bang rewrite

Keep the file names and prop APIs of `src/components/ui/*` and **swap their insides to rsuite**. The 21 call sites then barely
change, every phase can be merged on its own, and tests keep running. Only afterwards (optional, last) are call sites moved
to rsuite components directly. Tailwind stays for layout (`flex`, `gap`, `p-4`, ...); rsuite supplies the components.

### Component mapping

| shadcn (ours) | React Suite | Notes |
|---|---|---|
| `Button` (`variant`: default / outline / ghost / destructive, `size`: xs / sm / default / icon) | `Button` (`appearance`: primary / default / ghost / subtle, `color="red"`, `size`: xs / sm / md) | Adapter maps variants; `loading` replaces our `disabled={pending}` spinner use. |
| `Input` | `Input` | Controlled `onChange(value, event)` signature differs: adapter keeps the DOM-style `onChange(e)`. |
| `Textarea` | `Input as="textarea"` | |
| `Label` | `Form.ControlLabel` inside `Form.Group controlId` (or a plain `<label htmlFor>`) | **Must keep the `for`/`id` link**: 21 e2e tests use `getByLabel`. |
| `Switch` | `Toggle` | Needs `aria-label` to stay findable by `getByRole("switch", { name })`. |
| `Card` | `Panel` (`bordered`, `header`) | |
| `Table` (HTML `<table>`) | **decision**: rsuite `Table` is a virtualised div grid (`role=grid`, fixed height), poor for our short responsive lists. Recommend: keep semantic `<table>` styled with rsuite CSS variables for menu / admin / audit; use rsuite `Table` nowhere. | e2e uses `row` / `cell`. |
| `Dialog` / `AlertDialog` / `ConfirmButton` | `Modal` (+ `Modal.Header/Body/Footer`) | Must verify `role="alertdialog"` can be set (20 e2e assertions). |
| `sonner` `toast.success/error` | `useToaster().push(<Message type="success">)` | One `toast` shim in `lib/toast.ts` keeps the 39 call sites unchanged. |
| settings tabs (our own `tabs.tsx`) | `Nav appearance="tabs"` with `as={Link}` | Keep `role=tab` + `aria-selected`. |
| native `<select>` | `SelectPicker` (searchable) or keep native | e2e uses `selectOption` on the audit filters; decide per control (section 9). |
| `<details>` (setup files) | `Panel collapsible` | |
| lucide icons | `@rsuite/icons` (or keep lucide) | Only 2 files use them. |

## 3. Technical risks to settle in the spike

1. **Server vs client components.** Our pages are server components that render client components. rsuite components are client
   components; confirm they can be imported from client files without `"use client"` problems and that nothing pulls them into a
   server component. The adapter files all start with `"use client"`, which is the mitigation.
2. **CSS cohabitation.** Use `rsuite/dist/rsuite-no-reset.min.css` (no global reset: Tailwind's preflight stays) and load it in a
   cascade layer (`@import "rsuite/dist/rsuite-no-reset.min.css" layer(rsuite);`) so Tailwind utilities always win. Remove
   `shadcn/tailwind.css` and `tw-animate-css`. Check that `cacheComponents` / Turbopack handle the import (rsuite documents a
   Next.js App Router setup, `CustomProvider` in the root layout).
3. **Theme.** rsuite 6 themes with CSS variables (`--rs-*`) and `CustomProvider theme="light|dark|high-contrast"`. Decide: accept
   the default blue, or override `--rs-color-primary`, radius and font to our current monochrome look. Dark mode is not used today.
4. **Accessibility / DOM differences** that break e2e: modal role, toggle role + name, label association, tab roles, `Message`
   toasts vs sonner's (our tests look for toast text with `getByText`).
5. **Bundle size and CSP.** Measure `next build` route sizes before / after (import per component, e.g. `rsuite/Button`, not the
   barrel). Our CSP already allows inline styles; confirm rsuite needs nothing more (fonts, data URIs).
6. **React 19 / `act` warnings** in dev and in Playwright console output.
7. **Mobile widths.** The dashboard is used on tablets and phones (orders board): re-check layouts at 375 / 768 px.

## 4. Phases

| # | Phase | Work | Days |
|---|---|---|---|
| 0 | **Spike + baseline** (go / no-go) | Install `rsuite` next to shadcn. Capture Playwright **baseline screenshots** of every page (we have no visual tests today). Build one real page (the sign-in form + the settings General tab) with rsuite through adapters. Verify risks 1-7. Write down the go / no-go result. | 1 |
| 1 | **Foundation** | `Providers` client component with `CustomProvider` in `layout.tsx`; CSS layer + theme variables; `lib/toast.ts` shim replacing `sonner`'s `Toaster`; adapters for `Button`, `Input`, `Textarea`, `Label`/field, `Switch`, `Card`. Delete the matching shadcn files as each adapter lands. | 1.5 |
| 2 | **Overlays** | `Dialog` + `ConfirmButton` on `Modal` (keep the `alertdialog` role, Cancel / confirm buttons, focus return); `user-menu`. | 0.5-1 |
| 3 | **Tables** | Menu, modifiers, admin tenants, audit log, block list: styled semantic tables. | 1 |
| 4 | **Forms and pickers** | The 13 native controls (selects, radios, checkbox, details). Opening-hours editor with `TimeRangePicker` if wanted. | 1-1.5 |
| 5 | **Pages**, lowest risk last | Auth (4 pages) -> orders board -> menu / modifiers -> settings tabs (General, Team, Kitchen printing) -> admin (+ print agents panel). Visual compare against the baseline at each step. | 1.5-2 |
| 6 | **Cleanup** | Remove `@base-ui/react`, `class-variance-authority`, `shadcn`, `sonner`, `tw-animate-css`, `lucide-react`, `components.json`, unused tokens in `globals.css`; update `CLAUDE.md` ("UI: ...") and the Settings note; refresh e2e selectors. | 0.5-1 |
| 7 | **QA** | Full unit + e2e + Go tests, `next build` size comparison, manual pass at phone / tablet / desktop widths, keyboard-only pass on dialogs and tabs, screenshots vs baseline. | 1 |
| | **Total** | | **about 6-9 days** |

## 5. Test changes

- Keep behaviour tests as they are; only selectors change. Expect edits in: `alertdialog` (if the Modal role differs), `switch`
  name, `row` / `cell` (if tables change), toasts, `selectOption` (if selects become pickers), and the `div.rounded-lg.border`
  locators in `print.spec.ts` (these depend on shadcn class names: replace with `data-testid`s now, in phase 0).
- Add `data-testid` or stable roles where tests currently lean on classes (`p.font-mono`, `input[value='Kitchen']`).
- Add a screenshot smoke test per page (desktop + 375 px) so later UI changes are visible in review.

## 6. Rollback

Work on a branch. Because the adapters keep the `components/ui` API, reverting any single phase is a `git revert` of that
phase; shadcn and rsuite coexist (CSS is layered and the toast shim is introduced first, so there is never more than one
toast system). Do not start phase 5 until phases 1-4 are green.

## 7. Things that get better

- Pickers for time and date (opening hours, audit date filters) with proper keyboard and mobile behaviour.
- One notification / message component family, one theme mechanism (`CustomProvider`).
- Roughly 750 lines of our own UI primitives to maintain disappear.

## 8. Things that get worse or need care

- A dependency to keep updating (major versions can change props) instead of code we own.
- Heavier client bundle and extra CSS; the orders board is on a kitchen tablet, so measure first-load.
- rsuite's `Table` is not a good fit for our lists (see mapping); we would keep semantic tables.
- The default look changes noticeably unless themed; the print-agent and settings screens have a lot of dense custom layout.

## 9. Questions to answer before phase 0

1. **Why rsuite?** (look and feel, specific components such as pickers, company standard, or something else). This decides how
   far to theme it and whether the spike should test those components first.
2. **Look:** adopt rsuite's default blue theme, or re-skin it to the current neutral monochrome?
3. **Dark mode:** wanted at all? (today it is unused; rsuite supports it with one prop.)
4. **Selects and tables:** OK to keep semantic HTML tables and decide select-by-select between native and `SelectPicker`?
5. **Tailwind:** keep it for layout (recommended) or also remove it later (a much bigger job: 374 class usages)?
6. **Timing:** any release or pilot restaurant date this must not collide with (the kitchen-printing hardware test, for example)?

## 10. Definition of done

All 21 files use the adapters or rsuite directly; `components.json`, `@base-ui/react`, `shadcn`, `sonner`, `tw-animate-css`,
`class-variance-authority` and unused lucide icons are gone; `pnpm lint`, `tsc`, unit tests, e2e (15 specs) and `next build`
pass; screenshots at 375 / 768 / 1280 px match the agreed look; bundle growth is measured and accepted; `CLAUDE.md` is updated.

## Phase 4 result (forms and pickers), done

- **No native form control is left in the app** (grep for `<select`, `type="radio"`, `type="checkbox"`, `<details`, raw `<input` is empty
  outside `components/ui`). New adapters: `Checkbox`, `RadioGroup`, `Disclosure` (Panel collapsible), `DateField` (DatePicker with a
  `YYYY-MM-DD` string value), `TimeField` (TimePicker with a 24-hour `HH:MM` value); `Select` is used by the restaurant switcher, the
  LLM provider, printer paper / copies and the audit filters.
- **Opening hours** now use time pickers; the audit filters (restaurant, action, who, search, from / to dates) are a client form
  (`app/admin/audit/filters.tsx`) that mirrors the pickers into hidden inputs, so the page is still a plain GET (bookmarkable URL).
- Onboarding uses `Input` / `Button`; the audit "details" rows use `Disclosure` (compact).
- e2e: `pick(page, "<aria-label>", option)` helper for `SelectPicker` (role `combobox` + `option`); checkboxes use
  `check({ force: true })` like switches (the input sits under rsuite's visible box).
- The dashboard container is `max-w-5xl` (the theme switch no longer fit the nav at `max-w-4xl`).

## Phase 3 result (tables), done

- **Decision: semantic HTML tables, not rsuite `Table`.** rsuite's `Table` is a fixed-height, virtualised `role=grid` made for big
  datasets; our lists (menu, restaurants, audit page of 50) are short, contain buttons / switches / forms in cells and must wrap on
  phones, and the e2e relies on `row` / `cell` roles. `ui/table.tsx` keeps real `<table>` markup and is restyled to sit with rsuite:
  bordered rounded container, tinted header with small caps, roomier cells (light and dark via the theme tokens).
- **Audit log paging** is now rsuite `Pagination` (`app/admin/audit/pager.tsx`: first / prev / numbers / next / last, page in the
  URL, filters kept).
- **Control heights match:** `Input` / `Textarea` default to rsuite size `sm`, the same as `Button`, so a button next to an input
  lines up (they were 36 px vs 30 px).
- The neutral surface tokens (`--card`, `--muted`, `--border`, ...) deliberately stay OUR values, not rsuite's: rsuite's theme class
  is applied after hydration, so tying neutrals to it would flash light colours on a dark page. Only the accent tokens follow rsuite.

## Phase 5 result (visual pass), done

Every page was captured at 1280 / 768 / 375 px in light and dark (`VISUAL_LABEL=... [VISUAL_SCHEME=dark] pnpm test:e2e e2e/visual.spec.ts`)
and compared with the baseline. Fixed:

- **Phone nav** (dashboard): was three ragged rows. Now row 1 = restaurant switcher + theme + Sign out, row 2 = page links
  (`order-last` on phones, inline from `sm`); the e-mail shows from `lg`; the switcher is `clamp(8rem, 40vw, 12rem)` wide; the
  theme button shows just the mode on phones ("System ▾") and "Theme: System" from `sm`. Admin navs wrap the same way.
- **Sign-in / sign-up:** the form column had shrunk to its content (65 px side margins at 375 px): the page `main` elements are now
  `w-full max-w-md`; button hierarchy fixed (Sign in / Create account = primary, Continue with Google = outline; it was inverted).
- **Modifiers header:** the "Add group" button was clipped on phones; the header wraps and the button does not shrink.
- **Admin header:** "Platform admin" and its links wrap cleanly; "Block" button no longer squeezed.
- Looked fine and unchanged: orders board cards, menu table, dialogs (add dish, confirm), settings tabs, audit log, printing tab.

**Known test quirk (not a UI bug):** right after `page.goto`, a streamed (Suspense) page briefly holds BOTH the visible content and
a hidden copy (`<div hidden>` placeholder) until hydration finishes, so Playwright strict locators such as `getByText(...)` can see
two elements for a moment (confirmed by inspecting the DOM; the hidden copy is gone after about a second and is never visible).
rsuite's heavier bundle widens the window a little. Use `.first()` / `exact` or wait for the page to settle in specs.

## Phase 6 result (cleanup), done

- `globals.css` 135 -> about 100 lines: removed the unused sidebar / chart / accent / popover tokens (and the shadcn imports earlier);
  added the text-colour tokens below.
- Pruned unused adapter surface: Button variants / sizes nobody uses, `TableFooter`, `TableCaption`, `DialogDescription`.
- No `shadcn`, `sonner`, `base-ui`, `lucide` references left in code or docs (this plan keeps the history).
- Hard-coded colours (`text-red-600`, `text-green-600`, `text-neutral-600`, ...) replaced by theme-aware tokens
  (`text-destructive-text`, `text-success-text`, `text-warning-text`, `text-primary-text`, `text-muted-foreground`): they were
  unreadable in dark mode (the dashboard overview text was 2.5:1).

## Phase 7 result (QA), done

| Check | Result |
|---|---|
| Unit / integration (`pnpm test`) | 81 / 81 |
| Go agent (`go vet`, `go test`) | pass |
| e2e (`pnpm test:e2e`) | 18 / 18 (15 existing + keyboard 3; the old specs needed only selector tweaks) |
| lint, `tsc`, `next build` | clean |
| axe accessibility scan, WCAG 2 A + AA, all pages, light and dark (`A11Y=1 pnpm test:e2e e2e/a11y.spec.ts`) | **0 serious / critical violations, 0 console errors** (no React / hydration warnings) |
| Keyboard-only (`e2e/keyboard.spec.ts`) | dialog opens with Enter, Tab walks its controls, Escape closes and returns focus to the trigger; restaurant picker opens / closes with the keyboard; tabs and theme menu (Enter, arrows) work |
| Visual (1280 / 768 / 375 px, light + dark, `e2e/visual.spec.ts`) | reviewed page by page, fixes in phase 5 |

Found and fixed during QA:
- **Button contrast:** rsuite's default primary and red buttons are white on a light blue / red, about **3:1** (WCAG AA needs 4.5:1; axe
  does not flag these). Overridden with darker shades via rsuite's own button variables (`globals.css`, `@layer components`): now
  **6.2-6.7:1** in light and dark.
- **Text colours** (see phase 6): `.text-primary` 2.9:1 in light, hard-coded grey 2.5:1 in dark -> theme-aware tokens.
- **Dialog focus:** `Modal` puts focus on its wrapper element (the parent of the `role="alertdialog"` element), which is correct;
  Tab then walks Close, Keep order, Cancel order. Tabbing past the last control leaves the page for the browser UI like any modal
  (rsuite's `enforceFocus` pulls focus back if it lands behind the dialog).
- **Dropdown (theme menu):** items are chosen with Enter after arrowing to them (focusing an item and pressing Enter does not select).

Bundle, gzipped, ALL chunks of the app (not per page): JS 320 KB -> 394 KB (+74 KB), CSS 10 KB -> 65 KB (+55 KB), about +130 KB in
total, from the rsuite components in use (Button, Input, Modal, Toggle, Panel, Dropdown, SelectPicker, DatePicker, TimePicker,
Checkbox, Radio, Pagination, toaster) and its stylesheet. If first load on the kitchen tablet matters, per-component CSS imports and
`next/dynamic` for the pickers are the next levers (not done).

## Merge decision (open)

`ui/rsuite` is 8 commits ahead of `dev` and `dev` has nothing the branch lacks, so it merges cleanly. Merging changes the look of the
whole app (rsuite's blue theme, dark mode, new controls). Before merging: look at `e2e/screenshots/<label>` once, and run
`A11Y=1 pnpm test:e2e e2e/a11y.spec.ts` and the normal suites on the merged result.

## Follow-ups after phase 7

- **Settings -> Notifications** is its own tab (`/dashboard/settings/notifications`); General keeps phone number, details and hours.
- **Font: Roboto** (weights 400 / 500 / 700 + Roboto Mono), self-hosted by `next/font`
  dish names; rsuite uses the same stack. This also fixed a latent bug: `globals.css` had `--font-sans: var(--font-sans)` (a variable
  pointing at itself), so the whole app had been rendering in the browser's default SERIF font since the start. `e2e/fonts.spec.ts`
  checks that Roboto is loaded and used by both our text and rsuite components.
- **Top menu items highlight on mouse hover** (and keyboard focus): shared `navLinkClass` (`components/nav-link.ts`) for the dashboard and
  admin navs; checked in `e2e/keyboard.spec.ts`.
- **Dialog width:** `DialogContent` takes a `size` (`xs` 400 px, `sm` 600 px, `md` 800 px) and the content always fills it. The add-group
  dialog had inherited a `max-w-[33.6rem]` class that capped its content inside a wider modal; it is now `size="sm"`. e2e checks that
  the form fills the dialog body (use `offsetWidth`: the modal's open animation scales `getBoundingClientRect`).

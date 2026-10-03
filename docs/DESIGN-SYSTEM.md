# Design system — source of truth

The mental model is **central token → shared component → variant → screen**. Never
**screen → custom CSS → one-off fix**.

Before changing any user-facing UI, read this file. Before creating a component,
check whether one already exists here.

---

## 1. What the libraries already provide — do not rebuild these

| Concern | Provided by | Notes |
|---|---|---|
| Components, variants, sizes | `src/components/ui` (shadcn/ui), `src/components/kibo-ui` (Kibo UI) | 6 Button variants × 8 sizes, etc. Extend a variant; don't fork a component. |
| Interactive states (hover/focus/pressed/disabled) | Radix primitives + Tailwind state variants | `focus-visible:`, `disabled:`, `aria-invalid:` are already wired. |
| Accessibility | Radix | Accessible names, keyboard nav, focus management, ARIA semantics. |
| Responsive | Tailwind breakpoints | No duplicated mobile/desktop components. |
| Spacing scale | Tailwind's 4px scale (`p-4`, `gap-5`, `mt-3`) | These *are* tokens. Only arbitrary values (`p-[18px]`) are drift. |
| Direction-neutral layout | Logical utilities | Install base is free of physical direction classes; keep it that way. |

Vendored registry code is **excluded** from `npm run lint` by design
(`src/components/ui`, `src/components/kibo-ui`): it is third-party source we do not
own, and rewriting it wholesale would break the next `npx shadcn add`. Where a
registry component is genuinely wrong for this product, it is patched **at the
source, with a comment explaining the change** — see §8 for the six that are.

## 2. What this project owns

**Where the screens come from.** `App Screen design/*.html` is the handed-over
mockup set — six screens, one file each — and it is the source of truth for
*structure and content*: the same cards, the same rows, the same order, the same
words, the same figures and dates. It is **not** the source of truth for
*appearance*: its lime and dark-green palette, its corner-radius grid and its type
choices belong to the designer, and this app keeps its own identity — clay, cream
and ink, and the type scale below. "Follow the design" therefore means: match what
each screen *says* and *in what order*, dressed in the tokens in this section.
Where the mockup and the tokens disagree about a colour, the tokens win; where they
disagree about content, the mockup wins.

| Thing | Source of truth | Consumed by |
|---|---|---|
| Palette (clay, cream, ink, blue, green, red, amber, violet) | `src/styles/theme.css` → `@theme` | Every semantic token, every screen |
| Font stacks (serif, sans, mono, **urdu**) | `src/styles/theme.css` → `@theme` | `font-serif`, `font-sans`, `:lang(ur)` |
| **Type scale (named intents)** | `src/styles/theme.css` → `@theme --text-*` | `text-display`, `text-figure`, `text-lead`, `text-title`, `text-heading`, `text-subheading`, `text-body`, `text-body-sm`, `text-label`, `text-caption`, `text-overline` |
| Semantic contract (`--background`, `--primary`, `--brand` …) | `src/styles/theme.css` → `:root` / `.dark` | All registry components, all screens |
| Inverted surface (`--surface-inverted`) | `src/styles/theme.css` → `:root` / `.dark` | The one high-contrast block per screen — the weather hero, the scan verdict |
| Brand fill + its text (`--brand`, `--brand-foreground`) | `src/styles/theme.css` → `:root` / `.dark` | Every filled brand element: scan button, chat bubbles, unread badge |
| Theme switching | `src/theme/ThemeProvider.tsx` | `<html class="dark">`, persisted in `localStorage` |
| Language + direction | `src/i18n/LocaleProvider.tsx` | `<html lang dir>`, Radix's `DirectionProvider`, persisted in `localStorage` |
| The Community feed's state | `src/community/CommunityProvider.tsx` (`PROVIDER` + store) | The Community tab, and only it |
| **Words and word order** | `src/i18n/catalog.ts` (`en`, `ur`) | Every string the user can see |
| **Digits, dates, currency** | `src/i18n/format.ts` + `money.amount`, `time.hourPeriod` | Money, hours, dates, trend figures |
| Avatar initials | `src/lib/initials.ts` | Dealer rows, chat list, community, scan stockist |
| Loading / empty / error states | `src/components/States.tsx` | Any screen whose data can be absent or fail |
| Screen shell + tab bar | `src/App.tsx`, `src/components/AppTabBar.tsx` | All five destinations, plus the pushed profile screen |
| Profile (identity, language, appearance) | `src/screens/ProfileScreen.tsx` | Reached from the two-icon header on Home |
| Section label | `src/components/SectionLabel.tsx` | Every screen that has sections |
| **Community rules, limits, moderation, terms** | `src/data/community-rules.ts` | The composer, the reports, the rules sheet — and `docs/COMMUNITY.md`, which explains them |
| **Community feed, threads and moderation state** | `src/data/community.ts`, `src/community/*` | The Community tab: one pure store, one provider, no rules in the screen |
| Demo content | `src/data/chat.ts`, `src/data/community.ts`, and the `*_DATA` constants in each screen | Screens with no backend yet |

## 3. Change protocol (how to make a global change)

1. Find the token or shared component in the tables above.
2. Change it **there** — once.
3. Find every usage (`grep` the class or component name).
4. Verify propagation: light, dark, LTR, RTL, and the affected screens.
5. Run `npm run lint` — it fails on arbitrary sizes, arbitrary colours, inline hex
   and physical direction utilities, which is how drift is caught rather than trusted.

Worked example — "make section labels larger":

- Wrong: edit `text-overline` in five screens.
- Right: change `--text-overline` in `theme.css`. Every section label follows,
  in both directions and both themes, because they all consume the one token.

Worked example — "the amounts should follow the language":

- Wrong: add a translated copy of the number to the catalog.
- Right: call `formatMoney(value, locale)` from `src/i18n/format.ts`. Three screens
  changed at once, and the value can no longer disagree with itself.

## 4. Type tokens

Each token bundles size + leading + tracking (+ weight), so one class carries the
whole decision. Nothing in a screen may set a font size with a raw value.

| Token | Size | Weight | Intended use |
|---|---|---|---|
| `text-display` | 40px | 400 | The one number a screen is built around |
| `text-figure` | 28px | 400 | Money |
| `text-lead` | 21px | 500 | The sentence a card is making |
| `text-title` | 20px | 600 | Screen title |
| `text-heading` | 18px | 600 | A name, a strong label |
| `text-subheading` | 16px | 500 | Greeting, list titles, figures |
| `text-body` | 14px | 400 | Row titles, inputs, buttons |
| `text-body-sm` | 13px | 400 | Supporting lines |
| `text-label` | 12px | 400 | Labels, small figures |
| `text-caption` | 11px | 400 | The smallest voice |
| `text-overline` | 11px | 500 | Uppercase section labels (+0.08em) |

The mockups were drawn on a finer grid than this — 11.5, 12.5, 13.5, 14.5px —
and those values were collapsed into the eleven above. A scale of near-identical
one-offs is not a scale; it is a font-size per element, and it drifts the moment
anyone adds a twelfth.

Corners come from the same place: `--radius: 1.25rem` resolves to sm 16 / md 18 /
lg 20 / xl 24, which covers the mockups' 14–28px set without a radius per card.

Serif display text additionally needs `lining-nums`: Cormorant defaults to
old-style figures, and prices set in text figures read as broken numbers.

## 5. Language, direction and formatting

Three layers, each with exactly one owner.

| Layer | Owner | Rule |
|---|---|---|
| Words, word order, grammar | `src/i18n/catalog.ts` | A string the user reads lives here. Pattern, not concatenation: `'{amount} دستیاب'`. |
| Digits, dates, currency, word-in-sentence order | `src/i18n/format.ts` | Never type a formatted number or date into the catalog. |
| Direction | `<html dir>` via `LocaleProvider` | Never set direction on a screen. |

- Use logical utilities: `ps/pe`, `ms/me`, `start/end`, `text-start/text-end`.
- Mirror direction-bearing icons explicitly — a forward chevron is
  `rtl:rotate-180`.
- **Radix needs to be told separately.** Its primitives keep their own direction
  context, default to `ltr`, and stamp an explicit `dir` attribute on what they
  control — so `<html dir="rtl">` is invisible to them. `LocaleProvider` wraps the
  app in Radix's `DirectionProvider`, which is what makes a ToggleGroup, Sheet or
  DropdownMenu mirror and key correctly in Urdu. Do not pass `dir` per component;
  declare it once, there.
- Urdu month names, weekday names and day-first dates come from `Intl` with the
  `ur` locale (`4 اکتوبر`). Urdu uses Western digits, matching the catalog.
- Shop hours are the exception `Intl` cannot do — its Urdu data says `7:00 PM`.
  The period word comes from the catalog as `time.hourPeriod`, because Urdu puts
  it *before* the number (`شام 7`) and English *after* (`7 PM`), and the mockups
  write the period in capitals.
- Money is the same shape of problem. `Intl`'s Pakistani symbol is `Rs` with no
  dot — the mockups write `Rs.` — and in Urdu it drops a Latin `Rs` in front of
  Urdu text. So `formatMoney(value, locale, t)` takes the *amount* from `Intl` and
  the *pattern* from `money.amount`: `'Rs. {amount}'` / `'{amount} روپے'`.
- How long ago something happened is `formatRelativeTime(from, to, t)` — the
  caller supplies both ends, so the seeded feed is two hours old whenever it is
  opened and a test can pin the clock. Short forms (`2h`, `1d`), because they sit
  in a meta line beside the topic and the village.
- Chrome the primitives draw themselves is in the catalog too: the dialog and
  sheet dismiss control reads `common.close`, so an Urdu screen has no English
  left in it anywhere.
- Urdu gets `--font-urdu` (Noto Naskh, not Nastaliq — Nastaliq collapses at UI
  sizes) and extra leading via `:lang(ur)`.

**The Urdu font rule.** `:lang(ur)` repoints the family *tokens*
(`--font-sans`, `--font-serif`) rather than setting `font-family`. A base-layer
rule loses to a utility from a later layer, so a plain `font-family` there is
silently beaten by every `font-serif` heading — which is exactly what happened,
and left half the Urdu text in an operating-system font.

## 6. Business rules are not UI rules

Presentation is this document's business. Historical prices, sale snapshots,
COGS, inventory movements, credit and payments, payables, returns, RBAC and shop
isolation belong to the business/domain layers and are authoritative. Never
change a business rule to make a screen easier, and never let two shops' data mix
visually or otherwise.

## 7. Status: verified vs not

Everything below was checked by rendering it, not by reading the source.

| Area | Status |
|---|---|
| Type tokens | Verified — 45 arbitrary sizes removed, `npm run lint` blocks new ones |
| Light theme | Verified in the browser |
| Dark theme | Verified — body `rgb(18,17,16)`, inverted surface `#2E2D28`, all five screens |
| LTR | Verified |
| RTL | Verified — header, tab bar, chips, cards and chevrons mirror from one attribute |
| Urdu | Verified — every string, both directions, on all five screens and the profile |
| Empty / loading / error states | Built and reachable; exercised by tests — the chat empty state, and the community's loading, failure, storage-blocked, filter-empty, removed-content and offline states |
| Community feature | Verified in the browser, in both languages and both themes: feed, filters, threads with nesting, replies, likes, stories and the viewer, the composer (including a real attached file and voice), report, block/unblock, delete-to-tombstone, the rules sheet, and persistence across a reload |
| Radix direction | Verified — ToggleGroup reports `rtl`, mirrors, and its outer corners land on the correct sides |
| The mockups' content | Verified screen by screen against `App Screen design/*.html` — every dealer, rate, thread, post, amount, hour and date |
| Gates | `tsc --noEmit`, `npm run lint`, 28 unit tests, `npm run build` |

### Defects found by verifying rather than assuming

Each of these looked correct in the source and was wrong on the screen. They are
recorded because the pattern repeats: the bug is visible only when rendered.

| Symptom | Cause | Fix |
|---|---|---|
| Falling crops announced as rising to screen readers | Registry ticker put a fixed `id` on every row's `<title>` and pointed `aria-labelledby` at it, so all five arrows resolved to the first one | Direction is spoken as text; the SVG is `aria-hidden` |
| Half the Urdu text rendered in an OS font | `:lang(ur)` set `font-family` in the base layer, beaten by every `font-serif` utility | Repoint the family tokens instead |
| The weather card claimed a date three days out of step with the spray calendar beside it | The label was a frozen string in the catalog (`'Today · Sun 27 Sep'`) | Real date via `Intl`; the catalog supplies only `'Today · {date}'` |
| Prices and the progress bar could disagree | Amount and percentage were typed out by hand in two places | Both derived from one credit constant |
| Latin avatars in an otherwise Urdu interface | Initials hardcoded per screen — in four different screens | One `initialsOf(name)` helper |
| A joined option control did not mirror in Urdu, and its arrow keys still ran left-to-right | Radix keeps its own direction context, defaults to `ltr`, and stamps `dir` on what it controls — `<html dir>` is invisible to it | One `DirectionProvider` in `LocaleProvider`, so every Radix primitive is covered, including ones added later |
| The joined control's rounded corners landed on the wrong side once mirrored | The registry used physical corner and border classes (`rounded-l-md`, `border-l-0`) | Logical equivalents (`rounded-s-md`, `border-s-0`) |
| A chosen option was nearly invisible | The base selected state is `bg-accent`, and here that is the cream hover surface on a white card — about 2% apart in luminance | A reusable `brand` toggle variant |
| The chat list said one thing and the conversation behind it said another | The list line was a hand-written preview per dealer, unrelated to the thread's own messages | Each thread ends on the line the list quotes; the unread badge counts the same messages the thread shows |
| Money read `Rs 3,330` beside the app's own `Rs. per 40 kg` | `Intl`'s currency style, which has no dot and no Urdu equivalent | Pattern from `money.amount`, digits from `Intl` |
| The dark treatment block painted a strip behind its own label and left the rest invisible | An inline `<span>` cannot paint a background behind the block children stacked inside it | The dark surface *is* the bubble (`Bubble` takes a `className`), so the box wraps what it holds |
| `Close` was the only English left on an Urdu screen | The registry hard-codes the word in its dismiss button | `common.close`, read inside `ui/sheet` and `ui/dialog` |
| A `Chat with Ali Traders` button on Home opened nothing | The row was built for the mockup and never given a handler | It opens the same thread as the chat list and the Dealers screen |
| Deleting an answered post put its answers out of reach | The feed excluded removed posts while the card drew a tombstone for exactly those posts — so the tombstone was dead code, and the conversation it was kept for became unreachable | The store stops hiding the tombstone it keeps, and the tombstone card opens its own thread (found by deleting a post in the browser and then trying to read the replies) |
| A card showed `+10` beside two faces | The avatar stack's overflow counted *replies*, so it read as ten more farmers in a thread six people had answered | The overflow counts faces |
| The composer asked the farmer to pick their village under the heading `WAZIRABAD` | `farmer.village` is that village as a *value*; as a section label it printed a value where a field name belongs | A `community.place` label; the value stays in the chips |
| Opening a thread threw away a half-written reply | `openThread` reset the reply draft every time, including for the thread being reopened | Reopening keeps the draft; it is cleared only for a different thread — which is the whole reason the draft lives in the store |
| The app went unreachable after a sheet closed, and the story viewer's timer never stopped (two components, one mistake) | An effect whose cleanup changes the state that recreates the effect's dependency re-runs for ever: `setState` → new callback → cleanup → `setState`. In the story viewer the same mistake also restarted the timer it had just started, so a story never advanced | Timers and callbacks are read through refs and the effects depend on the story or on nothing. Found because the test run **hung** instead of failing |

### Known gaps, stated plainly

- **Seven controls the mockups draw have no destination yet**: the Home bell (no
  notifications screen), the pink-bollworm alert row, `View ledger`, `Request
  credit` (Home and the Scan verdict), and both `Listen` pills — spoken advice is
  the whole point of them, and the app has no voice yet. Each is left in the
  mockup's clothing because what is missing is the screen or the feature behind it,
  not the control. The rule applied elsewhere holds: a control whose destination
  exists gets a handler (`See all` and the dealer chat buttons now do).
- **Everything is demo content.** No backend. Persistence is per device: locale, theme, and the Community feed (`agri-shop.community`).
- **Community has no server**, so two farmers cannot see each other's posts, reports go nowhere and there is no cross-device moderation. The rules, the store and the screens are built so that adding one changes none of them. `docs/COMMUNITY.md` states this and the rest of the gaps plainly.
- **Installed but not mounted:** `ui/dialog` (nothing opens one yet), and the
  `kibo-ui` `ticker` and `status` components, which the rebuilt Home no longer uses
  — the rate tiles and the verified badge are drawn inline now. Their patches below
  still apply if a screen picks them up again.
- **Not installed yet:** dropdown-menu, table, popover. Install from the registry
  when a screen needs them (`npx shadcn@latest add dropdown-menu`), then add them to the
  map above so the next agent finds them.
- **The Scan diagnosis is a fixture.** There is no camera, no model, no upload.
- **This repo has no shop, RBAC or inventory layer.** Section 6 applies to the
  business codebase, not here.

## 8. Registry components we patched

Owned now, so `npx shadcn add` for these will need re-patching. Each carries a
comment at the call site saying what changed and why.

| Component | Change |
|---|---|
| `kibo-ui/ticker` | Zero decimals for PKR; accessible trend direction; locale-aware percent *(installed, not currently mounted)* |
| `kibo-ui/status` | The pinging halo is suppressed at the call site — a pulse in a list of rows reads as an alarm *(installed, not currently mounted)* |
| `ui/sonner` | Reads the theme from our own `.dark` class, not `next-themes` — one theme system, not two |
| `ui/toggle`, `ui/toggle-group` | A `brand` selected variant; logical corners and borders so a joined control mirrors |
| `ui/sheet`, `ui/dialog` | The dismiss control takes its label from `common.close` instead of the hard-coded English "Close" |

`kibo-ui/mini-calendar` was deleted along with its only consumer (the old spray
window card), which is also what let `date-fns` — and `next-themes`, which nothing
imported — come out of `package.json`: two dependencies for a component no screen
mounts.

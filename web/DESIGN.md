# Upkeep design system

Source theme: Hallmark catalog theme **Cobalt** (modern-minimal genre, cool engineered paper, one cobalt signal, hairline structure, tight 6px radii, one graphite band per page). Adapted for a money screen: the graphite band is the live quote tape on the swap route and the compute gauge on the ledger route. Body face swapped from Inter to Schibsted Grotesk because the project bans Inter-led pages.

Hallmark stamp: genre modern-minimal, macrostructure Fuse tape over ticket, theme Cobalt, enrichment none (typography and drawn gauge only), nav N1b adapted as a bordered bar with route tabs, footer Ft2 inline.

## Art direction

A drafting sheet for one price that expires. Cool paper, ruler hairlines, a graphite tape band where the agent's two signed prices burn down as fuses. Every number is a mono readout with a unit and a comparison. Nothing decorative moves; the only continuous motion is the fuse draining.

## Design Read

- Job of the main screen: swap against the agent's current signed price before it expires, and know why it is safe.
- Job of the ledger screen: prove where the agent's AI money came from, step by step, with a link for every step.
- Density 7, variance 6, motion 4.

## Tokens

All tokens live in `app/globals.css` as CSS variables and are exposed to Tailwind through `@theme`. Components never carry raw colours.

| Token | Value | Use |
| --- | --- | --- |
| paper | oklch(98.5% 0.004 250) | page |
| panel | oklch(99.4% 0.003 250) | ticket and rows, hairline framed |
| sunken | oklch(96% 0.006 250) | input wells, table headers |
| rule | oklch(90% 0.01 252) | hairlines |
| rule-2 | oklch(84% 0.014 254) | input borders, hover borders |
| ink | oklch(24% 0.02 258) | headings, numbers |
| ink-2 | oklch(34% 0.018 257) | body |
| muted | oklch(46% 0.02 256) | labels, helper text |
| graphite | oklch(22% 0.016 260) | the one dark band |
| graphite-2 | oklch(27% 0.018 260) | inset on graphite |
| graphite-rule | oklch(36% 0.02 260) | hairlines on graphite |
| on-graphite | oklch(95% 0.006 250) | text on graphite |
| on-graphite-muted | oklch(76% 0.02 255) | labels on graphite |
| accent | oklch(55% 0.20 256) | the one primary button, focus ring, active tab, links |
| on-accent | oklch(99% 0.003 250) | text on accent |
| ok / ok-ink / ok-tint | oklch(80% 0.17 155) on graphite, oklch(46% 0.14 155) on paper, oklch(96% 0.04 155) | fresh quote, Normal tier, confirmed |
| warn / warn-ink / warn-tint | oklch(82% 0.15 85), oklch(48% 0.12 70), oklch(96% 0.05 85) | Low tier, expiring under 60 seconds, pending |
| danger / danger-ink / danger-tint | oklch(74% 0.17 25), oklch(50% 0.20 25), oklch(96% 0.03 25) | expired quote, Critical tier, errors |

Status colour is semantic only. Paused uses muted ink with a bordered chip. Contrast of every text and surface pair is computed by `scripts/contrast.mjs` (red on a deliberately failing pair, green on this palette).

## Type

- Display: Space Grotesk 500 and 600, tracking -0.02em on 28px and up. Headings only.
- Body: Schibsted Grotesk 400 and 500, 15px, line-height 1.55.
- Data: JetBrains Mono 400 and 500 with `tabular-nums` for every amount, address, hash, id and time. Labels in mono use 11px uppercase with +0.06em tracking, at most one per section.
- Scale: 11 / 13 / 15 / 20 / 28 / 40 and the readout size 56 (mobile 40) in mono at -0.02em.
- Not every heading bold: h1 600, section heads 500, row labels 500.

## Spacing, radius, borders

- 4px scale: 4, 8, 12, 16, 24, 32, 48, 64.
- Radius 6px on controls, 10px on cards and the tape band. No pills.
- 1px hairlines define every surface. No shadows except a 0 1px 2px lift on the ticket.
- Page max width 1200px, 24px gutters on desktop, 16px on 375px.

## Components

- Button: primary (accent fill, one per group), secondary (hairline, panel fill), ghost (text). Heights 44px, mono-free labels with a verb ("Swap 20 USDC for W0G"). States: default, hover, focus-visible (2px accent ring, offset 2px, instant), active (translateY 1px), disabled (sunken fill, muted text), loading (inline spinner, label kept), error (danger border plus inline cause), success (ok tint with tx link).
- Fuse: a 4px track on graphite-2 with a fill that drains right to left. Colour ok above 60s, warn 15 to 60s, danger under 15s. At zero the track is gone, the price is struck through and the swap control locks.
- Tier meter: four notches Normal, Low, Critical, Paused, current one filled, one plain sentence of consequence.
- Evidence row: stage name, one-line plain description, mono hash with copy and explorer link, chain chip, time. Rail on the left with one marker per row.
- Amount field: sunken well, 28px mono amount, token chip right, balance and Max, 25, 50 chips under.
- Alert: bordered with semantic tint, title plus cause plus next step. Never plain text.

## Layout

- Swap route `/`: nav bar, title sentence with two lines of explanation, graphite quote tape (two fuses with the spread between them), then a two column band: the ticket on the left, "What backs this price" on the right (AI run, budget tier, latest funding step, link to ledger). On 375px: tape, ticket, backing, stacked, tape shows one row per direction.
- Ledger route `/ledger`: title sentence with the loop result, graphite gauge band (compute balance, today's spend against cap, tier meter), then the chronology rail with fills, fees, funding steps and AI runs, then tier changes seen by this browser.

## Motion

- Settle then reveal: skeleton to content in 160ms opacity. Fuse drains continuously in transform (scaleX) at 1s steps, not animated at zero or under reduced motion (static fill, number still ticks).
- Count-up on the receive amount when a quote lands, 400ms, transform free (number swap only).
- Keyboard actions: no animation. All motion honours `prefers-reduced-motion`.

## Copy rules

- Plain English first. W0G is glossed once as "wrapped 0G". An inference request is an "AI run". The Payment Layer is "the 0G Payment Layer, the account that pays for AI runs".
- Verbs on buttons. No celebratory toasts. Errors name the cause and the next step.
- No em dashes, no filler words, no invented numbers. Any figure comes from the agent API or the chain with its read time beside it.

## Refusals

No chart. No sparkline. No gradients. No glass. No icon tiles. No second accent. No token selector (the pair is fixed because the Aqua strategy holds exactly W0G and USDC). No slippage setting (the fill price is the signed quote and stale quotes revert).

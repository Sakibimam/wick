# Wick design system: Night circuit

Source: the DESIGN.md library slug `spacex` (`~/.config/design-md/designs/spacex.md`), adapted. Hallmark stamp: genre atmospheric, macrostructure 19 Map / Diagram, theme studied-DNA (spacex), nav N9 edge-aligned minimal, footer Ft1 mast-headed.

## Why this system fits a machine that feeds itself

Wick is a closed metabolism: fills pay fees, fees cross from Base to 0G, the 0G balance pays for the AI run that signs the next price, and the price expires. That is a mission, not a dashboard, and the SpaceX language was built for exactly one kind of screen: a vehicle with a countdown over its name and telemetry for each stage. We keep its night canvas, its condensed DIN voice in capitals for names, its clock set directly above the thing it counts down to, and its refusal of decoration. We drop its photography (we have no photograph of an agent) and let the drawn circuit be the picture. Colour is spent only on state: the circuit glows in the agent's budget tier, the price fuse turns amber then red as it burns down, and white is the one action.

The page has one picture: the loop, drawn as a transit circuit across two lanes, Base on top and the 0G chain one tone lighter below. Each station is a real contract, each hop links its real transaction, and the price leg is a fuse. When the fuse is out, the circuit is visibly open, which is the product's whole argument: no fresh price, no fill.

## Tokens

All colours are OKLCH custom properties in `app/globals.css`, exposed to Tailwind through `@theme`. Components never carry raw colours.

| Token | Value | Use |
| --- | --- | --- |
| paper | oklch(14.5% 0.005 270) | page canvas and the Base lane |
| lane | oklch(17.5% 0.006 270) | the 0G lane, one tone step lighter |
| panel | oklch(19.5% 0.007 270) | ticket body |
| sunken | oklch(23% 0.008 270) | amount wells, chips |
| rule | oklch(30% 0.008 270) | circuit track at rest, control edges |
| rule-2 | oklch(42% 0.01 270) | hover edges, empty node rings |
| ink | oklch(95.5% 0.008 280) | names, numbers, primary text (SpaceX #f0f0fa) |
| ink-2 | oklch(84% 0.008 280) | body |
| muted | oklch(70% 0.01 280) | labels, helper text |
| accent | oklch(95.5% 0.008 280) | the one filled action (white), focus ring |
| on-accent | oklch(14.5% 0.005 270) | text on the white action |
| ok / warn / danger | oklch(80% 0.17 152), oklch(84% 0.15 82), oklch(70% 0.19 25) | NORMAL, LOW and fuse under 60 s, CRITICAL and expired |
| quiet | oklch(78% 0.01 280) | PAUSED: the circuit drawn in plain light |
| *-tint | L 24% at the same hue | alert grounds |

Status colour is semantic only and is applied to live data: node fills, the lit track, the fuse, the fuel needle. Chrome stays neutral.

## Type

- Display: Barlow Condensed 600, capitals, tracking +0.02em, leading 0.95. h1 72px desktop, 44px phone. Station names 15px at +0.04em.
- Body: Barlow 400 and 500, 16px, leading 1.5. Numbers in Barlow with `tabular-nums`.
- Clocks and hashes: Barlow with tabular figures and a slashed zero. No monospace anywhere: the operator rejected mono labels, and the clock reads as a readout without it.
- Scale: 13 / 16 / 20 / 28 / 44 / 72, readout 56.
- Labels are sentence case in Barlow 13px muted. No monospace small caps anywhere.

## Spacing, radius

- 4px scale: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Radius 4px on every control, panel and chip. Node dots are circles. No pills.
- No shadows at rest, no gradients, no glass. Surfaces separate by tone steps.

## Components

- Circuit: an SVG layer measured from the station nodes in the DOM, straight segments only, 2px track. Lit segments carry the tier colour; segments with no evidence yet stay at `rule`. The price leg is drawn as a fuse whose length is the time left on the signed price.
- Station: node dot, name in condensed capitals, one value at 20 to 28px, one plain sentence, and the evidence link (tabular hash plus explorer icon).
- Fuel gauge: a log-scale bar from 0.01 to 10 0G with the agent's three lines (pause 0.05, critical 0.1, low 0.5) and the balance needle in the tier colour, with days of runway at the daily cap.
- Heartbeat: a 48 hour strip; each billed AI run is a spike labelled with its request id; after the last run the line is flat.
- Ticket: Uniswap anatomy (pay well, flip square straddling the seam, receive well, one full width 56px action), plus a summary block before signing: signed rate, rate after the maker fee, the fuse with T-minus clock, and the AI run behind the price.
- Buttons: primary is the white fill (one per screen region), secondary is a 1px ink outline, ghost is text. 4px radius. States: hover, focus-visible (2px ink ring, offset 2px, instant), active scale 0.97, disabled, loading, error, success.

## Motion

- On load the circuit draws once in the direction money travels (pathLength, 1.2s), then the real fills enter at the pool as pulses and the recorded funding run travels the four hops once, stopping at each station. The fuse drains in real seconds. The heartbeat strip only moves when a run is recent.
- transform, opacity and SVG path length only. Every motion stops under `prefers-reduced-motion`: the circuit renders complete, pulses are drawn at rest, clocks still tick.

## Copy

Plain English for a judge who has never seen 0G. Station names are the contract or protocol (AQUA POOL, UNISWAP, CCIP, PAYMENT LAYER), the sentence under each says what happens to the money there. Every figure comes from `/api/status`, `/api/fills`, `/api/quote` or the chain clock, with its block beside it.

## Refusals

No stat-grid band. No three equal cards. No token selector (the strategy holds exactly W0G and USDC). No slippage setting (the fill price is the signed quote and stale quotes revert). No eyebrow labels, no index numbers, no emoji, no purple.

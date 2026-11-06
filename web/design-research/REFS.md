# Upkeep design references

Job of the product: a taker sees one price that expires, swaps against it, and a second screen proves where the agent's compute money came from. References are split into direct swap competitors on Base, evidence and ledger screens, and premium references found by shape (a price with an expiry, history with a source, a spread between two sides).

## Aerodrome swap (direct competitor, Base)
Product screen: Sell and Buy stacked inside one 512px wide panel (fields 98px tall at 1440), a round direction button centred on a hairline between them, "0" and "$0.0" right-aligned under each amount, one full-width pill Connect wallet button (radius 9999px, 50px tall). Body background rgb(9,14,31), InterVariable 16px. Steal: the stacked pair with the fiat line under the amount and the single full-width action. Numbers show as a big muted 0 with a dollar line, empty state is the form itself with skeleton token chips. Do not take: Inter, the five-link nav above a one-job screen, the navy-on-navy low contrast of the panel edge. Shots: refs/aerodrome-1440.png and refs/aerodrome-m-375.png.

## Uniswap trade (direct competitor, Base)
Product screen: a 480px card on a near-black field rgb(19,19,19), tabs Swap Limit Buy Sell as 12px-gap pills, amount input Basel 36px weight 485 with line-height 43px, token selector pill on the right, the second panel overlapped by the flip button so the pair reads as one object. Steal: amount typography at 36px with a 43px leading, and the flip control straddling the seam. Numbers: grey 0 placeholder at 38% white, fiat $0 at 14px beneath. Primary action is a full-width 56px bar that stays muted until the form is valid. Do not take: the pink accent, the ETH default, the Beta chips in the nav. Shot: refs/uniswap-1440.png.

## Matcha swap with market strip (direct competitor, aggregator)
Product screen: chart card 750px wide beside a 433px swap card, the swap card has From and To blocks, 50% and Max chips (26px radius, 14px type) beside the balance, amount in Inter 30px weight 500 with 36px leading, white pill primary button 52px tall. Steal: quick amount chips 50% and Max on the sell side, and the market numbers (market cap, 24h volume, holders, age) as a four-cell strip of 12px labels over 14px values. Empty state shows 0.0 and $0.00, wallet state decides the button label. Do not take: the three marketing cards underneath, the chart that has no job in our flow. Shots: refs/matcha-1440.png and refs/matcha-m-375.png.

## CoW Swap (direct competitor, intent based)
Product screen: a 470px card on a deep indigo field rgb(24,25,59) with tabs Swap, Limit, TWAP as 14px pills, a rounded 28px button radius, headline studiofeixen 28px weight 700 leading 33.6px, chain switcher showing Base in the header. Steal: the chain badge in the header reading Base so the wrong network is a visible state before any click, and tabs as quiet text pills. Do not take: the cow illustration footer, the promotional banner occupying the form, the rotated cross-chain icon grid. Numbers are absent until a wallet connects, the empty state is an ad, which is the thing to avoid. Shot: refs/cow-1440.png.

## 1inch landing and nav (direct competitor, Aqua owner)
Marketing screen with an Aqua entry in the nav. Headline Suisse Intl 72px weight 500 leading 72px on pure black, white pill buttons with 24px radius and 8px 16px padding, nav items at 16px. Steal: leading equal to size on a two-line display headline and the white pill as the single action on black. Because this is the router's maker, the product shows its address 0x11111133 in copy only where it matters. Do not take: pure black #000, the notification badge, the blurred product teaser cut off at the fold. Shot: refs/oneinch-1440.png.

## CoW Explorer search (evidence by id)
Product screen: one 500px search field (50px tall, radius 6px, padding 16px 16px 16px 50px) on rgb(22,23,31) with the placeholder naming every id type it accepts: Order ID, ETH address, ENS, Tx hash. Steal: the placeholder that lists what is accepted, and the footer links to the Settlement contract with an explorer glyph, so the trust anchor is always one click away. Numbers: none, the screen is a lookup. Do not take: orange link colour on dark, 9px body text. For Upkeep this becomes the pattern for every inference request id: copy and open in one control. Shot: refs/cowexplorer-1440.png.

## Basescan contract page (evidence rows)
Product screen: a transactions table with 48px rows, Transaction Hash truncated as 0xcc54beca0c3… plus a copy icon, a Swap method chip, Block as a link, Age as "18 days ago", From and To truncated 0x992dF3c0…B654f4Fe0 with an IN badge, Txn Fee in 0.00000077 ETH. Overview card labels are 12px uppercase, values 15px. Steal: the hash plus copy plus link triple and the human age beside the block. Do not take: the ad slot, the ten-tab strip, the blue link on white for every cell. Numbers right-aligned in the fee column. Shot: refs/basescan-1440.png.

## GitHub Status incident history (chronology with a rail)
Product screen: incidents listed on a vertical rail 2px wide with a 28px circular marker per event, each event has a title in 20px orange, a sentence, and a time range "Nov 4, 17:40 - 18:16 UTC" in 14px muted type, month headers at 28px weight 500. Steal: the left rail with a marker per event as the structure for the brain ledger chronology, and the explicit start and end time in UTC. Do not take: the mascot illustration banner 280px tall, the orange titles, the apple system font. Empty state is a month with no entries and a plain sentence. Shot: refs/githubstatus-1440.png.

## Hyperliquid trade (zoned density and the spread row)
Product screen: order book with 25px rows at 12px type, asks above and bids below, and a spread row between them reading "Spread 0.1 0.004%". Header strip of Mark, Oracle, 24h Change, Volume in 12px labels over 14px values. Steal: the spread shown as its own row between the two sides, which maps to the agent's sell quote above and buy quote below with the spread between them, and the idea that every number has its label directly above. Do not take: the candlestick chart, the cross and leverage controls, the announcements overlay covering the order panel. Shot: refs/hyperliquid-1440.png.

## Our World in Data grapher (history with a source, premium)
Found by the shape "a history that carries its source". Title Playfair Display 25px weight 600 leading 30px, kicker 12px weight 900 tracking 1.2px uppercase, direct line labels at the line end instead of a legend, and a "Data source:" line at 14px under every figure with the licence. Steal: direct labels on the series and a source line under every figure, which becomes "read from agent status API at <time>" under each ledger block. Do not take: the serif title on a product UI, the nine-colour palette. Numbers have units on the axis (25 t, 20 t). Shot: refs/owid-1440.png.

## DefiLlama protocol page (definitions beside the number, premium)
Found by the shape "a number that needs its definition". Key Metrics list with 14px labels dotted-underlined and values right-aligned in a 20px row rhythm (Fees 30d $1.09m, Revenue 30d $789,803), a Methodology panel at 14px with line-height 20px that defines every metric in one sentence, TVL header 20px weight 600. Steal: each metric label is also its own definition on hover, and dense right-aligned tabular values on a 20px row rhythm. Do not take: the left rail of 20 links, Inter, the ad strip. Shot: refs/defillama-1440.png.

# Round 2 (2026-11-06): the rebuild after the Cobalt page was called AI slop

The Cobalt page is in `negative/upkeep-cobalt-before-1440.png` and `-390.png`: blue pill in a plain bar, sans headline over a grey paragraph, a near-black band of four stat columns, mono small-caps labels, hairline white cards. None of it showed the loop. This round looked for two things: a swap ticket that feels like the best wallets, and a way to show a machine that is running (or stopped) from live telemetry.

## Uniswap swap, captured again (ticket north star)
Product screen at 1440 and 390: near-black field rgb(19,19,19), Sell and Buy panels 480px wide, amount input Basel 36px weight 485 leading 43.2px, placeholder at 38% white, "$0" at 14px under the amount, the flip button a 40px square straddling the seam between the two panels, one full-width 56px action under them. On 390 the ticket keeps the same anatomy with 16px side margins. Steal: the seam-straddling flip, amount at 36px, one full-width action whose label states the next step. Do not take: the pink accent, token-select pills on a single-pair pool (our pair is fixed, so the token chip is a label, not a menu). Shots: refs/r2-uniswap-swap-1440.png and refs/r2-uniswap-swap-390.png.

## Rabby (wallet whose pre-sign summary is the bar)
Marketing page, Lato, h1 around 84px weight 700 with a highlighter bar behind two words, ghost buttons 290px wide with a 2px brand border and 10px radius. The product's known move is the plain-language transaction summary before signing. Steal: the summary-before-sign idea, which becomes the ticket's "what happens when you press" lines (rate, expiry, AI run behind the price). Do not take: the highlighter words, the cookie card, the periwinkle wash. Shot: refs/r2-rabby-1440.png.

## Hyperliquid trade (density and one data hue)
Product screen: OurFont 12px rows at 25px pitch, header strip of Mark, Oracle, 24h Change with 12px labels over 14px values, the single action filled rgb(80,210,193) with 8px radius and 0 16px padding, bids and asks coloured only on data. Steal: colour only on numbers that carry a state, labels directly above values, and the "Online" status chip pinned bottom-left as a system light. Do not take: candlesticks, leverage controls, the announcement overlay. Shot: refs/r2-hyperliquid-trade-1440.png.

## SpaceX launches (telemetry voice, the countdown as headline)
Marketing page on black: D-DIN-Bold h1 48px uppercase tracking 0.96px leading 45.6px, h2 60px uppercase leading 54px, a Roboto Mono 16px countdown "T-20:05:07" set directly above the mission name, nav links 13px bold uppercase tracking 1.17px, ghost button with a 1px white border and 4px radius. Steal: a clock set directly over the name it counts down to, which is exactly the price fuse; the condensed DIN voice in uppercase for station names; ghost secondary actions. Do not take: the photographic hero (we have no photograph of the agent, the machine diagram is our picture), pure #000. Shot: refs/r2-spacex-launches-1440.png.

## 1inch Aqua (the venue's own surface)
Marketing page: Suisse Intl h1 72px weight 500 leading 72px centred on rgb(0,0,255) electric blue, white pill 24px radius with 8px 16px padding, a half-dome of square dots as the only picture. Steal: the dot field as a picture of liquidity is a reminder that a diagram can be the hero; the honest naming "Provide liquidity without deposits" maps to our strategy station label. Do not take: the full blue field (it is 1inch's brand, not ours), centred hero composition. Shot: refs/r2-oneinch-aqua-1440.png.

## Teenage Engineering OP-1 (an instrument as the interface)
Product page on rgb(240,240,239): te-20 at weight 100 to 300, 19px paragraph leading 22px, the device itself drawn at 620px wide in the first screen with a tiny OLED showing live parameters (DELAY 12, a dial). Steal: the machine is the picture and its readouts live inside it, at their own small sizes, next to the part they measure. Do not take: hairline weight-100 type at body size (fails contrast on dark), the product photography. Shot: refs/r2-te-op1-1440.png.

## Nothing (dot-matrix machine voice)
Store locator modal on rgb(13,13,13) with a pale panel, Ndot dot-matrix display, LatteraMono 13px uppercase labels, one black 60px tall button 270px wide with 8px radius. Steal: one decisive filled button per panel and a modal that says what it knows ("looks like you're in"). Do not take: dot-matrix display type (a costume), uppercase mono labels (the exact tell the operator named). Shot: refs/r2-nothing-1440.png.

## NASA Open MCT (mission control telemetry)
Marketing page for the mission-operations framework: Montserrat 22px light over a photo of controllers at telemetry consoles, a 64px dark top bar rgb(51,51,51) with 13px uppercase nav. Steal: the operator's mental model, a console where each subsystem has a station and a live value, and stale data is marked rather than hidden. Do not take: the stock-photo hero, Montserrat, the blue CTA. Shot: refs/r2-openmct-1440.png.

## Linear home (rejected capture)
The capture rendered only the 72px nav (Inter Variable 13px links, 24px pill "Sign up" with 8px radius) over an unloaded black canvas, stddev 10.2. Kept as a record that the page body did not render; nothing taken from it beyond the 72px bar height. Shot: refs/r2-linear-1440.png.

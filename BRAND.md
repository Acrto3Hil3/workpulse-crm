# WorkPulse brand assets

Everything here ships inside the app. Swap these files to white-label it for a client — no code changes needed.

## The mark

A **W** drawn as a heartbeat: the letterform's final stroke overshoots into a pulse spike and settles onto a baseline, ending in a green dot — the "current reading". It says *work* and *pulse* in one shape, and stays legible down to 16px.

| File | Use |
|---|---|
| `public/img/logo.svg` | Primary mark — blue tile, white pulse. Header, login, favicon. |
| `public/img/logo-plain.svg` | No tile, blue strokes on transparent. Documents, letterheads, anywhere on white. |
| `public/img/logo-lockup.svg` | Horizontal mark + wordmark. Email signatures, print, invoices. |
| `public/img/empty-team.svg` | Empty-state art on a fresh dashboard. |
| `public/icons/*` | App icons — generated from the mark, see below. |

## Icons

| File | Size | Where it's used |
|---|---|---|
| `icon-192.png` | 192 | PWA / Android home screen |
| `icon-512.png` | 512 | PWA splash, app stores |
| `icon-maskable-512.png` | 512 | Android adaptive icons (art sits inside the 80% safe zone, full-bleed background) |
| `apple-touch-icon.png` | 180 | iPhone/iPad home screen |
| `favicon-32.png` / `favicon-16.png` | 32 / 16 | Browser tabs |

To regenerate them after editing the SVG, run the renderer used to build them (Chromium, exact pixel sizes) — see `scripts/` in the delivery notes, or simply export the SVG at those sizes from any design tool. Small sizes use a slightly heavier stroke so the mark holds up in a browser tab.

## Colours

| Token | Hex | Use |
|---|---|---|
| Brand blue | `#2456d6` | Primary buttons, links, the logo tile, active navigation |
| Ink | `#1c2330` | Body text, "Work" in the wordmark |
| Muted | `#5b6472` | Secondary text, labels |
| Green | `#1b7f3b` (bg `#e2f3e7`) | On track / done |
| Yellow | `#8a5f00` (bg `#fdf0c2`) | Slipping |
| Red | `#b42323` (bg `#fbe5e5`) | Needs attention |
| Pulse green | `#7ee2a8` | The dot in the mark (on blue only) |
| Line | `#dfe3e9` | Borders, dividers |
| Surface | `#f2f4f7` / `#ffffff` | Page background / cards |

The red/yellow/green set is deliberately dark-on-light so the text label inside each badge stays readable — status is never communicated by colour alone.

## Wordmark

**Work** in ink + **Pulse** in brand blue, weight 800, letter-spacing `-0.02em`, set in the system UI font. Using the system font means it renders natively on every device with no font file to download — important on slow industrial connections.

Tagline: *Every task, tracked.*

## White-labelling for a client

1. Set `APP_NAME=Their Company` in `.env` — the name replaces the two-tone wordmark everywhere: header, login, browser tab, phone home screen, and every reminder email and WhatsApp message.
2. Optionally set `APP_TAGLINE=` to their line (or blank to hide it).
3. Replace `public/img/logo.svg` and the files in `public/icons/` with theirs, keeping the same filenames and sizes.

Nothing else needs touching.

## Don't

- Don't put the green dot on a white background — it fails contrast. Use `logo-plain.svg`, whose dot is the darker `#1b7f3b`.
- Don't stretch the mark; it's square, and the tile radius is proportional (`rx=15` on a 64 grid).
- Don't recolour the tile to a status colour — blue is the brand; red/yellow/green mean something specific in this product.

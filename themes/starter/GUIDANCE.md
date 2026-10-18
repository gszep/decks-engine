# Starter theme — design guidance

A small, original starting point for new decks: black & white carry the
composition, one blue accent appears sparingly, square corners and hard 3px
rules give the pages structure, and headings are tightly negative-kerned.

## Principles

1. **Mostly black & white.** Colour is a signal, not a decoration. If a slide
   reads well with the accent removed, it is probably right.
2. **One accent at a time.** Never mix accent hues on one slide. Light/Medium
   dark variants of the same family may combine for depth.
3. **Hard edges.** Square corners, 3px rules, no shadows or gradients — depth
   comes from contrast and position.
4. **Type does the work.** Headlines at 2× body or larger, kerned −5%, leading
   ×0.9. Body leading = size + 3pt. Nothing below 12pt (16px) on screen.
5. **Bilingual from the start.** Every slide exists once; all text lives in
   per-locale catalogs. Japanese takes the ×0.86 EN→JP size bridge via
   `html[lang="ja"]` scoped CSS — check both renders for overflow.

## Tokens

All colours come from `tokens.css` (`var(--ct-*)`). A slide needing a colour
the theme lacks gets a new token in deck CSS — never a raw hex.

## Structure

Slides are 1280×720 full-bleed. Use `.slide` (light), `.slide.ink` (black) or
`.slide.blue` (accent) as the root; `.eyebrow`, `h1.t`/`h2.t`, `.lede`,
`.fill`, `.foot` make up the standard spine; `.panel`, `.grid`, `.c2`/`.c3`
compose the body.

Fork this theme freely: the editor can copy it into a deck's private theme
(`decks/<deck>/theme/`), where guidance, tokens and chrome are editable
without affecting anyone else.

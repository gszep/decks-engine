# Chiba Tech — design guidance

The prose half of the design constitution. The machine-checkable half is
`guidance.json` — the harness (editor, tools, build lint) enforces those rules
and names the rule when it blocks an action. **The escape hatch is editing the
rule**, not working around it: a rule change is a one-line, git-attributed,
reviewable decision. Quiet drift is the enemy; explicit exceptions are fine.

## Foundation

- **Mostly B&W.** Black and white are primary; every composition reads as
  monochrome first. Accent hues are always secondary.
- **One accent at a time** (`accentsPerSlide: 1`). The core blue is the
  default accent; other families (red/orange/yellow/green/teal/magenta) exist
  for special contexts, organised Light / Medium / Dark.
- **Square corners, hard rules** (`cornerRadiusPx: 0`, `ruleWeightPx: 3`).
  No rounding, no soft shadows in slide content; 3px black rules delimit.
- **Tight, negative-kerned headings** (`headingKerningMaxEm: 0` — heading
  letter-spacing is ≤ 0 for EN). Body leading = size + 3pt.
- **JP type**: JP font stack via `html[lang="ja"]`; EN→JP size bridge ×0.86;
  JP headings drop the negative kerning (CJK doesn't kern like Latin).
- **Digital minimum 12px** (`minFontPx`). Print minimum 8pt.

## Colours and tokens

All colour comes from `tokens.css` (`--ct-*`). Never a raw hex in slides or
deck CSS — if a colour is missing, **add a token** (theme-wide) or extend
tokens in the deck's own CSS (deck-scoped variant, shown dashed in the editor).

## Patterns

- Lead slides with an eyebrow (bordered top, uppercase, tracked).
- Panels: 3px solid borders; ink panels (black bg) for emphasis; the single
  accent for the one thing that matters on the slide.
- Footers: quiet, gray, with the wordmark right-aligned.

## Anti-patterns

- Two accent families on one slide.
- Rounded corners, drop shadows, gradients.
- Positive letter-spacing on EN headings; negative letter-spacing on JP text.
- Free-floating hex values "just this once".

## Evolving this document

Two sanctioned ways this file (and `guidance.json`) improves:

1. **Designer-driven**: you hit a rule that blocks something you actually
   want (e.g. a second accent for a comparison slide). Edit the rule, commit,
   done — the change hot-reloads into open editors and is visible in review.
2. **Distillation**: `node engine/distill.mjs <deck>` analyses human-authored
   edits (`data-author` elements, i18n META, git history) and proposes rule
   or token updates that capture what designers keep doing by hand — raising
   the 80% starting point for every future deck.

Deck-specific creative departures are welcome and *stay* deck-specific until
they prove out; promote them here only when they generalise.

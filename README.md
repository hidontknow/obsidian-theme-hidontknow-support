# Hidontknow Support

English | [简体中文](README.zh-CN.md)

A companion plugin for the [Hidontknow theme](https://github.com/hidontknow/obsidian-theme-hidontknow). The theme makes Live Preview look exactly like Reading view. A few differences come from how Obsidian's editor parses Markdown, so CSS alone can't fix them. This plugin handles those in Live Preview. Source mode is left untouched.

| What | Without the plugin | With the plugin |
| --- | --- | --- |
| Lists inside quotes | Shown as plain `- ` / `1. ` text | Bullets, numbers and checkboxes (clickable) with the same spacing as Reading view, including nested items |
| Code blocks inside lists | Box starts at the left edge, the list indent is part of the code | The whole block, box included, is indented to the list text |
| Footnote references | Raw `[^1]` | Superscript `[1]`, numbered by first reference like Reading view |
| Footnote definitions at the end of the note | Inline labels | A footnote section like Reading view: separator, numbers, `↩︎` back link |
| `%%comments%%` | Shown, dimmed | Hidden. A block comment takes its trailing blank lines with it, so the gap between paragraphs matches Reading view |
| Code highlighting | CodeMirror's highlighter, which splits code differently from Reading view | Highlighted with Reading view's Prism, so colors and styles match character by character |
| List markers | `-`, `*`, `+` all look the same; Reading view drops `)` from `1)` | `-` filled dot, `*` hollow circle, `+` square, `1)` keeps its parenthesis, in both views |
| Task items that wrap | Wrapped lines can start up to 1px left of the first line | Wrapped lines line up exactly with the first line's text |
| Ordered list numbers | `10.` stays `10.` | Renumbered the same way in both views: a list counts up from its first number, and an ordered list that directly follows a different kind of list (bullets, or `1.` vs `1)`) starts again at 1 |

When a list item changes level (pressing Enter on an empty item, Tab or Shift+Tab), its marker switches to match the list at the new level, and the following items are renumbered. This is undone together with the edit. Typing a different marker yourself is left alone.

When you type or edit an ordered list item, the numbers in the source are rewritten to the numbers shown, so the file matches what you see (for example, typing `7.` after `2.` becomes `3.`, and an ordered list right after a bullet list starts at `1.`). Only the list you are editing is changed; undo, opening a file and Source mode leave numbers alone.

In Reading view, the plugin also follows the blank lines in the source: blocks with no blank line between them sit directly together, two blank lines leave two lines of space, and blank lines between list items (loose lists) are kept, just like in the editor.

Whenever the cursor touches one of these, the original Markdown is shown so you can edit it, just like Obsidian's own markup.

## Limits

- Footnote definitions written in the middle of a note stay where they are. Reading view moves them to the end of the note.
- Inline footnotes `^[…]` get the right number, but their text is not added to the footnote section.
- The footnote section shows definitions in source order. Reading view orders them by first reference, so keep them in the same order.
- Code blocks with a language Prism doesn't know keep the editor's own highlighting.
- Every change rescans the whole note, and an edited code block is re-highlighted as a whole. Very long notes or code blocks with hundreds of lines may feel slower.

## Install

Until the plugin is in the community directory, copy `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/hidontknow/obsidian-theme-hidontknow-support/releases) into `<vault>/.obsidian/plugins/hidontknow-support/`, then enable it under Settings → Community plugins.

The plugin is designed for the Hidontknow theme. With other themes the spacing may not match.

## Development

The source is `src/main.js`. Run `npm ci` and `npm run build` to bundle it into `main.js`.

## License

[MIT](LICENSE)

# Markdown Preview Sample

A test document covering common Markdown features. Use it to verify rendering in the editor preview.

---

## Headings

# H1 — Page title
## H2 — Section
### H3 — Subsection
#### H4 — Minor heading
##### H5
###### H6

---

## Inline formatting

This paragraph has **bold**, *italic*, ***bold italic***, ~~strikethrough~~, `inline code`, and a [link to Anthropic](https://www.anthropic.com).

You can also use <kbd>⌘</kbd>+<kbd>K</kbd> for keyboard shortcuts and footnotes[^1].

[^1]: This is a footnote with a back-reference.

---

## Lists

### Unordered

- First item
- Second item
  - Nested item
  - Another nested item
    - Deeply nested
- Third item

### Ordered

1. Open the editor
2. Paste your content
3. Preview the result
   1. Verify headings
   2. Verify code blocks
   3. Verify tables

### Task list

- [x] Add headings
- [x] Add code blocks
- [ ] Add diagrams
- [ ] Ship preview

---

## Blockquotes

> Simplicity is the ultimate sophistication.
>
> — *Leonardo da Vinci*

> **Nested quotes work too:**
>> The inner quote sits one level deeper.
>>> And another one even deeper.

---

## Code

Inline: `const x = 42;`

Fenced block with language hint:

```ts
type User = {
  id: string;
  name: string;
  email?: string;
};

export function greet(user: User): string {
  return `Hello, ${user.name}!`;
}
```

```bash
# Run the dev server
npm install
npm run dev
```

```json
{
  "name": "agentsflow",
  "version": "1.0.0",
  "private": true
}
```

---

## Tables

| Feature       | Status      | Notes                          |
| ------------- | ----------- | ------------------------------ |
| Headings      | ✅ Working  | H1–H6 supported                |
| Code blocks   | ✅ Working  | Syntax highlighting preferred  |
| Tables        | ⚠️ Partial  | Alignment optional             |
| Math          | ❌ Missing  | Add KaTeX/MathJax support      |

### Aligned columns

| Left | Center | Right |
| :--- | :----: | ----: |
| a    |   b    |     c |
| 1    |   2    |     3 |

---

## Horizontal rule

Three dashes produce a horizontal rule:

---

## Links and images

- Autolink: <https://github.com>
- Inline image:

![Placeholder image](https://via.placeholder.com/400x120.png?text=Sample+Image)

Reference-style link: see the [docs][docs].

[docs]: https://www.markdownguide.org "Markdown Guide"

---

## Definition list (extension)

Markdown
: A lightweight markup language for plain text formatting.

Preview
: The rendered HTML output of a Markdown document.

---

## Callouts (GitHub-style)

> [!NOTE]
> Useful information that users should notice.

> [!TIP]
> A helpful suggestion.

> [!WARNING]
> Critical information requiring user attention.

> [!CAUTION]
> Advises about negative outcomes if not followed.

---

## HTML passthrough

<details>
<summary>Click to expand</summary>

Hidden content revealed after expanding. Supports **markdown** inside.

</details>

---

## Escapes

Use a backslash to render literal characters: \*not italic\*, \`not code\`, \# not a heading.

---

## Long paragraph

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

---

*End of sample.*

# Visual verification

Preferred loop:

```text
render -> capture -> inspect -> adjust -> capture again
```

Use the project's existing tooling first: Playwright screenshots, Storybook,
Puppeteer, browser dev server, snapshot tests, or terminal captures.

Record:

- exact route/story/command;
- viewport or terminal dimensions;
- before/after artifact paths when available;
- default and one meaningful interaction state;
- narrow and wide behavior;
- keyboard focus path;
- loading/empty/error states relevant to the change.

Passing unit tests do not prove visual quality. If a render cannot be produced,
return the limitation and downgrade the claim to code-level verification.

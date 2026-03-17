# Virgulas

Virgulas is a local-first browser outliner.

## Features

- Infinite list of editable nodes with recursive children
- Markdown rendering (bold, italic, links, images, inline code)
- Optional description field per node (auto-growing textarea when editing)
- Node collapse/expand (bullet click or `Ctrl+Enter`)
- Node indent/unindent (`Tab` / `Shift+Tab`)
- Node move (`Alt+↑` / `Alt+↓`)
- Node delete (`Ctrl+Backspace` or `Backspace` on empty node)
- Zoom into a node (`Alt+→`) with breadcrumb navigation
  - Zoomed node description is visible and editable with placeholder when empty
  - Zoomed node with no children shows an empty state to create the first child
- Undo/Redo stack (`Ctrl+Z` / `Ctrl+Y`)
- Smart-case search with result counter and `Tab`/`Shift+Tab` cycling
  - `Escape` clears search; `Enter` zooms to the closest collapsed ancestor of the current result
- Raw mode editor (`.vmd` format) with SAVE/CANCEL
- Node typography hierarchy (root 1rem, level 2 0.9rem, level 3+ 0.85rem)
- Distinct focus style (accent background + left border) separate from hover style
- Theme toggle (light/dark) persisted in localStorage
- Client-side AES-GCM encryption (passphrase never stored or transmitted)
- Optional quick unlock with device passkey (WebAuthn PRF) after passphrase unlock
- Optional cloud sync via Supabase (end-to-end encrypted)
- Keyboard shortcuts modal (`?` button)
- Options panel (theme, source link, purge data)

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```

2.  Run locally (serves the `source/` folder):
    ```bash
    npm run serve
    ```

3.  Run tests:
    ```bash
    npm test
    ```

## CI/CD

- Pull requests and pushes run Playwright E2E tests in GitHub Actions.
- Main branch deploys the static site to GitHub Pages and publishes branch previews under `/preview/<branch>`.
- A daily workflow runs E2E tests against `https://virgulas.com`.

Repository secrets expected by workflows:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `CLOUDFLARE_ZONE_ID` (optional, for cache purge)
- `CLOUDFLARE_API_TOKEN` (optional, for cache purge)

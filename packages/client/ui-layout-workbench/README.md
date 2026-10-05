# @workbench/ui-layout

Customized copy of upstream `@deepseek-ai/dsh-client-ui-layout` (version 0.2.1-alpha.1).
The web bundle loads THIS package in place of the upstream one (see
`packages/bundle/web-app/cordis.patch.yml`, row id `ui-layout`).

## Carried patches

- **Board deployments collapse the sidebar fully** (`src/client/AppFrame.tsx`):
  when `document.documentElement` carries `data-dsh-board-shell` (set by the
  task-board plugin, which re-homes the sidebar's general controls), the
  collapsed sidebar hides completely (width 0) instead of keeping the icon
  rail.

## Syncing from upstream

1. Copy the new upstream `packages/client/ui-layout` over this directory
   (exclude `node_modules/`, `lib/`, `*.tsbuildinfo`, `README.md`, `README.i18n.yaml`).
2. Re-apply the rename: package name → `@workbench/ui-layout`, tsdown name →
   `@workbench/ui-layout`.
3. Re-apply the collapsedWidth patch listed above.

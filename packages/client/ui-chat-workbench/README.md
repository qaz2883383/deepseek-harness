# @workbench/ui-chat

Customized copy of upstream `@deepseek-ai/dsh-client-ui-chat` (version 0.2.1-alpha.1).
The web bundle loads THIS package in place of the upstream one (see
`packages/bundle/web-app/cordis.patch.yml`, row id `ui-chat`).

## Carried patches

- **forkAt keeps the active feature panel mounted** (`src/client/apply.ts`):
  after a successful fork, upstream unconditionally calls
  `ctx.uiWorkspace.openSession(childId)`, which selects the Conversation and
  unmounts any active feature panel (e.g. the task board). Our copy reads
  `ctx.layout.panelInfo.getSnapshot().activePanelId` first and skips the
  navigation when a feature panel owns the main view; the panel follows the
  fork itself.

## Syncing from upstream

1. Copy the new upstream `packages/client/ui-chat` over this directory
   (exclude `node_modules/`, `lib/`, `*.tsbuildinfo`, `README.md`, `README.i18n.yaml`).
2. Re-apply the rename: package name → `@workbench/ui-chat`, tsdown name →
   `@workbench/ui-chat`, `dsh.client.inject` layout entry → `@workbench/ui-layout`.
3. Re-apply the forkAt patch listed above.

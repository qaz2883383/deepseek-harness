/**
 * Embedded Conversation host for the task board's right column. Mirrors the
 * ui-subagent sidebar-chat presentation: the shared conversation content in
 * embedded form, with a board-owned view switch (chat / trajectory) that the
 * embedded variant's header-less layout cannot offer.
 */

import { useMemo, useState } from 'react'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { type BoardKey, NS } from './locales.ts'
import css from './BoardAction.module.css'

/** The conversation views the board's right column switches between. */
const BOARD_VIEWS = ['chat', 'trajectory'] as const

type BoardViewId = (typeof BOARD_VIEWS)[number]

/** Locale keys for the board's view tabs, keyed by view id. */
const VIEW_LABELS: Readonly<Record<BoardViewId, BoardKey>> = {
  chat: 'chatview.chat',
  trajectory: 'chatview.trajectory',
}

/**
 * The board's Conversation view position: a sticky tab strip plus the
 * selected view. The embedded variant has no session header, so the strip is
 * the only switch surface — sticky keeps it reachable while the transcript
 * scrolls under it.
 */
function BoardConversationViews({ view, onView, bt, renderSlot }: ConversationViewsProps & {
  readonly view: BoardViewId
  readonly onView: (view: BoardViewId) => void
  readonly bt: (key: BoardKey) => string
}) {
  return (
    <>
      <div className={css.chatViewTabs} role="tablist">
        {BOARD_VIEWS.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === view}
            className={id === view ? `${css.chatViewTab} ${css.chatViewTabActive}` : css.chatViewTab}
            onClick={() => { onView(id) }}
          >
            {bt(VIEW_LABELS[id])}
          </button>
        ))}
      </div>
      {renderSlot('conversation.session', { view })}
    </>
  )
}

/** Props supplied to the board's session-scoped Conversation host. */
export type BoardConversationPanelProps =
  PropsRuntime<'board.conversation'> & PropsRenderFactories & PropsLocale<typeof NS>

/** Render the shared Conversation content for the board-selected session. */
export function BoardConversationPanel({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot, t,
}: BoardConversationPanelProps) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  // The board's view selection for this embedded conversation: panel state
  // threaded through a stable wrapper, so unrelated re-renders never remount
  // the conversation; a view switch itself remounts it, exactly as the
  // native view change replaces the content.
  const [view, setView] = useState<BoardViewId>('chat')
  const Views = useMemo(() => {
    const Wrapped = (props: ConversationViewsProps) =>
      <BoardConversationViews {...props} view={view} onView={setView} bt={t} />
    return Wrapped
  }, [view, t])
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
    slots: { views: Views },
  })
}

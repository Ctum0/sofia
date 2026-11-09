<script setup lang="ts">
import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'

import { ChatBackgroundTasks, ChatHistory } from '@proj-airi/stage-ui/components'
import { VoiceCallCapsule } from '@proj-airi/stage-ui/components/scenarios/chat'
import { useAnalytics } from '@proj-airi/stage-ui/composables/use-analytics'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useDeferredMount } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

import ChatPanelHeader from '../Widgets/chat-panel-header.vue'
import ChatActionButtons from '../Widgets/ChatActionButtons.vue'
import ChatArea from '../Widgets/ChatArea.vue'
import ChatContainer from '../Widgets/ChatContainer.vue'
import SofiaVoiceDock from '../Widgets/SofiaVoiceDock.vue'

import { useChatToolCallRerun } from '../../composables/useChatToolCallRerun'
import { useStageChatComposerStore } from '../../stores/chat-composer'

const { isReady } = useDeferredMount()
const chatOrchestrator = useChatStore()
const { activeTurns, backgroundTasks } = storeToRefs(chatOrchestrator)
const { activeSessionId, messages } = storeToRefs(useChatSessionStore())
const { streamingMessage } = storeToRefs(useChatStreamStore())
const { isReceivingRemoteStream } = storeToRefs(useContextBridgeStore())

const isLoading = ref(true)
const { composer } = useStageChatComposerStore()
const { clearReplyForMessage, selectReply } = composer
const historyMessages = computed(() => messages.value)
const isActiveSessionSending = computed(() => (
  (activeTurns.value.some(turn => turn.sessionId === activeSessionId.value))
  || isReceivingRemoteStream.value
))
const visibleStreamingMessage = streamingMessage
const { trackChatMessageDeleted } = useAnalytics()
const { rerunToolCall } = useChatToolCallRerun()

async function handleDeleteMessage(payload: { message: ChatHistoryItem, index: number }) {
  const { index, message } = payload
  await useChatSessionStore().deleteMessage({
    sessionId: activeSessionId.value,
    messageId: message?.id,
    index,
  })
  trackChatMessageDeleted({
    source: 'history',
    message_role: message?.role ?? 'unknown',
  })
  clearReplyForMessage(message)
}

async function handleRetryMessage(index: number) {
  await chatOrchestrator.retry({ sessionId: activeSessionId.value, index })
}
</script>

<template>
  <div flex="col" min-h-0 items-center pt-4>
    <div min-h-0 w-full flex-1 py="4">
      <ChatContainer>
        <div
          v-if="isLoading"
          absolute left-0 top-0 h-1 w-full overflow-hidden rounded-t-xl
          class="bg-primary-500/20"
        >
          <div h-full w="1/3" origin-left bg-primary-500 class="animate-scan" />
        </div>
        <ChatPanelHeader />
        <div w="full" max-h="<md:[60%]" py="<sm:2" flex="~ col" rounded="lg" relative min-h-0 flex-1 overflow-hidden px="2 <md:0" py-4>
          <ChatHistory
            v-if="isReady"
            :messages="historyMessages"
            :sending="isActiveSessionSending"
            :streaming-message="visibleStreamingMessage"
            h-full
            variant="desktop"
            @delete-message="handleDeleteMessage"
            @reply-message="selectReply"
            @retry-message="handleRetryMessage($event.index)"
            @tool-call-rerun="rerunToolCall"
            @vue:mounted="isLoading = false"
          />
        </div>
        <ChatBackgroundTasks :tasks="backgroundTasks" @stop="task => chatOrchestrator.stopBackgroundTask(task.sessionId)" @dismiss="task => chatOrchestrator.dismissBackgroundTask(task.sessionId)" />
        <ChatArea :composer="composer" :generating="isActiveSessionSending" />
      </ChatContainer>
    </div>

    <!--
      The bottom stack: the dock and the toolbar are siblings in one flex column with an
      8px gap, and the chat panel above is `flex-1 min-h-0` while this row is `shrink-0`.
      The toolbar therefore owns the row below the dock and can never ride up over the
      composer the way the old `absolute bottom--8 right-0` toolbar did.
    -->
    <div class="sofia-bottom-stack" flex="col" items-center gap-2 w-full shrink-0 pt-2 pb-3>
      <SofiaVoiceDock />
      <ChatActionButtons />
    </div>
    <!-- Teleports to `body` and pins itself to the top edge, so it adds no height here. -->
    <VoiceCallCapsule />
  </div>
</template>

<style scoped>
@keyframes scan {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(400%);
  }
}

.animate-scan {
  animation: scan 2s infinite linear;
}
</style>

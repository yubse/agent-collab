import type { AgentCapabilities, AgentError, AgentEvent, AgentProvider, AgentSendOpts } from './provider.ts'
import { ConnectorDispatcher } from '../connector/dispatcher.ts'
import { ConnectorRegistry } from '../connector/registry.ts'

const CAPABILITIES: AgentCapabilities = {
  providerName: 'remote-codex',
  supportsSessionResume: true,
  supportsAttachments: false,
  supportsToolUse: true,
  supportsThinking: false,
  supportsPartialEvents: false,
}

export class RemoteCodexProvider implements AgentProvider {
  private eventCb: ((event: AgentEvent) => void | Promise<void>) | null = null
  private errorCb: ((error: AgentError) => void) | null = null
  private active = false

  constructor(
    private dispatcher: ConnectorDispatcher,
    private registry: ConnectorRegistry,
    private context: { userId: string; conversationId: string; agentId: string },
  ) {}

  get isAlive(): boolean { return this.registry.isUserOnline(this.context.userId) }
  get sessionId(): string | null { return null }
  capabilities(): AgentCapabilities { return CAPABILITIES }
  onEvent(cb: (event: AgentEvent) => void | Promise<void>): void { this.eventCb = cb }
  onError(cb: (error: AgentError) => void): void { this.errorCb = cb }

  async send(text: string, _opts?: AgentSendOpts): Promise<void> {
    if (this.active) throw new Error('remote provider already has an active turn')
    this.active = true
    try {
      const result = await this.dispatcher.dispatch({
        user_id: this.context.userId,
        conversation_id: this.context.conversationId,
        agent_id: this.context.agentId,
        prompt: text,
      })
      if (result.content?.trim()) await this.eventCb?.({ type: 'assistant', text: result.content, raw: result })
      // Mark the turn free before emitting `result`: the server's result handler
      // immediately starts the next queued route on this same provider.
      this.active = false
      await this.eventCb?.({ type: 'result', usage: result.usage || undefined, raw: result })
    } catch (error: any) {
      const message = error?.message || 'remote connector error'
      this.errorCb?.({ kind: /timeout/i.test(message) ? 'timeout' : 'protocol_error', message })
      throw error
    } finally {
      this.active = false
    }
  }

  async interrupt(): Promise<boolean> { return false }
  async close(): Promise<void> {}
}

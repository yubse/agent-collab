/**
 * Per-agent FIFO routing context for long-lived provider turns.
 *
 * Providers may accept a second turn before the first turn has emitted its
 * assistant/result events. Keeping only one boolean/conversation per agent lets
 * the newer dispatch overwrite the older one, so a normal reply can be mistaken
 * for an observe-only reply. Some providers merge input sent during an active
 * turn, so only the queue head is started; the next prompt is sent after the
 * active turn's result event.
 */
export type AgentTurnRoute = {
  id: string
  conversationId: string
  observeOnly: boolean
  dispatchId: string
  recordId: string
  prompt: string
  started: boolean
  /** Hop number of the assistant output produced by this turn. */
  hopCount: number
}

export class AgentTurnRouteQueue {
  private queues = new Map<string, AgentTurnRoute[]>()

  enqueue(agentId: string, route: AgentTurnRoute): void {
    const queue = this.queues.get(agentId)
    if (queue) queue.push(route)
    else this.queues.set(agentId, [route])
  }

  current(agentId: string): AgentTurnRoute | null {
    return this.queues.get(agentId)?.[0] || null
  }

  /** Mark and return the head route only when it has not been sent yet. */
  startNext(agentId: string): AgentTurnRoute | null {
    const route = this.current(agentId)
    if (!route || route.started) return null
    route.started = true
    return route
  }

  complete(agentId: string): AgentTurnRoute | null {
    const queue = this.queues.get(agentId)
    if (!queue?.length) return null
    const completed = queue.shift() || null
    if (queue.length === 0) this.queues.delete(agentId)
    return completed
  }

  remove(agentId: string, routeId: string): AgentTurnRoute | null {
    const queue = this.queues.get(agentId)
    if (!queue?.length) return null
    const index = queue.findIndex((route) => route.id === routeId)
    if (index === -1) return null
    const [removed] = queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(agentId)
    return removed || null
  }

  hasResponseTurn(agentId: string): boolean {
    return Boolean(this.queues.get(agentId)?.some((route) => !route.observeOnly))
  }

  clear(agentId: string): AgentTurnRoute[] {
    const routes = this.queues.get(agentId) || []
    this.queues.delete(agentId)
    return routes
  }
}

import { describe, expect, test } from 'bun:test'
import { AgentTurnRouteQueue } from './agent-turn-routing.ts'

describe('AgentTurnRouteQueue', () => {
  test('a later observe turn cannot overwrite an active response turn', () => {
    const routes = new AgentTurnRouteQueue()
    routes.enqueue('product', {
      id: 'normal',
      conversationId: 'product-group',
      observeOnly: false,
      dispatchId: 'dispatch-normal',
      recordId: 'record-normal',
      prompt: 'normal prompt',
      started: false,
      hopCount: 1,
    })
    routes.enqueue('product', {
      id: 'observe',
      conversationId: 'product-group',
      observeOnly: true,
      dispatchId: 'dispatch-observe',
      recordId: 'record-observe',
      prompt: 'observe prompt',
      started: false,
      hopCount: 2,
    })

    expect(routes.startNext('product')?.id).toBe('normal')
    expect(routes.startNext('product')).toBeNull()
    expect(routes.current('product')?.id).toBe('normal')
    expect(routes.complete('product')?.id).toBe('normal')
    expect(routes.startNext('product')?.id).toBe('observe')
    expect(routes.current('product')?.id).toBe('observe')
    expect(routes.complete('product')?.id).toBe('observe')
    expect(routes.current('product')).toBeNull()
  })

  test('removes only the rejected dispatch while preserving queue order', () => {
    const routes = new AgentTurnRouteQueue()
    for (const id of ['first', 'rejected', 'last']) {
      routes.enqueue('creative', {
        id,
        conversationId: 'workgroup',
        observeOnly: id === 'last',
        dispatchId: `dispatch-${id}`,
        recordId: `record-${id}`,
        prompt: `${id} prompt`,
        started: false,
        hopCount: 1,
      })
    }

    expect(routes.remove('creative', 'rejected')?.id).toBe('rejected')
    expect(routes.complete('creative')?.id).toBe('first')
    expect(routes.complete('creative')?.id).toBe('last')
  })

  test('tracks whether a visible response turn remains queued', () => {
    const routes = new AgentTurnRouteQueue()
    routes.enqueue('social', {
      id: 'observe',
      conversationId: 'workgroup',
      observeOnly: true,
      dispatchId: 'dispatch-observe',
      recordId: 'record-observe',
      prompt: 'observe prompt',
      started: false,
      hopCount: 1,
    })
    expect(routes.hasResponseTurn('social')).toBe(false)
    routes.enqueue('social', {
      id: 'normal',
      conversationId: 'workgroup',
      observeOnly: false,
      dispatchId: 'dispatch-normal',
      recordId: 'record-normal',
      prompt: 'normal prompt',
      started: false,
      hopCount: 1,
    })
    expect(routes.hasResponseTurn('social')).toBe(true)
  })
})

export interface ConnectorSocket {
  send(data: string): unknown
  close?(code?: number, reason?: string): unknown
}

export type ConnectorConnection = {
  deviceId: string
  userId: string
  deviceName: string
  socket: ConnectorSocket
  connectedAt: number
  lastSeenAt: number
}

export class ConnectorRegistry {
  private devices = new Map<string, ConnectorConnection>()
  private disconnectListeners = new Set<(connection: ConnectorConnection) => void>()

  register(input: Omit<ConnectorConnection, 'connectedAt' | 'lastSeenAt'>): ConnectorConnection {
    const previous = this.devices.get(input.deviceId)
    if (previous && previous.socket !== input.socket) previous.socket.close?.(4001, 'device connected elsewhere')
    const now = Date.now()
    const connection = { ...input, connectedAt: now, lastSeenAt: now }
    this.devices.set(input.deviceId, connection)
    return connection
  }

  unregister(deviceId: string, socket?: ConnectorSocket): void {
    const connection = this.devices.get(deviceId)
    if (!connection || (socket && connection.socket !== socket)) return
    this.devices.delete(deviceId)
    for (const listener of this.disconnectListeners) listener(connection)
  }

  touch(deviceId: string): void {
    const connection = this.devices.get(deviceId)
    if (connection) connection.lastSeenAt = Date.now()
  }

  forUser(userId: string): ConnectorConnection | null {
    const candidates = [...this.devices.values()].filter((item) => item.userId === userId)
    candidates.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    return candidates[0] || null
  }

  get(deviceId: string): ConnectorConnection | null { return this.devices.get(deviceId) || null }
  isUserOnline(userId: string): boolean { return Boolean(this.forUser(userId)) }
  onDisconnect(listener: (connection: ConnectorConnection) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }
}


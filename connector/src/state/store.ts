export type ServerStatus = 'SERVER_DISCONNECTED' | 'SERVER_CONNECTED'
export type CodexStatus =
  | 'CODEX_RUNTIME_NOT_INSTALLED'
  | 'CODEX_RUNTIME_INSTALLING'
  | 'CODEX_RUNTIME_ERROR'
  | 'CODEX_NOT_LOGGED_IN'
  | 'CODEX_AUTHENTICATING'
  | 'CODEX_READY'
export type ExecutionStatus = 'EXECUTION_IDLE' | 'EXECUTION_RUNNING' | 'EXECUTION_ERROR'

export type ConnectorState = {
  server: ServerStatus
  serverError: string | null
  codex: CodexStatus
  execution: ExecutionStatus
  lastError: string | null
  updatedAt: string
}

export type ConnectorStateListener = (state: Readonly<ConnectorState>) => void

export class ConnectorStateStore {
  private state: ConnectorState = {
    server: 'SERVER_DISCONNECTED',
    serverError: null,
    codex: 'CODEX_RUNTIME_NOT_INSTALLED',
    execution: 'EXECUTION_IDLE',
    lastError: null,
    updatedAt: new Date().toISOString(),
  }
  private listeners = new Set<ConnectorStateListener>()

  snapshot(): Readonly<ConnectorState> { return { ...this.state } }

  subscribe(listener: ConnectorStateListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  setServer(server: ServerStatus, error: string | null = null): void {
    this.update({ server, serverError: error, lastError: error })
  }

  setCodex(codex: CodexStatus, error: string | null = null): void {
    this.update({ codex, lastError: error })
  }

  setExecution(execution: ExecutionStatus, error: string | null = null): void {
    this.update({ execution, lastError: error })
  }

  private update(patch: Partial<ConnectorState>): void {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() }
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

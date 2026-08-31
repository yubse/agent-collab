(function attachAIStudioTypewriter(root) {
  const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
    : null;

  function splitGraphemes(value) {
    const text = String(value || '');
    if (!text) return [];
    return segmenter
      ? Array.from(segmenter.segment(text), item => item.segment)
      : Array.from(text);
  }

  function chunkSizeFor(backlog, resultReceived) {
    let size = backlog <= 12 ? 1
      : backlog <= 36 ? 2
      : backlog <= 90 ? 3
      : backlog <= 180 ? 5
      : backlog <= 360 ? 9
      : Math.min(48, Math.ceil(backlog / 30));
    // Once the final result has arrived there will be no natural pause from the
    // model. Drain a large backlog promptly instead of making the completed turn
    // spend several more seconds "typing".
    if (resultReceived && backlog > 60) {
      size = Math.max(size, Math.min(48, Math.ceil(backlog / 24)));
    }
    return size;
  }

  class TypewriterBuffer {
    constructor(options = {}) {
      this.tickMs = Math.max(10, Number(options.tickMs) || 20);
      this.autoStart = options.autoStart !== false;
      this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
      this.schedule = options.schedule || ((fn, ms) => setInterval(fn, ms));
      this.cancel = options.cancel || (timer => clearInterval(timer));
      this.messages = new Map();
    }

    begin(input) {
      const id = String(input?.messageId || input?.message_id || '').trim();
      if (!id) return false;
      if (this.messages.has(id)) return false;
      const state = {
        id,
        channelId: String(input.channelId || input.conversation_id || ''),
        senderId: String(input.senderId || input.agent_id || input.sender_id || ''),
        createdAt: input.createdAt || input.ts || new Date().toISOString(),
        displayedText: '', receivedText: '', pending: [], resultReceived: false,
        completed: false, failed: false, error: '', finalText: null,
        persisted: false, persistedRecord: null, timer: null, seenEvents: new Set(),
      };
      this.messages.set(id, state);
      this._notify(state, 'started');
      return true;
    }

    pushDelta(input) {
      const id = String(input?.messageId || input?.message_id || '').trim();
      const delta = String(input?.delta ?? input?.text_delta ?? input?.content_delta ?? '');
      if (!id || !delta) return false;

      if (!this.messages.has(id)) this.begin(input);
      const state = this.messages.get(id);
      if (state.completed) return false;

      const eventKey = input.eventKey ?? input.event_id ?? input.sequence ?? input.seq ?? null;
      if (eventKey !== null && eventKey !== undefined) {
        const key = String(eventKey);
        if (state.seenEvents.has(key)) return false;
        state.seenEvents.add(key);
      }

      state.pending.push(...splitGraphemes(delta));
      state.receivedText += delta;
      this._notify(state, 'delta');
      this._ensureTimer(state);
      return true;
    }

    finish(input) {
      const id = String(input?.messageId || input?.message_id || '').trim();
      const state = this.messages.get(id);
      // A final saved response with no real delta must render normally. Starting a
      // typewriter from execution_result alone would be fake streaming.
      if (!state || state.completed) return false;

      state.resultReceived = true;
      state.failed = input.status === 'error' || input.failed === true;
      state.error = state.failed ? String(input.error || '生成失败') : '';
      const finalTextValue = input.content ?? input.text;
      if (typeof finalTextValue === 'string') {
        state.finalText = finalTextValue;
        const bufferedText = state.displayedText + state.pending.join('');
        if (finalTextValue.startsWith(bufferedText)) {
          state.pending.push(...splitGraphemes(finalTextValue.slice(bufferedText.length)));
        } else if (finalTextValue.startsWith(state.displayedText)) {
          state.pending = splitGraphemes(finalTextValue.slice(state.displayedText.length));
        }
      }
      this._notify(state, state.failed ? 'failed' : 'result');
      if (!this._completeIfDrained(state)) this._ensureTimer(state);
      return true;
    }

    fail(input) {
      return this.finish({ ...input, status: 'error', failed: true });
    }

    stop(input) {
      const id = String(input?.messageId || input?.message_id || '').trim();
      const state = this.messages.get(id);
      if (!state || state.completed) return false;
      // User cancellation freezes exactly what has already reached the screen.
      // Buffered or late text must never appear after the run is stopped.
      state.pending = [];
      state.receivedText = state.displayedText;
      state.finalText = state.displayedText;
      state.resultReceived = true;
      state.failed = true;
      state.error = String(input?.error || 'CODEX_EXECUTION_CANCELLED');
      state.completed = true;
      this._stopTimer(state);
      this._notify(state, 'stopped');
      return true;
    }

    markPersisted(messageId, record) {
      const state = this.messages.get(String(messageId || ''));
      if (!state) return false;
      state.persisted = true;
      state.persistedRecord = record || null;
      if (!state.resultReceived) {
        this.finish({ messageId: state.id, status: 'success', content: String(record?.text || '') });
      } else {
        this._notify(state, 'persisted');
      }
      return true;
    }

    tick(messageId) {
      const state = this.messages.get(String(messageId || ''));
      if (!state || state.completed) return false;
      if (state.pending.length === 0) {
        this._completeIfDrained(state);
        return false;
      }
      const take = chunkSizeFor(state.pending.length, state.resultReceived);
      state.displayedText += state.pending.splice(0, take).join('');
      this._notify(state, 'tick');
      this._completeIfDrained(state);
      return true;
    }

    get(messageId) {
      return this.messages.get(String(messageId || '')) || null;
    }

    list(channelId) {
      return [...this.messages.values()].filter(state => !channelId || state.channelId === channelId);
    }

    remove(messageId) {
      const state = this.messages.get(String(messageId || ''));
      if (!state) return false;
      this._stopTimer(state);
      this.messages.delete(state.id);
      return true;
    }

    dispose() {
      for (const state of this.messages.values()) this._stopTimer(state);
      this.messages.clear();
    }

    _ensureTimer(state) {
      if (!this.autoStart || state.timer || state.completed) return;
      state.timer = this.schedule(() => this.tick(state.id), this.tickMs);
    }

    _stopTimer(state) {
      if (!state.timer) return;
      this.cancel(state.timer);
      state.timer = null;
    }

    _completeIfDrained(state) {
      if (!state.resultReceived || state.pending.length > 0) return false;
      if (typeof state.finalText === 'string' && state.displayedText !== state.finalText) {
        state.displayedText = state.finalText;
      }
      state.completed = true;
      this._stopTimer(state);
      this._notify(state, state.failed ? 'failed-complete' : 'complete');
      return true;
    }

    _notify(state, reason) {
      this.onUpdate(state, reason);
    }
  }

  root.AIStudioTypewriterBuffer = TypewriterBuffer;
  root.AIStudioSplitGraphemes = splitGraphemes;
})(typeof window !== 'undefined' ? window : globalThis);

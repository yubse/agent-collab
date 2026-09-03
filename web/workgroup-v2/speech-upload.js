(function (root) {
  'use strict';

  const HELPER_URL = 'http://127.0.0.1:39481';

  async function json(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP_${response.status}`);
    return body;
  }

  async function create(file, options = {}) {
    if (!(file instanceof File)) throw new Error('SPEECH_FILE_REQUIRED');
    const created = await fetch('/api/transcriptions', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original_name: file.name, mime_type: file.type || 'application/octet-stream',
        byte_size: file.size, title: options.title || null, channel_id: options.channelId || null,
      }),
    }).then(json);
    return created.transcription;
  }

  async function upload(file, options = {}) {
    const transcription = await create(file, options);
    if (typeof options.onCreated === 'function') options.onCreated(transcription);
    await uploadExisting(file, transcription.id, options);
    return transcription.id;
  }

  async function uploadExisting(file, transcriptionId, options = {}) {
    if (!(file instanceof File)) throw new Error('SPEECH_FILE_REQUIRED');
    const proof = await fetch(`/api/transcriptions/${encodeURIComponent(transcriptionId)}/speech-proof`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(json);
    const grant = await fetch(`${HELPER_URL}/speech/grant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcription_id: transcriptionId, session_proof: proof.session_proof }),
    }).then(json);
    console.info(`[speech-upload] transcription=${transcriptionId} stage=speech_grant_ready`);
    // Keep the browser's File as a ReadableStream; never materialize the recording
    // as an in-memory buffer and never send its bytes to the NAS origin.
    const speechUrl = `${grant.speech_url}/transcriptions/${encodeURIComponent(transcriptionId)}/audio`;
    console.info(`[speech-upload] transcription=${transcriptionId} stage=speech_fetch_start`);
    let response;
    try {
      response = await fetch(speechUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${grant.speech_token}`,
          'Content-Type': file.type || 'application/octet-stream',
          'X-AIStudio-Original-Name': file.name,
          'X-AIStudio-Byte-Size': String(file.size),
        },
        body: file.stream(),
        duplex: 'half',
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[speech-upload] transcription=${transcriptionId} stage=speech_fetch_throw error_name=${name} error_message=${message}`);
      throw error;
    }
    console.info(`[speech-upload] transcription=${transcriptionId} stage=speech_fetch_response status=${response.status}`);
    await json(response);
    return transcriptionId;
  }

  async function retry(transcriptionId, file) {
    await fetch(`/api/transcriptions/${encodeURIComponent(transcriptionId)}/retry`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original_name: file.name, mime_type: file.type || 'application/octet-stream', byte_size: file.size }),
    }).then(json);
    return uploadExisting(file, transcriptionId);
  }

  async function cancel(transcriptionId) {
    await fetch(`/api/transcriptions/${encodeURIComponent(transcriptionId)}/cancel`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(json);
    return fetch(`${HELPER_URL}/speech/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcription_id: transcriptionId }),
    }).then(json);
  }

  async function status() {
    return fetch(`${HELPER_URL}/speech/status`).then(json);
  }

  async function installModel() {
    return fetch(`${HELPER_URL}/speech/model/install`, { method: 'POST' }).then(json);
  }

  root.AIStudioSpeech = { create, upload, uploadExisting, retry, cancel, status, installModel, helperUrl: HELPER_URL };
})(window);

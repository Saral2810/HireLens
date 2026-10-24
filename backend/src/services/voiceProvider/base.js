export class NotImplementedError extends Error {
  constructor(methodName) {
    super(`${methodName} is not implemented`);
    this.name = 'NotImplementedError';
  }
}

export class VoiceProvider {
  constructor(credentials) {
    this.credentials = credentials || {};
  }

  async initiateCall(phone, agentId, variables, webhookUrl) {
    throw new NotImplementedError('initiateCall');
  }

  async getCallStatus(sessionId) {
    throw new NotImplementedError('getCallStatus');
  }

  async getAgents() {
    throw new NotImplementedError('getAgents');
  }

  async parseWebhook(req) {
    throw new NotImplementedError('parseWebhook');
  }

  async fetchArtifacts(callId) {
    throw new NotImplementedError('fetchArtifacts');
  }
}

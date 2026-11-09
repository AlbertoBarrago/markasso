import { afterEach, describe, expect, it } from 'vitest';
import {
  agentRequests,
  canSendAgentRequests,
  handleRequestAccess,
  handleRequestStatus,
  revokeAgentRequestAccess,
  sendAgentRequest,
  setAgentRequestSender,
} from '../src/io/agent_requests';

function connect() {
  const sent: Record<string, unknown>[] = [];
  setAgentRequestSender((msg) => sent.push(msg as Record<string, unknown>));
  return sent;
}

afterEach(() => setAgentRequestSender(null));

describe('agent requests (client)', () => {
  it('sends nothing until the room grants access', () => {
    const sent = connect();
    expect(canSendAgentRequests()).toBe(false);
    expect(sendAgentRequest('agent', 'hi')).toBe(false);
    expect(sent).toEqual([]);
  });

  it('tracks a request from sent to replied', () => {
    const sent = connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    expect(sendAgentRequest('agent', '  Add a cache  ')).toBe(true);
    const ref = sent[0]?.ref as string;
    expect(sent[0]).toEqual({
      type: 'request',
      ref,
      to: 'agent',
      text: 'Add a cache',
    });
    handleRequestStatus({
      type: 'request_status',
      ref,
      id: 'r',
      status: 'sent',
    });
    handleRequestStatus({
      type: 'request_status',
      id: 'r',
      status: 'replied',
      text: 'Done',
    });
    // A late `received` does not hide the answer.
    handleRequestStatus({
      type: 'request_status',
      id: 'r',
      status: 'received',
    });
    expect(agentRequests('agent')).toEqual([
      expect.objectContaining({ status: 'replied', replies: ['Done'] }),
    ]);
  });

  it('loses access on an unauthorized rejection and on disconnect', () => {
    const sent = connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest('agent', 'hi');
    handleRequestStatus({
      type: 'request_status',
      ref: sent[0]?.ref as string,
      status: 'rejected',
      reason: 'unauthorized',
    });
    expect(canSendAgentRequests()).toBe(false);
    handleRequestAccess({ type: 'request_access', allowed: true });
    revokeAgentRequestAccess();
    expect(canSendAgentRequests()).toBe(false);
  });

  it('keeps only the last five requests per agent', () => {
    connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    for (let i = 0; i < 7; i++) sendAgentRequest('agent', `request ${i}`);
    expect(agentRequests('agent').map((e) => e.text)).toEqual([
      'request 2',
      'request 3',
      'request 4',
      'request 5',
      'request 6',
    ]);
  });

  it('forgets everything when the session ends', () => {
    connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest('agent', 'hi');
    setAgentRequestSender(null);
    expect(agentRequests('agent')).toEqual([]);
    expect(canSendAgentRequests()).toBe(false);
  });
});

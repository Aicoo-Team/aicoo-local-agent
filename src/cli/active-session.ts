import type { CommunicationSession } from "../shared/contracts.js";

/**
 * Select a relationship whose route from `selfPrincipalId` actually terminates at the peer's
 * local runtime. A communication session is bidirectional, so the destination is the frozen
 * recipient route in the forward direction and the requester reply route in reverse.
 */
export function selectLocalSessionForPeer(
  sessions: readonly CommunicationSession[],
  selfPrincipalId: string,
  peerPrincipalId: string,
): CommunicationSession | undefined {
  return sessions
    .filter((session) => session.status === "active")
    .filter((session) => {
      const route = destinationRoute(session, selfPrincipalId, peerPrincipalId);
      return Boolean(route && isLocalRuntimeRoute(route.endpointId, route.sessionHandle));
    })
    .sort((left, right) =>
      Date.parse(right.activatedAt ?? right.requestedAt) - Date.parse(left.activatedAt ?? left.requestedAt))[0];
}

function destinationRoute(
  session: CommunicationSession,
  selfPrincipalId: string,
  peerPrincipalId: string,
): { endpointId?: string; sessionHandle?: string } | undefined {
  if (
    session.requester.principalId === selfPrincipalId
    && session.recipient.principalId === peerPrincipalId
  ) {
    return {
      endpointId: session.recipient.endpointId,
      sessionHandle: session.recipient.sessionHandle,
    };
  }
  if (
    session.recipient.principalId === selfPrincipalId
    && session.requester.principalId === peerPrincipalId
  ) {
    return {
      endpointId: session.requester.replyEndpointId,
      sessionHandle: session.requester.replySessionHandle,
    };
  }
  return undefined;
}

function isLocalRuntimeRoute(endpointId?: string, sessionHandle?: string): boolean {
  if (!endpointId?.trim() || !sessionHandle?.trim()) return false;
  return !endpointId.startsWith("chat:") && !sessionHandle.startsWith("chat:");
}

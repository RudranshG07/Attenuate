export interface EnrollmentSession {
  sessionId: string;
  pairingCode: string;
  expiresAt: number;
}

export async function beginEnrollment(hostLabel: string): Promise<EnrollmentSession> {
  throw new Error("todo");
}

export async function completeEnrollment(sessionId: string, pairingCode: string): Promise<void> {
  throw new Error("todo");
}

export async function relayApprovalRequest(summary: string): Promise<boolean> {
  throw new Error("todo");
}

import type { MessageDelivery } from "../shared/contracts.js";

export function formatDelivery(delivery: MessageDelivery): string {
  const lines = [
    `messageId: ${delivery.messageId}`,
    `status: ${delivery.status}${delivery.adapterLabel ? ` ${delivery.adapterLabel}` : ""}`,
    `queuedAt: ${delivery.queuedAt}`,
  ];
  if (delivery.dispatchedAt) lines.push(`dispatchedAt: ${delivery.dispatchedAt} (+${delta(delivery.queuedAt, delivery.dispatchedAt)}ms)`);
  if (delivery.deviceAckReceivedAt) {
    lines.push(`deviceAckReceivedAt: ${delivery.deviceAckReceivedAt} (+${delta(delivery.queuedAt, delivery.deviceAckReceivedAt)}ms)`);
  }
  if (delivery.runtimePendingAt) lines.push(`runtimePendingAt: ${delivery.runtimePendingAt}`);
  if (delivery.runtimeAckReceivedAt) {
    lines.push(`runtimeAckReceivedAt: ${delivery.runtimeAckReceivedAt} (+${delta(delivery.queuedAt, delivery.runtimeAckReceivedAt)}ms)`);
  }
  if (delivery.resultCode) lines.push(`resultCode: ${delivery.resultCode}`);
  if (delivery.runtimeAckId) lines.push(`runtimeAckId: ${delivery.runtimeAckId}`);
  return lines.join("\n");
}

function delta(start: string, end: string): number {
  return new Date(end).getTime() - new Date(start).getTime();
}

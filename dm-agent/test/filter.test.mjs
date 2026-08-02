/**
 * Inbound-message filter: which rows the loop may turn into an agent turn.
 * Guards the anti-loop property — agent-authored rows (ours or a peer's) are
 * never processed, so two dm-agents cannot auto-reply to each other.
 */
const me = "9b44950b";
const cursor = 100;

const rows = [
  { id: 101, senderType: "human", senderId: "b35bd366", role: "user", label: "peer human message", expected: true },
  { id: 102, senderType: "agent", senderId: me, role: "user", label: "our own reply echoed back", expected: false },
  { id: 103, senderType: "agent", senderId: "b35bd366", role: "user", label: "peer AGENT message (a2a loop bait)", expected: false },
  { id: 104, senderType: "human", senderId: me, role: "user", label: "owner's own message", expected: false },
  { id: 105, senderType: "human", senderId: "b35bd366", role: "assistant", label: "assistant-role row", expected: false },
  { id: 99, senderType: "human", senderId: "b35bd366", role: "user", label: "older than cursor", expected: false },
];

const selected = rows
  .filter((m) => Number(m.id) > cursor)
  .filter((m) => m.senderType === "human" && m.senderId && m.senderId !== me && m.role !== "assistant")
  .map((m) => m.id);

let failures = 0;
for (const row of rows) {
  const picked = selected.includes(row.id);
  const ok = picked === row.expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${row.label} -> ${picked ? "processed" : "skipped"}`);
}
console.log(failures === 0 ? `\nFILTER-OK (${rows.length} rows)` : `\nFILTER-FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

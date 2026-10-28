import type { HiveTask, HumanQA } from './TasksKanban';

/**
 * Answer the open question on a task card: record it ON the card (humanQA),
 * then tell the orchestrator so the card gets unblocked and work continues.
 * Resolves the card's new humanQA, or null when the card changed underneath
 * (the question was swapped or already answered), in which case nothing was
 * written. Shared by the Ask me board and the Inbox conversations.
 */
export async function answerOpenQuestion(task: HiveTask, open: HumanQA, text: string): Promise<HumanQA[] | null> {
  const humanQA = (task.humanQA ?? []).map((e) =>
    e === open || (e.q === open.q && !e.a)
      ? { ...e, a: text, answeredAt: new Date().toISOString() }
      : e
  );
  const result = await window.cth.hivePatchTask(task.id, { humanQA });
  if (!result.ok) return null;
  await window.cth.hiveSend({
    to: 'god',
    act: 'inform',
    subject: `HUMAN ANSWER on task "${task.title}"`,
    body: [
      `The human answered the open question on task ${task.id} ("${task.title}"):`,
      `Q: ${open.q}`,
      `A: ${text}`,
      'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.'
    ].join('\n')
  }, 'human');
  return humanQA;
}

/**
 * Put the open question on a card aside WITHOUT answering it: it is marked
 * dismissed (no made-up answer), stays in the card's history, and the card
 * stays blocked; the orchestrator can ask again. The same rule as the Ask me
 * board's ✕. Resolves whether it was written.
 */
export async function dismissOpenQuestion(task: HiveTask, open: HumanQA): Promise<boolean> {
  const humanQA = (task.humanQA ?? []).map((e) =>
    e === open || (e.q === open.q && !e.a && !e.dismissedAt)
      ? { ...e, dismissedAt: new Date().toISOString() }
      : e
  );
  const result = await window.cth.hivePatchTask(task.id, { humanQA });
  return !!result.ok;
}
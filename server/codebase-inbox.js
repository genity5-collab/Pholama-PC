'use strict';
// The chatbox the person can keep typing in WHILE the agent works. Messages wait here until the agent reads them.
// The agent reads them with the check_chatbox_pholama tool, and the loop also hands over anything unread at the start of a turn,
// so a new message is never missed. Kept in memory for one run only; nothing is written to disk.
const MAX_MESSAGES = 20, MAX_CHARS = 2000;

function create(now = Date.now) {
  let list = [];   // { id, text, at, read }
  let seq = 0;
  return {
    // The person sent something while the agent was working.
    add(text) {
      const t = String(text == null ? '' : text).trim().slice(0, MAX_CHARS);
      if (!t) return { ok: false, error: 'Type a message first.' };
      list.push({ id: ++seq, text: t, at: now(), read: false });
      if (list.length > MAX_MESSAGES) list = list.slice(-MAX_MESSAGES);
      return { ok: true, id: seq };
    },
    unread() { return list.filter(m => !m.read).length; },
    // Hands over every unread message once, oldest first, and marks them read.
    take() { const out = list.filter(m => !m.read); for (const m of out) m.read = true; return out.map(m => m.text); },
    clear() { list = []; },
  };
}

// The words the agent sees. The person's text is DATA from them, so it is quoted, and it is plainly a new request from the person.
function describe(texts) {
  if (!texts || !texts.length) return 'The chatbox has no new messages.';
  return "I've noticed " + (texts.length === 1 ? 'a new message' : texts.length + ' new messages') + ' from the person in the text box while you were working. Read ' + (texts.length === 1 ? 'it' : 'them') + ', fit ' + (texts.length === 1 ? 'it' : 'them') + ' into what you are doing, and say in a note what you will change:\n' + texts.map((t, i) => (i + 1) + '. "' + t + '"').join('\n');
}
module.exports = { create, describe, MAX_MESSAGES, MAX_CHARS };

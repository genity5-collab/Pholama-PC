'use strict';
// Pholama Codebase: the ONE registry of everything the agent may do.
// Every tool has a permission level. The agent loop may only call tools through run(), so a tool can never skip its permission check.
//   none    = runs without asking
//   ask     = the user must press Allow for this action
//   strict  = the user must press Allow every single time (never remembered, shows the exact command or target)
// Costs are credits per use (screenshot: 10 per shot and read, as the owner set).

const TOOLS = {
  // --- memory and eyes: the two most important tools, no approval ---
  note_:       { level: 'none',   cost: 0,  where: 'agent',  does: 'Write to the note board: what it is thinking, what is done, what comes next.' },
  remember:    { level: 'none',   cost: 0,  where: 'agent',  does: 'Save one important fact in long-term memory so it is remembered in every later run. Give it as text.' },
  check_chatbox_pholama: { level: 'none', cost: 0, where: 'agent', does: 'Check the chatbox for new messages from the person, typed while you were working. Use it about every minute of work, and before you say done. It says what they wrote, so you can change course without being restarted.' },
  forget:      { level: 'none',   cost: 0,  where: 'agent',  does: 'Remove one thing from memory. Give its id, shown in YOUR MEMORY as [id].' },
  screenshot_: { level: 'none',   cost: 10, where: 'pc',     does: 'Take a screenshot of what the user sees; it is read by the vision sub-agent and put in the edit log.' },
  next_task:   { level: 'none',   cost: 0,  where: 'agent',  does: 'Say the first task is finished and start the next one. A new note is then required before any edit.' },
  // --- cloud only: nothing touches the PC ---
  cloud_browse:{ level: 'none',   cost: 0,  where: 'cloud',  does: 'Browse and search the web from the cloud. Nothing opens on the PC.' },
  github_read: { level: 'none',   cost: 0,  where: 'cloud',  does: 'Read GitHub. Give action and repo (owner/name): list_files, read_file (path), commits, repo_info, list_branches, pages_status; optional ref (branch).' },
  github_write:{ level: 'ask',    cost: 0,  where: 'cloud',  does: 'Write to GitHub, never to the main branch. Actions: create_branch (branch pholama/...), write_files (branch, message, files:[{path,content}]), open_pr (branch, title), publish_preview (files with index.html: a built web app shown on GitHub Pages), enable_pages.' },
  // --- moving files between the PC and the cloud (safer than editing in place) ---
  pull_file:   { level: 'ask',    cost: 0,  where: 'pc',     does: 'Copy a PC file into the agent cloud so it can work on the copy.' },
  push_files_to_pc: { level: 'ask', cost: 0, where: 'pc',    does: 'Send fixed files from the agent cloud back to the PC.' },
  edit_file:   { level: 'ask',    cost: 0,  where: 'pc',     does: 'Edit a file on the PC in place.' },
  create_item: { level: 'ask',    cost: 0,  where: 'pc',     does: 'Create a file, folder or window on the PC.' },
  set_object_parent_or_position: { level: 'ask', cost: 0, where: 'pc', does: 'Move a folder or file, or move a window.' },
  // --- driving the PC ---
  user_pc:     { level: 'ask',    cost: 0,  where: 'pc',     does: 'Wander and act on the PC with the agent\'s own small cursor (the user\'s mouse is not used).' },
  open_window: { level: 'ask',    cost: 0,  where: 'pc',     does: 'Open an app or window on the PC. The agent may close it afterwards.' },
  close_window:{ level: 'ask',    cost: 0,  where: 'pc',     does: 'Close a window. Only windows the agent itself opened.' },
  pc_browse:   { level: 'ask',    cost: 0,  where: 'pc',     does: 'Open a site in a browser on the PC.' },
  copy_text:   { level: 'ask',    cost: 0,  where: 'pc',     does: 'Copy text to the clipboard.' },
  paste_text:  { level: 'ask',    cost: 0,  where: 'pc',     does: 'Paste the clipboard text.' },
  copy_paste_image: { level: 'ask', cost: 0, where: 'pc',    does: 'Copy or paste an image.' },
  // --- dangerous: strict, asked every time ---
  terminal_open:      { level: 'strict', cost: 0, where: 'pc', does: 'Open the PC terminal and run a command.' },
  windows_powershell: { level: 'strict', cost: 0, where: 'pc', does: 'Run a Windows PowerShell command.' },
  delete_folder_or_window_or_app: { level: 'strict', cost: 0, where: 'pc', does: 'Delete a folder or uninstall an app.' },
  // --- generators run in the cloud and cost extra ---
  make_image:  { level: 'none',   cost: 45, where: 'cloud',  does: 'Generate an image (flux2-klein).' },
  make_music:  { level: 'none',   cost: 45, where: 'cloud',  does: 'Generate music or a sound (ace-step). Waits in a queue.' },
  make_3d:     { level: 'none',   cost: 90, where: 'cloud',  does: 'Generate a 3D model: a picture (45) then the mesh (45).' },
  make_speech: { level: 'none',   cost: 25, where: 'cloud',  does: 'Text to speech for video editing (kokoro).' },
};

const LEVELS = new Set(['none', 'ask', 'strict']);

// Tools that change the PC or the project. The loop must write a note before the first of these, and again when it moves to the next task.
const EDITING = new Set(['edit_file', 'push_files_to_pc', 'create_item', 'set_object_parent_or_position', 'delete_folder_or_window_or_app', 'paste_text', 'copy_paste_image', 'github_write', 'windows_powershell', 'terminal_open']);

const has = name => typeof name === 'string' && Object.prototype.hasOwnProperty.call(TOOLS, name);   // own tools only: 'constructor' or 'toString' are not tools
function describe(name) { return has(name) ? { name, ...TOOLS[name] } : null; }
function list() { return Object.keys(TOOLS).map(describe); }
function isEditing(name) { return EDITING.has(name); }

// The permission gate. approved is what the user pressed for THIS call: { allowed: true, callId }.
// 'strict' only passes for the exact call that was approved (callId must match), so one Allow can never cover a second command.
function gate(name, args, approval, callId) {
  const t = has(name) ? TOOLS[name] : null;
  if (!t) return { ok: false, code: 'unknown-tool', say: 'That tool does not exist.' };
  if (t.level === 'none') return { ok: true };
  if (!approval || approval.allowed !== true) return { ok: false, code: 'needs-approval', level: t.level, say: 'Waiting for your Allow.' };
  if (t.level === 'strict' && (!callId || approval.callId !== callId)) return { ok: false, code: 'needs-approval', level: 'strict', say: 'Waiting for your Allow for this exact action.' };
  return { ok: true };
}

// The note rule: before an editing tool, the most recent note must be newer than the last editing tool, and it must be about the current task.
function noteRule(name, memory) {
  if (!isEditing(name)) return { ok: true };
  const m = memory || {};
  if (!m.lastNoteAt) return { ok: false, code: 'note-first', say: 'Write a note (what you are about to do) before this edit.' };
  if (m.lastEditAt && m.lastNoteAt < m.lastEditAt) return { ok: false, code: 'note-first', say: 'Write a new note before the next edit.' };
  if (m.taskId && m.noteTaskId !== m.taskId) return { ok: false, code: 'note-first', say: 'You moved to a new task: write a note first.' };
  return { ok: true };
}

// A tool result is only handed back to the model after secrets are removed.
const SECRET = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;
function redact(text) { return String(text == null ? '' : text).replace(SECRET, '[hidden secret]'); }

module.exports = { TOOLS, LEVELS, EDITING, describe, list, isEditing, gate, noteRule, redact };

// Applies a tracker update issue to partay/data.json, or takes the daily burndown snapshot.
// Runs in GitHub Actions. Reads the issue from the event file, never from the command line.
import fs from 'node:fs';
import path from 'node:path';

const DATA = 'partay/data.json';
const tmp = process.env.RUNNER_TEMP || '.';
const mode = process.env.EVENT === 'issues' ? 'issue' : 'snapshot';
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

const STATUS = ['To do', 'In progress', 'Done'];
const PRIORITY = ['Core', 'Additional'];
const SPRINTS = data.sprints.map(s => s.name);
const PREFIX = { 'Sprint 0': 'S0', 'Sprints 1 and 2': 'S12', 'Sprint 3': 'S3', 'Sprint 4': 'S4', 'Final week': 'FW' };

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
const fail = msg => { throw new Error(msg); };
const text = (v, max, what) => {
  if (typeof v !== 'string') fail(`${what} must be text`);
  v = v.replace(/\s+/g, ' ').trim();
  if (!v) fail(`${what} is empty`);
  if (v.length > max) fail(`${what} is longer than ${max} characters`);
  return v;
};
const hours = (v, what) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 500) fail(`${what} must be a number from 0 to 500`);
  return Math.round(n * 10) / 10;
};
const points = v => {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100) fail('Points must be a whole number from 0 to 100');
  return n;
};
const oneOf = (v, list, what) => (list.includes(v) ? v : fail(`${what} must be one of: ${list.join(', ')}`));
const owner = v => (v === '' || v == null ? '' : oneOf(v, data.team, 'Owner'));
const storyRef = v => (v === '-' ? '-' : data.stories.some(s => s.id === v) ? v : fail(`Unknown story ${v}`));

function currentSprint(day) {
  return data.sprints.find(s => s.start <= day && day <= s.end);
}
function snapshot() {
  const day = today();
  const sprint = currentSprint(day);
  if (!sprint) return null;
  const tasks = data.tasks.filter(t => t.sprint === sprint.name);
  if (!tasks.some(t => t.estimate != null)) return null;
  const left = tasks.reduce((sum, t) => sum + (t.status === 'Done' ? 0 : t.remaining ?? t.estimate ?? 0), 0);
  data.burndown[sprint.name] ??= {};
  data.burndown[sprint.name][day] = Math.round(left * 10) / 10;
  return `${sprint.name} ${day}: ${left} h left`;
}

function applyOp(op, lines) {
  if (!op || typeof op !== 'object') fail('Each change must be an object');
  switch (op.op) {
    case 'task': {
      const t = data.tasks.find(x => x.id === op.id) ?? fail(`Unknown task ${op.id}`);
      const set = op.set ?? {};
      const changes = [];
      for (const [k, v] of Object.entries(set)) {
        if (k === 'owner') t.owner = owner(v);
        else if (k === 'remaining') t.remaining = hours(v, 'Hours left');
        else if (k === 'estimate') t.estimate = hours(v, 'Estimate');
        else if (k === 'status') t.status = oneOf(v, STATUS, 'Status');
        else if (k === 'title') t.title = text(v, 200, 'Task');
        else if (k === 'sprint') t.sprint = oneOf(v, SPRINTS, 'Sprint');
        else if (k === 'story') t.story = storyRef(v);
        else continue;
        changes.push(`${k} ${JSON.stringify(t[k])}`);
      }
      if (t.status === 'Done') { if (!('remaining' in set)) t.remaining = 0; t.done ??= today(); }
      else delete t.done;
      lines.push(`${t.id}: ${changes.join(', ') || 'no change'}`);
      break;
    }
    case 'addTask': {
      const sprint = oneOf(op.sprint, SPRINTS, 'Sprint');
      const prefix = PREFIX[sprint] ?? 'T';
      const n = Math.max(0, ...data.tasks.filter(t => t.id.startsWith(prefix + '-')).map(t => Number(t.id.split('-')[1]) || 0)) + 1;
      const est = hours(op.estimate ?? null, 'Estimate');
      const t = { id: `${prefix}-${String(n).padStart(2, '0')}`, sprint, story: storyRef(op.story ?? '-'), title: text(op.title, 200, 'Task'),
        owner: owner(op.owner), estimate: est, remaining: est, status: 'To do' };
      data.tasks.push(t);
      lines.push(`Added ${t.id}: ${t.title}`);
      break;
    }
    case 'deleteTask': {
      const i = data.tasks.findIndex(x => x.id === op.id);
      if (i < 0) fail(`Unknown task ${op.id}`);
      lines.push(`Deleted ${op.id}: ${data.tasks[i].title}`);
      data.tasks.splice(i, 1);
      break;
    }
    case 'story': {
      const s = data.stories.find(x => x.id === op.id) ?? fail(`Unknown story ${op.id}`);
      const changes = [];
      for (const [k, v] of Object.entries(op.set ?? {})) {
        if (k === 'status') s.status = oneOf(v, STATUS, 'Status');
        else if (k === 'points') s.points = points(v);
        else if (k === 'sprint') s.sprint = oneOf(v, SPRINTS, 'Sprint');
        else if (k === 'priority') s.priority = oneOf(v, PRIORITY, 'Priority');
        else if (k === 'text') s.text = text(v, 400, 'Story');
        else continue;
        changes.push(`${k} ${JSON.stringify(s[k])}`);
      }
      lines.push(`${s.id}: ${changes.join(', ') || 'no change'}`);
      break;
    }
    case 'addStory': {
      const n = Math.max(0, ...data.stories.filter(s => /^US\d+$/.test(s.id)).map(s => Number(s.id.slice(2)))) + 1;
      const s = { id: `US${n}`, text: text(op.text, 400, 'Story'), priority: oneOf(op.priority ?? 'Additional', PRIORITY, 'Priority'),
        sprint: oneOf(op.sprint, SPRINTS, 'Sprint'), status: 'To do', points: points(op.points ?? null), feature: '' };
      data.stories.push(s);
      lines.push(`Added ${s.id}: ${s.text}`);
      break;
    }
    default:
      fail(`Unknown change type ${op.op}`);
  }
}

function write(file, content) { fs.writeFileSync(path.join(tmp, file), content); }

if (mode === 'snapshot') {
  const msg = snapshot();
  fs.writeFileSync(DATA, JSON.stringify(data, null, 1) + '\n');
  write('msg.txt', `Partay tracker: daily burndown snapshot\n\n${msg ?? 'No sprint with estimates today.'}\n`);
  console.log(msg ?? 'No snapshot today');
} else {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const issue = event.issue;
  const who = issue.user.login;
  try {
    const allowed = (data.allowed ?? []).map(u => String(u).toLowerCase());
    const isOwner = issue.author_association === 'OWNER' || who.toLowerCase() === String(process.env.GITHUB_REPOSITORY_OWNER ?? '').toLowerCase();
    if (!isOwner && !allowed.includes(who.toLowerCase())) fail(`@${who} is not on the team list for this tracker. Ask Alex to add your GitHub username.`);
    const body = String(issue.body ?? '');
    if (body.length > 20000) fail('The update is too long.');
    const m = body.match(/```json\s*([\s\S]*?)```/);
    if (!m) fail('No change list found. Send updates from the tracker page.');
    let payload;
    try { payload = JSON.parse(m[1]); } catch { fail('The change list is not valid JSON.'); }
    const ops = Array.isArray(payload) ? payload : payload.changes;
    if (!Array.isArray(ops) || !ops.length) fail('The change list is empty.');
    if (ops.length > 100) fail('Send at most 100 changes at a time.');
    const name = payload.name && data.team.includes(payload.name) ? payload.name : '';
    const lines = [];
    for (const op of ops) applyOp(op, lines);
    const snap = snapshot();
    data.log.unshift({ at: new Date().toISOString(), by: name ? `${name} (@${who})` : `@${who}`, issue: issue.number, summary: lines.join('; ') });
    data.log = data.log.slice(0, 200);
    fs.writeFileSync(DATA, JSON.stringify(data, null, 1) + '\n');
    write('msg.txt', `Partay tracker: update from @${who} (#${issue.number})\n\n${lines.join('\n')}\n`);
    write('reply.md', `Applied ${lines.length} change${lines.length === 1 ? '' : 's'}:\n\n${lines.map(l => '- ' + l).join('\n')}${snap ? `\n\nBurndown: ${snap}` : ''}\n\nThe tracker shows them now: https://alextudev.com/partay/`);
    write('result.txt', 'ok');
  } catch (e) {
    write('reply.md', `Nothing was changed. ${e.message}\n\nOpen https://alextudev.com/partay/ and send the update again.`);
    write('result.txt', 'error');
    console.log('Rejected:', e.message);
  }
}

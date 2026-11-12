// Nightly burndown point for the Partay tracker. Reads the Supabase URL and public key from the page itself.
import fs from 'node:fs';

const page = fs.readFileSync('partay/index.html', 'utf8');
const url = (page.match(/SUPABASE_URL = '([^']*)'/) || [])[1];
const key = (page.match(/SUPABASE_KEY = '([^']*)'/) || [])[1];
if (!url || !key) { console.log('Database not connected yet. Nothing to do.'); process.exit(0); }

const { sprints } = JSON.parse(fs.readFileSync('partay/data.json', 'utf8'));
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
const sprint = sprints.find(s => s.start <= day && day <= s.end);
if (!sprint) { console.log('No sprint today.'); process.exit(0); }

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const res = await fetch(`${url}/rest/v1/tasks?select=estimate,remaining,status&sprint=eq.${encodeURIComponent(sprint.name)}`, { headers });
if (!res.ok) throw new Error(`Reading tasks failed: ${res.status} ${await res.text()}`);
const tasks = await res.json();
if (!tasks.some(t => t.estimate != null)) { console.log(`${sprint.name} has no estimates.`); process.exit(0); }
const left = Math.round(tasks.reduce((a, t) => a + (t.status === 'Done' ? 0 : Number(t.remaining ?? t.estimate ?? 0)), 0) * 10) / 10;

const up = await fetch(`${url}/rest/v1/burndown?on_conflict=sprint,day`, {
  method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify({ sprint: sprint.name, day, hours: left })
});
if (!up.ok) throw new Error(`Saving the point failed: ${up.status} ${await up.text()}`);
console.log(`${sprint.name} ${day}: ${left} h left`);

'use strict';
// cv.js — CV и сопроводительное письмо под конкретную вакансию, на языке вакансии.
// Правило: только факты из profile.json. Ничего не выдумывать — ни дат, ни дипломов, ни цифр.
const fs = require('fs');
const path = require('path');
const { ask, STRONG } = require('./llm');

const OUT = path.join(__dirname, 'cv-out');

function profileText(p) {
  const ans = Object.entries(p.answers || {}).map(([k, v]) => `- ${v.q} → ${v.a}`).join('\n');
  return `Name: ${p.name}\nEmail: ${p.email}\nPhone: ${p.phone}\nLocation: ${p.city}\n\nFACTS:\n- ${p.facts.join('\n- ')}\n\nANSWERS FROM SERHII (in Russian, translate as needed):\n${ans || '(none yet)'}`;
}

function jobText(j) {
  return `TITLE: ${j.title}\nCOMPANY: ${j.company}\nLOCATION: ${j.location}\nSALARY: ${j.salary || '-'}\nURL: ${j.url}\n\nDESCRIPTION:\n${(j.description || '').slice(0, 7000)}`;
}

// Чего не хватает, чтобы CV под эту вакансию было сильным. Вопросы — по-русски, максимум 3.
async function gapQuestions(profile, job) {
  const r = await ask(
    'You prepare a job application for Serhii. Compare the job requirements with what is already known about him. ' +
    'Return JSON {"questions":[...]} with at most 3 short questions IN RUSSIAN (simple, friendly, answerable in one line) ' +
    'only about things that (a) the job explicitly asks for, (b) are NOT already answered in his facts/answers, and (c) would really change the CV. ' +
    'Do not ask about things already covered. If nothing important is missing return {"questions":[]}.',
    `PROFILE:\n${profileText(profile)}\n\nJOB:\n${jobText(job)}`,
    { model: STRONG, json: true, maxTokens: 800 });
  return (r.questions || []).filter(q => typeof q === 'string' && q.trim()).slice(0, 3);
}

async function writeCv(profile, job) {
  const system = `You are a top recruiter and CV writer. Write a tailored, ATS-friendly one-to-two page CV and a short cover letter for Serhii for THIS job.
LANGUAGE: write everything in the language of the job posting (if the posting is in German - German, Polish - Polish, etc.; English posting - British English). Return the ISO code in "lang".
TRUTH RULES (critical): use ONLY facts from the profile and his answers. Never invent employers, dates, degrees, certificates, metrics or tools he has not used. If a date is unknown, leave "dates" empty. NO invented numbers, results, time savings, clients, frequencies ("daily") or integrations - only what the profile states; when tempted to add a metric, describe the mechanism instead. You may reframe and prioritise facts to match the job, and describe his projects in strong, concrete, results-oriented language. Be honest that he builds with AI coding agents if relevant - present it as a strength (fast AI-assisted delivery).
LENGTH: max 2 A4 pages - max 4 skill groups x 6 items, max 4 projects x 3 bullets, bullets max 25 words.
STRUCTURE: headline tailored to the job title; 3-4 line summary; skills grouped and ordered by job relevance; "projects" = his AI/automation systems (most relevant first, 2-4 bullets each); "experience" = businesses he runs and relevant earlier roles (keep hospitality short unless relevant); languages; education only if known.
COVER LETTER: 120-180 words, specific to the company and role, no clichés, same language.
Also "note_ru": 2-3 sentences in Russian - what you emphasised and why, and "cover_ru": Russian translation of the cover letter.
Return JSON: {"lang":"en","headline":"","summary":"","skills":[{"group":"","items":[""]}],"projects":[{"name":"","tech":"","bullets":[""]}],"experience":[{"role":"","org":"","place":"","dates":"","bullets":[""]}],"languages":[""],"education":[""],"links":["only real URLs from his answers (LinkedIn/GitHub/site), else empty"],"labels":{"summary":"Profile","skills":"Skills","projects":"Selected AI & automation projects","experience":"Experience","languages":"Languages","education":"Education"},"cover_letter":"","cover_ru":"","note_ru":""}
"labels" must be translated into the CV language.`;
  return ask(system, `PROFILE:\n${profileText(profile)}\n\nJOB:\n${jobText(job)}`, { model: STRONG, json: true, maxTokens: 6000 });
}

const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render(profile, cv) {
  const L = cv.labels || {};
  const sec = (title, body) => body ? `<h2>${esc(title)}</h2>${body}` : '';
  const skills = (cv.skills || []).map(g => `<div class="sg"><b>${esc(g.group)}:</b> ${(g.items || []).map(esc).join(' · ')}</div>`).join('');
  const projects = (cv.projects || []).map(p => `<div class="it"><div class="row"><span class="t">${esc(p.name)}</span></div>${p.tech ? `<div class="sub">${esc(p.tech)}</div>` : ''}<ul>${(p.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>`).join('');
  const exp = (cv.experience || []).map(e => `<div class="it"><div class="row"><span class="t">${esc(e.role)}${e.org ? ' — ' + esc(e.org) : ''}</span><span class="d">${esc(e.dates)}</span></div>${e.place ? `<div class="sub">${esc(e.place)}</div>` : ''}<ul>${(e.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>`).join('');
  const list = a => (a || []).length ? `<p>${a.map(esc).join(' · ')}</p>` : '';
  // Ссылки — кликабельные, но показываем коротко: «LinkedIn» / «github.com/user», без %D1%81… и utm-хвостов
  const link = l => { const u = String(l).split('?')[0]; const txt = /linkedin/i.test(u) ? 'LinkedIn' : u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''); return `<a href="${esc(u)}" style="color:inherit">${esc(txt)}</a>`; };
  const links = (cv.links || []).filter(l => /^https?:|linkedin|github/i.test(l) && !/mailto|@/.test(l)).map(link);
  const contact = [...[profile.city, profile.phone, profile.email].filter(Boolean).map(esc), ...links].join(' &nbsp;|&nbsp; ');
  return `<!doctype html><html lang="${esc(cv.lang || 'en')}"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;font-size:10.5pt;line-height:1.45;padding:34px 42px}
h1{font-size:24pt;color:#0f172a;letter-spacing:-.5px}
.hl{color:#2563eb;font-weight:600;font-size:11.5pt;margin-top:2px}
.ct{color:#475569;font-size:9.5pt;margin-top:6px;padding-bottom:10px;border-bottom:2px solid #2563eb}
h2{font-size:9pt;letter-spacing:2.5px;text-transform:uppercase;color:#2563eb;margin:16px 0 6px}
p{margin:0 0 4px}.sg{margin-bottom:3px}
.it{margin-bottom:9px;page-break-inside:avoid}.row{display:flex;justify-content:space-between;gap:10px}
.t{font-weight:700;color:#0f172a}.d{color:#64748b;white-space:nowrap;font-size:9.5pt}
.sub{color:#2563eb;font-size:9pt}ul{margin:3px 0 0 16px}li{margin-bottom:2px}
</style></head><body>
<h1>${esc(profile.name)}</h1><div class="hl">${esc(cv.headline)}</div><div class="ct">${contact}</div>
${sec(L.summary || 'Profile', `<p>${esc(cv.summary)}</p>`)}
${sec(L.skills || 'Skills', skills)}
${sec(L.projects || 'Projects', projects)}
${sec(L.experience || 'Experience', exp)}
${sec(L.languages || 'Languages', list(cv.languages))}
${sec(L.education || 'Education', list(cv.education))}
</body></html>`;
}

async function toPdf(html, file) {
  const { chromium } = require('playwright');
  const b = await chromium.launch({ channel: 'msedge', headless: true }).catch(() => chromium.launch({ headless: true }));
  try {
    const p = await b.newPage();
    await p.setContent(html, { waitUntil: 'load' });
    await p.pdf({ path: file, format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
  } finally { await b.close(); }
  return file;
}

async function makeCv(profile, job) {
  const cv = await writeCv(profile, job);
  fs.mkdirSync(OUT, { recursive: true });
  const safe = String(job.company || 'job').replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 30);
  const base = path.join(OUT, `CV_Serhii_Hichka_${safe}_${(cv.lang || 'en').toUpperCase()}`);
  const html = render(profile, cv);
  fs.writeFileSync(base + '.html', html);
  fs.writeFileSync(base + '.json', JSON.stringify(cv, null, 2));
  await toPdf(html, base + '.pdf');
  return { cv, pdf: base + '.pdf' };
}

module.exports = { gapQuestions, makeCv, profileText, jobText };

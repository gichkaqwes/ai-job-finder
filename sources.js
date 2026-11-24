'use strict';
// sources.js — откуда берём вакансии. Только AI / автоматизация.
// Каждая вакансия: { id, source, title, company, location, url, salary, description, posted }
const axios = require('axios');
const cheerio = require('cheerio');

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept-Language': 'en-GB,en;q=0.9' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = h => cheerio.load(`<div>${h || ''}</div>`)('div').text().replace(/\s+/g, ' ').trim();
const log = (...a) => console.log('[src]', ...a);

// ── Отсев по названию: что точно про ИИ/автоматизацию и не уровень «senior инженер» ──
const WANT = /\b(ai|a\.i\.|artificial intelligence|automation|automations|automate|n8n|zapier|make\.com|no-?code|low-?code|llm|gpt|genai|gen ai|generative|prompt|chatbot|chat bot|agentic|ai agent|workflow|rpa|rlhf|ai trainer|annotat|evaluator|integrations?)\b/i;
const NOPE = /\b(senior|sr\.?|staff|principal|lead|head of|director|vp|vice president|chief|architect|phd|scientist|research|machine learning engineer|ml engineer|mlops|data engineer|software engineer|backend|back-end|frontend|front-end|full[- ]?stack|devops|sre|security|firmware|embedded|hardware|android|ios|java|\.net|c\+\+|golang|rust|account executive|sales|sdr|bdr|recruiter|nurse|physician|attorney|lawyer|teacher|tutor|professor|electrician|mechanic|driver|warehouse|forklift|qa automation|test automation|automation tester|plc|scada|controls engineer|industrial automation|robotics technician)\b/i;
// Где нельзя работать из Шотландии
const US_ONLY = /^(us|usa|united states|u\.s\.|canada|us only|usa only|north america|latam|latin america|brazil|mexico|india|philippines|apac|australia|us,? canada|americas)$/i;
const GOOD_GEO = /(uk|united kingdom|england|scotland|glasgow|edinburgh|europe|emea|eu\b|european|worldwide|anywhere|global|remote$|ukraine|poland|cet|gmt)/i;

function titleOk(title) { return WANT.test(title) && !NOPE.test(title); }
function geoOk(loc) {
  const l = String(loc || '').trim();
  if (!l) return true;
  if (/^NOT-UK/.test(l)) return false;
  if (GOOD_GEO.test(l)) return true;
  const parts = l.split(/[,;/|]+/).map(s => s.trim()).filter(Boolean);
  if (parts.length && parts.every(p => US_ONLY.test(p) || /^[A-Z]{2}$/.test(p) && p !== 'UK' && p !== 'GB')) return false;
  return !/(united states|usa\b|\bus only|canada|latam|brazil|india|philippines|australia)/i.test(l);
}

// ── LinkedIn (гостевой поиск, без логина) ──
const LI_SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const LI_QUERIES = [
  ['AI automation', 'Glasgow, Scotland', ''],
  ['automation', 'Glasgow, Scotland', ''],
  ['AI', 'Glasgow, Scotland', ''],
  ['AI automation', 'United Kingdom', '2'],
  ['n8n', 'United Kingdom', '2'],
  ['workflow automation', 'United Kingdom', '2'],
  ['no-code automation', 'United Kingdom', '2'],
  ['AI agent', 'United Kingdom', '2'],
  ['AI implementation', 'United Kingdom', '2'],
  ['AI operations', 'United Kingdom', '2'],
  ['prompt engineer', 'United Kingdom', '2'],
  ['AI trainer', 'United Kingdom', '2'],
  ['Zapier', 'United Kingdom', '2'],
  ['AI automation', 'European Union', '2'],
  ['n8n', 'European Union', '2'],
  ['AI trainer Ukrainian', 'Worldwide', '2'],
  ['AI trainer Russian', 'Worldwide', '2'],
  ['AI trainer Polish', 'Worldwide', '2'],
  ['n8n', 'Poland', ''],
];

async function linkedIn() {
  const out = [];
  for (const [kw, loc, wt] of LI_QUERIES) {
    const p = new URLSearchParams({ keywords: kw, location: loc, f_TPR: 'r604800', start: '0' });
    if (wt) p.set('f_WT', wt);
    try {
      const r = await axios.get(LI_SEARCH + '?' + p, { headers: { ...UA, Referer: 'https://www.linkedin.com/jobs/search/' }, timeout: 20000 });
      const $ = cheerio.load(r.data);
      let n = 0;
      $('li').each((_, el) => {
        const c = $(el);
        const title = c.find('.base-search-card__title').text().trim();
        const urn = c.find('[data-entity-urn]').attr('data-entity-urn') || '';
        const jid = (urn.match(/(\d{7,})/) || [])[1];
        if (!title || !jid) return;
        n++;
        out.push({
          id: 'li_' + jid, source: 'LinkedIn', liId: jid, title,
          company: c.find('.base-search-card__subtitle').text().trim(),
          location: c.find('.job-search-card__location').text().trim() || loc,
          url: `https://www.linkedin.com/jobs/view/${jid}/`,
          salary: c.find('.job-search-card__salary-info').text().replace(/\s+/g, ' ').trim(),
          description: '', posted: c.find('time').attr('datetime') || '',
        });
      });
      log(`LinkedIn «${kw}» ${loc}: ${n}`);
    } catch (e) { log(`LinkedIn «${kw}»: ${e.response ? e.response.status : e.message}`); if (e.response && e.response.status === 429) await sleep(20000); }
    await sleep(2500);
  }
  return out;
}

// Полный текст вакансии LinkedIn — только для тех, кто прошёл отсев (экономим запросы)
async function linkedInDetails(job, retry = true) {
  try {
    const r = await axios.get('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + job.liId, { headers: UA, timeout: 20000 });
    const $ = cheerio.load(r.data);
    job.description = $('.show-more-less-html__markup').text().replace(/\s+/g, ' ').trim();
    const crit = $('.description__job-criteria-list').text().replace(/\s+/g, ' ').trim();
    if (crit) job.description += '\n[' + crit + ']';
    const sal = $('.salary.compensation__salary').text().trim();
    if (sal) job.salary = sal;
  } catch (e) {
    log('LinkedIn detail', job.liId, e.response ? e.response.status : e.message);
    if (retry && e.response && e.response.status === 429) { await sleep(45000); return linkedInDetails(job, false); }
  }
  await sleep(3500);
  return job;
}

// ── Remotive (удалёнка, JSON) ──
async function remotive() {
  const out = [];
  for (const q of ['automation', 'ai', 'n8n', 'zapier', 'prompt', 'no-code', 'chatbot']) {
    try {
      const r = await axios.get('https://remotive.com/api/remote-jobs?limit=100&search=' + encodeURIComponent(q), { headers: UA, timeout: 25000 });
      for (const j of r.data.jobs || []) out.push({
        id: 'rmt_' + j.id, source: 'Remotive', title: j.title, company: j.company_name,
        location: j.candidate_required_location || 'Remote', url: j.url, salary: j.salary || '',
        description: strip(j.description), posted: j.publication_date,
      });
    } catch (e) { log('Remotive', q, e.message); }
    await sleep(1000);
  }
  log('Remotive', out.length);
  return out;
}

// ── Himalayas (удалёнка, JSON) ──
async function himalayas() {
  const out = [];
  for (const q of ['ai automation', 'automation specialist', 'n8n', 'workflow automation', 'no-code', 'prompt engineer', 'ai operations', 'ai trainer']) {
    try {
      const r = await axios.get('https://himalayas.app/jobs/api/search?q=' + encodeURIComponent(q), { headers: UA, timeout: 25000 });
      for (const j of r.data.jobs || []) {
        const loc = (j.locationRestrictions || []);
        out.push({
          id: 'him_' + (j.guid || j.applicationLink || j.title).toString().replace(/\W+/g, '').slice(-40),
          source: 'Himalayas', title: j.title, company: j.companyName,
          location: !loc.length ? 'Remote (worldwide)' : loc.includes('United Kingdom') ? (loc.length > 6 ? 'Remote (many countries incl. UK)' : loc.join(', ')) : 'NOT-UK: ' + loc.slice(0, 4).join(', '),
          url: j.applicationLink || j.guid, salary: j.minSalary ? `${j.currency || ''} ${j.minSalary}–${j.maxSalary || ''}` : '',
          description: strip(j.description || j.excerpt), posted: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : '',
        });
      }
    } catch (e) { log('Himalayas', q, e.message); }
    await sleep(1000);
  }
  log('Himalayas', out.length);
  return out;
}

// ── Jobicy (удалёнка, JSON; есть гео) ──
async function jobicy() {
  const out = [];
  for (const [tag, geo] of [['automation', 'uk'], ['automation', 'europe'], ['ai', 'uk'], ['ai', 'europe'], ['automation', 'anywhere'], ['ai', 'anywhere']]) {
    try {
      const r = await axios.get(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${tag}&geo=${geo}`, { headers: UA, timeout: 25000 });
      for (const j of r.data.jobs || []) out.push({
        id: 'jcy_' + j.id, source: 'Jobicy', title: strip(j.jobTitle), company: j.companyName,
        location: j.jobGeo || 'Remote', url: j.url,
        salary: j.annualSalaryMin ? `${j.salaryCurrency || ''} ${j.annualSalaryMin}–${j.annualSalaryMax || ''}` : '',
        description: strip(j.jobDescription || j.jobExcerpt), posted: j.pubDate,
      });
    } catch (e) { log('Jobicy', tag, geo, e.response ? e.response.status : e.message); }
    await sleep(1000);
  }
  log('Jobicy', out.length);
  return out;
}

// ── RemoteOK (JSON) ──
async function remoteOk() {
  const out = [];
  for (const tag of ['ai', 'automation', 'no-code', 'llm']) {
    try {
      const r = await axios.get('https://remoteok.com/api?tag=' + tag, { headers: UA, timeout: 25000 });
      for (const j of (r.data || []).slice(1)) out.push({
        id: 'rok_' + j.id, source: 'RemoteOK', title: j.position, company: j.company,
        location: j.location || 'Remote', url: j.url,
        salary: j.salary_min ? `$${j.salary_min}–${j.salary_max}` : '',
        description: strip(j.description), posted: j.date,
      });
    } catch (e) { log('RemoteOK', tag, e.message); }
    await sleep(1500);
  }
  log('RemoteOK', out.length);
  return out;
}

// Всё вместе: собрать, убрать дубли, отсеять по названию и географии.
async function collect(seen) {
  const lists = await Promise.all([
    linkedIn().catch(() => []), remotive().catch(() => []), himalayas().catch(() => []),
    jobicy().catch(() => []), remoteOk().catch(() => []),
  ]);
  const all = lists.flat();
  const byId = new Set(), byKey = new Set(), keep = [];
  for (const j of all) {
    if (!j.title || !j.url || byId.has(j.id)) continue;
    byId.add(j.id);
    const k = (j.title + '|' + j.company).toLowerCase().replace(/\W+/g, '');
    if (byKey.has(k)) continue;
    byKey.add(k);
    if (seen[j.id] || seen[k]) continue;
    j.key = k;
    if (!titleOk(j.title) || !geoOk(j.location)) { seen[j.id] = Date.now(); continue; }
    // старше 21 дня — уже поздно откликаться
    if (j.posted && Date.now() - Date.parse(j.posted) > 21 * 86400e3) { seen[j.id] = Date.now(); continue; }
    keep.push(j);
  }
  log(`всего ${all.length}, после отсева ${keep.length}`);
  for (const j of keep) if (j.source === 'LinkedIn' && !j.description) await linkedInDetails(j);
  return keep;
}

module.exports = { collect, titleOk, geoOk };

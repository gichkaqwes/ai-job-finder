'use strict';
// AI Job Finder — Telegram bot: finds realistic AI/automation jobs, scores them with an LLM,
// and writes a tailored CV + cover letter (PDF) in the language of the job posting.
// UI language of the bot: Russian. Set TELEGRAM_TOKEN and OPENAI_API_KEY in the environment.
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { collect } = require('./sources');
const { ask, CHEAP, STRONG } = require('./llm');
const { gapQuestions, makeCv, profileText, jobText } = require('./cv');

const TOKEN = process.env.TELEGRAM_TOKEN; // Telegram bot token from @BotFather
const F = n => path.join(__dirname, n);
const load = (n, d) => { try { return JSON.parse(fs.readFileSync(F(n), 'utf8')); } catch (_) { return d; } };
const save = (n, v) => fs.writeFileSync(F(n), JSON.stringify(v, null, 2));
const esc = s => String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

const cfg = load('config.json', { chatId: null, active: true });
const MAX_PER_RUN = 10;
const MIN_FIT = 7;
const DRY = !!process.env.JF_DRY;   // для тестов: без Телеграма и без автопоиска
const bot = new TelegramBot(TOKEN, { polling: !DRY });
const me = msg => cfg.chatId && msg.chat.id === cfg.chatId;

// ── состояние: о чём бот сейчас спрашивает ──
let state = load('state.json', { asking: null, dislikes: [], lastRun: 0 });
const saveState = () => save('state.json', state);
const jobs = load('jobs.json', {});            // короткий id → вакансия с оценкой
const saveJobs = () => save('jobs.json', jobs);
let seen = load('seen-v2.json', {});
let busy = false;

// ── вопросы Сергею ──
function nextBaseQuestion() {
  const p = load('profile.json', {});
  return (p.questions || []).find(q => !(p.answers || {})[q.id] && !(state.skipped || []).includes(q.id));
}
async function askNext(chatId) {
  const a = state.asking;
  if (a && a.type === 'job') {
    const q = a.queue[a.i];
    return bot.sendMessage(chatId, `❓ (${a.i + 1}/${a.queue.length}) ${q}\n\n<i>Ответь одним сообщением. Не знаешь/не важно — /skip</i>`, { parse_mode: 'HTML' });
  }
  const q = nextBaseQuestion();
  if (!q) { state.asking = null; saveState(); return bot.sendMessage(chatId, '✅ Спасибо, всё записал. Теперь CV будут точнее. Изменить ответы — /profile'); }
  state.asking = { type: 'base', id: q.id }; saveState();
  const p = load('profile.json', {});
  const left = p.questions.filter(x => !(p.answers || {})[x.id]).length;
  return bot.sendMessage(chatId, `❓ ${q.q}\n\n<i>Осталось вопросов: ${left}. Пропустить — /skip</i>`, { parse_mode: 'HTML' });
}
function remember(id, q, a) {
  const p = load('profile.json', {});
  p.answers = p.answers || {};
  p.answers[id] = { q, a, at: new Date().toISOString().slice(0, 10) };
  save('profile.json', p);
}

// ── оценка вакансии под Сергея ──
// Двухступенчато: дешёвая модель отсеивает явное «не то», сильная перепроверяет финалистов.
const SCORE_RULES = `You are a strict, honest career advisor. Decide if this job is REALISTIC for the candidate to get and do well, given his real experience (AI-assisted builder of business automations, not a CS-degree software engineer; runs two small businesses; lives in Glasgow, Scotland, UK).
Good fits: AI automation specialist/consultant/builder, n8n/Make/Zapier/no-code automation, AI implementation for SMBs, AI operations, prompt/LLM workflow roles, chatbot/agent builder, junior/mid AI integration roles, AI trainer/rater/annotator roles that value native Ukrainian/Russian or professional Polish or domain expertise (food, hospitality, construction, crypto), AI roles in construction/hospitality/property companies.
HARD CAPS (apply them!):
- Location: he can work on-site/hybrid ONLY in Glasgow area (Glasgow, Clydebank, Paisley, West Dunbartonshire, Lanarkshire, Edinburgh at most). On-site/hybrid anywhere else -> fit max 3.
- Remote limited to specific countries that do not include the UK (e.g. "remote - South Africa", "EU residents only", "must be based in Germany") -> fit max 3. Remote UK / Europe incl. UK / worldwide / EMEA is fine.
- Requires fluent language he does not have (German, French, Czech, Dutch, Spanish...) -> fit max 2. His languages: Ukrainian, Russian, Polish, English (working level).
- Needs professional software engineering (Python/TypeScript as main job, CS degree, 3+ years as developer), ML/data science, senior/lead/manager level -> fit max 4.
- Sales quotas, cold calling, unpaid/commission-only, MLM, "pay to start", vague crypto schemes -> fit 0.
Score "fit" 0-10 (8+ = strong, apply now; 7 = worth applying). Be honest; most jobs should score below 7.
Write Russian texts addressing him as «ты» (never use his name).
Keep every Russian text SHORT: max 25 words each.
Return JSON {"fit":0,"from_glasgow":true,"lang_ok":true,"why_ru":"почему тебе подходит (до 25 слов)","concerns_ru":"главный риск (до 25 слов) или пусто","lang":"язык текста вакансии ISO-код","country":"страна работы","format_ru":"удалёнка/гибрид/офис + полная/частичная/контракт","salary_ru":"оплата если указана, иначе пусто"}
"from_glasgow": true ONLY if he can do this job while living in Glasgow: fully remote open to UK residents (UK / Europe incl. UK / EMEA / worldwide), or on-site/hybrid in Glasgow area or Edinburgh. Office/hybrid in any other city (Bristol, London, Lisbon, Sofia...) or remote restricted to another country -> false.
"lang_ok": false if the job needs fluent German/French/Italian/Czech/Dutch/Spanish or any language other than English/Ukrainian/Russian/Polish.`;

async function score(job, model = CHEAP) {
  const p = load('profile.json', {});
  const dis = (state.dislikes || []).slice(-15).map(d => `- ${d.title}${d.why ? ' (' + d.why + ')' : ''}`).join('\n');
  const rejected = dis ? 'HE REJECTED THESE JOBS (avoid similar):\n' + dis + '\n\n' : '';
  const r = await ask(SCORE_RULES,
    `CANDIDATE:
${profileText(p)}

${rejected}JOB:
${jobText(job).slice(0, 6000)}`,
    { model, json: true, maxTokens: model === CHEAP ? 500 : 1500 });
  // место и язык — жёстко в коде: модель любит «закрывать глаза» на офис в Софии
  if (model !== CHEAP && (r.from_glasgow === false || r.lang_ok === false)) r.fit = Math.min(r.fit || 0, 3);
  return r;
}

let seq = load('seq.json', { n: 0 });
function storeJob(job, sc) {
  seq.n++; save('seq.json', seq);
  const id = seq.n.toString(36);
  jobs[id] = { ...job, sc, status: 'queued', at: Date.now() };
  saveJobs();
  return id;
}

function card(id) {
  const j = jobs[id], s = j.sc || {};
  const stars = '⭐'.repeat(Math.max(1, Math.min(5, Math.round((s.fit || 0) / 2))));
  const text = [
    `🤖 <b>${esc(j.title)}</b>`,
    `🏢 ${esc(j.company || '—')}`,
    `📍 ${esc(j.location || '—')}${s.country ? ' · ' + esc(s.country) : ''}`,
    s.format_ru ? `🧭 ${esc(s.format_ru)}` : null,
    `💷 ${esc(s.salary_ru || j.salary || 'оплата не указана')}`,
    ``,
    `${stars} <b>Подходит на ${s.fit}/10</b>`,
    `✅ ${esc(s.why_ru || '')}`,
    s.concerns_ru ? `⚠️ ${esc(s.concerns_ru)}` : null,
    ``,
    `🌐 CV будет на: ${esc(langName(s.lang))} · Источник: ${esc(j.source)}`,
  ].filter(x => x !== null).join('\n');
  const kb = { inline_keyboard: [
    [{ text: '📄 CV под эту вакансию', callback_data: 'cv:' + id }],
    [{ text: '🔗 Открыть вакансию', url: j.url }, { text: '👎 Не то', callback_data: 'no:' + id }],
  ] };
  return { text, kb };
}
const LANGS = { en: 'английском', de: 'немецком', pl: 'польском', uk: 'украинском', ru: 'русском', fr: 'французском', nl: 'нидерландском', es: 'испанском', it: 'итальянском', pt: 'португальском', sv: 'шведском', cs: 'чешском' };
const langName = l => LANGS[String(l || 'en').slice(0, 2).toLowerCase()] || (l || 'английском');

async function sendCard(chatId, id) {
  const { text, kb } = card(id);
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb });
  jobs[id].status = 'sent'; jobs[id].sentAt = Date.now(); saveJobs();
}

// ── поиск ──
async function runSearch(chatId, manual = false) {
  if (busy) return manual && bot.sendMessage(chatId, '⏳ Уже ищу, подожди пару минут.');
  busy = true;
  try {
    if (manual) await bot.sendMessage(chatId, '🔍 Ищу AI-вакансии под тебя: LinkedIn (Глазго, UK, Европа), Remotive, Himalayas, Jobicy, RemoteOK… ~5–10 мин.');
    const found = await collect(seen);
    let scored = 0, good = 0;
    for (const j of found) {
      seen[j.id] = Date.now(); if (j.key) seen[j.key] = Date.now();
      if ((j.description || '').length < 150) continue;   // без текста оценить честно нельзя
      try {
        let sc = await score(j); scored++;
        if ((sc.fit || 0) >= 4) sc = await score(j, STRONG);   // дешёвая отсекает явный мусор, решает сильная
        if ((sc.fit || 0) >= MIN_FIT) { storeJob(j, sc); good++; }
      } catch (e) { log('оценка:', e.message); }
    }
    save('seen-v2.json', seen);
    const queue = Object.entries(jobs).filter(([, j]) => j.status === 'queued')
      .sort((a, b) => (b[1].sc.fit || 0) - (a[1].sc.fit || 0)).slice(0, MAX_PER_RUN);
    for (const [id] of queue) { await sendCard(chatId, id); await new Promise(r => setTimeout(r, 800)); }
    const left = Object.values(jobs).filter(j => j.status === 'queued').length;
    state.lastRun = Date.now(); saveState();
    log(`поиск: новых ${found.length}, оценено ${scored}, подходят ${good}, отправлено ${queue.length}`);
    if (manual || queue.length) await bot.sendMessage(chatId,
      `📊 Проверил ${found.length} новых AI-вакансий, оценил ${scored}, по-настоящему подходят: ${good}.\n` +
      (queue.length ? `Показал ${queue.length}.` : 'Новых достойных нет — мусор не шлю.') +
      (left ? ` В запасе ещё ${left} — /more` : '') + `\nСледующий автопоиск через 6 ч.`);
  } catch (e) {
    log('поиск упал', e);
    await bot.sendMessage(chatId, '❌ Поиск упал: ' + e.message.slice(0, 150));
  } finally { busy = false; }
}

// ── CV ──
async function startCv(chatId, id) {
  const job = jobs[id];
  if (!job) return bot.sendMessage(chatId, 'Эта вакансия устарела, не нашёл её.');
  await bot.sendMessage(chatId, `⏳ Готовлю CV под «${job.title}» (${job.company}). Сначала проверю, всё ли я про тебя знаю для этой вакансии…`);
  let qs = [];
  try { qs = await gapQuestions(load('profile.json', {}), job); } catch (e) { log('вопросы:', e.message); }
  if (qs.length) {
    state.asking = { type: 'job', jobId: id, queue: qs, i: 0 }; saveState();
    await bot.sendMessage(chatId, `Чтобы CV попало в цель, ответь на ${qs.length} ${qs.length === 1 ? 'вопрос' : 'вопроса'} (можно коротко, по-русски):`);
    return askNext(chatId);
  }
  return buildCv(chatId, id);
}

async function buildCv(chatId, id) {
  const job = jobs[id];
  await bot.sendMessage(chatId, '✍️ Пишу CV и сопроводительное письмо… (~1–2 мин)');
  bot.sendChatAction(chatId, 'upload_document').catch(() => {});
  try {
    const { cv, pdf } = await makeCv(load('profile.json', {}), job);
    await bot.sendDocument(chatId, pdf, { caption: `📄 CV под «${job.title}» — ${job.company}\n🌐 Язык: ${langName(cv.lang)}\n\n💡 ${cv.note_ru || ''}`.slice(0, 1000) });
    const cover = `✉️ <b>Сопроводительное письмо</b> (скопируй в отклик):\n\n<code>${esc(cv.cover_letter)}</code>`;
    await bot.sendMessage(chatId, cover.slice(0, 4000), { parse_mode: 'HTML' });
    if (cv.cover_ru && String(cv.lang).slice(0, 2) !== 'ru') await bot.sendMessage(chatId, `🇷🇺 Перевод письма:\n\n${cv.cover_ru}`.slice(0, 4000));
    await bot.sendMessage(chatId, `👉 Откликнуться: ${job.url}\n\nКогда отправишь — нажми, я запомню.`, {
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '✅ Откликнулся', callback_data: 'ap:' + id }]] },
    });
    job.cv = pdf; job.status = 'cv'; saveJobs();
  } catch (e) {
    log('CV упало', e);
    await bot.sendMessage(chatId, '❌ Не получилось сделать CV: ' + e.message.slice(0, 200) + '\nПопробуй ещё раз кнопкой.');
  }
}

// ── вакансия по ссылке, которую прислал Сергей ──
async function jobFromLink(chatId, url) {
  await bot.sendMessage(chatId, '🔎 Открываю вакансию по ссылке…');
  const job = { id: 'link_' + Date.now(), source: 'твоя ссылка', url, title: '', company: '', location: '', description: '' };
  try {
    const li = url.match(/linkedin\.com\/.*?(\d{8,})/);
    const src = li ? 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + li[1] : url;
    const r = await axios.get(src, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36' }, timeout: 25000 });
    const $ = cheerio.load(r.data);
    $('script,style,nav,footer,header').remove();
    job.title = ($('.top-card-layout__title').text() || $('h1').first().text() || $('title').text()).trim().slice(0, 150);
    job.company = $('.topcard__org-name-link').text().trim();
    job.location = $('.topcard__flavor--bullet').first().text().trim();
    job.description = ($('.show-more-less-html__markup').text() || $('main').text() || $('body').text()).replace(/\s+/g, ' ').trim().slice(0, 8000);
  } catch (e) { log('ссылка:', e.message); }
  if (job.description.length < 200) return bot.sendMessage(chatId, '😕 Не смог прочитать текст вакансии по ссылке (сайт закрыт). Скопируй сюда текст вакансии целиком — я сделаю по нему.');
  return offerOwn(chatId, job);
}
async function offerOwn(chatId, job) {
  let sc = {};
  try { sc = await score(job); } catch (_) {}
  if (!job.title) job.title = 'Вакансия';
  const id = storeJob(job, sc);
  await sendCard(chatId, id);
}

// ── команды ──
const HELP = `🤖 <b>Бот AI-вакансий</b>

Ищу только реальные вакансии по ИИ и автоматизации, которые подходят под твой опыт (боты, n8n, ИИ-агенты, автоматизация бизнеса). Каждую оцениваю по 10-балльной шкале и показываю только 7+.

Под каждой вакансией:
📄 <b>CV под эту вакансию</b> — сделаю CV + сопроводительное на языке вакансии (PDF). Если чего-то не знаю — спрошу по-русски.
👎 <b>Не то</b> — запомню и буду реже такое показывать.

Своя вакансия? Просто пришли ссылку или текст — сделаю CV под неё.

/search — искать сейчас
/more — показать ещё из запаса
/profile — что я о тебе знаю
/questions — ответить на вопросы о себе
/stop · /start — выключить/включить автопоиск (каждые 6 ч)`;

bot.onText(/^\/start/, async msg => {
  cfg.chatId = msg.chat.id; cfg.active = true; save('config.json', cfg);
  await bot.sendMessage(msg.chat.id, HELP, { parse_mode: 'HTML' });
  if (nextBaseQuestion()) {
    await bot.sendMessage(msg.chat.id, 'Сначала пара коротких вопросов о тебе — чтобы CV были точными и честными. Отвечай по-русски, как удобно.');
    await askNext(msg.chat.id);
  }
});
bot.onText(/^\/help|^\/menu/, msg => me(msg) && bot.sendMessage(msg.chat.id, HELP, { parse_mode: 'HTML' }));
bot.onText(/^\/search/, msg => me(msg) && runSearch(msg.chat.id, true));
bot.onText(/^\/more/, async msg => {
  if (!me(msg)) return;
  const q = Object.entries(jobs).filter(([, j]) => j.status === 'queued').sort((a, b) => (b[1].sc.fit || 0) - (a[1].sc.fit || 0)).slice(0, MAX_PER_RUN);
  if (!q.length) return bot.sendMessage(msg.chat.id, 'Запас пуст. /search — поискать новые.');
  for (const [id] of q) { await sendCard(msg.chat.id, id); await new Promise(r => setTimeout(r, 800)); }
});
bot.onText(/^\/stop/, msg => { if (!me(msg)) return; cfg.active = false; save('config.json', cfg); bot.sendMessage(msg.chat.id, '⏸ Автопоиск выключен. /start — включить.'); });
bot.onText(/^\/questions/, msg => { if (!me(msg)) return; state.skipped = []; saveState(); askNext(msg.chat.id); });
bot.onText(/^\/profile/, msg => {
  if (!me(msg)) return;
  const p = load('profile.json', {});
  const ans = (p.questions || []).map(q => `• ${q.q.split('?')[0]}?\n   ➜ ${(p.answers[q.id] || {}).a || '— нет ответа'}`).join('\n');
  const extra = Object.entries(p.answers || {}).filter(([k]) => k.startsWith('j_')).map(([, v]) => `• ${v.q}\n   ➜ ${v.a}`).join('\n');
  bot.sendMessage(msg.chat.id, `🧾 <b>Что я знаю о тебе</b>\n\n${esc(ans)}${extra ? '\n\n<b>Из вопросов по вакансиям:</b>\n' + esc(extra) : ''}\n\nПереответить — /questions (старые ответы заменятся новыми)`.slice(0, 4000), { parse_mode: 'HTML' });
});
bot.onText(/^\/skip/, async msg => {
  if (!me(msg) || !state.asking) return;
  const a = state.asking;
  if (a.type === 'base') { state.skipped = [...(state.skipped || []), a.id]; saveState(); return askNext(msg.chat.id); }
  if (a.type === 'job') return advanceJob(msg.chat.id);
  state.asking = null; saveState();
});

async function advanceJob(chatId) {
  const a = state.asking;
  a.i++;
  if (a.i < a.queue.length) { saveState(); return askNext(chatId); }
  state.asking = null; saveState();
  return buildCv(chatId, a.jobId);
}

bot.on('message', async msg => {
  if (!me(msg) || !msg.text || msg.text.startsWith('/')) return;
  const t = msg.text.trim();
  const a = state.asking;
  if (a && a.type === 'base') {
    const q = (load('profile.json', {}).questions || []).find(x => x.id === a.id);
    remember(a.id, q ? q.q : a.id, t);
    return askNext(msg.chat.id);
  }
  if (a && a.type === 'job') {
    remember(`j_${a.jobId}_${a.i}`, a.queue[a.i], t);
    return advanceJob(msg.chat.id);
  }
  if (a && a.type === 'why' && !/https?:\/\//.test(t) && t.length < 300) {
    const d = (state.dislikes || []).find(x => x.id === a.jobId); if (d) d.why = t;
    state.asking = null; saveState();
    return bot.sendMessage(msg.chat.id, '👌 Понял, учту.');
  }
  if (a && a.type === 'why') { state.asking = null; saveState(); }
  const url = (t.match(/https?:\/\/\S+/) || [])[0];
  if (url) return jobFromLink(msg.chat.id, url);
  if (t.length > 300) return offerOwn(msg.chat.id, { id: 'txt_' + Date.now(), source: 'твой текст', url: 'https://www.linkedin.com/jobs/', title: t.split('\n')[0].slice(0, 100), company: '', location: '', description: t });
  return bot.sendMessage(msg.chat.id, 'Пришли ссылку на вакансию или её текст — сделаю CV под неё. Команды — /help');
});

bot.on('callback_query', async q => {
  const chatId = q.message.chat.id;
  if (chatId !== cfg.chatId) return bot.answerCallbackQuery(q.id);
  const [act, id] = q.data.split(':');
  bot.answerCallbackQuery(q.id).catch(() => {});
  if (act === 'cv') return startCv(chatId, id);
  if (act === 'no' && jobs[id]) {
    jobs[id].status = 'no'; saveJobs();
    state.dislikes = [...(state.dislikes || []), { id, title: `${jobs[id].title} @ ${jobs[id].company}` }].slice(-50);
    state.asking = { type: 'why', jobId: id }; saveState();
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
    return bot.sendMessage(chatId, '👎 Убрал. Почему не то? (пару слов — или просто пропусти)');
  }
  if (act === 'ap' && jobs[id]) {
    jobs[id].status = 'applied'; jobs[id].appliedAt = Date.now(); saveJobs();
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
    const n = Object.values(jobs).filter(j => j.status === 'applied').length;
    return bot.sendMessage(chatId, `✅ Записал. Всего откликов: ${n}. Удачи! 🍀`);
  }
});

bot.on('polling_error', e => log('polling:', e.message.slice(0, 80)));

// автопоиск каждые 6 часов (и при старте, если давно не искали)
if (!DRY) setInterval(() => { if (cfg.active && cfg.chatId) runSearch(cfg.chatId); }, 6 * 3600e3);
if (!DRY) setTimeout(() => { if (cfg.active && cfg.chatId && Date.now() - (state.lastRun || 0) > 6 * 3600e3) runSearch(cfg.chatId); }, 60e3);

log('Job Finder v2 запущен');
module.exports = { score, runSearch };

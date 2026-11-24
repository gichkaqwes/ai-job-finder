'use strict';
// llm.js — два уровня ума: дешёвый (оценить вакансию) и сильный (написать CV).
// Ключ OPENAI_API_KEY берётся из переменной среды Windows — в файлы не пишем.
const axios = require('axios');

const CHEAP = 'gpt-4o-mini';
const STRONG = 'gpt-5.1';

async function ask(system, user, { model = CHEAP, json = false, maxTokens = 1500 } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('нет OPENAI_API_KEY в среде');
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await axios.post('https://api.openai.com/v1/chat/completions', body,
        { headers: { authorization: 'Bearer ' + key }, timeout: 180000 });
      const text = (r.data.choices[0].message.content || '').trim();
      return json ? JSON.parse(text) : text;
    } catch (e) {
      last = e;
      const st = e.response && e.response.status;
      if (st && st < 500 && st !== 429) break;
      await new Promise(r => setTimeout(r, 4000 * (i + 1)));
    }
  }
  const msg = (last.response && last.response.data && last.response.data.error && last.response.data.error.message) || last.message;
  throw new Error('ИИ не ответил: ' + String(msg).slice(0, 150));
}

module.exports = { ask, CHEAP, STRONG };

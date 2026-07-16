import { getStore } from '@edgeone/pages-blob';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const ALLOWED_NEEDS = new Set(['soft', 'lowSalt', 'lowOil', 'protein']);
const ALLOWED_TIMES = new Set(['all', '20', '30', '45']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

function safeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function cleanText(value, maxLength = 20) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function numberInRange(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

async function hashDevice(deviceId, secret) {
  const bytes = new TextEncoder().encode(`${deviceId}|${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

function chinaDateKey() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll('-', '');
}

async function readCount(store, key) {
  const value = await store.get(key);
  const count = Number.parseInt(value || '0', 10);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function getLimitStore() {
  const blob = getStore({ name: 'warm-kitchen-limits', consistency: 'strong' });
  return {
    get(key) {
      return blob.get(`counters/${key}`, { consistency: 'strong' });
    },
    put(key, value) {
      return blob.set(`counters/${key}`, value);
    }
  };
}

function makePrompt({ ingredients, needs, servings, timeLimit, recentNames }) {
  const needNames = {
    soft: '软烂易嚼',
    lowSalt: '少盐清淡',
    lowOil: '少油烹饪',
    protein: '补充蛋白质'
  };
  const requirements = needs.length ? needs.map(item => needNames[item]).join('、') : '日常均衡、适合中老年人';
  const timeText = timeLimit === 'all' ? '不限' : `${timeLimit}分钟以内`;
  const avoidText = recentNames.length ? `尽量不要重复最近推荐过的菜：${recentNames.join('、')}。` : '';

  return `请根据以下条件，为中国家庭设计8道彼此差异明显的家常菜：
现有食材：${ingredients.join('、')}
用餐人数：${servings}人
制作时间：${timeText}
制作要求：${requirements}
${avoidText}

要求：
1. 优先使用现有食材，允许补充常见调料和少量容易购买的配菜；不要虚构食材。
2. 8道菜尽量覆盖蒸菜、炖煮、快手菜、汤羹、主食等不同类别，不要都推荐最基础的炒菜。
3. 步骤必须具体、按顺序、适合不熟悉手机操作的中老年用户阅读；标明火候、时间和成熟判断。
4. 少盐少油，兼顾软烂易嚼；涉及生肉、蛋类时提醒彻底加热。
5. 每道菜的 amounts 按${servings}人份给出，使用“克、个、勺、毫升”等清楚单位。
6. 只返回一个JSON对象，不要添加解释、标题或Markdown代码块。

JSON格式必须严格为：
{"recipes":[{"name":"菜名","time":30,"level":"简单","method":"炖","category":"炖煮","ingredients":["食材1","食材2"],"tags":["特点1","特点2"],"amounts":{"食材1":"用量"},"steps":["步骤1","步骤2","步骤3"],"note":"适合中老年人的提醒"}]}
category只能从“蒸菜、炖煮、快手菜、汤羹、主食”中选择。`;
}

function extractRecipes(content) {
  const clean = String(content || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(clean);
  const recipes = Array.isArray(parsed) ? parsed : parsed.recipes;
  if (!Array.isArray(recipes) || recipes.length < 3) throw new Error('invalid_recipe_payload');
  return recipes.slice(0, 10);
}

export async function onRequestGet({ env }) {
  return json({
    ok: true,
    service: 'warm-kitchen-family-ai',
    configured: Boolean(env?.DEEPSEEK_API_KEY && env?.FAMILY_ACCESS_CODE),
    counterStorage: 'makers-blob'
  });
}

export async function onRequestPost({ request, env }) {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return json({ message: '请从暖味厨房网页中使用推荐功能' }, 403);
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 20_000) return json({ message: '提交的内容过多，请减少食材数量' }, 413);

  const apiKey = env?.DEEPSEEK_API_KEY;
  const familySecret = env?.FAMILY_ACCESS_CODE;
  if (!apiKey || !familySecret) {
    return json({ message: '家庭 AI 尚未完成云端设置' }, 503);
  }

  let store;
  try {
    store = getLimitStore();
  } catch (_) {
    return json({ message: '每日次数保护暂时不可用，请稍后再试' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ message: '提交内容格式不正确' }, 400);
  }

  if (!safeEqual(body.accessCode, familySecret)) {
    return json({ message: '家庭访问码不正确' }, 401);
  }

  const ingredients = [...new Set((Array.isArray(body.ingredients) ? body.ingredients : [])
    .map(item => cleanText(item, 16)).filter(Boolean))].slice(0, 12);
  if (!ingredients.length) return json({ message: '请至少填写一种食材' }, 400);

  const needs = (Array.isArray(body.needs) ? body.needs : []).filter(item => ALLOWED_NEEDS.has(item)).slice(0, 4);
  const servings = numberInRange(body.servings, 2, 1, 6);
  const timeLimit = ALLOWED_TIMES.has(String(body.timeLimit)) ? String(body.timeLimit) : 'all';
  const recentNames = [...new Set((Array.isArray(body.recentNames) ? body.recentNames : [])
    .map(item => cleanText(item, 24)).filter(Boolean))].slice(0, 16);
  const deviceId = cleanText(body.deviceId, 80);
  if (deviceId.length < 8) return json({ message: '设备信息无效，请刷新网页重试' }, 400);

  const familyLimit = numberInRange(env?.DAILY_FAMILY_LIMIT, 60, 5, 500);
  const deviceLimit = numberInRange(env?.DAILY_DEVICE_LIMIT, 20, 3, familyLimit);
  const dateKey = chinaDateKey();
  const deviceHash = await hashDevice(deviceId, familySecret);
  const familyKey = `family_${dateKey}`;
  const deviceKey = `device_${dateKey}_${deviceHash}`;

  let familyCount;
  let deviceCount;
  try {
    [familyCount, deviceCount] = await Promise.all([
      readCount(store, familyKey),
      readCount(store, deviceKey)
    ]);
  } catch (_) {
    return json({ message: '今日次数记录暂时不可用，请稍后再试' }, 503);
  }

  if (familyCount >= familyLimit) {
    return json({ message: '今天全家的 AI 推荐次数已经用完，明天会自动恢复' }, 429);
  }
  if (deviceCount >= deviceLimit) {
    return json({ message: '这台设备今天的 AI 推荐次数已经用完，明天会自动恢复' }, 429);
  }

  try {
    await Promise.all([
      store.put(familyKey, String(familyCount + 1)),
      store.put(deviceKey, String(deviceCount + 1))
    ]);
  } catch (_) {
    return json({ message: '今日次数记录暂时不可用，请稍后再试' }, 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let deepSeekResponse;
  try {
    deepSeekResponse = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: env?.DEEPSEEK_MODEL || 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是擅长中国家常菜和中老年饮食的菜谱助手。严格按用户要求输出有效JSON，不输出任何额外文字。' },
          { role: 'user', content: makePrompt({ ingredients, needs, servings, timeLimit, recentNames }) }
        ],
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        temperature: 0.9,
        max_tokens: 5000,
        stream: false
      }),
      signal: controller.signal
    });
  } catch (_) {
    clearTimeout(timeout);
    return json({ message: 'DeepSeek 暂时没有响应，已为您保留本地菜谱' }, 503);
  }
  clearTimeout(timeout);

  if (!deepSeekResponse.ok) {
    return json({ message: 'DeepSeek 服务暂时不可用，已为您保留本地菜谱' }, 503);
  }

  try {
    const payload = await deepSeekResponse.json();
    const recipes = extractRecipes(payload?.choices?.[0]?.message?.content);
    return json({
      recipes,
      limits: {
        familyRemaining: Math.max(0, familyLimit - familyCount - 1),
        deviceRemaining: Math.max(0, deviceLimit - deviceCount - 1)
      }
    });
  } catch (_) {
    return json({ message: '这次生成的菜谱格式不完整，请再试一次' }, 503);
  }
}
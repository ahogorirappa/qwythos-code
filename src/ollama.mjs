// Ollama の /api/chat と話す部分。逐次（ストリーミング）で受け取る。
const jsonHeaders = { 'Content-Type': 'application/json' };

export class OllamaError extends Error {}

export async function checkServer(cfg) {
  try {
    const res = await fetch(`${cfg.host}/api/version`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new OllamaError(`HTTP ${res.status}`);
    const data = await res.json();
    return { ok: true, version: data.version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function listModels(cfg) {
  const res = await fetch(`${cfg.host}/api/tags`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new OllamaError(`モデル一覧が取れませんでした (HTTP ${res.status})`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

// モデルが何をできるか（tools / thinking など）を聞く。
// 思考モードを持たないモデルに think を送るとエラーになるので、事前に合わせるために使う。
export async function showModel(cfg, name = cfg.model) {
  try {
    const res = await fetch(`${cfg.host}/api/show`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { ok: false, capabilities: [] };
    const data = await res.json();
    return {
      ok: true,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      contextLength: data.model_info?.[`${data.model_info?.['general.architecture']}.context_length`] ?? null,
      parameterSize: data.details?.parameter_size ?? null
    };
  } catch {
    return { ok: false, capabilities: [] };
  }
}

// 取得した能力に合わせて設定を寄せる。戻り値は利用者に伝えるべき注意点。
/**
 * 入っているモデルの中から、この用途に向くものを1つ選ぶ。
 *
 * 指定されたモデルが無いときに、いきなり終了させないためのもの。
 * 「どれを使うか」を利用者に考えさせる前に、こちらで妥当なものを出す。
 *
 * 埋め込み専用のモデルは会話ができないので外す。
 * 名前の並びは、実測で自律的に走り切れた順。
 */
export function pickBestModel(models) {
  const usable = models.filter((m) => !/embed/i.test(m));
  if (!usable.length) return null;

  const preferred = [
    /^qwythos/i,        // 9B。速く、対策なしで完走した
    /^qwen3:14b/i,      // 遅いが確実
    /^qwen2\.5-coder/i, // 癖はあるが対策済み
    /^qwen3:/i,
    /^qwen2\.5:/i
  ];
  for (const rule of preferred) {
    const hit = usable.find((m) => rule.test(m));
    if (hit) return hit;
  }
  return usable[0];
}

export async function adaptToModel(cfg) {
  const info = await showModel(cfg);
  const notes = [];
  if (!info.ok) return { info, notes };

  const canThink = info.capabilities.includes('thinking');
  const canTools = info.capabilities.includes('tools');
  // 目を持っているモデルだけが画像を受け取れる。
  // 持っていないモデルに送ると、無視されるか、そのまま失敗する。
  const canVision = info.capabilities.includes('vision');
  cfg.vision = canVision;

  // 利用者の希望（thinkPreference）は残したまま、実際に送る値だけモデルに合わせる
  if (cfg.thinkPreference === undefined) cfg.thinkPreference = Boolean(cfg.think);
  cfg.think = cfg.thinkPreference && canThink;
  if (cfg.thinkPreference && !canThink) {
    notes.push({ level: 'info', text: `${cfg.model} は思考モードを持たないので、思考なしで動かします。` });
  }
  if (!canTools) {
    notes.push({
      level: 'error',
      text:
        `${cfg.model} はツール呼び出しに対応していません。` +
        'このアプリはツールでファイルを読み書きするため、このモデルでは動きません。'
    });
  }
  return { info, notes, canTools, canThink, canVision };
}

function buildOptions(cfg) {
  return {
    num_ctx: cfg.numCtx,
    temperature: cfg.temperature,
    top_p: cfg.topP,
    top_k: cfg.topK,
    repeat_penalty: cfg.repeatPenalty
  };
}

// 本文に書かれてしまった道具の呼び出しを拾う。
//
// qwen2.5-coder のように「道具は使えます」と申告しておきながら、
// 決められたタグ（<tool_call>）を付けずに JSON をそのまま本文へ書くモデルがある。
// その場合 Ollama は解釈できず、道具は永遠に呼ばれない。
// モデル側は直せないので、こちらで受け止める。
export function salvageToolCalls(text, tools) {
  const known = new Set((tools || []).map((t) => t?.function?.name).filter(Boolean));
  if (!known.size || !text) return { calls: [], cleaned: text };

  const candidates = [];
  const push = (raw, json) => candidates.push({ raw, json });

  // <tool_call>{...}</tool_call>
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) push(m[0], m[1]);
  // ```json {...} ```
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) push(m[0], m[1]);
  // 本文まるごとが JSON
  const whole = text.trim();
  if (whole.startsWith('{') && whole.endsWith('}')) push(whole, whole);
  if (whole.startsWith('[') && whole.endsWith(']')) push(whole, whole);

  const calls = [];
  let cleaned = text;

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.json.trim());
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let used = false;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const name = item.name || item.tool || item.function?.name;
      const args = item.arguments ?? item.parameters ?? item.function?.arguments ?? {};
      if (typeof name === 'string' && known.has(name) && args && typeof args === 'object') {
        calls.push({ id: `salvaged_${calls.length}`, name, args });
        used = true;
      }
    }
    if (used) cleaned = cleaned.replace(candidate.raw, '');
  }

  return { calls, cleaned: cleaned.trim() };
}

// 逐次で届く断片を、扱いやすい形のイベントに直して流す。
// yield されるもの:
//   { type: 'thinking', text }   … 考えている途中の文
//   { type: 'content',  text }   … 本文
//   { type: 'done', message, stats } … 1回分の応答が完成
export async function* chatStream({ cfg, messages, tools, signal }) {
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    think: Boolean(cfg.think),
    keep_alive: cfg.keepAlive,
    options: buildOptions(cfg)
  };
  if (tools && tools.length) body.tools = tools;

  let res;
  try {
    res = await fetch(`${cfg.host}/api/chat`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new OllamaError(`Ollama につながりません (${cfg.host}): ${err.message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new OllamaError(`Ollama がエラーを返しました (HTTP ${res.status}): ${detail.slice(0, 400)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  const toolCalls = [];
  let stats = null;

  const pushToolCall = (call) => {
    const fn = call.function || {};
    const index = typeof fn.index === 'number' ? fn.index : toolCalls.length;
    let slot = toolCalls.find((t) => t.index === index);
    if (!slot) {
      slot = { index, id: call.id || `call_${index}`, name: '', argsText: '', args: null };
      toolCalls.push(slot);
    }
    if (call.id) slot.id = call.id;
    if (fn.name) slot.name = fn.name;
    if (typeof fn.arguments === 'string') {
      // 断片で届く場合に備えてつなげる
      slot.argsText += fn.arguments;
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      slot.args = fn.arguments;
    }
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!raw) continue;

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        continue; // 壊れた行は捨てる
      }

      if (data.error) throw new OllamaError(String(data.error));

      const msg = data.message || {};
      if (msg.thinking) {
        thinking += msg.thinking;
        yield { type: 'thinking', text: msg.thinking };
      }
      if (msg.content) {
        content += msg.content;
        yield { type: 'content', text: msg.content };
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) pushToolCall(call);
      }

      if (data.done) {
        stats = {
          promptTokens: data.prompt_eval_count || 0,
          outputTokens: data.eval_count || 0,
          totalMs: Math.round((data.total_duration || 0) / 1e6),
          evalMs: Math.round((data.eval_duration || 0) / 1e6),
          loadMs: Math.round((data.load_duration || 0) / 1e6),
          doneReason: data.done_reason || 'stop'
        };
      }
    }
  }

  let finalCalls = toolCalls
    .sort((a, b) => a.index - b.index)
    .map((slot) => {
      let args = slot.args;
      if (!args && slot.argsText) {
        try {
          args = JSON.parse(slot.argsText);
        } catch {
          args = { __parseError: slot.argsText };
        }
      }
      return { id: slot.id, name: slot.name, args: args || {} };
    })
    .filter((call) => call.name);

  // 正規の道具呼び出しが1つも無いのに、本文が道具呼び出しの形をしている場合は拾う
  let salvaged = false;
  if (!finalCalls.length && content.trim()) {
    const rescue = salvageToolCalls(content, tools);
    if (rescue.calls.length) {
      finalCalls = rescue.calls;
      content = rescue.cleaned;
      salvaged = true;
    }
  }

  const message = { role: 'assistant', content };
  if (thinking) message.thinking = thinking;
  if (finalCalls.length) {
    message.tool_calls = finalCalls.map((call) => ({
      id: call.id,
      function: { name: call.name, arguments: call.args }
    }));
  }

  yield { type: 'done', message, toolCalls: finalCalls, stats: stats || {}, salvaged };
}

// ツールなしで一発だけ答えてもらう（要約などの裏方仕事に使う）
export async function chatOnce({ cfg, messages, signal, temperature = 0.2 }) {
  const res = await fetch(`${cfg.host}/api/chat`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: false,
      think: false,
      keep_alive: cfg.keepAlive,
      options: { ...buildOptions(cfg), temperature }
    }),
    signal
  });
  if (!res.ok) throw new OllamaError(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.message && data.message.content) || '';
}

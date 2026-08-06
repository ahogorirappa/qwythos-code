// エージェント本体。「考える → 道具を使う → 結果を見る」を繰り返す輪の部分。
import path from 'node:path';
import { chatStream, chatOnce } from './ollama.mjs';
import { TOOL_MAP, toolSchemas, truncateOutput } from './tools.mjs';
import { buildSystemPrompt, COMPACT_PROMPT } from './prompt.mjs';
import { PathError } from './paths.mjs';
import {
  c, line, out, clearLine, supportsAnsi, Spinner, toolHeader, toolResultLine,
  formatMarkdown, termWidth, info, warn
} from './ui.mjs';

// 文字数からだいたいのトークン数を見積もる（日本語混じりを想定して 1トークン≒3文字）
function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content || '').length + (m.thinking || '').length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 3);
}

export class Agent {
  constructor({ config, root, permissions, onSave }) {
    this.config = config;
    this.root = root;
    this.permissions = permissions;
    this.onSave = onSave || (() => {});
    this.systemPrompt = buildSystemPrompt({ root, config });
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.abortController = null;
    this.running = false;
    // 道具の呼び出しを本文に書いてしまうモデルか。
    // 1度でもそうと分かったら、以後は本文を出す前に必ず見分ける（画面にJSONを漏らさない）。
    this.writesToolCallsAsText = false;
    this.stats = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
    this.ctx = {
      root,
      config,
      changedFiles: new Set(),
      readFiles: new Set(),
      // いまのやることリスト。todo_write が書き換える。
      todos: [],
      signal: null
    };
  }

  restore(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const rest = messages.filter((m) => m.role !== 'system');
    this.messages = [{ role: 'system', content: this.systemPrompt }, ...rest];
  }

  interrupt() {
    if (this.abortController) this.abortController.abort();
  }

  rebuildSystemPrompt() {
    this.systemPrompt = buildSystemPrompt({ root: this.root, config: this.config });
    this.messages[0] = { role: 'system', content: this.systemPrompt };
  }

  clear() {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.ctx.changedFiles.clear();
    this.ctx.readFiles.clear();
    this.ctx.todos = [];
  }

  // ── ひとまとまりのお願いを最後まで処理する ────────────────
  async runTurn(userInput, images = []) {
    // 前のお願いの思考テキストはもう要らない。文脈を空けるために落とす。
    for (const m of this.messages) {
      if (m.role === 'assistant' && m.thinking) delete m.thinking;
    }

    // 画像は Ollama の作法どおり、その発言に添えて送る（base64 の配列）。
    // 前の発言に付いていた画像は落とす。1枚で数十万トークン相当になるため、
    // 残したままだと2枚目を渡した時点で文脈が尽きる。
    for (const m of this.messages) {
      if (m.role === 'user' && m.images) delete m.images;
    }

    const message = { role: 'user', content: userInput };
    if (images.length) message.images = images.map((i) => i.data);
    this.messages.push(message);
    this.stats.turns++;
    this.running = true;
    this.abortController = new AbortController();
    this.ctx.signal = this.abortController.signal;

    const recentCalls = new Map();
    let interrupted = false;
    let nudges = 0;
    // やることリストの促しは1回まで（下の判定で使う）
    let toldAboutTodos = false;

    try {
      for (let step = 0; step < this.config.maxSteps; step++) {
        await this.maybeCompact();

        let result;
        try {
          result = await this.streamAssistant();
        } catch (err) {
          if (err.name === 'AbortError') {
            interrupted = true;
            break;
          }
          throw err;
        }

        this.messages.push(result.message);
        if (result.stats) {
          this.stats.inputTokens += result.stats.promptTokens || 0;
          this.stats.outputTokens += result.stats.outputTokens || 0;
        }

        if (!result.toolCalls.length) {
          const said = result.message.content.trim();

          if (!said && step === 0) {
            // 何も言わずに終わってしまったときは一度だけ促す
            this.messages.push({
              role: 'user',
              content: 'You returned an empty response. Either use a tool to make progress, or answer the request directly.'
            });
            continue;
          }

          // 「これからやります」と書くだけで手を動かさないモデルがある。
          // 待っていても永遠に動かないので、その場で促す。
          if (said && nudges < (this.config.maxNudges ?? 5) && describesIntentWithoutActing(said)) {
            nudges++;
            info('手順を述べただけで実行していないので、促しました。');
            this.messages.push({
              role: 'user',
              content:
                'You described what you are going to do, but you did not actually use any tool. ' +
                'Nothing happened. Do it now by calling the tools yourself. ' +
                'Do not ask the user to proceed and do not describe the steps again.'
            });
            continue;
          }

          break;
        }

        let denied = false;
        for (const call of result.toolCalls) {
          if (this.abortController.signal.aborted) {
            interrupted = true;
            break;
          }
          const outcome = await this.executeTool(call, recentCalls);
          this.messages.push({
            role: 'tool',
            tool_name: call.name,
            tool_call_id: call.id,
            content: outcome.output
          });
          if (outcome.denied) denied = true;
        }

        if (interrupted) break;
        if (denied) {
          // 断られたことはモデルに伝わっているので、次の一手を考えさせる
          continue;
        }

        // 長くなってきたのにやることリストが無いときだけ、一度だけ促す。
        //
        // 実測（qwythos 9B）では、5手で終わる作業では自分から todo_write を呼ばなかった。
        // 短い作業ならそれで困らないので、そこは放っておく。
        // 困るのは長い作業で、途中で何を頼まれていたのか見失うとき。
        // 促すのは1回だけ。毎回言うと、そのぶん往復を食って本来の作業が進まない。
        if (
          !toldAboutTodos &&
          !this.ctx.todos?.length &&
          this.stats.toolCalls >= (this.config.todoHintAfter ?? 6)
        ) {
          toldAboutTodos = true;
          this.messages.push({
            role: 'user',
            content:
              'This is taking several steps. Call todo_write once with the full list of what is left, ' +
              'so you and the user can both see where this is going. Then carry on.'
          });
          continue;
        }

        if (step === this.config.maxSteps - 1) {
          warn(`ツールの往復が上限 (${this.config.maxSteps} 回) に達したので止めました。続けるなら「続けて」と言ってください。`);
          this.messages.push({
            role: 'user',
            content: 'You reached the maximum number of tool calls for this turn. Summarize what you did and what is left.'
          });
        }
      }
    } finally {
      this.running = false;
      this.abortController = null;
      this.ctx.signal = null;
      this.onSave();
    }

    if (interrupted) {
      line();
      warn('中断しました。');
      this.messages.push({
        role: 'user',
        content: '[The user interrupted you. Stop what you were doing and wait for the next instruction.]'
      });
    }
    return { interrupted };
  }

  // ── モデルの応答を逐次受け取って画面に出す ────────────────
  async streamAssistant() {
    const spinner = new Spinner('考えています').start();
    let phase = 'idle';
    let lineBuffer = '';
    let thinkStart = Date.now();
    let sawThinking = false;
    // 道具の呼び出しを本文に書いてしまうモデルがある。それを画面に出さないよう、
    // 見分けがつくまで表示を保留する（'unknown' → 'hold' か 'show'）。
    let contentAll = '';
    let shownLen = 0;
    // 本文にJSONを書く癖があると分かっているモデルでは、最初から最後まで保留する。
    // 逐次表示は諦めることになるが、道具の呼び出しを画面に晒すよりはよい。
    let holdDecision = this.writesToolCallsAsText ? 'hold' : 'unknown';

    const flushLine = (text) => {
      line(formatMarkdown(text));
    };

    const events = chatStream({
      cfg: this.config,
      messages: this.messages,
      tools: toolSchemas(this.ctx.config),
      signal: this.abortController.signal
    });

    let final = null;

    for await (const ev of events) {
      if (ev.type === 'thinking') {
        if (phase !== 'thinking') {
          spinner.stop();
          phase = 'thinking';
          thinkStart = Date.now();
          sawThinking = true;
        }
        if (this.config.showThinking === 'full') {
          out(c.gray(ev.text));
        } else if (this.config.showThinking !== 'off' && supportsAnsi) {
          // 直近の一行だけを、その場で書き換えながら見せる
          const flat = ev.text.replace(/\s+/g, ' ');
          this._thinkTail = ((this._thinkTail || '') + flat).slice(-(termWidth() - 14));
          clearLine();
          out(`${c.magenta('✻')} ${c.gray(this._thinkTail)}`);
        }
        continue;
      }

      if (ev.type === 'content') {
        contentAll += ev.text;

        if (holdDecision === 'unknown') {
          const head = contentAll.trimStart();
          if (head) {
            if (!'{[<`'.includes(head[0])) {
              holdDecision = 'show';
            } else if (head.length >= 12 || head.includes('\n')) {
              holdDecision = looksLikeToolCall(head) ? 'hold' : 'show';
            }
          }
        }
        if (holdDecision !== 'show') continue;

        if (phase !== 'content') {
          if (phase === 'thinking') {
            const secs = ((Date.now() - thinkStart) / 1000).toFixed(1);
            if (this.config.showThinking === 'full') {
              line();
            } else {
              clearLine();
            }
            this._thinkTail = '';
            line(c.gray(`✻ ${secs} 秒考えました`));
          }
          spinner.stop();
          phase = 'content';
          line();
        }
        // 保留していた分もここでまとめて流す
        lineBuffer += contentAll.slice(shownLen);
        shownLen = contentAll.length;
        let nl;
        while ((nl = lineBuffer.indexOf('\n')) >= 0) {
          const oneLine = lineBuffer.slice(0, nl);
          // 文章の途中から道具の呼び出しが始まることがある。
          // その行に達したら、そこから先は出さずに保留へ切り替える。
          if (startsToolCallBlock(oneLine)) {
            holdDecision = 'hold';
            break;
          }
          flushLine(oneLine);
          lineBuffer = lineBuffer.slice(nl + 1);
        }
        continue;
      }

      if (ev.type === 'done') {
        // 本文から道具の呼び出しを拾ったなら、このモデルはその癖を持つ
        if (ev.salvaged) this.writesToolCallsAsText = true;
        spinner.stop();
        if (phase === 'thinking') {
          const secs = ((Date.now() - thinkStart) / 1000).toFixed(1);
          clearLine();
          this._thinkTail = '';
          if (sawThinking) line(c.gray(`✻ ${secs} 秒考えました`));
        }
        // 保留していた分の後始末。
        //   道具の呼び出しだった → 出さずに捨てる（画面にJSONを晒さない）
        //   ただの文章だった     → まだ出していない分をここで出す
        if (ev.salvaged) {
          lineBuffer = '';
        } else {
          const unshown = contentAll.slice(shownLen);
          if (unshown) lineBuffer += unshown;
          if (lineBuffer.trim() && phase !== 'content') {
            phase = 'content';
            line();
          }
        }
        if (lineBuffer) {
          flushLine(lineBuffer);
          lineBuffer = '';
        }
        if (phase === 'content') line();
        final = ev;
      }
    }

    spinner.stop();
    if (!final) throw new Error('モデルからの応答が途中で切れました。');
    return final;
  }

  // ── 道具を1つ実行する ──────────────────────────────────────
  async executeTool(call, recentCalls) {
    const tool = TOOL_MAP.get(call.name);
    this.stats.toolCalls++;

    if (!tool) {
      toolHeader(call.name, '');
      toolResultLine(`知らない道具です`, true);
      return {
        output: `Unknown tool "${call.name}". Available tools: ${[...TOOL_MAP.keys()].join(', ')}.`,
        denied: false
      };
    }

    if (call.args && call.args.__parseError !== undefined) {
      toolHeader(tool.name, '');
      toolResultLine('引数のJSONが壊れていました', true);
      return {
        output: 'Your tool arguments were not valid JSON. Call the tool again with correct JSON arguments.',
        denied: false
      };
    }

    // 同じ呼び出しの繰り返しを止める
    const key = `${call.name}:${JSON.stringify(call.args)}`;
    const count = (recentCalls.get(key) || 0) + 1;
    recentCalls.set(key, count);
    if (count > this.config.duplicateLimit) {
      toolHeader(tool.name, summarizeArgs(tool.name, call.args));
      toolResultLine('同じ呼び出しの繰り返しなので止めました', true);
      return {
        output:
          `You have called ${call.name} with these exact arguments ${count} times. ` +
          'The result will not change. Try a different approach, or tell the user what is blocking you.',
        denied: false
      };
    }

    toolHeader(tool.name, summarizeArgs(tool.name, call.args));

    // 成立しない操作は、確認を出す前にここで弾いてモデルに理由を返す
    if (typeof tool.validate === 'function') {
      let problem = null;
      try {
        problem = tool.validate(call.args || {}, this.ctx);
      } catch (err) {
        problem = err instanceof PathError ? err.message : `${err.name}: ${err.message}`;
      }
      if (problem) {
        toolResultLine('そのままでは適用できません', true);
        return { output: problem, denied: false };
      }
    }

    // 確認が要るかどうか
    let needsApproval = tool.approval === 'always';
    if (tool.approval === 'conditional' && typeof tool.needsApproval === 'function') {
      needsApproval = tool.needsApproval(call.args, this.ctx, this.permissions);
    }

    if (needsApproval) {
      let preview = '';
      let title = tool.approvalTitle ? safeCall(() => tool.approvalTitle(call.args, this.ctx), '') : '';
      if (typeof tool.preview === 'function') {
        preview = safeCall(() => tool.preview(call.args, this.ctx), '');
      }
      const decision = await this.permissions.request({
        toolName: tool.name,
        args: call.args,
        title,
        preview
      });
      if (!decision.granted) {
        toolResultLine('ユーザーが実行を断りました', true);
        return {
          output:
            'The user denied this action. Do not try it again. ' +
            'Ask what they would prefer, or continue with a different approach.',
          denied: true
        };
      }
      // 実際に人へ聞いたときだけ、確認欄と結果の間に1行あける
      if (decision.reason === 'user' || decision.reason === 'always') line();
    }

    try {
      const res = await tool.run(call.args || {}, this.ctx);
      // 道具が自分で画面に出したときは、結果の行を重ねない（やることリストなど）
      if (!res.quiet) toolResultLine(res.display || 'done', Boolean(res.isError));
      return {
        output: truncateOutput(String(res.output ?? ''), this.config.maxToolChars),
        denied: false
      };
    } catch (err) {
      const message = err instanceof PathError ? err.message : `${err.name}: ${err.message}`;
      toolResultLine(message.split('\n')[0], true);
      return { output: `Tool error: ${message}`, denied: false };
    }
  }

  // ── 文脈が長くなりすぎたら要約して詰める ──────────────────
  async maybeCompact() {
    const limit = Math.floor(this.config.numCtx * this.config.compactAtRatio);
    if (estimateTokens(this.messages) < limit) return;

    // まず古いツール出力を短くする（これだけで足りることが多い）
    const cutoff = this.messages.length - 8;
    for (let i = 1; i < cutoff; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && m.content && m.content.length > 400) {
        m.content = `${m.content.slice(0, 300)}\n…[古い出力のため省略]`;
      }
    }
    if (estimateTokens(this.messages) < limit) {
      info('古いツール出力を短くして文脈を空けました。');
      return;
    }

    await this.compact();
  }

  async compact() {
    const keep = 6;
    if (this.messages.length <= keep + 2) return;

    // 切れ目がツール結果の途中に来ると、呼び出しだけ消えた履歴になってしまう。
    // 残す側の先頭がツール結果でなくなるまで境界をずらす。
    let start = this.messages.length - keep;
    while (start < this.messages.length - 1 && this.messages[start].role === 'tool') start++;

    const head = this.messages[0];
    const middle = this.messages.slice(1, start);
    const tail = this.messages.slice(start);

    const transcript = middle
      .map((m) => {
        if (m.role === 'tool') return `[tool ${m.tool_name}] ${String(m.content).slice(0, 600)}`;
        if (m.role === 'assistant' && m.tool_calls) {
          return `[assistant used tools] ${m.tool_calls.map((t) => t.function.name).join(', ')} ${m.content || ''}`;
        }
        return `[${m.role}] ${m.content || ''}`;
      })
      .join('\n')
      .slice(-40000);

    const spinner = new Spinner('これまでのやり取りを要約中').start();
    let summary = '';
    try {
      summary = await chatOnce({
        cfg: this.config,
        messages: [
          { role: 'system', content: COMPACT_PROMPT },
          { role: 'user', content: transcript }
        ]
      });
    } catch {
      summary = '';
    }
    spinner.stop();

    if (!summary.trim()) {
      // 要約できなければ古い部分を捨てるだけにする
      this.messages = [head, ...tail];
      warn('要約に失敗したので、古いやり取りを切り捨てました。');
      return;
    }

    // 要約はモデルが書くので取り違えが混じる。実際に触ったファイルは事実として添える。
    const facts = [];
    const changed = [...this.ctx.changedFiles].map((f) => path.relative(this.root, f));
    const read = [...this.ctx.readFiles].map((f) => path.relative(this.root, f)).filter((f) => !changed.includes(f));
    if (changed.length) facts.push(`Files actually written in this session: ${changed.join(', ')}`);
    if (read.length) facts.push(`Files actually read (not modified): ${read.slice(0, 20).join(', ')}`);
    if (!changed.length) facts.push('No file has been written in this session yet.');

    this.messages = [
      head,
      {
        role: 'user',
        content:
          `[Summary of the earlier part of this session]\n${summary.trim()}\n\n` +
          `[Verified facts recorded by the tool runner — these override the summary above]\n${facts.join('\n')}`
      },
      { role: 'assistant', content: 'Understood. Continuing from there.' },
      ...tail
    ];
    info('文脈が長くなったので、これまでの内容を要約して続けます。');
  }

  changedFileList() {
    return [...this.ctx.changedFiles];
  }
}

// 「これからこうします」と述べただけで、実際には何もしていない返答か。
//
// 道具を呼ばずにターンを終えた返答だけに対して使う。
// 過去形の報告（直しました・実行しました）は対象外にしないと、正しい完了報告まで促してしまう。
export function describesIntentWithoutActing(text) {
  const intent =
    /(\bI will\b|\bI'll\b|\blet me\b|\blet's\b|\bI am going to\b|\bI'm going to\b|\bnext,? I\b|please proceed|proceed with|\bStep 1\b|これから|次に|してください|していきます|する予定|します。)/i;
  const done =
    /(\bI (have |already )?(changed|edited|fixed|created|ran|verified|updated)\b|\bnow pass(es|ed)?\b|しました|直しました|作成しました|確認しました|通りました)/i;

  // 判定は「最後の一文」で行う。
  // 「直しました。次にテストを実行します。」のように完了報告と次の宣言が同居することがあり、
  // 全文で見ると完了報告に引っぱられて、動いていないのに終わったと誤認してしまう。
  const sentences = text.trim().split(/(?<=[.。!?！？])\s*|\n+/).filter((s) => s.trim());
  if (!sentences.length) return false;

  const last = sentences[sentences.length - 1];
  if (intent.test(last)) return !done.test(last);

  // 最後の一文が短すぎて判断できないときだけ、1つ前も併せて見る
  if (last.trim().length < 15 && sentences.length > 1) {
    const merged = `${sentences[sentences.length - 2]} ${last}`;
    return intent.test(merged) && !done.test(merged);
  }
  return false;
}

// 本文の書き出しが、道具の呼び出しに見えるか
function looksLikeToolCall(head) {
  return /^(<tool_call>|```(?:json)?\s*[[{]|[[{]\s*"?(name|tool|function)"?\s*:)/.test(head);
}

// その1行から、道具の呼び出しの塊が始まっていそうか。
// 本物のコード例（```json …）まで拾ってしまうが、道具でなければ最後にまとめて出すので消えはしない。
function startsToolCallBlock(oneLine) {
  const t = oneLine.trimStart();
  return /^(<tool_call>|```(?:json)?\s*$|```(?:json)?\s*[[{]|[[{]\s*"?(name|tool|function)"?\s*:)/.test(t);
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return typeof fallback === 'string' ? `${fallback}${err.message}` : fallback;
  }
}

// ツール名ごとに「何をしようとしているか」を1行で見せる
function summarizeArgs(name, args = {}) {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(args.path || '');
    case 'list_dir':
      return String(args.path || '.');
    case 'search_files':
      // glob も出す。これが無いと「一致なし」の理由が画面から追えない。
      return [
        args.pattern || '',
        args.path ? ` in ${args.path}` : '',
        args.glob ? ` glob:${args.glob}` : ''
      ].join('');
    case 'run_command': {
      const cmd = String(args.command || '');
      return cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd;
    }
    default:
      return Object.keys(args).length ? JSON.stringify(args).slice(0, 60) : '';
  }
}

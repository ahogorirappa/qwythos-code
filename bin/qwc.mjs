#!/usr/bin/env node
// Qwythos Code — 入り口。起動オプションの解釈と、対話ループ。
import readline from 'node:readline';
import path from 'node:path';
import process from 'node:process';
import { loadConfig, saveConfig } from '../src/config.mjs';
import { checkServer, listModels, adaptToModel, pickBestModel, checkGpuFit } from '../src/ollama.mjs';
import { PermissionManager } from '../src/permissions.mjs';
import { Agent } from '../src/agent.mjs';
import { TOOLS, activeTools, setMcpTools, KEY_HELP } from '../src/tools.mjs';
import { startMcp, stopMcp, loadMcpConfig } from '../src/mcp.mjs';
import { loadApiKey } from '../src/web.mjs';
import { resolveMentions, buildMentionBlock } from '../src/mentions.mjs';
import { anyServerAvailable, serverStatus, stopAll as stopLsp } from '../src/lsp.mjs';
import { loadCommands, renderCommand, isReserved } from '../src/commands.mjs';
import {
  isAvailable as browserAvailable,
  login as browserLogin,
  savedSites,
  forgetAll,
  INSTALL_HELP as BROWSER_HELP
} from '../src/browser.mjs';
import { newSessionId, saveSession, listSessions, loadSession, latestSessionForRoot } from '../src/session.mjs';
import { loadHarness, undoHarness, describeHarness } from '../src/harness.mjs';
import { c, line, out, banner, info, warn, error, success, renderTodos, sendDisplayToStderr, Spinner } from '../src/ui.mjs';
import { serve, requestTool, emit, ready, turnEnd } from '../src/embed.mjs';

const VERSION = '0.1.0';

// ── 起動オプション ──────────────────────────────────────────
function parseArgs(argv) {
  const opts = { prompt: null, resume: null, cwd: null, overrides: {}, listSessions: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '-p': case '--print': opts.prompt = next(); break;
      case '-m': case '--model': opts.overrides.model = next(); break;
      case '--host': opts.overrides.host = next(); break;
      case '--ctx': opts.overrides.numCtx = Number(next()); break;
      case '--temp': opts.overrides.temperature = Number(next()); break;
      case '--steps': opts.overrides.maxSteps = Number(next()); break;
      case '--yolo': case '--dangerously-skip-permissions': opts.overrides.autoApprove = true; break;
      case '--no-think': opts.overrides.think = false; break;
      case '--show-thinking': opts.overrides.showThinking = 'full'; break;
      case '--quiet-thinking': opts.overrides.showThinking = 'off'; break;
      case '--allow-outside': opts.overrides.allowOutsideRoot = true; break;
      case '--no-net': opts.overrides.net = false; break;
      case '--plan': opts.overrides.planMode = true; break;
      case '--embed': opts.embed = true; break;
      case '--cwd': opts.cwd = next(); break;
      case '--resume': opts.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? next() : 'last'; break;
      case '--sessions': opts.listSessions = true; break;
      default:
        if (a.startsWith('-')) {
          error(`知らないオプションです: ${a}`);
          process.exit(1);
        }
        rest.push(a);
    }
  }
  if (!opts.prompt && rest.length) opts.prompt = rest.join(' ');
  return opts;
}

function showHelp() {
  line(`
${c.bold('Qwythos Code')} v${VERSION} — ローカルのモデルで動く自律コーディングエージェント

${c.bold('使い方')}
  qwc                          対話モードで起動する
  qwc -p "テストを直して"       一回だけ実行して終了する
  qwc --resume                 直前の会話の続きから始める

${c.bold('オプション')}
  -p, --print <文>       一回だけ実行して結果を出す（自動化向け）
  -m, --model <名前>     使うモデル（既定: gemma4:26b）
      --host <URL>       Ollama の場所（既定: http://localhost:11434）
      --ctx <数>         文脈の広さ（既定: 32768）
      --temp <数>        創造性の高さ 0〜1（既定: 0.3）
      --steps <数>       1回のお願いで許すツール実行の上限（既定: 40）
      --yolo             確認を全部飛ばす（自動運転。中身を分かっている時だけ）
      --no-think         思考モードを切る（速くなるが精度は落ちる）
      --show-thinking    考えている内容を全部表示する
      --quiet-thinking   考えている様子を表示しない
      --cwd <フォルダ>   作業フォルダを指定する
      --allow-outside    作業フォルダの外も触れるようにする
      --no-net           ネット接続を切る（検索とページ取得の道具を渡さない）
      --plan             計画モードで始める（まず調べて方針を出す。書き換えない）
      --resume [ID]      前の会話を読み込む（IDなしなら直近）
      --sessions         保存済みの会話を一覧する
  -h, --help             このヘルプ
  -v, --version          バージョン

${c.bold('対話中に使えるコマンド')}
  /help /clear /compact /model /think /yolo /tools /stats /files /refine /init /exit
  /login /logins /logout   ログインが要るサイトを読めるようにする
`);
}

function showSlashHelp() {
  line(`
${c.bold('  対話中のコマンド')}
  ${c.cyan('/help')}      この一覧
  ${c.cyan('/clear')}     会話をまっさらにする（作業フォルダはそのまま）
  ${c.cyan('/compact')}   会話をいますぐ要約して短くする
  ${c.cyan('/model')}     モデルを見る・切り替える（例: /model qwen3:14b-q4_K_M）
  ${c.cyan('/think')}     思考モードの切り替え（on / off / full / compact）
  ${c.cyan('/yolo')}      確認あり／なしを切り替える
  ${c.cyan('/plan')}      計画モードの出入り（まず調べて方針を出す。書き換えない）
  ${c.cyan('/todo')}      いまのやることリストを見る
  ${c.cyan('/commands')}  自分で作ったコマンドの一覧（.qwythos/commands/*.md）
  ${c.cyan('/tools')}     使える道具の一覧
  ${c.cyan('/login')}     サイトに手でログインして、その状態を保存する（例: /login github.com）
  ${c.cyan('/logins')}    ログイン状態が残っているサイトの一覧
  ${c.cyan('/logout')}    保存したログイン状態をすべて消す
  ${c.cyan('/stats')}     使ったトークン数などの記録
  ${c.cyan('/files')}     このセッションで書き換えたファイル
  ${c.cyan('/refine')}    いまのやり取りから、覚えておくことを直す（/refine list ・ /refine undo）
  ${c.cyan('/init')}      プロジェクトを調べて QWYTHOS.md を作る
  ${c.cyan('/save')}      いまの設定を次回以降の既定にする
  ${c.cyan('/exit')}      終了（Ctrl+D でも同じ）
`);
}

// ── 対話の入力受け付け ──────────────────────────────────────
let rl = null;
let pendingAsk = null;
let inputClosed = false;
const inputQueue = [];

function createReadline() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    historySize: 200
  });

  // 作業中に打たれた行も取りこぼさないよう、いったん溜めておく
  rl.on('line', (text) => {
    if (pendingAsk) {
      const resolve = pendingAsk;
      pendingAsk = null;
      resolve(text);
    } else {
      inputQueue.push(text);
    }
  });

  // Ctrl+D や入力の終わりで、待っている質問を解いてループを抜けられるようにする
  rl.on('close', () => {
    inputClosed = true;
    if (pendingAsk) {
      const resolve = pendingAsk;
      pendingAsk = null;
      resolve(null);
    }
  });
  return rl;
}

function showPrompt(question) {
  if (rl && process.stdin.isTTY) {
    rl.setPrompt(question);
    rl.prompt();
  } else {
    out(question);
  }
}

function ask(question) {
  return new Promise((resolve) => {
    // 対話できない状況（-p など）では null を返す＝確認は「やめる」扱い
    if (!rl) return resolve(null);

    const deliver = (value) => {
      // パイプ入力は画面に出ないので、記録として自分で書き出す
      if (value !== null && !process.stdin.isTTY) line(value);
      resolve(value);
    };

    showPrompt(question);
    if (inputQueue.length) return deliver(inputQueue.shift());
    if (inputClosed) return resolve(null);
    pendingAsk = deliver;
  });
}

// ── 別のアプリの中で動くときの本体 ──────────────────────────
//
// 相手から届く hello で、こちらの道具立てが決まる。
// 相手が持っていない道具はモデルに見せない（呼べない道具を見せない、はここでも同じ）。
async function runEmbedded({ config, root }) {
  let agent = null;
  let workRoot = root;

  await serve({
    onHello(message) {
      // 作業フォルダは相手が決める。あちらの利用者が選んだ場所がすべて。
      if (typeof message.root === 'string' && message.root) {
        workRoot = path.resolve(message.root);
        try {
          process.chdir(workRoot);
        } catch {
          emit.error(`指定されたフォルダに移動できません: ${workRoot}`);
        }
      }
      if (typeof message.model === 'string' && message.model) config.model = message.model;

      // 道具の実体は相手にある。呼び出しはそちらへ回す。
      config.hostToolNames = Array.isArray(message.tools) ? message.tools : [];
      config.hostTools = requestTool;
      // 確認は持ち主の仕事。こちらで聞くと、同じことを二度聞かれることになる。
      config.autoApprove = true;
      config.onContentDelta = (text) => emit.text(text);
      config.onTodos = (todos) => emit.todos(todos);

      agent = new Agent({ config, root: workRoot, permissions: null, onSave: () => {} });
      ready(activeTools(config).map((t) => t.name));
    },

    async onUser(message) {
      if (!agent) {
        emit.error('先に hello を送ってください。');
        turnEnd('');
        return;
      }
      const result = await agent.runTurn(String(message.text ?? ''));
      // 最後にモデルが言ったことを、そのまま返す
      let answer = '';
      for (let i = agent.messages.length - 1; i >= 0; i--) {
        const m = agent.messages[i];
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
          answer = m.content.trim();
          break;
        }
      }
      turnEnd(answer, result?.interrupted);
    },

    onInterrupt() {
      agent?.interrupt();
    },

    onGone() {
      agent?.interrupt();
    }
  });

  // 相手がいなくなったら、こちらも終わる。
  // 待っている通信が残っていると輪が抜けきらないことがあるので、ここで断ち切る。
  process.exit(0);
}

// ── 本体 ────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return showHelp();
  if (opts.version) return line(`qwc ${VERSION}`);

  if (opts.listSessions) {
    const sessions = listSessions(20);
    if (!sessions.length) return info('保存された会話はまだありません。');
    line();
    for (const s of sessions) {
      line(`  ${c.cyan(s.id)}  ${c.gray(`${s.root || '?'} — ${s.firstUser || ''}`)}`);
    }
    line();
    return;
  }

  // 別のアプリの中でエンジンとして動くときは、標準出力を JSON のやりとりに使う。
  // 色つきの表示が混ざると相手が読めなくなるので、いちばん先に行き先を変える
  // （ここから下では、つなぎ先の確認やモデルの選び直しが info/error を出しうる）。
  if (opts.embed) sendDisplayToStderr();

  const config = { ...loadConfig(), ...opts.overrides };
  const root = path.resolve(opts.cwd || process.cwd());
  try {
    process.chdir(root);
  } catch {
    error(`フォルダに移動できません: ${root}`);
    process.exit(1);
  }

  // Ollama が動いているか確認する
  const health = await checkServer(config);
  if (!health.ok) {
    error(`Ollama につながりません (${config.host})。`);
    info('別のターミナルで `ollama serve` を実行してから、もう一度お試しください。');
    process.exit(1);
  }
  // 一覧はこの下の「載りきるか」の判定でも使うので、try の外に出しておく
  let models = [];
  try {
    models = await listModels(config);
    // Ollama では「名前だけ」は「名前:latest」と同じ扱いになる
    const wanted = config.model.includes(':') ? config.model : `${config.model}:latest`;
    let found = models.includes(config.model) || models.includes(wanted);

    // 量子化の接尾辞まで書いていない場合（qwen3:14b → qwen3:14b-q4_K_M）は前方一致で拾う
    if (!found) {
      const near = models.filter((m) => m.startsWith(`${config.model}-`) || m.startsWith(`${config.model}:`));
      if (near.length === 1) {
        info(`${config.model} は見つからないので ${near[0]} を使います。`);
        config.model = near[0];
        found = true;
      } else if (near.length > 1) {
        error(`${config.model} に当てはまるモデルが複数あります: ${near.join(', ')}`);
        info('どれを使うか -m で指定してください。');
        process.exit(1);
      }
    }

    if (!found) {
      // 無いからといって、いきなり終わらせない。
      // 入っているものから妥当なものを選んで、そのまま使えるようにする。
      // -m で明示されたときだけは、黙ってすり替えず本人に決めてもらう。
      const substitute = opts.overrides.model ? null : pickBestModel(models);
      if (substitute) {
        info(`"${config.model}" は入っていないので ${substitute} を使います（-m で変えられます）。`);
        config.model = substitute;
        found = true;
      } else {
        error(`モデル "${config.model}" が見つかりません。`);
        info(`使えるモデル: ${models.join(', ') || '（1つもありません）'}`);
        info(`取得するなら: ollama pull ${config.model}`);
        process.exit(1);
      }
    }
  } catch (err) {
    warn(`モデル一覧を確認できませんでした: ${err.message}`);
  }

  // GPU に載りきるかを先に確かめる。
  //
  // 載りきらないと、はみ出した分が CPU 側で動いて極端に遅くなるが、画面には何も出ない。
  // 「今日はなぜか遅い」で終わらせないために、ここで実際に測って、駄目なら軽いほうに落とす。
  // -m で明示されたときは落とさない。本人が選んだものを黙ってすり替えないため。
  if (config.autoDowngrade && !opts.overrides.model && config.lightModel && config.lightModel !== config.model) {
    const spinner = new Spinner(`${config.model} を読み込んでいます`).start();
    const fit = await checkGpuFit(config);
    spinner.stop();
    if (!fit.ok && models.includes(config.lightModel)) {
      const pct = Math.round(fit.onGpu * 100);
      warn(`${config.model} は GPU に ${pct}% しか載りませんでした（残りは CPU 側で動くため極端に遅くなります）。`);
      info(`${config.lightModel} に切り替えます。GPU の空きが戻れば、次回はそのまま ${config.model} を使います。`);
      info(`このまま使いたいときは -m ${config.model} を付けてください。`);
      config.model = config.lightModel;
    }
  }

  // モデルの能力に設定を合わせる（思考モードの有無など）
  const adapted = await adaptToModel(config);
  for (const note of adapted.notes || []) {
    if (note.level === 'error') error(note.text);
    else info(note.text);
  }
  if (adapted.canTools === false) {
    info('ツール呼び出しに対応したモデルを指定してください（例: -m gemma4:26b）。');
    process.exit(1);
  }

  // 外の道具（MCP）をつなぐ。
  // 設定が無ければ何も起きないので、立ち上げが遅くなるのは使う人だけ。
  {
    const { tools: mcp, notes } = await startMcp(root);
    if (mcp.length) {
      setMcpTools(mcp);
      info(`外の道具を ${mcp.length} 個つなぎました（${mcp.map((t) => t.name).join(', ')}）。`);
    }
    for (const note of notes) warn(note);
  }

  // ── 別のアプリの中でエンジンとして動く ──────────────────────
  //
  // 道具の実体は相手が持っている。こちらは輪だけを回して、
  // 「これを実行してほしい」と頼み、結果を受け取って次の一手を考える。
  // 相手の作法（権限・記録・確認）に手を出さないので、あちらの約束は壊れない。
  if (opts.embed) {
    await runEmbedded({ config, root });
    return;
  }

  const isInteractive = !opts.prompt && !opts.embed;
  if (isInteractive) createReadline();

  const permissions = new PermissionManager(config, ask);
  const sessionId = newSessionId();

  const agent = new Agent({
    config,
    root,
    permissions,
    onSave: () => {
      saveSession(sessionId, {
        id: sessionId,
        root,
        model: config.model,
        updatedAt: new Date().toISOString(),
        messages: agent.messages.filter((m) => m.role !== 'system')
      });
    }
  });

  // 前の会話を読み込む
  if (opts.resume) {
    const id = opts.resume === 'last' ? latestSessionForRoot(root) : opts.resume;
    const data = id ? loadSession(id) : null;
    if (data) {
      agent.restore(data.messages);
      info(`前の会話を読み込みました (${id}, ${data.messages.length} 件)。`);
    } else {
      warn('読み込める会話が見つかりませんでした。新しく始めます。');
    }
  }

  // Ctrl+C の扱い
  let lastSigint = 0;
  const onSigint = () => {
    if (agent.running) {
      agent.interrupt();
      if (pendingAsk) {
        const resolve = pendingAsk;
        pendingAsk = null;
        out('\n');
        resolve('n');
      }
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 1500) {
      line();
      info('またどうぞ。');
      process.exit(0);
    }
    lastSigint = now;
    line();
    info('終了するにはもう一度 Ctrl+C（または /exit）。');
    if (rl) rl.prompt();
  };
  process.on('SIGINT', onSigint);
  if (rl) rl.on('SIGINT', onSigint);

  // ブラウザが使えるかは、ここで1回だけ調べる。
  // 道具を渡すかどうかの判断に使うので、最初の発言より前に済ませておく。
  if (config.net !== false) {
    config.browserReady = await browserAvailable();
  }
  // 言語サーバーがあるかも、ここで1回だけ調べる（毎回 PATH を舐めると遅い）
  config.lspReady = anyServerAvailable();

  // 言語サーバーは子プロセスとして残る。qwc が終わるときに必ず落とす。
  // 残ると、次に起動したときに二重に立ち上がってメモリを食う。
  const cleanup = () => { try { stopLsp(); stopMcp(); } catch { /* すでに落ちている */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  /**
   * 打たれた文を、モデルへ送る形に整える。
   *
   *   /自作コマンド → その中身に差し替える
   *   @パス        → そのファイルの中身を添える
   *
   * 対話モードと -p の両方から呼ぶ。片方だけ効くと、
   * 「対話では動いたのにスクリプトでは動かない」が起きる。
   */
  function prepareInput(raw, workRoot) {
    let text = String(raw);

    if (text.startsWith('/')) {
      const [word, ...rest] = text.slice(1).split(/\s+/);
      const custom = loadCommands(workRoot).get(String(word).toLowerCase());
      if (custom) {
        info(`/${custom.name}${custom.description ? ` — ${custom.description}` : ''}`);
        text = renderCommand(custom, rest.join(' '));
      }
    }

    const mentioned = resolveMentions(text, workRoot, { vision: Boolean(config.vision) });
    for (const m of mentioned.missing) {
      warn(`@${m.name} は渡せませんでした（${m.reason}）`);
    }

    for (const a of mentioned.attachments) {
      info(`@${a.name} を添えました（${a.chars.toLocaleString()}文字${a.truncated ? '・一部' : ''}）`);
    }
    for (const img of mentioned.images) {
      info(`@${img.name} を画像として見せます（${Math.round(img.bytes / 1024)}KB）`);
    }

    return {
      text: mentioned.attachments.length ? text + buildMentionBlock(mentioned.attachments) : text,
      images: mentioned.images
    };
  }

  // ── 一回だけ実行して終わるモード ──────────────────────────
  if (opts.prompt) {
    if (!config.autoApprove) {
      // 対話できないので、確認が必要な操作は自動で断られてしまう。先に伝える。
      warn('-p では確認に答えられません。書き換えも任せるなら --yolo を付けてください。');
    }
    // 対話モードと同じ扱いにする。`@` や `/自作コマンド` が
    // -p のときだけ効かない、という差をつくらない。
    const prepared = prepareInput(opts.prompt, root);
    await agent.runTurn(prepared.text, prepared.images);
    printChanged(agent);
    process.exit(0);
  }

  // ── 対話モード ────────────────────────────────────────────
  banner(config, root);
  if (config.autoApprove) warn('確認なしモードです（--yolo）。書き換えもコマンドもそのまま実行されます。');
  // 鍵が無ければ検索の道具は渡していない。黙って使えないより、理由が分かるほうがよい。
  if (config.net !== false && !loadApiKey()) {
    warn('ネット検索は使えません（ページ取得は使えます）。' + KEY_HELP.split('\n')[0]);
  }

  for (;;) {
    const input = await ask(`${c.magenta('❯')} `);
    if (input === null || input === undefined) break;
    let text = input.trim();
    if (!text) continue;

    if (text.startsWith('/')) {
      // 自分で作ったコマンドでなければ、組み込みとして処理する
      const word = text.slice(1).split(/\s+/)[0];
      if (!loadCommands(root).has(String(word).toLowerCase())) {
        const done = await handleSlash(text, { agent, config, permissions, root });
        if (done === 'exit') break;
        continue;
      }
    }

    try {
      const prepared = prepareInput(text, root);
      await agent.runTurn(prepared.text, prepared.images);

      // 計画モードで一区切りついたら、そのまま進めてよいかを聞く。
      // ここで承認を取らないと、計画モードは「書けないだけの不便なモード」で終わる。
      if (config.planMode) {
        line();
        line(`${c.brightYellow('┌')} ${c.bold('この方針で進めますか')}`);
        line(`${c.brightYellow('└')} ${c.gray('y = 実行に移る / n = このまま相談を続ける')}`);
        const answer = String((await ask(`${c.brightYellow('  →')} [y/n] `)) ?? '').trim().toLowerCase();
        if (answer === 'y' || answer === 'yes' || answer === '') {
          config.planMode = false;
          agent.rebuildSystemPrompt();
          success('計画モードを抜けました。いまの方針で進めます。');
          await agent.runTurn(
            'その計画のとおりに実行してください。手順は変えず、終わったら何をどう変えたかを短く報告してください。'
          );
        } else {
          info('計画モードのままです。気になるところを続けてどうぞ（/plan で抜けられます）。');
        }
      }
    } catch (err) {
      line();
      error(err.message);
      if (process.env.QWC_DEBUG) line(c.gray(err.stack || ''));
    }
  }

  line();
  info('またどうぞ。');
  process.exit(0);
}

function printChanged(agent) {
  const files = agent.changedFileList();
  if (!files.length) return;
  line();
  success(`書き換えたファイル (${files.length} 件)`);
  for (const f of files) line(c.gray(`    ${path.relative(agent.root, f)}`));
}

// ── /コマンド ───────────────────────────────────────────────
async function handleSlash(text, { agent, config, permissions, root }) {
  const [cmd, ...args] = text.slice(1).split(/\s+/);
  const arg = args.join(' ').trim();

  switch (cmd) {
    case 'help':
      showSlashHelp();
      return;

    case 'exit':
    case 'quit':
      return 'exit';

    case 'clear':
      agent.clear();
      out('\x1b[2J\x1b[H');
      banner(config, root);
      info('会話をまっさらにしました。');
      return;

    case 'compact':
      await agent.compact();
      return;

    case 'model': {
      if (!arg) {
        try {
          const models = await listModels(config);
          line();
          for (const m of models) {
            line(`  ${m === config.model ? c.green('●') : c.gray('○')} ${m}`);
          }
          line();
        } catch (err) {
          error(err.message);
        }
        return;
      }
      const previous = config.model;
      config.model = arg;
      const adapted = await adaptToModel(config);
      if (adapted.canTools === false) {
        error(`${arg} はツール呼び出しに対応していないため、切り替えを取り消しました。`);
        config.model = previous;
        await adaptToModel(config);
        return;
      }
      for (const note of adapted.notes || []) {
        if (note.level === 'error') error(note.text);
        else info(note.text);
      }
      agent.rebuildSystemPrompt();
      success(`モデルを ${arg} に切り替えました。`);
      return;
    }

    case 'think': {
      if (arg === 'off') {
        config.thinkPreference = false;
        success('思考モードを切りました。');
      } else if (arg === 'on' || arg === '') {
        config.thinkPreference = true;
        config.showThinking = config.showThinking === 'off' ? 'compact' : config.showThinking;
        success('思考モードを入れました。');
      } else if (arg === 'full' || arg === 'compact') {
        config.thinkPreference = true;
        config.showThinking = arg;
        success(`考えている内容の表示を ${arg} にしました。`);
      } else {
        info('使い方: /think on | off | full | compact');
        return;
      }
      // モデルが思考モードを持たない場合はここで無効に戻る
      const adapted = await adaptToModel(config);
      for (const note of adapted.notes || []) info(note.text);
      agent.rebuildSystemPrompt();
      return;
    }

    case 'login': {
      // 本物のブラウザを開いて、人が手でログインする。
      // qwc はキーボードにも画面の中身にも触らない。パスワードは受け取らない。
      if (!(await browserAvailable())) {
        info(BROWSER_HELP);
        return;
      }
      if (!arg) {
        info('使い方: /login github.com   （ログインしたいサイトを書いてください）');
        return;
      }
      line();
      info('ブラウザを開きます。表示された画面で、いつも通りログインしてください。');
      info('qwc はパスワードを受け取りません。終わったらここで Enter を押してください。');

      const result = await browserLogin(arg, {
        waitForUser: () => ask(`${c.brightYellow('  →')} ログインが終わったら Enter `)
      });

      if (!result.ok) {
        error(result.reason);
        return;
      }
      config.browserReady = true;
      success(`${result.host} のログイン状態を保存しました（Cookie ${result.cookieCount} 件）。`);
      info('以後 browse がこの状態でページを開きます。消すときは /logout です。');
      return;
    }

    case 'logins': {
      if (!(await browserAvailable())) {
        info(BROWSER_HELP);
        return;
      }
      const res = await savedSites();
      if (!res.ok) {
        error(res.reason);
        return;
      }
      if (!res.sites.length) {
        info('保存されているログインはありません。/login <サイト> で追加できます。');
        return;
      }
      line();
      for (const s of res.sites.slice(0, 30)) {
        line(`  ${c.bold(s.host.padEnd(34))} ${c.gray(`Cookie ${s.count} 件`)}`);
      }
      line(c.gray('\n  中身（値）は表示しません。消すには /logout。\n'));
      return;
    }

    case 'logout': {
      const res = forgetAll();
      config.browserReady = await browserAvailable();
      success(res.removed ? 'ログイン状態をすべて消しました。' : '消すものはありませんでした。');
      return;
    }

    case 'commands': {
      const found = loadCommands(root);
      if (!found.size) {
        info('自分で作ったコマンドはまだありません。');
        line(c.gray(`  .qwythos/commands/名前.md を置くと /名前 で呼べます。`));
        line(c.gray(`  中身がそのまま依頼になります（$ARGUMENTS で引数を差し込めます）。`));
        return;
      }
      line();
      for (const cmd of found.values()) {
        const clash = isReserved(cmd.name) ? c.yellow('  ← 組み込みと同じ名前なので呼べません') : '';
        line(`  ${c.cyan(`/${cmd.name}`.padEnd(16))} ${c.gray(cmd.description || '')}${clash}`);
      }
      line();
      return;
    }

    case 'plan': {
      config.planMode = !config.planMode;
      agent.rebuildSystemPrompt();
      if (config.planMode) {
        success('計画モードに入りました。');
        info('書き換えとコマンド実行の道具を外しました。まず調べて、方針を出します。');
      } else {
        success('計画モードを抜けました。');
      }
      return;
    }

    case 'todo': case 'todos': {
      const todos = agent.ctx.todos || [];
      if (!todos.length) {
        info('やることリストはまだありません。');
        return;
      }
      renderTodos(todos);
      return;
    }

    case 'yolo': {
      permissions.autoApprove = !permissions.autoApprove;
      agent.rebuildSystemPrompt();
      if (permissions.autoApprove) warn('確認なしモードにしました。書き換えもコマンドもそのまま実行されます。');
      else success('確認ありモードに戻しました。');
      return;
    }

    case 'tools': {
      // いま実際に渡している道具に印を付ける。
      // 一覧に出ているのに呼べない、という状態を作らない。
      const active = new Set(activeTools(config).map((t) => t.name));
      line();
      for (const t of TOOLS) {
        const badge = t.approval === 'never' ? c.green('読み取り') : t.approval === 'always' ? c.yellow('要確認') : c.cyan('条件つき');
        const off = active.has(t.name) ? '' : c.gray('  ← いまは渡していません');
        line(`  ${c.bold(t.name.padEnd(14))} ${badge}${off}`);
        line(c.gray(`    ${t.description.split('.')[0]}.`));
      }
      if (config.net === false) {
        line(c.gray('\n  ネット接続は切られています（--no-net）。'));
      } else if (!loadApiKey()) {
        line(c.gray(`\n  ${KEY_HELP.split('\n')[0]}`));
      }
      line();
      return;
    }

    case 'stats': {
      const s = agent.stats;
      line();
      line(`  ${c.gray('やり取り')}      ${s.turns} 回`);
      line(`  ${c.gray('ツール実行')}    ${s.toolCalls} 回`);
      line(`  ${c.gray('入力トークン')}  ${s.inputTokens.toLocaleString()}`);
      line(`  ${c.gray('出力トークン')}  ${s.outputTokens.toLocaleString()}`);
      line(`  ${c.gray('会話の長さ')}    ${agent.messages.length} 件`);
      line();
      return;
    }

    case 'files':
      printChanged(agent);
      if (!agent.changedFileList().length) info('まだ何も書き換えていません。');
      return;

    case 'refine': {
      const harness = loadHarness(root);

      if (arg === 'list') {
        line();
        const show = (notes, label) => {
          if (!notes.length) return;
          line(`  ${c.bold(label)}`);
          for (const n of notes) {
            line(`    ${c.gray(n.id)} ${n.text}`);
            line(`         ${c.gray(`根拠: ${n.evidence}`)}`);
          }
        };
        show(harness.project, 'このフォルダ');
        show(harness.global, '全体');
        if (!harness.project.length && !harness.global.length) info(describeHarness(harness));
        line();
        return;
      }

      if (arg === 'undo') {
        const undone = undoHarness(root);
        if (!undone.length) info('取り消せる変更がありません。');
        else {
          agent.rebuildSystemPrompt();
          success('直前の見直しを取り消しました。');
        }
        return;
      }

      const spinner = new Spinner('やり取りを見直しています').start();
      const result = await agent.refine(arg);
      spinner.stop();

      if (!result.applied.length) {
        info(result.reason || '変更はありませんでした。');
        return;
      }
      line();
      for (const a of result.applied) {
        const mark = a.op === 'delete' ? c.red('−') : a.op === 'update' ? c.cyan('~') : c.green('+');
        line(`  ${mark} ${a.scope === 'global' ? c.gray('[全体]') : c.gray('[このフォルダ]')} ${a.text}`);
      }
      line();
      info('取り消すなら /refine undo。一覧は /refine list。');
      return;
    }

    case 'save': {
      saveConfig({
        model: config.model,
        host: config.host,
        numCtx: config.numCtx,
        temperature: config.temperature,
        think: config.thinkPreference ?? config.think,
        showThinking: config.showThinking,
        maxSteps: config.maxSteps
      });
      success('いまの設定を次回以降の既定にしました。');
      return;
    }

    case 'init': {
      await agent.runTurn(
        'Explore this project and write a QWYTHOS.md at the workspace root. ' +
        'It must cover: what the project is, how to run it, how to test it, the folder layout, ' +
        'and any conventions a new contributor must follow. Base every line on files you actually read. ' +
        'Keep it under 100 lines.'
      );
      return;
    }

    default:
      warn(`知らないコマンドです: /${cmd}（/help で一覧）`);
  }
}

main().catch((err) => {
  error(err.message);
  if (process.env.QWC_DEBUG) line(c.gray(err.stack || ''));
  process.exit(1);
});

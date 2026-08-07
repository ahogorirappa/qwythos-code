// モデルを使わずに動かせる検証。`npm test` で実行する。
// ここが通らない状態で対話を試しても原因の切り分けができないので、先にこれを通すこと。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_MAP, truncateOutput } from '../src/tools.mjs';
import { loadConfig } from '../src/config.mjs';
import { PermissionManager } from '../src/permissions.mjs';
import { renderDiff } from '../src/ui.mjs';
import { salvageToolCalls, chatStream } from '../src/ollama.mjs';
import { describesIntentWithoutActing, claimsWorkDone, looksLikeFileRewrite, Agent } from '../src/agent.mjs';
import { TOOLS, activeTools } from '../src/tools.mjs';
import { checkUrl, htmlToText, decodeEntities, extractTitle } from '../src/web.mjs';
import { normalizeUrl, PROFILE_DIR } from '../src/browser.mjs';
import { findMentions, resolveMentions, buildMentionBlock, isImagePath } from '../src/mentions.mjs';
import { stripImages } from '../src/session.mjs';
import { loadCommands, renderCommand, isReserved } from '../src/commands.mjs';
import { pickBestModel, checkGpuFit, GPU_FIT_THRESHOLD } from '../src/ollama.mjs';
import { looksLikeComment as looksLikeCommentForTest, serverStatus } from '../src/lsp.mjs';
import { buildSystemPrompt } from '../src/prompt.mjs';
import { loadSkills, skillsBlock } from '../src/skills.mjs';
import { startMcp, stopMcp } from '../src/mcp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwc-test-'));
const ctx = {
  root,
  config: loadConfig(),
  changedFiles: new Set(),
  readFiles: new Set(),
  signal: null
};

const edit = TOOL_MAP.get('edit_file');
const read = TOOL_MAP.get('read_file');
const list = TOOL_MAP.get('list_dir');
const search = TOOL_MAP.get('search_files');
const write = TOOL_MAP.get('write_file');
const run = TOOL_MAP.get('run_command');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  NG   ${name}${detail ? `\n       ${String(detail).slice(0, 300)}` : ''}`);
  }
};
const put = (name, body) => {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
  return p;
};
const get = (name) => fs.readFileSync(path.join(root, name), 'utf8');

console.log('\nedit_file — 置き換えの正しさ');
{
  put('a.js', 'function f() {\n  return 1;   \n}\n');
  let r = await edit.run({ path: 'a.js', old_string: '  return 1;', new_string: '  return 2;' }, ctx);
  check('行末の空白のズレを吸収する', !r.isError && get('a.js').includes('return 2;'), r.output);

  put('b.js', 'class A {\n    method() {\n        return 1;\n    }\n}\n');
  r = await edit.run(
    { path: 'b.js', old_string: 'method() {\n    return 1;\n}', new_string: 'method() {\n    return 42;\n}' },
    ctx
  );
  check('一律にずれた字下げを補正する', get('b.js').includes('        return 42;') && get('b.js').includes('    method() {'), get('b.js'));

  put('c.js', 'let x = 1;\nlet x = 1;\n');
  r = await edit.run({ path: 'c.js', old_string: 'let x = 1;', new_string: 'let x = 2;' }, ctx);
  check('複数一致は拒否する', r.isError && /appears 2 times/.test(r.output), r.output);

  r = await edit.run({ path: 'c.js', old_string: 'let x = 1;', new_string: 'let x = 2;', replace_all: true }, ctx);
  check('replace_all なら全部置き換える', get('c.js') === 'let x = 2;\nlet x = 2;\n', get('c.js'));

  r = await edit.run({ path: 'c.js', old_string: 'nope', new_string: 'x' }, ctx);
  check('一致しないときは現物を返して直させる', r.isError && /actually contains/.test(r.output) && /let x = 2;/.test(r.output), r.output);

  put('d.js', 'export function sum(a, b) {\n  return a + b;\n}\n');
  r = await edit.run(
    {
      path: 'd.js',
      old_string: '    1\texport function sum(a, b) {\n    2\t  return a + b;\n    3\t}',
      new_string: '    1\texport function sum(a, b) {\n    2\t  return a + b;\n    3\t}\n    4\t\n    5\texport function multiply(a, b) {\n    6\t  return a * b;\n    7\t}'
    },
    ctx
  );
  check('read_file の行番号ごと貼られても救済する', !r.isError && get('d.js').includes('return a * b;') && !get('d.js').includes('\t'), r.output);

  put('e.tsv', '1\tapple\n2\tbanana\n');
  r = await edit.run({ path: 'e.tsv', old_string: '2\tbanana', new_string: '2\tcherry' }, ctx);
  check('行番号に見えるタブ区切りデータを壊さない', !r.isError && get('e.tsv') === '1\tapple\n2\tcherry\n', get('e.tsv'));

  put('f.js', 'const x = 1;\n');
  r = await edit.run({ path: 'f.js', old_string: 'const x = 1;\n', new_string: 'const x = 1;\nconst y = 2;\n' }, ctx);
  check('末尾への追記ができる', !r.isError && get('f.js') === 'const x = 1;\nconst y = 2;\n', get('f.js'));

  r = await edit.run({ path: 'f.js', old_string: 'const y = 2;', new_string: 'const y = 2;' }, ctx);
  check('中身が変わらない編集は断る', r.isError && /identical/.test(r.output), r.output);

  check('確認前の検査が不一致を見つける', edit.validate({ path: 'f.js', old_string: 'zzz', new_string: 'y' }, ctx) !== null);
  check('確認前の検査は成立する編集を通す', edit.validate({ path: 'f.js', old_string: 'const y = 2;', new_string: 'const y = 3;' }, ctx) === null);
}

console.log('\nパスの扱い');
{
  put('src/deep.js', 'x\n');
  let r = await read.run({ path: 'wrong/place/deep.js' }, ctx);
  check('取り違えたパスに候補を出す', r.isError && /Did you mean/.test(r.output) && /src\/deep\.js/.test(r.output), r.output);

  r = await read.run({ path: 'nowhere.xyz' }, ctx);
  check('候補が無ければ作業フォルダの中身を教える', r.isError && /workspace root/.test(r.output), r.output);

  let threw = null;
  try {
    await read.run({ path: '../../../etc/hosts' }, ctx);
  } catch (err) {
    threw = err;
  }
  check('作業フォルダの外は読めない', threw !== null && /作業フォルダ/.test(threw.message), threw?.message);

  threw = null;
  try {
    await write.run({ path: '/tmp/qwc-should-not-exist.txt', content: 'x' }, ctx);
  } catch (err) {
    threw = err;
  }
  check('作業フォルダの外へは書けない', threw !== null && !fs.existsSync('/tmp/qwc-should-not-exist.txt'), threw?.message);
}

console.log('\n読み取り系のツール');
{
  put('long.txt', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  let r = await read.run({ path: 'long.txt', offset: 10, limit: 3 }, ctx);
  check('offset と limit が効く', /line 10/.test(r.output) && /line 12/.test(r.output) && !/line 13\b/.test(r.output), r.output);

  put('bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x00]).toString('binary'));
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  r = await read.run({ path: 'bin.dat' }, ctx);
  check('バイナリは読まずに断る', r.isError && /binary/.test(r.output), r.output);

  r = await list.run({ path: '.' }, ctx);
  check('フォルダ一覧が返る', !r.isError && /src\//.test(r.output), r.output);

  put('hay/needle.js', 'const findMe = 42;\n');
  r = await search.run({ pattern: 'findMe', path: '.' }, ctx);
  check('横断検索で見つけられる', !r.isError && /needle\.js/.test(r.output) && /findMe/.test(r.output), r.output);

  r = await search.run({ pattern: 'zzz_not_present_zzz', path: '.' }, ctx);
  check('見つからない場合はその旨を返す', /No matches/.test(r.output), r.output);
}

console.log('\nコマンド実行');
{
  let r = await run.run({ command: 'echo hello' }, ctx);
  check('標準出力を拾う', !r.isError && /hello/.test(r.output), r.output);

  r = await run.run({ command: 'exit 3' }, ctx);
  check('失敗の終了コードを伝える', r.isError && /Exit code: 3/.test(r.output), r.output);

  r = await run.run({ command: 'sleep 5', timeout_ms: 400 }, ctx);
  check('時間切れで打ち切る', /timed out/.test(r.output), r.output);
}

console.log('\n確認が要るコマンドの判定');
{
  const perms = new PermissionManager(loadConfig(), async () => 'n');
  const cases = [
    ['ls -la', true], ['git status', true], ['pwd', true], ['cat README.md', true],
    ['rm -rf /', false], ['npm test', false], ['git push', false],
    ['cat a.txt > b.txt', false], ['ls; rm -rf x', false], ['git log | head', false],
    ['echo `whoami`', false], ['cat $(ls)', false]
  ];
  let ok = true;
  const wrong = [];
  for (const [cmd, want] of cases) {
    if (perms.isSafeCommand(cmd) !== want) {
      ok = false;
      wrong.push(cmd);
    }
  }
  check(`読み取り専用かどうかを ${cases.length} 件すべて正しく判定する`, ok, wrong.join(' / '));
}

// ── 長すぎる出力の切り詰め ──────────────────────────────────
console.log('\n長すぎる出力の切り詰め');
{
  const long = 'あ'.repeat(5000);
  const cut = truncateOutput(long, 1000);
  check('短ければ触らない', truncateOutput('みじかい', 1000) === 'みじかい');
  check('前と後ろを残す', cut.startsWith('あ') && cut.endsWith('あ'));
  check('省略した文字数を言う', cut.includes('4000 characters omitted'), cut.slice(0, 60));
  // ここが弱いと、前の3分の1だけを見て「該当は2つです」と答えてしまう（実測）
  check('全部ではないと分かる書き方にする', cut.includes('THIS IS NOT THE WHOLE OUTPUT'));
  check('次の手も書いてある', cut.includes('offset/limit'));
}

console.log('\n本文に書かれた道具呼び出しの救済');
{
  // qwen2.5-coder のように、決められたタグを付けずに JSON をそのまま本文へ書くモデルがある。
  // 拾えないと道具が永遠に呼ばれない。逆に拾いすぎると、ふつうの文章を誤って実行してしまう。
  const tools = [{ function: { name: 'run_command' } }, { function: { name: 'read_file' } }];
  const salvage = (text) => salvageToolCalls(text, tools);

  let r = salvage('{"name": "run_command", "arguments": {"command": "npm test"}}');
  check('裸のJSONを拾う', r.calls.length === 1 && r.calls[0].args.command === 'npm test', JSON.stringify(r));

  r = salvage('直します。\n```json\n{"name":"read_file","arguments":{"path":"a.js"}}\n```');
  check('jsonフェンスの中を拾う', r.calls.length === 1 && r.calls[0].args.path === 'a.js', JSON.stringify(r));

  r = salvage('<tool_call>{"name":"run_command","arguments":{"command":"ls"}}</tool_call>');
  check('tool_callタグの中を拾う', r.calls.length === 1, JSON.stringify(r));

  r = salvage('[{"name":"read_file","arguments":{"path":"a"}},{"name":"read_file","arguments":{"path":"b"}}]');
  check('配列で複数書かれても拾う', r.calls.length === 2, JSON.stringify(r));

  r = salvage('sum.js の引き算を足し算に直しました。');
  check('ふつうの文章は拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage('{"name":"delete_everything","arguments":{}}');
  check('知らない道具名は拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage('設定は {"name": "foo"} のように書きます。');
  check('文章中のJSONは拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage('やります。\n<tool_call>{"name":"run_command","arguments":{"command":"ls"}}</tool_call>');
  check('拾った部分は本文から取り除く', r.calls.length === 1 && r.cleaned === 'やります。', JSON.stringify(r));

  // 関数を書くような形で本文に書く癖。qwythos 9B に道具の名前を出して頼むと、こうなる
  const withArgs = [
    { function: { name: 'spawn_agent', parameters: { properties: { task: { type: 'string' } } } } },
    { function: { name: 'read_file', parameters: { properties: { path: {}, offset: {}, limit: {} } } } }
  ];
  const salvage2 = (text) => salvageToolCalls(text, withArgs);

  r = salvage2('spawn_agent(task="src/tools.mjs を読み、always の道具を挙げてください。")');
  check('関数の形も拾う', r.calls.length === 1 && r.calls[0].name === 'spawn_agent'
    && r.calls[0].args.task.includes('always'), JSON.stringify(r));

  r = salvage2('では調べます。\nread_file(path="src/app.js", limit=50)');
  check('引数が複数でも拾う', r.calls.length === 1 && r.calls[0].args.path === 'src/app.js'
    && r.calls[0].args.limit === 50, JSON.stringify(r));

  r = salvage2('read_file({"path":"a.js"})');
  check('括弧の中がJSONでも拾う', r.calls.length === 1 && r.calls[0].args.path === 'a.js', JSON.stringify(r));

  // ここを間違えると、説明したつもりの一文が実行される
  r = salvage2('この処理は read_file(ファイルを読む道具) を使っています。');
  check('文の途中で触れただけなら拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('read_file(なにかいい感じに)');
  check('引数の名前が合わなければ拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('spawn_agent(depth=3)');
  check('持っていない引数名なら拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('unknown_tool(path="a.js")');
  check('知らない道具の関数形は拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('調べます。\nspawn_agent(task="どこで決めているか（判定の場所）を教えて")');
  check('引数の中の丸括弧で切らない', r.calls.length === 1
    && r.calls[0].args.task === 'どこで決めているか（判定の場所）を教えて', JSON.stringify(r));

  r = salvage2('やります。\nspawn_agent(task="調べて")');
  check('関数形も本文から取り除く', r.cleaned === 'やります。', JSON.stringify(r));

  // 書き方を説明しているだけの例を実行してしまわないこと
  r = salvage2('使い方はこうです。\n```js\nread_file(path="a.js")\n```\n以上です。');
  check('コード例の中は拾わない', r.calls.length === 0, JSON.stringify(r));

  r = salvage2('文の途中に書かれた spawn_agent(task="やって") は拾いません。');
  check('行の途中から始まるものは拾わない', r.calls.length === 0, JSON.stringify(r));
}

console.log('\n宣言だけで手を動かさない返答の検知');
{
  // 「やります」と書いて終わるモデルがある。待っていても永遠に動かないので促す。
  // ただし、正しい完了報告まで促してしまっては逆効果になる。
  const yes = [
    'Let me locate the sum.js file and correct it.\n\nStep 1: Locate the file\nPlease proceed with the first step.',
    'I will search for the test file and read its content.',
    'これから sum.js を修正します。',
    '次に、テストを実行してください。',
    // 完了報告と次の宣言が同居する形。実機で促しが不発になった実例。
    'I have fixed the sum function. Now, I will run the tests again to verify the changes.',
    'sum.js を直しました。次に、テストを実行します。'
  ];
  const no = [
    'sum.js の引き算を足し算に直しました。npm test は通っています。',
    'I changed the implementation in sum.js and the tests now pass.',
    '合計は 57,000円です。',
    'I ran npm test and verified all tests passed.',
    // 実機で誤検知した形。ただのコードの説明が「します。」で終わっているだけ。
    // これを拾うと、正しく答えたあとに催促が出て「指示が不明確です」と聞き返す返事に化ける。
    'cart.js の total 関数は、買い物かごの合計金額を計算するものです。\n\n引数 items という配列を受け取り、各アイテムの価格と数量を掛け合わせて合計を求め、その合計金額を返します。',
    'この関数は配列を受け取り、条件に合う要素だけを残した新しい配列を返します。',
    'エラーが起きた場合は null を返します。'
  ];
  let ok = true;
  for (const t of yes) if (!describesIntentWithoutActing(t)) { ok = false; console.log(`       見逃し: ${t.slice(0, 40)}`); }
  for (const t of no) if (describesIntentWithoutActing(t)) { ok = false; console.log(`       誤検知: ${t.slice(0, 40)}`); }
  check(`宣言だけの返答${yes.length}件を検知し、完了報告${no.length}件は促さない`, ok);
}

// ── やっていないのに「やりました」と言う ────────────────────
//
// 実機で出た不具合。read_file だけ呼んで「4行目を修正しました」と報告し、
// ファイルは1文字も変わらないまま終わっていた。
// 上の判定は過去形をわざと除外しているので、こちらで拾う。
// この関数は「そう言っているか」だけを見る。本当かどうかは ctx.mutations と突き合わせる。
console.log('\nやっていないのに「やりました」と言う返答の検知');
{
  const claims = [
    '4 行目の i <= items.length を i < items.length に修正しました。',
    'sum.js を直しました。',
    'I fixed the off-by-one error in cart.js.',
    'I have updated the loop condition.',
    'The fix is applied to line 4.',
    'テストを追加しました。',
    '不要な行を削除しました。',
    'ファイルを作成しました。'
  ];
  const notClaims = [
    // 手を動かさなくても成り立つ、正しい報告
    'ファイルを確認しました。バグは 4 行目にあります。',
    'I read cart.js and the bug is on line 4.',
    '合計は 57,000円です。',
    // 打ち消している場合
    'まだ修正していません。先に確認させてください。',
    'I did not change the file because the path was outside the project.',
    '直す必要はありません。',
    // 完了報告と打ち消しが同居する形。前半は本物の主張なので拾えないと困る
  ];
  let ok = true;
  for (const t of claims) if (!claimsWorkDone(t)) { ok = false; console.log(`       見逃し: ${t.slice(0, 40)}`); }
  for (const t of notClaims) if (claimsWorkDone(t)) { ok = false; console.log(`       誤検知: ${t.slice(0, 40)}`); }
  check(`「やりました」${claims.length}件を検知し、そうでない${notClaims.length}件は拾わない`, ok);

  // 打ち消しは文ごとに見る。全文で見ると、前半の本物の完了報告まで消えてしまう。
  check(
    '打ち消しが別の文にあっても、完了報告は拾える',
    claimsWorkDone('cart.js を修正しました。テストは実行していません。')
  );
}

// ── 直した全文を画面に貼るだけで保存しない ──────────────────
//
// 実機で出た不具合。read_file のあと、関数を1つ足した全文を ``` で囲んで出して終わり、
// ファイルは元のままだった。本人は何も主張しないので、文章を読む判定では捕まらない。
console.log('\n書き直した中身を貼っただけの返事の検知');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwc-rewrite-'));
  const target = path.join(dir, 'cart.js');
  const source = [
    '// 買い物かごの合計を出す',
    'export function total(items) {',
    '  let sum = 0;',
    '  for (let i = 0; i < items.length; i++) {',
    '    sum += items[i].price * items[i].qty;',
    '  }',
    '  return sum;',
    '}'
  ].join('\n');
  fs.writeFileSync(target, source, 'utf8');
  const rctx = { root: dir, readFiles: new Set([target]) };

  // 実機で出た形そのまま。元の全文＋足した関数
  const rewrite = '```javascript\n' + source + '\n\n// 割引後の合計\nexport function totalWithDiscount(items, discount) {\n  return total(items) * (1 - discount);\n}\n```';
  check('元の全文を含む塊は「保存し忘れ」と分かる', looksLikeFileRewrite(rewrite, rctx) === target);

  // 説明のための短い引用は、重なりが少ないので拾わない
  const quote = '合計はここで足しています。\n\n```javascript\n    sum += items[i].price * items[i].qty;\n```\n\nこの1行が本体です。';
  check('説明のための数行の引用は拾わない', looksLikeFileRewrite(quote, rctx) === null);

  // まったく別のコードを見せる場合も拾わない
  const other = '```javascript\nconst x = fetch("https://example.com/very/long/path");\nconsole.log(await x.text());\nprocess.exit(0);\n```';
  check('関係のないコード例は拾わない', looksLikeFileRewrite(other, rctx) === null);

  // コードの塊が無ければ、そもそも対象外
  check('``` が無ければ拾わない', looksLikeFileRewrite('cart.js は合計を計算します。', rctx) === null);

  // 読んでいないファイルは比べようがない
  check('読んでいないファイルとは比べない', looksLikeFileRewrite(rewrite, { root: dir, readFiles: new Set() }) === null);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 促しが本当にループから出るか ────────────────────────────
//
// 判定の関数が正しいことと、それがループで使われていることは別。
// モデルの返事を台本で差し替えて、往復そのものを確かめる。
// 実機は温度0.3で毎回違う道を通るので、これを実機の確認の代わりにはできない。逆も同じ。
console.log('\nやったと言い張ったときの促し（ループの往復）');
{
  // 台本どおりに返すだけの偽モデル
  class ScriptedAgent extends Agent {
    constructor(opts, script) {
      super(opts);
      this.script = script;
      this.calls = 0;
    }
    async streamAssistant() {
      const step = this.script[this.calls++] || { content: '終わりです。' };
      if (step.mutate) this.ctx.mutations = (this.ctx.mutations || 0) + 1;
      return {
        message: { role: 'assistant', content: step.content },
        toolCalls: [],
        stats: null
      };
    }
  }

  const mkAgent = (script) =>
    new ScriptedAgent(
      {
        config: { ...loadConfig(), maxSteps: 6, isSubagent: true },
        root,
        permissions: new PermissionManager(loadConfig(), async () => 'n')
      },
      script
    );

  const nudgeText = /did not call write_file/;
  const nudgesIn = (agent) =>
    agent.messages.filter((m) => m.role === 'user' && nudgeText.test(m.content || '')).length;

  // 実機で出た形。読んだだけで「修正しました」と言って終わる。
  {
    const a = mkAgent([{ content: '4 行目の i <= items.length を i < items.length に修正しました。' }, { content: '直しました。' }]);
    await a.runTurn('cart.js のバグを直して');
    check('手を動かさずに「修正しました」と言ったら促す', nudgesIn(a) > 0);
  }

  // 本当に直したときは促さない。ここが壊れると、正しく終わるたびに催促が出る。
  {
    const a = mkAgent([{ content: 'cart.js を修正しました。', mutate: true }]);
    await a.runTurn('cart.js のバグを直して');
    check('本当に書き換えたあとの完了報告は促さない', nudgesIn(a) === 0);
  }

  // 手を動かしていなくても、変えたと言っていなければ促さない（ただの質問への答え）。
  {
    const a = mkAgent([{ content: 'バグは 4 行目にあります。境界の比較が誤っています。' }]);
    await a.runTurn('cart.js のどこが悪い？');
    check('変えたと言っていない答えは促さない', nudgesIn(a) === 0);
  }

  // 促しても言い張り続ける相手に、無限に付き合わない
  {
    const script = Array.from({ length: 20 }, () => ({ content: '修正しました。' }));
    const a = mkAgent(script);
    a.config.maxNudges = 2;
    a.config.maxSteps = 20;
    await a.runTurn('cart.js のバグを直して');
    check('促す回数は maxNudges で頭打ちになる', nudgesIn(a) === 2, `実際: ${nudgesIn(a)} 回`);
  }
}

console.log('\n差分表示');
{
  const d = renderDiff('a\nb\nc\n', 'a\nB\nc\n');
  check('変わった行だけを出す', /-b/.test(d) && /\+B/.test(d) && !/-a/.test(d), d);
  check('変化なしはその旨を出す', /変化はありません/.test(renderDiff('same\n', 'same\n')));
}

// ── 確認が本当に出るか ──────────────────────────────────────
//
// 以前、6つの道具すべてが approval:'never' になっていて、
// README が謳う確認が一度も出ない状態だった。同じことを二度起こさないための番人。
console.log('\n実行前の確認');
{
  const expected = {
    read_file: 'never',
    list_dir: 'never',
    search_files: 'never',
    write_file: 'always',
    edit_file: 'always',
    run_command: 'conditional',
    web_search: 'always',
    web_fetch: 'always',
    browse: 'always',
    browser_login: 'always',
    todo_write: 'never',
    find_symbol: 'never',
    spawn_agent: 'never',
    read_skill: 'never'
  };
  let ok = true;
  for (const t of TOOLS) {
    const want = expected[t.name];
    if (t.approval !== want) {
      ok = false;
      console.log(`       ${t.name}: ${t.approval} になっている（${want} のはず）`);
    }
  }
  check('書き換え・コマンド・ネットは確認を通る設定になっている', ok);

  // 確認が要る道具は、何をするか見せる手段を必ず持っていること
  const guarded = TOOLS.filter((t) => t.approval !== 'never');
  check(
    `確認する${guarded.length}件すべてに見出しと下見がある`,
    guarded.every((t) => typeof t.approvalTitle === 'function' && typeof t.preview === 'function')
  );

  // conditional の道具は判定関数が要る（無いと素通りする）
  check(
    'conditional の道具には判定関数がある',
    TOOLS.filter((t) => t.approval === 'conditional').every((t) => typeof t.needsApproval === 'function')
  );
}

// ── ネットの道具の出し分け ──────────────────────────────────
console.log('\nネットの道具');
{
  const off = activeTools({ net: false }).map((t) => t.name);
  check('--no-net ではネットの道具を1つも渡さない', !off.includes('web_search') && !off.includes('web_fetch'));
  check('--no-net でも手元の道具は残る', off.includes('read_file') && off.includes('write_file'), off.join(', '));

  const on = activeTools({ net: true }).map((t) => t.name);
  check('ネット時は web_fetch を渡す', on.includes('web_fetch'));
}

// ── 意味で探す（LSP） ───────────────────────────────────────
console.log('\n意味で探す（LSP）');
{
  const off = activeTools({ net: false, lspReady: false }).map((t) => t.name);
  check('言語サーバーが無ければ渡さない', !off.includes('find_symbol'));

  const on = activeTools({ net: false, lspReady: true }).map((t) => t.name);
  check('あれば渡す', on.includes('find_symbol'));

  // 読むだけなので、計画モードでも使える
  const planning = activeTools({ net: false, lspReady: true, planMode: true }).map((t) => t.name);
  check('計画モードでも使える', planning.includes('find_symbol'));

  // コメントに書かれたコード例を定義と誤認しない（このリポジトリで実際に起きた）
  check('コメント行を定義とみなさない', looksLikeCommentForTest('  // export function foo() {'));
  check('本物の定義は通す', !looksLikeCommentForTest('export function foo() {'));
  check('ブロックコメントも除く', looksLikeCommentForTest('   * const bar = 1'));
}

// ── 調べものを任せる ────────────────────────────────────────
console.log('\n調べものを任せる');
{
  const normal = activeTools({ net: false }).map((t) => t.name);
  check('本体には渡す', normal.includes('spawn_agent'));

  // 入れ子は木が無限に広がるので、任された側には渡さない
  const sub = activeTools({ net: false, isSubagent: true }).map((t) => t.name);
  check('任された側には渡さない', !sub.includes('spawn_agent'));

  // 任された側は読むだけ。2つが同時に書いたら、どちらの結果も信用できなくなる
  const subTools = activeTools({ net: false, planMode: true, isSubagent: true }).map((t) => t.name);
  check('任された側は書き換えられない', !subTools.includes('write_file') && !subTools.includes('edit_file'));
  check('任された側も調べる道具は持つ', subTools.includes('read_file') && subTools.includes('search_files'));

  // 入れ子を頼まれたら、道具の側でも断る（渡していなくても、本文から拾われる場合がある）
  const spawn = TOOL_MAP.get('spawn_agent');
  const asSub = { ...ctx, config: { ...ctx.config, isSubagent: true } };
  const refused = await spawn.run({ task: 'なにか調べて' }, asSub);
  check('入れ子の依頼は道具が断る', refused.isError === true, refused.display);

  check('空の依頼を断る', (await spawn.run({ task: '  ' }, { ...ctx, config: { ...ctx.config } })).isError === true);

  // やることリストは人に見せるためのもの。任された側の画面は流れて消えるので渡さない
  check('任された側にやることリストは渡さない', !subTools.includes('todo_write'));
  check('計画モードだけならやることリストは渡す', activeTools({ net: false, planMode: true }).map((t) => t.name).includes('todo_write'));

  // 立場が違うので指示ごと入れ替える。
  // 計画モードの文面は「承認されたら自分が実装する」前提なので、任された側に渡ると嘘になる
  const subPrompt = buildSystemPrompt({ root, config: { ...ctx.config, planMode: true, isSubagent: true } });
  check('任された側は調べる係だと名乗る', subPrompt.includes('research assistant'));
  check('計画モードの説明文は渡さない', !subPrompt.includes('PLAN MODE'));
  check('変更したと言わせない', subPrompt.includes('Never claim you changed'));

  const planPrompt = buildSystemPrompt({ root, config: { ...ctx.config, planMode: true } });
  check('計画モードにはそのままの説明文', planPrompt.includes('PLAN MODE') && !planPrompt.includes('research assistant'));
}

// ── フォルダごとの決まりごと ────────────────────────────────
console.log('\nフォルダごとの決まりごと');
{
  put('rules/QWYTHOS.md', 'このフォルダは日本語で書くこと。');
  put('rules/deep/QWYTHOS.md', 'ここでは英語で書くこと。');
  put('rules/deep/target.js', 'const x = 1;\n');
  put('rules/plain.js', 'const y = 2;\n');

  const rulesCtx = { ...ctx, config: loadConfig(), deliveredRules: new Set() };

  let r = await read.run({ path: 'rules/deep/target.js' }, rulesCtx);
  check('近いフォルダの決まりごとを渡す', r.output.includes('ここでは英語で書くこと'), r.output.slice(-200));
  check('上のフォルダの決まりごとも渡す', r.output.includes('このフォルダは日本語で書くこと'));
  // 指示は末尾にあるものほど効くので、近いほうを後ろに置く
  check('近いほうを後ろに置く',
    r.output.lastIndexOf('ここでは英語') > r.output.lastIndexOf('このフォルダは日本語'));

  // 同じものを何度も積むと、それだけで文脈が埋まる
  r = await read.run({ path: 'rules/deep/target.js' }, rulesCtx);
  check('同じ決まりごとは二度渡さない', !r.output.includes('ここでは英語で書くこと'));

  // 作業フォルダ直下のものは最初から指示文に入っているので、ここでは渡さない
  put('QWYTHOS.md', 'いちばん上の決まりごと。');
  const freshCtx = { ...ctx, config: loadConfig(), deliveredRules: new Set() };
  r = await read.run({ path: 'rules/plain.js' }, freshCtx);
  check('いちばん上のものは二重に渡さない', !r.output.includes('いちばん上の決まりごと'));
  check('途中のフォルダのものは渡す', r.output.includes('このフォルダは日本語で書くこと'));
}

// ── 書き換えたあとに走らせる処理 ────────────────────────────
console.log('\n書き換えたあとに走らせる処理');
{
  const hookCtx = { ...ctx, config: loadConfig(), deliveredRules: new Set() };

  put('.qwythos/hooks.json', JSON.stringify({ afterEdit: 'echo 整えました $QWC_FILE_RELATIVE' }));
  let r = await write.run({ path: 'hooked.js', content: 'const a = 1;\n' }, hookCtx);
  check('書いたあとに走る', r.output.includes('afterEdit hook ok'), r.output);
  check('どのファイルかを渡す', r.output.includes('hooked.js'), r.output);

  // 失敗しても止めない。出力をそのままモデルに返して、直す機会を残す
  put('.qwythos/hooks.json', JSON.stringify({ afterEdit: 'echo かたちが違います >&2; exit 1' }));
  r = await write.run({ path: 'hooked2.js', content: 'const b = 1;\n' }, hookCtx);
  check('失敗しても書き込みは成功のまま', !r.isError, r.display);
  check('失敗の中身をモデルに返す', r.output.includes('かたちが違います'), r.output);
  check('直すよう促す', r.output.includes('Fix what it reported'), r.output);

  // 設定が無いプロジェクトでは何も起きない
  fs.rmSync(path.join(root, '.qwythos', 'hooks.json'));
  r = await write.run({ path: 'hooked3.js', content: 'const c = 1;\n' }, hookCtx);
  check('設定が無ければ何もしない', !r.output.includes('afterEdit'), r.output);

  put('.qwythos/hooks.json', '{壊れた');
  r = await write.run({ path: 'hooked4.js', content: 'const d = 1;\n' }, hookCtx);
  check('壊れた設定は黙って無視しない', r.output.includes('読めませんでした'), r.output);
  fs.rmSync(path.join(root, '.qwythos', 'hooks.json'));
}

// ── 手順書（スキル） ────────────────────────────────────────
console.log('\n手順書（スキル）');
{
  put('.qwythos/skills/release/SKILL.md',
    '---\nname: release\ndescription: リリース手順。版を上げてタグを打つまで\n---\n1. 版を上げる\n2. タグを打つ\n');
  put('.qwythos/skills/nometa/SKILL.md', 'ただの本文です。\n');

  const skills = loadSkills(root);
  check('見つけられる', skills.length === 2, JSON.stringify(skills.map((s) => s.name)));

  const release = skills.find((s) => s.name === 'release');
  check('頭の名前と説明を読む', release?.description.includes('リリース手順'), JSON.stringify(release));
  check('頭の部分は本文から外す', !release.body.includes('description:'), release?.body);
  check('名前が無ければフォルダ名を使う', skills.some((s) => s.name === 'nometa'));

  // 指示文に載せるのは名前と一行だけ。全文を載せると使わないぶんまで毎ターン払う
  const block = skillsBlock(skills);
  check('一覧には説明だけを載せる', block.includes('リリース手順') && !block.includes('1. 版を上げる'), block);

  const skill = TOOL_MAP.get('read_skill');
  let r = await skill.run({ name: 'release' }, ctx);
  check('読みにきたら全文を渡す', r.output.includes('タグを打つ'), r.output);

  // 名前を取り違えただけのことが多いので、実際にあるものを返す
  r = await skill.run({ name: 'releaes' }, ctx);
  check('名前違いには実際にあるものを教える', r.isError && r.output.includes('release'), r.output);

  // 1つも無いプロジェクトでは、読む道具そのものを渡さない
  const withSkills = activeTools({ net: false, skillCount: 2 }).map((t) => t.name);
  const without = activeTools({ net: false, skillCount: 0 }).map((t) => t.name);
  check('手順書があれば渡す', withSkills.includes('read_skill'));
  check('無ければ渡さない', !without.includes('read_skill'));

  fs.rmSync(path.join(root, '.qwythos', 'skills'), { recursive: true, force: true });
}

// ── 外の道具（MCP） ─────────────────────────────────────────
console.log('\n外の道具（MCP）');
{
  // 最小の MCP サーバーを立てて、本物の JSON-RPC でやりとりする。
  // 道具は3つ持たせ、設定では1つだけ使う（増やしすぎないことがいちばんの要点）。
  put('fake-mcp.mjs', `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'add', description: '2つの数を足す', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
    { name: 'noisy1', description: '使わない' },
    { name: 'noisy2', description: '使わない' }
  ] } });
  else if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params;
    if (name === 'add') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '答えは ' + (args.a + args.b) + ' です' }] } });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: '知らない道具' } });
  }
});
`);

  put('.qwythos/mcp.json', JSON.stringify({
    servers: { calc: { command: 'node', args: ['fake-mcp.mjs'], tools: ['add'] } }
  }));

  const { tools: mcp, notes } = await startMcp(root);
  check('つながって道具を持ってくる', mcp.length === 1, JSON.stringify(mcp.map((t) => t.name)));
  check('名前でどこの道具か分かる', mcp[0]?.name === 'mcp__calc__add', mcp[0]?.name);

  // 30個持っているサーバーの道具を全部見せると、9B は選べなくなる
  check('設定に書いた道具だけを渡す', !mcp.some((t) => t.name.includes('noisy')));

  // 何をする道具かはこちらには分からない。分からないものを黙って走らせない
  check('外の道具は必ず確認する', mcp[0]?.approval === 'always');

  let r = await mcp[0].run({ a: 3, b: 4 });
  check('実際に呼べて結果が返る', r.output.includes('答えは 7 です'), JSON.stringify(r));

  check('余計なお知らせは出さない', notes.length === 0, notes.join(' / '));

  // 設定で絞らなければ、上限まで自動で絞る
  put('.qwythos/mcp.json', JSON.stringify({
    servers: { calc2: { command: 'node', args: ['fake-mcp.mjs'] } }
  }));
  const loose = await startMcp(root);
  check('絞っていなければ全部渡すが上限は超えない', loose.tools.length === 3, String(loose.tools.length));

  // 名前を書き間違えたときに黙って減らさない
  put('.qwythos/mcp.json', JSON.stringify({
    servers: { calc3: { command: 'node', args: ['fake-mcp.mjs'], tools: ['addd'] } }
  }));
  const typo = await startMcp(root);
  check('無い道具を指定したら教える', typo.notes.some((n) => n.includes('addd')), typo.notes.join(' / '));

  // 立ち上がらないサーバーがあっても、理由を出して他は続ける
  put('.qwythos/mcp.json', JSON.stringify({
    servers: { broken: { command: 'this-command-does-not-exist-xyz' } }
  }));
  const broken = await startMcp(root);
  check('つながらなければ理由を出す', broken.notes.some((n) => n.includes('broken')), broken.notes.join(' / '));
  check('つながらなくても落ちない', Array.isArray(broken.tools) && broken.tools.length === 0);

  stopMcp();
  fs.rmSync(path.join(root, '.qwythos', 'mcp.json'));
}

// ── 別のアプリの中で動く ────────────────────────────────────
console.log('\n別のアプリの中で動く');
{
  // 道具の実体は相手が持つ。相手が持っている名前だけをモデルに見せる。
  const host = activeTools({ hostToolNames: ['read_file', 'list_dir'] }).map((t) => t.name);
  check('相手が持つ道具は渡す', host.includes('read_file') && host.includes('list_dir'));
  check('相手が持たない道具は渡さない', !host.includes('write_file') && !host.includes('run_command'));

  // やることリストと調べものの委譲は外に手を出さないので、相手の実装が要らない。
  // ここが持ち込める中身でもある（相手は輪と一緒にこの2つも手に入る）。
  check('外に触れない道具は付いていく', host.includes('todo_write') && host.includes('spawn_agent'));

  const sub = activeTools({ hostToolNames: ['read_file'], isSubagent: true }).map((t) => t.name);
  check('任された側には入れ子を渡さない', !sub.includes('spawn_agent'));
  check('任された側の扱いは本体のときと同じ', !sub.includes('todo_write'));
  check('任された側でも相手の道具は使える', sub.includes('read_file'));

  // ネットの鍵やブラウザの有無で勝手に増えない（増えたら相手が実装していない道具が混ざる）
  const withNet = activeTools({ hostToolNames: ['read_file'], net: true, browserReady: true }).map((t) => t.name);
  check('相手の一覧にないものは足さない', !withNet.includes('web_fetch') && !withNet.includes('browse'));
}

// ── ログイン済みブラウザ ────────────────────────────────────
console.log('\nブラウザ（ログインが要るページ用）');
{
  // Playwright が無い環境で browse を渡すと、呼ばれて失敗するだけで往復を1回損する
  const noPw = activeTools({ net: true, browserReady: false }).map((t) => t.name);
  check('Playwright が無ければ browse を渡さない', !noPw.includes('browse'));

  const withPw = activeTools({ net: true, browserReady: true }).map((t) => t.name);
  check('入っていれば browse を渡す', withPw.includes('browse'));
  check('--no-net なら入っていても渡さない', !activeTools({ net: false, browserReady: true }).map((t) => t.name).includes('browse'));

  // ログイン状態はホームの下に置く。作業フォルダには絶対に作らない
  check('ログイン状態はホームの下に置く', PROFILE_DIR.startsWith(os.homedir()), PROFILE_DIR);
  check('作業フォルダの中に作らない', !PROFILE_DIR.startsWith(root));

  check('サイト名だけでも https を補う', normalizeUrl('github.com') === 'https://github.com');
  check('http を書いてあれば尊重する', normalizeUrl('http://localhost:3000') === 'http://localhost:3000');
  check('file:// は受けない', normalizeUrl('file:///etc/passwd') === null);
  check('空は受けない', normalizeUrl('  ') === null);
}

// ── 取りに行ってよい URL か ─────────────────────────────────
console.log('\nURL の検査');
{
  const blocked = [
    'http://localhost:11434/api/tags',
    'http://127.0.0.1:8080/',
    'http://[::1]/',
    'http://192.168.1.1/',
    'http://10.0.0.5/admin',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',  // クラウドの資格情報が置いてある場所
    'http://printer.local/',
    'file:///etc/passwd',
    'ftp://example.com/x'
  ];
  let ok = true;
  for (const u of blocked) {
    if (checkUrl(u).ok) { ok = false; console.log(`       通してしまった: ${u}`); }
  }
  check(`手元・社内・別方式の${blocked.length}件を断る`, ok);

  const allowed = ['https://example.com/a?b=c', 'http://example.org/', 'https://docs.rs/serde/latest/serde/'];
  let ok2 = true;
  for (const u of allowed) {
    const r = checkUrl(u);
    if (!r.ok) { ok2 = false; console.log(`       断ってしまった: ${u} (${r.reason})`); }
  }
  check(`ふつうの${allowed.length}件は通す`, ok2);

  check('明示すれば手元も通せる', checkUrl('http://127.0.0.1:3000/', { allowLocal: true }).ok);
  check('空の URL を断る', !checkUrl('').ok);
  check('URLでない文字列を断る', !checkUrl('とりあえず調べて').ok);
}

// ── HTML を読める文にする ───────────────────────────────────
console.log('\nHTML の変換');
{
  const html = `<!doctype html><html><head><title>使い方 &amp; 注意</title>
    <style>.a{color:red}</style><script>var x=1;</script></head>
    <body><h1>見出し</h1><p>本文の1つ目です。</p><p>2つ目は&nbsp;空白入り。</p>
    <ul><li>ひとつ</li><li>ふたつ</li></ul>
    <div>末尾</div></body></html>`;
  const text = htmlToText(html);

  check('title を取り出す', extractTitle(html) === '使い方 & 注意', extractTitle(html));
  check('script の中身を捨てる', !text.includes('var x'), text.slice(0, 80));
  check('style の中身を捨てる', !text.includes('color:red'));
  check('タグが残らない', !/<[a-z/]/i.test(text), text.slice(0, 80));
  check('本文が残る', text.includes('本文の1つ目です。') && text.includes('末尾'));
  check('見出しに印が付く', text.includes('# 見出し'), text.slice(0, 40));
  check('箇条書きが行になる', text.includes('- ひとつ') && text.includes('- ふたつ'));
  check('空行が3つ以上続かない', !/\n{3,}/.test(text));

  check('数値参照を戻す', decodeEntities('&#72;&#x69;') === 'Hi');
  check('知らない実体はそのまま残す', decodeEntities('&unknownthing;') === '&unknownthing;');
  check('HTMLでない本文はそのまま扱える', htmlToText('ただの文章です') === 'ただの文章です');

  // 実体を戻すのはタグを落とし切った「あと」でなければならない。
  // 先に戻すと &lt;script&gt; が本物のタグに化けて、そのまま消えてしまう。
  // 実物のページで <v8::Local<T>> のような記法が出てきて気づいた性質。
  const escaped = htmlToText('<p>use &lt;v8::Local&lt;T&gt;&gt; here</p>');
  check('エスケープされた山かっこは本文として残る', escaped === 'use <v8::Local<T>> here', escaped);

  const fake = htmlToText('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  check('タグに化けさせずそのまま文字として出す', fake.includes('<script>alert(1)</script>'), fake);
}

// ── やることリスト ──────────────────────────────────────────
console.log('\nやることリスト');
{
  const todo = TOOL_MAP.get('todo_write');
  const tctx = { ...ctx, todos: [] };

  const r = await todo.run({
    todos: [
      { step: 'テストを走らせる', status: 'completed' },
      { step: '失敗を直す', status: 'in_progress' },
      { step: 'もう一度走らせる', status: 'pending' }
    ]
  }, tctx);
  check('リストを持ち回れる', tctx.todos.length === 3);
  check('進み具合を数える', /1\/3/.test(r.display), r.display);
  check('次にやることをモデルへ返す', /Next: 失敗を直す/.test(r.output), r.output.slice(0, 60));
  check('画面に出したので結果行は重ねない', r.quiet === true);

  // 手をつけているものが2つあると、どれを進めているのか分からなくなる
  await todo.run({
    todos: [
      { step: 'A', status: 'in_progress' },
      { step: 'B', status: 'in_progress' }
    ]
  }, tctx);
  check('in_progress は1つに絞る', tctx.todos.filter((t) => t.status === 'in_progress').length === 1);

  // 知らない状態を書かれても落ちない
  await todo.run({ todos: [{ step: 'C', status: 'こわれた値' }] }, tctx);
  check('知らない状態は pending に倒す', tctx.todos[0].status === 'pending');

  check('空のリストは断る', todo.validate({ todos: [] }) !== null);
  check('配列でなければ断る', todo.validate({ todos: 'あれこれ' }) !== null);
  check('多すぎるリストは断る', todo.validate({ todos: new Array(21).fill({ step: 'x', status: 'pending' }) }) !== null);
}

// ── 計画モード ──────────────────────────────────────────────
console.log('\n計画モード');
{
  const planning = activeTools({ net: false, planMode: true }).map((t) => t.name);
  check('書き換える道具を渡さない', !planning.includes('write_file') && !planning.includes('edit_file'));
  check('調べる道具は渡す', planning.includes('read_file') && planning.includes('search_files'));
  check('やることリストは使える', planning.includes('todo_write'));

  const normal = activeTools({ net: false, planMode: false }).map((t) => t.name);
  check('抜ければ書き換える道具が戻る', normal.includes('write_file') && normal.includes('edit_file'));

  // run_command は渡すが、中で状態を変えるものは断る
  const run = TOOL_MAP.get('run_command');
  const planCtx = { ...ctx, config: { ...ctx.config, planMode: true } };
  const danger = await run.run({ command: 'rm -rf /tmp/nope' }, planCtx);
  check('計画中は書き換えるコマンドを実行しない', danger.isError === true, danger.display);
  const safe = await run.run({ command: 'echo ok' }, planCtx);
  check('計画中でも読み取りのコマンドは通す', safe.isError === false, safe.display);
}

// ── @ でファイルを添える ────────────────────────────────────
console.log('\n@ でファイルを添える');
{
  fs.writeFileSync(path.join(root, 'notes.md'), '# メモ\n本文です\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const x = 1;\n');

  check('拾える', findMentions('@notes.md を読んで').join() === 'notes.md');
  check('日本語のすぐ後ろでも拾える', findMentions('この @src/app.js の中身').join() === 'src/app.js');
  check('文末の句点を名前に含めない', findMentions('@notes.md。').join() === 'notes.md');
  check('同じものは1回だけ', findMentions('@notes.md と @notes.md').length === 1);
  check('メールアドレスは拾わない', findMentions('foo@example.com に送って').length === 0);
  check('@ が無ければ空', findMentions('ふつうの文です').length === 0);

  const ok = resolveMentions('@notes.md と @src/app.js を見て', root);
  check('中身を読める', ok.attachments.length === 2, JSON.stringify(ok.missing));
  check('相対パスで持つ', ok.attachments.map((a) => a.name).sort().join() === 'notes.md,src/app.js');

  const block = buildMentionBlock(ok.attachments);
  check('渡す形に中身が入る', block.includes('本文です') && block.includes('const x = 1;'));

  // 作業フォルダの外を読ませない
  const escaped = resolveMentions('@../../.ssh/id_rsa を見て', root);
  check('作業フォルダの外は断る', escaped.attachments.length === 0 && escaped.missing.length === 1, JSON.stringify(escaped.missing));
  check('断った理由を返す', /外/.test(escaped.missing[0].reason));

  const gone = resolveMentions('@nowhere.txt', root);
  check('無いファイルは理由つきで返す', gone.missing.length === 1 && /見つかり/.test(gone.missing[0].reason));

  const dir = resolveMentions('@src', root);
  check('フォルダは断る', dir.missing.length === 1 && /フォルダ/.test(dir.missing[0].reason));
}

// ── 画像を見せる ────────────────────────────────────────────
console.log('\n画像を見せる');
{
  // 1x1 の PNG（実物のバイト列）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(path.join(root, 'shot.png'), png);

  check('拡張子で画像と分かる', isImagePath('a/b/shot.PNG') && isImagePath('x.webp'));
  check('コードは画像ではない', !isImagePath('src/app.js'));

  // 目のないモデルに送っても意味がないので、渡さず理由を返す
  const noEye = resolveMentions('@shot.png これ見て', root, { vision: false });
  check('目のないモデルには渡さない', noEye.images.length === 0 && noEye.missing.length === 1);
  check('別のモデルを案内する', /gemma4|画像を見られません/.test(noEye.missing[0].reason), noEye.missing[0].reason);

  const withEye = resolveMentions('@shot.png これ見て', root, { vision: true });
  check('目があれば画像として渡す', withEye.images.length === 1, JSON.stringify(withEye.missing));
  check('base64 で持つ', withEye.images[0].data === png.toString('base64'));
  check('文字の添付には混ぜない', withEye.attachments.length === 0);

  // 会話の保存に base64 を残さない（1枚で数MBになるため）
  const saved = JSON.parse(
    JSON.stringify({ messages: [{ role: 'user', content: 'x', images: ['AAAA', 'BBBB'] }] })
  );
  const stripped = stripImages(saved);
  check('保存時に画像の中身を落とす', !JSON.stringify(stripped).includes('AAAA'));
  check('見せた事実は残す', stripped.messages[0].imageCount === 2);
}

// ── 自分で作るコマンド ──────────────────────────────────────
console.log('\n自分で作るコマンド');
{
  const cmdDir = path.join(root, '.qwythos', 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.writeFileSync(path.join(cmdDir, 'review.md'), '# 変更を見直す\n直近の変更を確認して。\n$ARGUMENTS\n');
  fs.writeFileSync(path.join(cmdDir, 'plain.md'), '決まった手順をやって。\n');
  fs.writeFileSync(path.join(cmdDir, 'notes.txt'), '拾わない\n');

  const found = loadCommands(root);
  check('md だけを拾う', found.has('review') && found.has('plain') && !found.has('notes'));
  check('見出しを説明に使う', found.get('review').description === '変更を見直す');
  check('見出しは本文から外す', !found.get('review').body.includes('#'));

  check(
    '$ARGUMENTS に引数を入れる',
    renderCommand(found.get('review'), '認証まわり').includes('認証まわり')
  );
  check(
    '$ARGUMENTS が無ければ末尾に足す',
    renderCommand(found.get('plain'), '追加の指示').endsWith('追加の指示')
  );
  check('引数なしならそのまま', renderCommand(found.get('plain'), '') === '決まった手順をやって。');

  check('組み込みと同じ名前は分かる', isReserved('plan') && isReserved('todo') && !isReserved('review'));
}

// ── 入っているモデルから選ぶ ────────────────────────────────
console.log('\nモデルの自動選択');
{
  check('gemma4 を最優先する', pickBestModel(['qwen3:32b-q4_K_M', 'qwythos:latest', 'gemma4:26b']) === 'gemma4:26b');
  check('gemma4 が無ければ 9B', pickBestModel(['qwen3:32b-q4_K_M', 'qwythos:latest']) === 'qwythos:latest');
  check('埋め込み専用は選ばない', pickBestModel(['qwen3-embedding:0.6b', 'qwen3:14b-q4_K_M']) === 'qwen3:14b-q4_K_M');
  check('埋め込みしか無ければ選ばない', pickBestModel(['qwen3-embedding:0.6b']) === null);
  check('1つも無ければ null', pickBestModel([]) === null);
  check('知らない名前でも1つは返す', pickBestModel(['mystery:7b']) === 'mystery:7b');
}

// ── GPU に載りきったかを見る ────────────────────────────────
//
// 載りきらないと、はみ出した分が CPU 側で動いて極端に遅くなる。
// 画面には何も出ないので「今日はなぜか遅い」で終わってしまう。それを検知して軽いほうへ落とす。
console.log('\nGPU に載りきったかの判定');
{
  const http = await import('node:http');

  // Ollama のふりをして、載り具合だけ差し替えられるサーバー
  const fake = (ps) =>
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // /api/generate は読み込み、/api/ps は状況
      res.end(JSON.stringify(req.url === '/api/ps' ? ps : { done: true }));
    });

  const withServer = async (ps, fn) => {
    const srv = fake(ps);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      return await fn({ host: `http://127.0.0.1:${srv.address().port}`, model: 'big:26b', keepAlive: '30m' });
    } finally {
      srv.close();
    }
  };

  // 丸ごと GPU に載った
  const full = await withServer({ models: [{ name: 'big:26b', size: 17_300_000_000, size_vram: 17_300_000_000 }] }, checkGpuFit);
  check('全部 GPU に載っていれば、そのまま使う', full.ok === true && full.onGpu === 1);

  // 半分しか載らなかった＝はみ出しがCPU側にある
  const half = await withServer({ models: [{ name: 'big:26b', size: 17_300_000_000, size_vram: 8_000_000_000 }] }, checkGpuFit);
  check('半分しか載らなければ、載りきらないと判定する', half.ok === false, `GPU率 ${Math.round(half.onGpu * 100)}%`);

  // わずかなはみ出しは実害が無いので通す（数値の端数で毎回警告を出さない）
  const almost = await withServer({ models: [{ name: 'big:26b', size: 100, size_vram: 98 }] }, checkGpuFit);
  check('わずかな端数では騒がない', almost.ok === true && GPU_FIT_THRESHOLD <= 0.98);

  // Ollama は :latest を付けたり外したりして返すことがある
  const bare = await withServer({ models: [{ name: 'big:26b:latest', size: 100, size_vram: 10 }] }, checkGpuFit);
  check(':latest の有無が違っても同じモデルと分かる', bare.ok === false);

  // 自分のモデルが一覧に無い＝判断材料が無い。取り上げずに通す
  const missing = await withServer({ models: [{ name: 'other:7b', size: 100, size_vram: 10 }] }, checkGpuFit);
  check('自分のモデルが見当たらなければ通す', missing.ok === true && missing.unknown === true);

  // つながらないときも、確かめられないことを理由に使えるものを取り上げない
  const down = await checkGpuFit({ host: 'http://127.0.0.1:1', model: 'big:26b', keepAlive: '30m' });
  check('Ollama に聞けなくても止めない', down.ok === true && down.unknown === true);
}

// ── 返事を待つ時間 ──────────────────────────────────────────
//
// Node の fetch は、1文字目が返るまで300秒で必ず諦める（undici の headersTimeout）。
// 手元のモデルは文脈が長いとそれ以上かかるので、少し長い作業をすると必ず落ちていた。
// 偽のサーバーを立てて、待ち方が自分の手の内にあることを確かめる。
console.log('\n返事を待つ時間');
{
  const http = await import('node:http');

  // 受け取るだけで何も返さないサーバー＝黙り込んだモデル
  const silent = http.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const silentPort = silent.address().port;

  let waited = 0;
  let message = '';
  const t0 = Date.now();
  try {
    const stream = chatStream({
      cfg: { host: `http://127.0.0.1:${silentPort}`, model: 'x', firstTokenMs: 300, stallMs: 300 },
      messages: [{ role: 'user', content: 'hi' }]
    });
    for await (const _ of stream) { /* 来ない */ }
  } catch (err) {
    waited = Date.now() - t0;
    message = err.message;
  }
  silent.close();

  check('黙ったままなら自分で見切る', waited > 0 && waited < 5000, `${waited}ms`);
  check('300秒の壁ではなく設定した長さで切れる', waited < 3000, `${waited}ms`);
  check('理由と次の手を日本語で言う', message.includes('だまったまま') && message.includes('/clear'), message);

  // 普通に返すサーバー＝ちゃんと最後まで読めること
  const talker = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'こん' } }) + '\n');
    res.write(JSON.stringify({ message: { content: 'にちは' } }) + '\n');
    res.end(JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 3 }) + '\n');
  });
  await new Promise((r) => talker.listen(0, '127.0.0.1', r));
  const talkPort = talker.address().port;

  let text = '';
  let done = null;
  for await (const ev of chatStream({
    cfg: { host: `http://127.0.0.1:${talkPort}`, model: 'x' },
    messages: [{ role: 'user', content: 'hi' }]
  })) {
    if (ev.type === 'content') text += ev.text;
    if (ev.type === 'done') done = ev;
  }
  talker.close();

  check('逐次で届く本文をつなげる', text === 'こんにちは', text);
  check('締めくくりの数字も拾う', done?.stats?.promptTokens === 12 && done?.stats?.outputTokens === 3);

  // 話しはじめてから黙り込んだ場合。ここは短い方の物差しで切る
  const halfway = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'とちゅう' } }) + '\n');
    // 以降は何も書かないまま放置する
  });
  await new Promise((r) => halfway.listen(0, '127.0.0.1', r));
  const halfPort = halfway.address().port;

  let partial = '';
  let stallMsg = '';
  const t1 = Date.now();
  try {
    for await (const ev of chatStream({
      cfg: { host: `http://127.0.0.1:${halfPort}`, model: 'x', firstTokenMs: 5000, stallMs: 300 },
      messages: [{ role: 'user', content: 'hi' }]
    })) {
      if (ev.type === 'content') partial += ev.text;
    }
  } catch (err) {
    stallMsg = err.message;
  }
  const stallWait = Date.now() - t1;
  halfway.close();

  check('途中で止まったら短い方で見切る', stallMsg.includes('とぎれた'), stallMsg);
  check('見切るまで待ちすぎない', stallWait < 3000, `${stallWait}ms`);
  check('そこまでに届いた分は受け取れている', partial === 'とちゅう', partial);

  // エラーはエラーとして見せる（黙って握りつぶさない）
  const angry = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('model not found');
  });
  await new Promise((r) => angry.listen(0, '127.0.0.1', r));
  const angryPort = angry.address().port;
  let httpErr = '';
  try {
    for await (const _ of chatStream({
      cfg: { host: `http://127.0.0.1:${angryPort}`, model: 'x' },
      messages: [{ role: 'user', content: 'hi' }]
    })) { /* 来ない */ }
  } catch (err) {
    httpErr = err.message;
  }
  angry.close();
  check('サーバーの言い分をそのまま見せる', httpErr.includes('500') && httpErr.includes('model not found'), httpErr);
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n合計: ${passed} 件成功 / ${failed} 件失敗\n`);
process.exit(failed ? 1 : 0);

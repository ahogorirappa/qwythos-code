// モデルを使わずに動かせる検証。`npm test` で実行する。
// ここが通らない状態で対話を試しても原因の切り分けができないので、先にこれを通すこと。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_MAP } from '../src/tools.mjs';
import { loadConfig } from '../src/config.mjs';
import { PermissionManager } from '../src/permissions.mjs';
import { renderDiff } from '../src/ui.mjs';
import { salvageToolCalls } from '../src/ollama.mjs';
import { describesIntentWithoutActing } from '../src/agent.mjs';
import { TOOLS, activeTools } from '../src/tools.mjs';
import { checkUrl, htmlToText, decodeEntities, extractTitle } from '../src/web.mjs';
import { normalizeUrl, PROFILE_DIR } from '../src/browser.mjs';
import { findMentions, resolveMentions, buildMentionBlock, isImagePath } from '../src/mentions.mjs';
import { stripImages } from '../src/session.mjs';
import { loadCommands, renderCommand, isReserved } from '../src/commands.mjs';
import { pickBestModel } from '../src/ollama.mjs';
import { looksLikeComment as looksLikeCommentForTest, serverStatus } from '../src/lsp.mjs';

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
    'I ran npm test and verified all tests passed.'
  ];
  let ok = true;
  for (const t of yes) if (!describesIntentWithoutActing(t)) { ok = false; console.log(`       見逃し: ${t.slice(0, 40)}`); }
  for (const t of no) if (describesIntentWithoutActing(t)) { ok = false; console.log(`       誤検知: ${t.slice(0, 40)}`); }
  check(`宣言だけの返答${yes.length}件を検知し、完了報告${no.length}件は促さない`, ok);
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
    find_symbol: 'never'
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
  check('9B を優先する', pickBestModel(['qwen3:32b-q4_K_M', 'qwythos:latest']) === 'qwythos:latest');
  check('埋め込み専用は選ばない', pickBestModel(['qwen3-embedding:0.6b', 'qwen3:14b-q4_K_M']) === 'qwen3:14b-q4_K_M');
  check('埋め込みしか無ければ選ばない', pickBestModel(['qwen3-embedding:0.6b']) === null);
  check('1つも無ければ null', pickBestModel([]) === null);
  check('知らない名前でも1つは返す', pickBestModel(['mystery:7b']) === 'mystery:7b');
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n合計: ${passed} 件成功 / ${failed} 件失敗\n`);
process.exit(failed ? 1 : 0);

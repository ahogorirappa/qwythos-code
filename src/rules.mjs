// フォルダごとの決まりごとと、書き換えたあとに走らせる処理。
//
// ■ フォルダごとの決まりごと（パススコープルール）
//     大きなリポジトリでは、場所によって作法が違う。
//     `src/` は TypeScript で書く、`migrations/` は手で編集しない、`docs/` は日本語で書く。
//     こういう話を全部いちばん上の QWYTHOS.md に書くと、
//     **触りもしないフォルダの作法まで毎回送ることになる**。32k の文脈ではそれが効いてくる。
//
//     そこで、触ったファイルの近くにある決まりごとだけを、触ったときに渡す。
//     読んだ・書いた瞬間に「このフォルダにはこう書いてある」と分かれば、
//     モデルは自分でそれに合わせられる。
//
//     同じものは1回しか渡さない。毎回付けると、同じ文が会話に何度も積もる。
//
// ■ 書き換えたあとに走らせる処理（編集フック）
//     整形や型検査は、人がやると忘れる。忘れたまま次の作業に進むと、
//     あとでまとめて直すことになる。書き換えた直後に走らせるのがいちばん安い。
//
//     失敗しても止めない。**出力をそのままモデルに返す**。
//     直せるのはモデルなので、こちらが握りつぶすと直す機会そのものが消える。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { statSafe, displayPath } from './paths.mjs';

/** フォルダごとの決まりごとを書くファイル名。上から順に探して、最初に見つかったものを使う */
export const RULE_FILES = ['QWYTHOS.md', 'AGENTS.md', 'CLAUDE.md', '.qwythos.md'];

/** 1つの決まりごとファイルの上限。これより大きいものは載せない（文脈を食い潰すため） */
const MAX_RULE_BYTES = 16000;

/**
 * そのファイルに効いている決まりごとを集める。
 *
 * 触ったファイルのあるフォルダから、作業フォルダまで上っていく。
 * 作業フォルダ直下のものは**含めない**。それは最初から指示文に入っているので、
 * ここで返すと同じ文を二重に送ることになる。
 */
export function rulesForPath(absPath, ctx) {
  const root = path.resolve(ctx.root);
  let dir = path.dirname(path.resolve(absPath));
  const found = [];

  // 上っていくが、作業フォルダより上には出ない
  for (let depth = 0; depth < 20; depth++) {
    if (!dir.startsWith(root) || dir === root) break;
    for (const name of RULE_FILES) {
      const file = path.join(dir, name);
      const st = statSafe(file);
      if (st && st.isFile() && st.size <= MAX_RULE_BYTES) {
        found.push(file);
        break; // 同じフォルダに何個あっても1つだけ
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 近いフォルダのものほど後ろに置く。指示は末尾にあるものほど効く。
  return found.reverse();
}

/**
 * まだ渡していない決まりごとを、渡せる形にして返す。
 *
 * 1回渡したものは覚えておいて、二度は渡さない。
 * 毎回付けると、同じ文が会話に何度も積もって文脈を食う。
 */
export function pendingRules(absPath, ctx) {
  if (!ctx.deliveredRules) ctx.deliveredRules = new Set();

  const parts = [];
  for (const file of rulesForPath(absPath, ctx)) {
    if (ctx.deliveredRules.has(file)) continue;
    ctx.deliveredRules.add(file);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    if (!text) continue;
    parts.push(
      `\n\n--- Rules for this folder (${displayPath(file, ctx)}) — they override the general instructions ---\n${text}`
    );
  }
  return parts.join('');
}

/**
 * 書き換えたあとに走らせる処理を読む。
 *
 * 置き場所は作業フォルダの `.qwythos/hooks.json`。
 * 整形の仕方はプロジェクトごとに違うので、利用者ごとの設定ではなくプロジェクトに置く。
 *
 * ```json
 * { "afterEdit": "npx prettier --write \"$QWC_FILE\"" }
 * ```
 */
export function loadHooks(root) {
  const file = path.join(root, '.qwythos', 'hooks.json');
  const st = statSafe(file);
  if (!st || !st.isFile()) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return { __error: `.qwythos/hooks.json が読めませんでした: ${err.message}` };
  }
}

/**
 * ファイルを書き換えたあとの処理を走らせる。
 *
 * 戻り値はモデルに見せる文字列（何も走らせなければ空）。
 * 失敗しても投げない。**出力をそのまま返す**——直せるのはモデルなので、
 * こちらが握りつぶすと直す機会そのものが消える。
 */
/** 構文検査にかける上限。これより大きいものは見ない（時間のほうが高くつく） */
const SYNTAX_CHECK_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 書き換えた直後に、そのファイルが構文として成り立っているかだけ見る。
 *
 * ■ なぜ既定で入れるか
 *   qwc は書いたものを一度も動かさずに「直しました」と言える。
 *   `.qwythos/hooks.json` を置いていないフォルダ（`~/bin` など）で作業したとき、
 *   書いた結果が壊れていても、誰も気づかないまま話が進む。
 *
 * ■ 何をしないか
 *   **中身は動かさない。** 型検査もテストも走らせない。それは持ち主が hooks に書くもの。
 *   ここは「保存した瞬間に壊れていることが分かる」ところまでで止める。
 *   Python も `import` ではなく構文解析だけにしてあるので、副作用が出ない
 *   （`py_compile` は使わない。あれは `__pycache__` を作って人のフォルダを汚す）。
 *
 * ■ 拡張子が無いファイル
 *   `~/bin/line-guard` のように拡張子の無い実行ファイルがある。1行目の shebang で見分ける。
 *   実測 20〜30ms なので、書き換えごとに走らせても体感に出ない。
 */
function builtinSyntaxCheck(absPath) {
  const st = statSafe(absPath);
  if (!st || !st.isFile() || st.size > SYNTAX_CHECK_MAX_BYTES) return '';

  const kind = syntaxKindOf(absPath);
  if (!kind) return '';

  // JSON は外の道具を呼ばずにここで見る（速いし、Node に読み手がある）
  if (kind === 'json') return jsonSyntaxCheck(absPath);

  // シェルは**その本体に読ませる**。`sh` にまとめてはいけない。
  //
  // 2026-09-10 実測: `sh -n` は正しい bash / zsh を「壊れている」と言う。
  //     #!/usr/bin/env bash + `mapfile -t a < <(...)`  → bash -n は通る / sh -n は syntax error
  //     #!/bin/zsh        + `if [[ ]] { } else { }`    → zsh -n は通る / sh -n は syntax error
  // 検査に落ちた文面はそのままモデルへ渡るので、**正しく書けたコードを直しにいく**。
  // 見られないなら黙るほうがよい、というこのファイルの方針からも外れていた。
  const shell = SHELL_CHECKERS[kind];
  const result =
    kind === 'python'
      ? spawnSync('python3', ['-c', PY_SYNTAX_CHECK, absPath], { encoding: 'utf8', timeout: 10000 })
      : shell
        ? spawnSync(shell, ['-n', absPath], { encoding: 'utf8', timeout: 10000 })
        : kind === 'plist'
          ? spawnSync('plutil', ['-lint', absPath], { encoding: 'utf8', timeout: 10000 })
          : spawnSync(process.execPath, ['--check', absPath], { encoding: 'utf8', timeout: 10000 });

  // 検査する道具が無い・動かせないときは黙る。
  // 「検査できなかった」を「壊れている」と伝えると、直っているものを直させることになる。
  if (!result || result.error || result.status === null || result.status === 0) return '';

  const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (!out) return '';
  return (
    `\n\n[syntax check failed]\n${out.slice(0, 800)}\n` +
    'The file you just wrote does not parse. Fix it before moving on.'
  );
}

/**
 * シェルの種類ごとに、構文を見てもらう相手。
 *
 * 入っていない本体を指したときは spawnSync が error を返し、呼び出し側が黙って通す
 * （「検査できなかった」を「壊れている」と伝えない、というこのファイルの方針どおり）。
 */
const SHELL_CHECKERS = { sh: 'sh', bash: 'bash', zsh: 'zsh' };

/**
 * shebang の行から、実際に動かす本体の名前を取り出す。
 *
 * `#!/usr/bin/env bash` の形があるので、`env` のときは次の語を見る
 * （`-S` のような旗と `FOO=1` の形の代入は読み飛ばす）。
 */
function shebangCommand(head) {
  const m = /^#!([^\n]*)/.exec(head);
  if (!m) return '';
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const base = (w) => w.slice(w.lastIndexOf('/') + 1);
  let name = base(words[0]);
  if (name === 'env') {
    const next = words.slice(1).find((w) => !w.startsWith('-') && !w.includes('='));
    name = next ? base(next) : '';
  }
  return name;
}

/** 構文検査のしかた。拡張子で決まらないものは shebang で見る */
function syntaxKindOf(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.py') return 'python';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'node';
  if (ext === '.json') return 'json';
  if (ext === '.sh') return 'sh';
  if (ext === '.bash') return 'bash';
  if (ext === '.zsh') return 'zsh';
  if (ext === '.plist') return 'plist';
  // ここに無いもの（.ts .toml .yaml .yml など）は見ない。
  // TypeScript は `node --check` が読めず、TOML と YAML は Node に読み手が無い。
  // 外の道具を入れれば見られるが、qwc は依存ゼロで通しているので、
  // **見られないものは黙って見ない**。「検査した」と誤解させないほうがよい。
  if (ext) return null;

  let head = '';
  try {
    const fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(80);
    const n = fs.readSync(fd, buf, 0, 80, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  }
  const name = shebangCommand(head);
  if (/^python[\d.]*$/.test(name)) return 'python';
  if (name === 'node') return 'node';
  if (name === 'bash') return 'bash';
  if (name === 'zsh') return 'zsh';
  if (name === 'sh' || name === 'dash') return 'sh';
  return null;
}

/**
 * JSON が壊れていないか。
 *
 * ■ コメント付き（JSONC）で誤報を出さない
 *   `tsconfig.json` や `.eslintrc.json` はコメント入りが普通で、そのまま JSON.parse すると必ず落ちる。
 *   落ちたときだけコメントを外してもう一度試し、**それで通るなら壊れていない**と見る。
 *   最初から外さないのは、外す処理そのものが壊す可能性を残さないため。
 *
 * ■ 文字列の中の // を消さない
 *   `{"url": "https://example.com"}` のような値がある。素朴に消すと、正しい JSON を壊して
 *   「壊れています」と報告することになる。文字列の中かどうかを見ながら進む。
 */
function jsonSyntaxCheck(absPath) {
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
  if (!text.trim()) return '';
  try {
    JSON.parse(text);
    return '';
  } catch (err) {
    try {
      JSON.parse(stripJsonComments(text));
      return '';
    } catch {
      return (
        `\n\n[syntax check failed]\n${String(err.message).slice(0, 300)}\n` +
        'The file you just wrote is not valid JSON. Fix it before moving on.'
      );
    }
  }
}

/** JSON からコメントだけを外す。文字列の中は触らない */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 構文解析だけして、駄目なら1行で理由を出す（中身は実行しない） */
const PY_SYNTAX_CHECK = [
  'import ast, sys',
  'try:',
  '    ast.parse(open(sys.argv[1], encoding="utf-8").read())',
  'except SyntaxError as e:',
  '    print(f"{e.msg} (line {e.lineno})")',
  '    sys.exit(1)',
  'except Exception:',
  '    sys.exit(0)'
].join('\n');

export function runAfterEdit(absPath, ctx) {
  const hooks = loadHooks(ctx.root);
  if (hooks.__error) return `\n\n[${hooks.__error}]`;

  const command = typeof hooks.afterEdit === 'string' ? hooks.afterEdit.trim() : '';
  // 決めごとが無いフォルダでも、**構文だけは**見る。
  if (!command) return builtinSyntaxCheck(absPath);

  const relative = path.relative(ctx.root, absPath) || path.basename(absPath);
  const result = spawnSync(command, {
    shell: true,
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: Math.min(ctx.config?.commandTimeoutMs ?? 120000, 120000),
    // コマンド側は $QWC_FILE で対象を受け取る。
    // 引数で渡す形にすると、シェルの引用符の扱いを利用者に押しつけることになる。
    env: { ...process.env, QWC_FILE: absPath, QWC_FILE_RELATIVE: relative }
  });

  if (result.error) {
    return `\n\n[afterEdit hook failed to start: ${result.error.message}]`;
  }

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status === 0) {
    // 成功したときは、出力があるときだけ載せる。
    // 「整形しました」の一行を毎回積むと、そのぶん文脈を食う。
    return output ? `\n\n[afterEdit hook ok] ${output.slice(0, 600)}` : '';
  }
  return (
    `\n\n[afterEdit hook failed (exit ${result.status})]\n${output.slice(0, 2000)}\n` +
    'Fix what it reported before moving on.'
  );
}

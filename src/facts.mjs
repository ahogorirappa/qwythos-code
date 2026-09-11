// 依頼が「もう在るもの」として書いている名前が、本当に在るかを先に確かめる。
//
// ■ なぜ要るか（実機で2日続けて起きた）
//   2026-09-08、利用者が traceback を貼って「この行を直して」と頼んだ。
//   ところが traceback が指す `_typo_round_two()` は、そのファイルにも控えにも無かった。
//   モデルは自分で grep して**0件を見ている**。それでも「無い」とは言わず、
//   3回とも別のものを書き換えて「削除しました」と報告した。
//   翌日の再現では、無関係な行の `mins // 60` を `mins // 6` に変えた（本物のバグを作った）。
//
//   文章で忠告しても効かない。現物を貼って「これを写せ」と言っても3回無視し、
//   「同じ引数を4回目です」と言っても5回無視した記録がある。
//   **効くのは、事実を先に渡して、そもそも探させないこと。**
//
// ■ なぜ道具に任せないか
//   モデルは grep を呼べるし、実際に呼んでいる。呼んだうえで結果を無視する。
//   だから呼ばせるのではなく、**呼ぶ前に答えを置いておく**。
//
// ■ どこに置くか
//   利用者の発言の末尾。いちばん上の指示文は触らない（触ると会話を丸ごと読み直す）。
import { spawnSync } from 'node:child_process';

/** 一度に確かめる名前の数。多すぎると事実確認のほうが長くなる */
const MAX_NAMES = 6;

/**
 * ふつうの英単語や、traceback に必ず出てくる語は名前として扱わない。
 * ここが緩いと「function が見つかりません」のような無意味な報告が並ぶ。
 */
const STOP = new Set([
  'function', 'return', 'import', 'export', 'const', 'class', 'async', 'await',
  'error', 'Error', 'Exception', 'Traceback', 'NameError', 'TypeError', 'ValueError',
  'AttributeError', 'ImportError', 'KeyError', 'IndexError', 'SyntaxError',
  'None', 'True', 'False', 'null', 'undefined', 'self', 'this', 'args', 'kwargs',
  'print', 'line', 'File', 'module', 'python', 'node', 'npm', 'test', 'main',
  'string', 'number', 'object', 'boolean', 'result', 'value', 'data', 'name',
  // qwc 自身の語彙。利用者は道具の名前を書いて頼むことがある
  // （「edit_file を使わずに write_file で書き直して」）。これを「作業場に無い名前」として
  // 拾うと、**その依頼のあいだ書き換えが全部止まる**。実機で踏んだ。
  'read_file', 'write_file', 'edit_file', 'list_dir', 'search_files', 'run_command',
  'todo_write', 'web_search', 'web_fetch', 'find_symbol', 'spawn_agent', 'browse',
  'browser_login', 'old_string', 'new_string', 'replace_all'
]);

/**
 * 依頼文から、コードの名前らしいものを拾う。
 *
 * 拾うのは2種類だけ。
 *   1) バッククォートで囲まれたもの … 利用者が「これ」と指しているもの
 *   2) `_` か数字か大文字を含む識別子 … ふつうの英単語と見分けがつくもの
 * `foo` のような短くありふれた語は拾わない。外して困るより、
 * 無意味な事実確認を並べるほうが害が大きい。
 */
/**
 * 依頼が名指ししているファイルの場所。
 *
 * ■ なぜ識別子と別に見るか
 *   `namesInRequest` は識別子だけを拾うので、**パスだけを言われると何も確かめない**。
 *   「src/utils/helper.js のバグを直して」に識別子が無ければ、事実確認も前提の見張りも
 *   一度も働かない。実機の題材で拾えていたのは、たまたま関数名が混ざっていたからだった。
 *
 * ■ 拾う形
 *   `/` を含むか、拡張子が付いているもの。URL は除く（外の話なので作業場には無くて当然）。
 */
export function pathsInRequest(text) {
  const t = String(text ?? '');
  const out = [];
  const add = (raw) => {
    const p = String(raw).replace(/[。、,.:;)\]]+$/, '').trim();
    if (!p || p.length > 200) return;
    if (/^[a-z]+:\/\//i.test(p)) return;            // URL は見ない
    // スラッシュを含むか、**英字の拡張子**が付いているもの。
    // 以前は拡張子を [A-Za-z0-9] で見ていたので、`0.3` が
    // 「拡張子 3 のファイル」として通っていた（実測 2026-09-10）。
    // 数字だけの幹（0.3・1.5 など）は値であってファイルではない。
    const 拡張子つき = /^[\w.\-~]+\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(p) && !/^[\d.]+$/.test(p);
    if (!/[/\\]/.test(p) && !拡張子つき) return;
    if (!/^[\w./\-~]+$/.test(p)) return;
    if (out.length < MAX_NAMES && !out.includes(p)) out.push(p);
  };
  for (const m of t.matchAll(/`([^`\n]{1,200})`/g)) add(m[1]);
  for (const m of t.matchAll(/(?:^|[\s"'(（])([\w.\-~]+(?:\/[\w.\-~]+)+(?:\.[A-Za-z0-9]{1,6})?)/gm)) add(m[1]);
  return out;
}

/**
 * そのパスが作業場に無いか。
 *
 * **同じ名前のファイルがどこかにあれば「無い」とは言わない。**
 *   書き方が違うだけ（`src/utils/helper.js` と `utils/helper.js`）のことがあり、
 *   そこで「無い」と伝えると、在るものを無いと言うことになる。
 *   場所が違うのは、モデルが自分で探せばよい話。
 */
export function missingPaths(paths, ctx) {
  if (!paths.length) return [];
  const root = ctx?.root;
  if (!root) return null;
  let 一覧;
  try {
    const r = spawnSync('rg', ['--files', root], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
    if (!r || r.error || (r.status !== 0 && r.status !== 1)) return null;
    一覧 = String(r.stdout || '').split('\n').filter(Boolean);
  } catch {
    return null;
  }
  const 名前だけ = new Set(一覧.map((f) => f.slice(f.lastIndexOf('/') + 1)));
  return paths.filter((p) => {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (名前だけ.has(base)) return false;                       // 同じ名前がどこかにある
    return !一覧.some((f) => f.endsWith(`/${p}`) || f === p);   // 末尾一致でも見つからない
  });
}

export function namesInRequest(text) {
  const t = String(text ?? '');
  const found = [];
  const add = (raw) => {
    const n = String(raw).replace(/\(\)$/, '').trim();
    if (!n || n.length < 3 || n.length > 60) return;
    if (STOP.has(n)) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return;
    if (!found.includes(n)) found.push(n);
  };

  // 1) バッククォートで囲まれたもの。利用者が「これ」と指している。
  for (const m of t.matchAll(/`([^`\n]{1,60})`/g)) add(m[1]);

  // 2) 括弧つきの呼び出し。`foo()` は名前だと分かる。
  for (const m of t.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(\)/g)) add(m[1]);

  // 3) traceback / スタックトレースの、**名前が来ると決まっている位置**から拾う。
  //
  // ■ 語の形で拾ってはいけない
  //   以前は「`_` か数字を含む、または camelCase」という条件だった。
  //   その形だと、ふつうの技術語がぜんぶ通る。実測で8件中7件が誤爆した（2026-09-10）。
  //     「この JavaScript を macOS 用に直して」／「utf8 の扱いがおかしい」
  //     「Python3 で動かない」／「arg1 と arg2 の順番が逆」
  //   作業場に無いのは当たり前なので前提の見張りが立ち、`-p` では書き換えが却下される。
  //   **ふつうの依頼が通らなくなる。**
  //
  // ■ 語彙の一覧では解けない
  //   STOP に足しても切りがない。技術語は無限にある。
  //
  // ■ 行の中を全部さらうのも駄目
  //   「機械が出した行だけ見る」に変えても、`Traceback (most recent call last)` から
  //   most・recent・call・last を拾ってしまう。定型文まで名前として報告することになる。
  //
  // ■ だから「その位置に来るのは名前だと決まっている」形だけを見る
  //   どれも機械が出す文言で、人が書く地の文には現れない。
  //
  // ■ 位置を増やすのは、誤爆と引き換えではない（2026-09-11 に測った）
  //   位置ベースに絞ったとき、見ていたのは誤爆だけで、取りこぼしを測っていなかった。
  //   題材24件（機械の文言8・日本語の言い換え8・英語の言い換え8）で測ると、
  //   **19件を取りこぼしていた。** 日本語の言い換えは 0/8、英語の言い換えも 0/8 で、
  //   traceback をそのまま貼った場合しか効いていなかった。
  //
  //   取りこぼしを決めるのは「**名前が来ると決まっている位置をいくつ知っているか**」、
  //   誤爆を決めるのは「**地の文に語の形を当てているかどうか**」で、**別の機構**。
  //   だから位置を足しても誤爆は増えない。実測: 下の2つを足して
  //   取りこぼし 19→8、書き換えが誤って止まる件数は 3/23 のまま変わらず。
  const 名前の位置 = [
    /name '([A-Za-z_][A-Za-z0-9_]*)' is not defined/g,          // Python NameError
    /has no attribute '([A-Za-z_][A-Za-z0-9_]*)'/g,             // Python AttributeError
    /\.([A-Za-z_][A-Za-z0-9_]*) is not a function/g,            // JS TypeError
    /^\s*at ([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,                   // JS スタックフレーム
    /,\s*line \d+,\s*in ([A-Za-z_][A-Za-z0-9_]*)/g,             // Python フレーム

    // 「X is not defined」の裸形。**JS の ReferenceError はこの形**で、
    // 上の Python 用（name 'X' is not defined）には当たらない。
    // 英語で言い換えられたとき（"calc_total is not defined, please fix"）もここで拾う。
    // 地の文の語を巻き込まないのは、`is not defined` が直後に要るため。
    // 「this/it/the function is not defined」は STOP と長さで落ちる。
    /\b([A-Za-z_][A-Za-z0-9_]*)\s+is not defined\b/g,

    // 決まった例外名のあとに、引用符でくくられた名前が来る形。
    //   KeyError: 'user_id' / ImportError: cannot import name 'parse_config' from …
    // 例外名を先に要求するので、ふつうの文中の引用符は拾わない。
    /(?:KeyError|ImportError|ModuleNotFoundError|cannot import name|no attribute)[^\n'"]{0,40}['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g
  ];
  for (const re of 名前の位置) {
    for (const m of t.matchAll(re)) add(m[1]);
  }

  return found.slice(0, MAX_NAMES);
}

/**
 * その名前が作業場のどこかに在るかを、1回の走査で確かめる。
 * 走査できないとき（rg が無い・失敗した）は **null** を返す。
 * 「確かめられなかった」を「無い」と言うと、在るものを無いと伝えることになる。
 */
export function missingNames(names, ctx) {
  if (!names.length) return [];
  const missing = [];
  for (const n of names) {
    // **名前ごとに1回ずつ引く。**
    // まとめて `-e A -e B` で引いて `--max-count 1` を付けると、
    // 上限が「ファイルあたりの一致数」なので、同じファイルで先に当たった名前しか出てこない。
    // 実際それで「在るもの」を「無い」と報告した（bin-原本 で `_typo_round_two` を取りこぼした）。
    const r = spawnSync('rg', ['--quiet', '--fixed-strings', '--', n, ctx.root], {
      cwd: ctx.root, encoding: 'utf8', timeout: 10000
    });
    // rg が無い・落ちた・打ち切られた → 確かめられていないので、何も言わない
    if (!r || r.error || r.status === null) return null;
    if (r.status === 1) missing.push(n);
    else if (r.status !== 0) return null;
  }
  return missing;
}

/**
 * 依頼の末尾に添える事実。無いものが1つも無ければ空文字（何も足さない）。
 *
 * **「手を止めろ」とは書かない。** 作るように頼まれている場合は無くて当然で、
 * そこで止めると新規作成ができなくなる。書くのは事実と、
 * 「無いものを直したことにするな」の一点だけ。
 */
export function factsHint(missing) {
  if (!missing || !missing.length) return '';
  const lines = missing.map((n) => `  \`${n}\` … この作業場のどのファイルにも見つかりません`);
  return (
    '\n\n[事実確認：作業を始める前に、この作業場を検索した結果です]\n' +
    `${lines.join('\n')}\n` +
    'これらが「すでに在るもの」として書かれているなら、その前提が誤っています。\n' +
    '無いものを直したことにせず、無いと伝えてください。' +
    '新しく作るよう頼まれている場合は、いつもどおり作って構いません。'
  );
}

/**
 * その依頼は、名前を「もう在るもの」として書いているか。
 *
 * ■ なぜ要るか
 *   「`totalWithDiscount` を追加して」も「`_typo_round_two` を削除して」も、
 *   名前が作業場に無いという事実は同じ。**違うのは、無くて当たり前かどうか。**
 *   ここを見分けないと、**新規追加が全部止まる**（実際に止めてしまった）。
 *
 * ■ 迷ったら「作る側」に倒す
 *   在る前提だと誤れば、書き換えに確認が1回増えるだけ。
 *   作る側だと誤れば、**頼んだ作業がそもそも実行されない**。損害が釣り合っていない。
 */
export function treatsAsExisting(text) {
  const t = String(text ?? '');
  // これから作る言い方が1つでもあれば、在る前提とは見ない
  const 作る =
    /(追加|新規|新しく|作って|作成|つくって|実装|導入|足して|加えて|生やして|\badd\b|\bcreate\b|\bimplement\b|\bintroduce\b)/i;
  if (作る.test(t)) return false;
  // 「もう在って、それが壊れている」と言っている印
  const 在る =
    /(直して|なおして|修正|削除|消して|取り除|落ちて|落ちる|エラー|例外|バグ|動かな|直せ|Traceback|Error:|Exception|\bfix\b|\bremove\b|\bdelete\b|\bcrash|\bfail)/i;
  return 在る.test(t);
}

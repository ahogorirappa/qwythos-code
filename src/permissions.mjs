// 「書き換え」「コマンド実行」の前に人へ確認をとる仕組み。
import { c, line, out } from './ui.mjs';

/**
 * 危険な連結が含まれていない、素直な読み取り専用コマンドかを見る。
 *
 * 確認をとるかどうか（PermissionManager）と、
 * 計画モードで実行してよいかどうか（tools.mjs）の両方から使うので、
 * 判断は1箇所にだけ置く。片方だけ緩いと、そこが穴になる。
 */
export function isSafeCommand(command, config) {
  const cmd = String(command).trim();
  if (/[;&|><`]|\$\(/.test(cmd)) return false;
  return (config.safeCommands || []).some((prefix) => {
    if (cmd === prefix) return true;
    return cmd.startsWith(`${prefix} `);
  });
}

export class PermissionManager {
  constructor(config, ask) {
    this.config = config;
    this.ask = ask;                 // (question) => Promise<string>
    this.alwaysAllow = new Set();   // このセッション中ずっと許可するもの
    this.denied = 0;
  }

  get autoApprove() {
    return Boolean(this.config.autoApprove);
  }

  set autoApprove(v) {
    this.config.autoApprove = Boolean(v);
  }

  // 危険な連結が含まれていない、素直な読み取り専用コマンドかを見る
  isSafeCommand(command) {
    return isSafeCommand(command, this.config);
  }

  key(toolName, args) {
    if (toolName === 'run_command') {
      const first = String(args.command || '').trim().split(/\s+/).slice(0, 2).join(' ');
      return `run_command:${first}`;
    }
    return `${toolName}`;
  }

  async request({ toolName, args, title, preview }) {
    if (this.autoApprove) return { granted: true, reason: 'auto' };

    const key = this.key(toolName, args);
    if (this.alwaysAllow.has(key)) return { granted: true, reason: 'remembered' };

    line();
    line(`${c.brightYellow('┌')} ${c.bold('確認')} ${c.gray(title)}`);
    if (preview) {
      for (const l of preview.split('\n')) line(`${c.brightYellow('│')} ${l}`);
    }
    line(`${c.brightYellow('└')} ${c.gray('y = 実行 / n = やめる / a = 以後このセッションは同種を自動許可')}`);

    for (;;) {
      const raw = await this.ask(`${c.brightYellow('  →')} [y/n/a] `);
      if (raw === null || raw === undefined) {
        // 入力が閉じた（Ctrl+D など）ときは「やめる」扱いにする
        this.denied++;
        return { granted: false, reason: 'closed' };
      }
      const answer = String(raw).trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') {
        return { granted: true, reason: 'user' };
      }
      if (answer === 'a' || answer === 'always') {
        this.alwaysAllow.add(key);
        return { granted: true, reason: 'always' };
      }
      if (answer === 'n' || answer === 'no') {
        this.denied++;
        return { granted: false, reason: 'user' };
      }
      out(c.gray('  y / n / a のどれかを入力してください。\n'));
    }
  }
}

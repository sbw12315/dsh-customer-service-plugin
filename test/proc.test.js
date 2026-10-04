import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFailure, firstLine, lastJsonObject, runCli, scanJsonValues, spawnHint } from '../lib/proc.js';

/** 造一个假 subprocess 服务。 */
function fakeSubprocess(result) {
  const calls = [];
  return {
    calls,
    service: {
      spawn(spec) {
        calls.push(spec);
        if (result instanceof Error) throw result;
        return {
          done: Promise.resolve({ exitCode: result.code, signal: result.signal ?? null }),
          collected: {
            stdout: { readFrom: () => ({ text: result.stdout ?? '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: result.stderr ?? '', nextOffset: 0, lossy: false }) },
          },
        };
      },
    },
  };
}

/** 把假服务包成 ctx。 */
const ctxWith = (service) => ({ get: (key) => (key === 'subprocess' ? service : undefined) });

test('scanJsonValues 能在混杂文本里挑出所有平衡的 JSON', () => {
  const text = 'noise {"a":1} more [2,3] tail {"b":{"c":"}"}} end';
  const values = scanJsonValues(text).map((entry) => entry.value);
  assert.deepEqual(values, [{ a: 1 }, [2, 3], { b: { c: '}' } }]);
});

test('scanJsonValues 忽略字符串里的括号与转义引号', () => {
  const values = scanJsonValues('{"s":"}{\\"x","n":1}').map((entry) => entry.value);
  assert.deepEqual(values, [{ s: '}{"x', n: 1 }]);
});

test('lastJsonObject 取最后一个对象，跳过数组', () => {
  assert.deepEqual(lastJsonObject('[1,2] {"a":1}'), { a: 1 });
  assert.equal(lastJsonObject('nothing here'), null);
});

test('firstLine 取第一个非空行', () => {
  assert.equal(firstLine('\n\n  hello \nworld'), 'hello');
  assert.equal(firstLine(''), '');
});

test('lark 的 stderr 里有非 JSON 前缀时仍能取到错误信封', () => {
  const stderr = [
    "[lark-cli] [WARN] uat-client: failed to remove token: operation not permitted",
    'tip: run "lark-cli mail user_mailboxes profile" to confirm your email identity',
    '{"ok":false,"identity":"user","error":{"type":"authentication","subtype":"token_missing",',
    '  "message":"API call failed: need_user_authorization","hint":"run: lark-cli auth login",',
    '  "missing_scopes":["mail:user_mailbox.message:readonly"]}}',
  ].join('\n');
  const error = lastJsonObject(stderr).error;
  assert.equal(error.type, 'authentication');
  assert.equal(error.subtype, 'token_missing');
});

test('classifyFailure：飞书认证失败 → auth + 重新授权命令', () => {
  const stderr =
    '{"ok":false,"error":{"type":"authentication","subtype":"token_missing","message":"need_user_authorization","hint":"run: lark-cli auth login"}}';
  const result = classifyFailure({ name: 'lark', code: 3, stdout: '', stderr });
  assert.equal(result.kind, 'auth');
  assert.equal(result.fixCommand, 'lark-cli auth login --domain mail');
  assert.equal(result.message, 'need_user_authorization');
});

test('classifyFailure：飞书 exit 10 是同意门，不是错误，且不给修复命令', () => {
  const stderr =
    '{"ok":false,"error":{"type":"confirmation","subtype":"confirmation_required","message":"add --yes to confirm"}}';
  const result = classifyFailure({ name: 'lark', code: 10, stdout: '', stderr });
  assert.equal(result.kind, 'confirmation');
  assert.equal(result.fixCommand, null);
});

test('classifyFailure：飞书参数校验 exit 2 → validation', () => {
  const stderr = '{"ok":false,"error":{"type":"validation","subtype":"invalid_argument","message":"unknown flag"}}';
  assert.equal(classifyFailure({ name: 'lark', code: 2, stdout: '', stderr }).kind, 'validation');
});

test('classifyFailure：ziniao 未配置的纯文本错误也要识别出来', () => {
  const result = classifyFailure({
    name: 'ziniao',
    code: 1,
    stdout: '',
    stderr: 'Error: 未找到配置文件，请先执行 ziniao-cli config init\n',
  });
  assert.equal(result.kind, 'auth');
  assert.equal(result.fixCommand, 'ziniao-cli config init');
  assert.match(result.message, /未找到配置文件/);
});

test('classifyFailure：ziniao 未登录 → 只能用 zclaw login', () => {
  const result = classifyFailure({
    name: 'ziniao',
    code: 1,
    stdout: '',
    stderr: 'Ziniao user is not logged in\n',
  });
  assert.equal(result.kind, 'auth');
  assert.equal(result.fixCommand, 'ziniao-cli zclaw login');
});

test('classifyFailure：ziniao Bridge 不通 → network + doctor', () => {
  const stderr = '{"ok":false,"error":{"type":"network","message":"127.0.0.1:9481 连接失败"}}';
  const result = classifyFailure({ name: 'ziniao', code: 1, stdout: '', stderr });
  assert.equal(result.kind, 'network');
  assert.equal(result.fixCommand, 'ziniao-cli doctor');
});

test('classifyFailure：超时单独成类，且不给修复命令', () => {
  const result = classifyFailure({ name: 'lark', code: null, stdout: '', stderr: '', timedOut: true });
  assert.equal(result.kind, 'timeout');
  assert.equal(result.fixCommand, null);
});

test('runCli：没有指定 CLI 路径时给出可操作的配置错误，且不启动子进程', async () => {
  const fake = fakeSubprocess({ code: 0, stdout: '' });
  const result = await runCli(ctxWith(fake.service), { name: 'lark', cli: '   ', args: ['--version'], cwd: '/tmp' });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'config');
  assert.equal(fake.calls.length, 0);
});

test('runCli：cwd 不存在时给出可读错误，而不是让子进程报 ENOENT', async () => {
  const fake = fakeSubprocess({ code: 0, stdout: '' });
  const result = await runCli(ctxWith(fake.service), {
    name: 'ziniao',
    cli: '/usr/bin/ziniao-cli',
    args: ['--version'],
    cwd: '/definitely/not/a/real/dir/for-tests',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'config');
  assert.match(result.error.message, /工作目录不存在/);
  assert.equal(fake.calls.length, 0);
});

test('runCli：宿主没有 subprocess 时明确降级，而不是抛异常', async () => {
  const result = await runCli(
    { get: () => undefined },
    { name: 'lark', cli: '/usr/bin/lark-cli', args: ['--version'], cwd: '/tmp' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.unavailable, true);
  assert.equal(result.error.kind, 'unavailable');
});

test('runCli：argv[0] 必须是可执行文件本身，参数跟在后面', async () => {
  const fake = fakeSubprocess({ code: 0, stdout: '{"ok":true}\n' });
  const result = await runCli(ctxWith(fake.service), {
    name: 'lark',
    cli: '/opt/homebrew/bin/lark-cli',
    args: ['mail', '+triage', '--max', '50'],
    cwd: '/tmp',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls[0].argv, [
    '/opt/homebrew/bin/lark-cli',
    'mail',
    '+triage',
    '--max',
    '50',
  ]);
});

test('runCli：成功路径解析 stdout 信封，并把 env 覆盖交给子进程', async () => {
  const fake = fakeSubprocess({ code: 0, stdout: '{"ok":true,"data":{"count":2}}\n' });
  const result = await runCli(ctxWith(fake.service), {
    name: 'lark',
    cli: '/usr/bin/lark-cli',
    args: ['mail', '+triage'],
    cwd: '/tmp',
    env: { PATH: '/usr/bin', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.json.data.count, 2);
  assert.equal(result.error, null);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].argv, ['/usr/bin/lark-cli', 'mail', '+triage']);
  assert.equal(fake.calls[0].env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, '1');
  assert.equal(fake.calls[0].cwd, '/tmp');
  assert.equal(fake.calls[0].stdio.stdin, 'ignore');
});

test('runCli：非零退出码带上分类后的错误', async () => {
  const fake = fakeSubprocess({ code: 3, stderr: '{"ok":false,"error":{"type":"authentication","message":"expired"}}' });
  const result = await runCli(ctxWith(fake.service), {
    name: 'lark',
    cli: '/usr/bin/lark-cli',
    args: ['mail', '+triage'],
    cwd: '/tmp',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.equal(result.error.kind, 'auth');
  assert.equal(result.error.fixCommand, 'lark-cli auth login --domain mail');
});

test('spawnHint 对 ENOENT 给出三条具体方向，而不是笼统的「检查路径」', () => {
  const hint = spawnHint('spawn /x/ziniao-cli ENOENT', ['/x/ziniao-cli', '--version']);
  assert.match(hint, /\/x\/ziniao-cli/);
  assert.match(hint, /node/);
  assert.match(hint, /可执行权限/);
});

test('spawnHint 区分权限问题', () => {
  const hint = spawnHint('spawn EACCES', ['/x/lark-cli']);
  assert.match(hint, /chmod \+x/);
});

test('spawnHint 对未知错误给出兜底文案并带上目标路径', () => {
  const hint = spawnHint('something odd', ['/x/y']);
  assert.match(hint, /\/x\/y/);
});

test('runCli：spawn 同步抛异常时被包成 spawn 错误', async () => {
  const fake = fakeSubprocess(new Error('ENOENT'));
  const result = await runCli(ctxWith(fake.service), {
    name: 'ziniao',
    cli: '/usr/bin/ziniao-cli',
    args: ['--version'],
    cwd: '/tmp',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'spawn');
  assert.match(result.error.message, /ENOENT/);
  assert.match(result.error.hint, /找不到可执行文件/);
});

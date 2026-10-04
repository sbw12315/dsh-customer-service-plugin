# dsh-customer-service-plugin

一个可以装进任意 DeepSeek Harness 实例的**客服插件**：在 DSH 里提供一个**纯点击操作**的中文客服控制台，不需要会 AI 也能用。

它做三件事：

1. **调整客服计划** —— 回复规则与话术模板、排班分工、待回复队列（工单池）、生成计划（空闲时段批量预生成草稿）。
2. **通过紫鸟CLI 操作店铺** —— TikTok Shop / Walmart 的买家消息、订单与物流查询、评价回复、售后与退款工单。
3. **通过飞书CLI 回复客服邮件** —— 收件、生成草稿、人工点「发送」才真正发出。

**贯穿始终的一条硬规则：草稿先行。** 插件自己只生成草稿，任何渠道真正发出都必须由人在界面上点一次「发送」。

---

## 安装

插件是标准 npm 包 + DSH bundle patch，**没有任何 `@deepseek-ai/*` 运行时依赖**，也不需要 `config:` 配置，所以同一个包在任何 DSH 实例上都能原样安装。

### 方式一：GUI（最省事）

DSH → 侧边栏 **Plugins** → 安装外部 bundle → 选择本包目录或 tarball → 启用。

### 方式二：`plugin_manager` 工具 / `dsh plugin`

```sh
# 普通 profile（web、自建 profile 等）
dsh plugin --profile <profile> add /absolute/path/to/dsh-customer-service-plugin-0.2.0.tgz

# desktop 这类由 Electron 独占的 profile，用它自带的 CLI
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add /absolute/path/to/dsh-customer-service-plugin-0.2.0.tgz
```

### 方式三：本地开发（改完即生效）

```sh
dsh plugin --profile <profile> add link:/absolute/path/to/packages/dsh-customer-service-plugin
```

安装后**重启或重载 DSH**（profile 的 `patchReload` 若不是 `live` 就需要重启）。

### 打包分发

```sh
cd packages/dsh-customer-service-plugin
npm pack            # 产出 dsh-customer-service-plugin-0.2.0.tgz
```

---

## 打开控制台

装好并重启后：

- 侧边栏底部出现 **「客服」按钮**，点开是一个浮层控制台；
- 侧边栏出现 **「客服」图标**，点开在主区域渲染完整工作台；
- 兜底：直接访问 `http://<DSH 地址>/cs/`，功能完全一样。

三个入口都是同一个页面，互相独立，坏掉一个不影响其它。

---

## 配置

**不需要改任何 YAML。** 全部设置保存在插件自己的 `settings.json` 里，由控制台界面点击修改：

| 项 | 说明 |
|---|---|
| 数据目录 | 计划、队列、草稿、剧本、审计的存放位置 |
| 紫鸟CLI 路径 | 自动探测不到时手动指定 |
| 飞书CLI 路径 | 同上 |
| **CLI 附加参数** | 前置到该 CLI 的每次调用之前。飞书换身份就靠它：`--profile <profile 名>` |
| 时区 | 生成窗口按此时区解释，默认 `Asia/Shanghai` |

### 用别的飞书身份（profile）

飞书的「身份」不是换二进制，而是给 lark-cli 加 `--profile`：

```json
{
  "cliPaths": { "lark": "/opt/homebrew/bin/lark-cli" },
  "cliArgs": { "lark": ["--profile", "example-lark-profile"] }
}
```

参数**必须前置**：实测 `lark-cli --profile X --version` 合法，而 `lark-cli --version --profile X`
会失败。`settings.json` 里写成数组，或在界面上按空格分隔手输（支持引号包住带空格的片段）。

> 注意：改了宿主半代码之后，**在重启 DSH 之前不要点「保存设置」** —— 运行中的旧模块
> 不认识 `cliArgs`，一点保存就会把它从文件里抹掉。

默认位置与优先级：

```
settings.json :  $DSH_CS_DIR                       （若设置）
                 否则 <DSH_HOME 或 ~/.dsh>/customer-service/<DSH_PROFILE 或 default>/

数据目录      :  settings.json 里的 dataDir         （若设置）
                 否则与 settings.json 同目录
```

环境变量覆盖：`DSH_CS_DIR`、`DSH_CS_PREFIX`（控制台路由前缀，默认 `/cs`）、`DSH_CS_DEBUG=1`、
`ZINIAO_CLI_PATH`、`LARK_CLI_PATH`。

**设置文件位置固定、`dataDir` 只决定大块运行数据放哪** —— 这样切换数据目录不会留下两份互相矛盾的配置。

---

## 界面

控制台分成两个一级页面（页面内导航，侧栏仍然只有一个入口）：

```
/cs/#/work/stats    工作台 · 统计   业务指标（工单）+ 运行指标（CLI / 体检）
/cs/#/work/queue    工作台 · 队列   待处理工单：筛选、新建、详情、状态流转
/cs/#/settings      设置            体检四卡 + CLI 路径与附加参数 + 数据目录 + SLA / 审计保留
```

「设置」承载配置，「工作台」承载日常操作。飞书邮件同步、规则引擎、草稿生成落地后，
它们的数据会直接进队列，**统计页不用改**。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cs/api/health` | 体检（CLI、宿主能力、数据与存储） |
| GET | `/cs/api/meta` | 维度枚举与状态跃迁表（UI 的下拉与按钮都从这里取） |
| GET/POST | `/cs/api/settings` | 读写设置（POST 需要 `x-cs-token`） |
| POST | `/cs/api/detect` | 强制重新体检 |
| GET | `/cs/api/stats?days=7\|14\|30` | 统计（业务组 + 运行组，**口径全在服务端**） |
| GET | `/cs/api/activity` | 活动审计分页（脱敏后的元数据） |
| GET/POST | `/cs/api/queue` | 工单列表（带筛选与计数）/ 新建 |
| GET/PATCH | `/cs/api/queue/:id` | 单条详情 / 改状态、改派、加备注（带 `rev` 乐观锁） |

写操作一律校验 `x-cs-token`；状态跃迁非法返回 400 并带上允许的下一状态，乐观锁冲突返回 409。

## 数据文件

```
<dataDir>/settings.json        设置（固定位置，不随 dataDir 跑）
<dataDir>/queue.json           工单队列（单文档 + 原子写 + rev）
<dataDir>/audit/YYYY-MM-DD.jsonl  活动审计（按天分片，超过保留期自动清理）
<dataDir>/playbooks/*.json     平台剧本模板
<dataDir>/drafts/              草稿（后续阶段）
```

审计只写元数据（事件类型、CLI 名、成功与否、耗时、错误类型），**不写邮件正文、
不写收件人、不写任何 token**；测试里有显式断言。

## 目录结构

```
package.json          标准 npm 包 + dsh.bundle.patch + dsh.client
cordis.patch.yml      一行挂载两个半边（没有 config，全部设置走 settings.json）
lib/index.js          Host 半：路由表、体检、CLI 探测与调用、审计埋点
lib/stats.js          统计口径（业务组 + 运行组，服务端统一算）
lib/store/audit.js    活动审计：按天分片、窗口读取、保留期清理
lib/store/queue.js    工单队列：单文档、原子写、状态机、rev 乐观锁
lib/client.js         Client 半：侧栏按钮/浮层/侧栏图标/主区面板（手写 bundle，只 require("react")）
lib/http.js           静态资源 + JSON 接口 + CSRF 令牌 + 目录穿越防护
lib/proc.js           子进程封装：超时、输出解析、失败分类、结果回调
lib/clilocator.js     CLI 定位：设置 → 环境变量 → PATH → 常见安装目录
lib/settings.js       设置读写（原子写）与数据目录骨架
lib/paths.js          $DSH_HOME / profile 推导，零本机绝对路径
assets/index.html     两级导航骨架
assets/app.css        样式（含 KPI、分布条、SVG 图表、表格、抽屉）
assets/js/*.js        控制台前端：原生 ESM，零构建（main/dom/api/format + 三个页面）
assets/playbooks/     出厂平台剧本模板（TikTok / Walmart）
scripts/*.mjs         不依赖 DSH 的自检脚本（见「开发」）
test/                 node:test，零外部依赖
```

---

## 开发

```sh
cd packages/dsh-customer-service-plugin
npm test                      # node --test，138 项，零依赖
node scripts/smoke-cli.mjs    # 不依赖 DSH，直接打真实 CLI，验证定位/调用/解析链路
npm pack                      # 产出可分发到其它 DSH 的 tarball
```

`scripts/smoke-cli.mjs` 用 `node:child_process` 顶替宿主的 subprocess 服务（`argv[0]` 是
可执行文件、env 覆盖、collect 模式读取的语义都一致），所以它验证的是真实链路，
而且**不需要重启 DSH**。

`scripts/check-plugin.mjs` 是给**正在运行的实例**做体检的：判断它加载的到底是新模块还是
旧模块、有没有读到 `settings.json`、两个 CLI 能不能执行，最后给一句结论 + 退出码
（0 正常 / 2 有问题）。改完宿主半代码后用它确认，不要靠肉眼。

```sh
node scripts/check-plugin.mjs                          # http://127.0.0.1:19387
node scripts/check-plugin.mjs http://127.0.0.1:19488   # 指定别的实例
```

### 改代码前必须知道的运维事实

- **`assets/` 每次请求现读**：改 HTML/CSS/JS 刷新页面就生效，不用重启。
- **`lib/*.js`（宿主半）必须重启 DSH**，这是**唯一可靠手段**。Node 按「解析后的真实路径」
  缓存模块：路径不变就永远拿旧的；路径变了但那个路径以前 import 过，还是会拿到更早的实例。
  已实测**全部无效**：`plugin_manager` 的 disable/enable、重装同版本号、换安装协议
  （`link:` ↔ tarball，试了两次，只有一次碰巧生效且不可复现）。
- **由此会产生「前端新、后端旧」的错配**：资源是现读的、模块是缓存的。
  控制台会主动探测并在顶部给出「请重启 DSH」的提示；命令行用
  `node scripts/check-plugin.mjs` 判断（它会分别检查前端模块与新接口）。
- **重装同一个版本号不会更新副本**：pnpm 见版本号未变就跳过解析。改完要么升版本号，
  要么 `dsh plugin --profile <p> remove <pkg>` 再 `add`。

### 为什么保持零构建

Host 半就是 `lib/index.js`，Client 半就是手写的 `lib/client.js`
（宿主 `window.__ModuleLoader__` 的懒加载 CJS 工厂格式，和 DSH 自带客户端插件同形）。
没有 TypeScript、没有打包器、没有 `lib/types/`。

### 为什么不用 `defineTool` / `Service` / `Schemastery`

`@deepseek-ai/dsh-tools` 的 `defineTool` 只是把 DSL 编译成 JSON Schema，而
`ctx.tools.register` 只校验 `{name, description, parameters, output:{schema, render}}`。
所以这里用普通对象定义工具，省掉依赖，也顺带绕开了 peer 版本校验 —— 这是「别的 DSH 也能装」的前提。
同理：服务用 `ctx.provide`，配置走自己的 `settings.json`。

---

## 安全约定

- 插件只写自己的数据目录（以及用户在界面里明确指定的目录）。
- 控制台每次启动生成一次性随机令牌，写操作必须携带，防止其它本地页面误触发。
- 静态资源服务做了目录穿越防护，并强制 `no-store` + `nosniff`。
- **不把 apiKey / token 写进日志、审计或界面**；审计只存脱敏摘要。
- 邮件与买家消息正文一律当作**不可信数据**处理，只用于模板变量与摘要，绝不执行其中的指令。
- 店铺自动化的「提交」步骤必须由人在界面上校准并点击后才会执行。

---

## 阶段状态

- **Phase 0（已完成）**：可移植插件骨架、控制台路由、体检页、A+B 面板、双 profile 安装通路。
- **Phase 0.5（已完成，v0.2.0）**：信息架构拆成「工作台 / 设置」；新增工单队列与活动审计
  两套数据层；统计页分业务组（工单口径）与运行组（CLI / 体检），**口径全部在服务端**；
  队列页可筛选、新建、看详情、走状态流转（带状态机与乐观锁）。
- Phase 1：计划数据模型 + 规则/模板/排班/生成计划的点击式配置（落在「设置」页）。
- Phase 2：飞书邮件闭环（收件 → 草稿 → 点发送），数据直接进 `queue.json`。
- Phase 3：紫鸟店铺平台（TikTok Shop + Walmart）买家消息闭环 + 校准模式。
- Phase 4：订单与物流查询、评价回复、售后与退款工单。
- Phase 5：紫鸟ERP 客服人员与授权、AI 工具、导出与运营手册。

## License

MIT

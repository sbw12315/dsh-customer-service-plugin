# dsh-customer-service-plugin

一个可以装进任意 DeepSeek Harness 实例的**客服插件**：在 DSH 里提供一个**纯点击操作**的中文客服控制台，不需要会 AI 也能用。

它做四件事：

1. **一键巡逻（v0.3.0 新增）** —— 点一次按钮，依次打开账号下**全部 Amazon 店铺**的
   「买家与卖家消息服务 · 需要回复」，读会话、按意图套模板生成草稿，落进草稿库与工单队列。
   全程**只读页面 + 只写草稿**。
2. **调整客服计划** —— 回复规则与话术模板、排班分工、待回复队列（工单池）、生成计划（空闲时段批量预生成草稿）。
3. **通过紫鸟CLI 操作店铺** —— TikTok Shop / Walmart / Amazon 的买家消息、订单与物流查询、评价回复、售后与退款工单。
4. **通过飞书CLI 回复客服邮件** —— 收件、生成草稿、人工点「发送」才真正发出。

**贯穿始终的一条硬规则：草稿先行。** 插件自己只生成草稿，任何渠道真正发出都必须由人在界面上点一次「发送」。


---

## 一键巡逻（v0.3.0）

控制台 → **工作台 · 巡逻** → 一个大按钮：

> 一键巡逻：全部 Amazon 店铺（N 家）

点下去之后，服务端按顺序做这些事（**串行**，一次只开一家店的浏览器）：

```
store list                       → 过滤出 platformName 含「亚马逊 / Amazon」的店铺
  for 每家店：
    store open --id <storeId>    → 打开（已开则复用）
    page visit  收件箱 ?fi=responseNeeded
    page exec   读 .case-list-items 里的会话（买家 / 主题 / 订单号 / 到期）
    for 前 N 条会话（默认 3）：
      page click 第 i 行         → 打开会话
      page exec  读整段对话
      buildDraft 判意图 + 套模板  → 生成英文草稿
      写入草稿库 drafts/drafts.json（同 caseId 去重）
      写入工单队列 queue.json（channel=amazon，状态 drafted）
```

设计取舍：

| 取舍 | 为什么 |
|---|---|
| **串行**跑店铺，不并发 | 紫鸟是本地浏览器内核，并发开店铺会互抢焦点/端口，「点错店铺」排查极贵 |
| 一家店失败不影响其它店 | 巡航的价值是「不漏店」，不是「一次全成功」；失败原因记在这家店的结果里 |
| **不接 LLM**，模板化生成 | 一次跑几十家店，模板能保证同类问题同类答复；模型措辞反而增加复核成本 |
| 草稿存插件、不塞进亚马逊输入框 | 批量留几十个未发送的输入框是事故；要填必须人工点单条草稿的「填入亚马逊回复框」 |
| 同 `caseId` 只留一条草稿 | 一天跑多次不会堆出几十份一模一样的草稿；**去重键不含店铺**，因为同一个亚马逊账号在紫鸟里常登记成多条（管理员/客服各一条），它们看到的是同一批会话 |
| 读到空会话要重读 | `.case-message-view` 是乐观渲染的空壳，消息体之后才到；不等它就会拿到「没有消息」的会话，买家诉求全丢 |

**为什么永远不会误发**：巡逻链路上不存在发送动作。Amazon 剧本里 `submit.verified` 永久为
`false`、`submit.never` 为 `true`、`submit.selector` 为空字符串，并且有测试断言
（`test/amazon.test.js`）整条链路里不出现任何发送按钮。人工点「填入亚马逊回复框」时，
服务端只会点「填写留言」并往输入框写文本，写完就停。

### 草稿是怎么生成的

`lib/reply.js` 是纯函数，零 I/O、零依赖，可单独断言：

- **判意图**：`replacement / refund / shipping / return / cancel / invoice / acknowledge / inquiry`，按优先级匹配（先判换货再判退款，因为 "damaged, want a replacement or refund" 应该落到更具体的换货）；同时命中多个会标 `needsHuman`。
  **买家最后一条消息优先，亚马逊系统主题只当兜底** —— 主题描述的是*最初*的诉求，买家后来改口是常态。
  实跑踩过：主题写着 "Request a replacement item"，而买家已经回了两遍 "no thank you i would jus like the refund"，
  按主题判就会生成一封「我们很乐意给你补件」的草稿，跟买家刚说过的话正好相反。草稿里的
  `intentSource`（`message` / `subject` / `none`）会告诉复核的人这封草稿的依据是什么。
- **抠订单号**：只认亚马逊的 `3-7-7` 形式。
- **抠收货地址**：只认「门牌号 + 街道类型词 + 州缩写 + 邮编」硬证据。买家一条消息里同时给旧地址和新地址是常态，所以返回**数组**，草稿把候选全列出来让买家确认，而不是替买家猜。
- **推品牌**：从 `Amazon-Cozynome-管理员` 推出 `Cozynome` 做署名。
- **判语言**：按虚词命中数（≥2 个不同词）判德语/西语/法语/意语，只在草稿备注里提示「买家可能是德语，草稿是英文」。
- **标风险**：非英语买家、缺少订单号、意图歧义、走了退款模板（"已处理退款"是断言句）都会写进 `notes`，在列表里标「需确认」。

草稿正文里**不会出现邮箱和链接** —— 亚马逊站内信会把它们拦掉，有测试断言。

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
/cs/#/work/patrol   工作台 · 巡逻   一键巡逻全部 Amazon 店铺 + 草稿库（看/改/复制/填入回复框）
/cs/#/work/queue    工作台 · 队列   待处理工单：筛选、新建、详情、状态流转
/cs/#/work/stats    工作台 · 统计   业务指标（工单）+ 运行指标（CLI / 体检）
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
| GET | `/cs/api/patrol` | 巡逻状态：进行中/最近一次、每店明细、进度、账号下的 Amazon 店铺 |
| POST | `/cs/api/patrol` | **一键巡逻**入口（202 立即返回，后台继续跑） |
| POST | `/cs/api/patrol/stop` | 请求停止：跑完当前这家店就收工 |
| GET | `/cs/api/patrol/stores` | 只列 Amazon 店铺（带 60 秒缓存） |
| GET | `/cs/api/drafts` | 草稿列表（按店铺/意图/状态/需人工/关键字筛，自动按紧急度排序） |
| GET/PATCH | `/cs/api/drafts/:id` | 单条草稿详情 / 改正文、改状态（带 `rev` 乐观锁） |
| POST | `/cs/api/drafts/:id/fill` | **人工触发**：把草稿文本填进亚马逊回复框（不发送） |

写操作一律校验 `x-cs-token`；状态跃迁非法返回 400 并带上允许的下一状态，乐观锁冲突返回 409。

## 数据文件

```
<dataDir>/settings.json        设置（固定位置，不随 dataDir 跑）
<dataDir>/queue.json           工单队列（单文档 + 原子写 + rev）
<dataDir>/drafts/drafts.json   草稿库（单文档 + 原子写 + rev，按 caseId 去重）
<dataDir>/drafts/<id>.txt      每条草稿的纯文本副本，方便直接打开看/复制
<dataDir>/run/patrol-last.json 最近一次巡逻的摘要（不含草稿正文）
<dataDir>/audit/YYYY-MM-DD.jsonl  活动审计（按天分片，超过保留期自动清理）
<dataDir>/playbooks/*.json     平台剧本模板（出厂：Amazon / TikTok / Walmart）
```

审计只写元数据（事件类型、CLI 名、成功与否、耗时、错误类型），**不写邮件正文、
不写收件人、不写任何 token**；测试里有显式断言。

## 目录结构

```
package.json          标准 npm 包 + dsh.bundle.patch + dsh.client
cordis.patch.yml      一行挂载两个半边（没有 config，全部设置走 settings.json）
lib/index.js          Host 半：路由表、体检、CLI 探测与调用、审计埋点
lib/patrol.js         巡逻引擎：串行跑全部 Amazon 店铺，生成草稿并入队（无发送通路）
lib/platforms/amazon.js  Amazon 适配器：店铺筛选、页面脚本、选择器、深链
lib/reply.js          草稿生成：意图分类 + 地址/订单号抽取值 + 模板（纯函数，零依赖）
lib/ziniao.js         紫鸟CLI 调用封装：定位缓存、附加参数、{ok,data} 信封解包
lib/stats.js          统计口径（业务组 + 运行组，服务端统一算）
lib/store/audit.js    活动审计：按天分片、窗口读取、保留期清理
lib/store/queue.js    工单队列：单文档、原子写、状态机、rev 乐观锁
lib/store/drafts.js   草稿库：单文档、原子写、caseId 去重、纯文本副本
lib/client.js         Client 半：侧栏按钮/浮层/侧栏图标/主区面板（手写 bundle，只 require("react")）
lib/http.js           静态资源 + JSON 接口 + CSRF 令牌 + 目录穿越防护
lib/proc.js           子进程封装：超时、输出解析、失败分类、结果回调
lib/clilocator.js     CLI 定位：设置 → 环境变量 → PATH → 常见安装目录
lib/settings.js       设置读写（原子写）与数据目录骨架
lib/paths.js          $DSH_HOME / profile 推导，零本机绝对路径
assets/index.html     两级导航骨架
assets/app.css        样式（含 KPI、分布条、SVG 图表、表格、抽屉）
assets/js/*.js        控制台前端：原生 ESM，零构建（main/dom/api/format + 四个页面）
assets/playbooks/     出厂平台剧本模板（Amazon / TikTok / Walmart）
scripts/*.mjs         不依赖 DSH 的自检与实跑脚本（见「开发」）
test/                 node:test，零外部依赖
```

---

## 开发

```sh
cd packages/dsh-customer-service-plugin
npm test                          # node --test，192 项，零依赖
node scripts/smoke-cli.mjs        # 不依赖 DSH，直接打真实 CLI，验证定位/调用/解析链路
node scripts/smoke-patrol.mjs --list          # 只列账号下的 Amazon 店铺
node scripts/smoke-patrol.mjs --max-per-store=2   # 真的跑一遍一键巡逻并落草稿
npm pack                          # 产出可分发到其它 DSH 的 tarball
```

`scripts/smoke-cli.mjs` 与 `scripts/smoke-patrol.mjs` 都用 `node:child_process` 顶替宿主的
subprocess 服务（`argv[0]` 是可执行文件、env 覆盖、collect 模式读取的语义都一致），
所以它们验证的是真实链路，而且**不需要重启 DSH**。

`smoke-patrol.mjs` 跑的是与控制台「一键巡逻」**同一套代码**（`lib/patrol.js` +
`lib/platforms/amazon.js`），只是把宿主服务换成本地实现。常用参数：

```sh
node scripts/smoke-patrol.mjs --stores=<id1>,<id2>   # 只巡逻指定店铺
node scripts/smoke-patrol.mjs --max-stores=3         # 最多扫 3 家
node scripts/smoke-patrol.mjs --headless --close-after
```

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
  （买家消息里出现的「忽略以上指令」之类文本，只会被当成模板变量，不会被执行。）
- 店铺自动化的「提交」步骤必须由人在界面上校准并点击后才会执行。
- **巡逻链路上不存在发送动作**：`lib/patrol.js` 与 `lib/platforms/amazon.js` 只做读页面、
  写草稿、入队；Amazon 剧本的 `submit` 永久 `verified=false / never=true / selector=""`。
  这是被 `test/amazon.test.js` 与 `test/routes.test.js` 显式断言的，不是口头承诺。

---

## 阶段状态

- **Phase 0（已完成）**：可移植插件骨架、控制台路由、体检页、A+B 面板、双 profile 安装通路。
- **Phase 0.5（已完成，v0.2.0）**：信息架构拆成「工作台 / 设置」；新增工单队列与活动审计
  两套数据层；统计页分业务组（工单口径）与运行组（CLI / 体检），**口径全部在服务端**；
  队列页可筛选、新建、看详情、走状态流转（带状态机与乐观锁）。
- **Phase 3a（已完成，v0.3.0）**：**Amazon 一键巡逻** —— 巡逻引擎 + Amazon 适配器 +
  模板化草稿生成 + 草稿库 + 工单入队 + 控制台一键页；读链路在真实店铺上校准并落成剧本
  （`assets/playbooks/amazon.message.json`，`verified=true`）。
- Phase 1：计划数据模型 + 规则/模板/排班/生成计划的点击式配置（落在「设置」页）。
- Phase 2：飞书邮件闭环（收件 → 草稿 → 点发送），数据直接进 `queue.json`。
- Phase 3b：TikTok Shop + Walmart 买家消息接入（复用巡逻引擎与草稿库）+ 点击式校准模式。
- Phase 4：订单与物流查询、评价回复、售后与退款工单。
- Phase 5：紫鸟ERP 客服人员与授权、AI 工具、导出与运营手册。

### 已知边界（v0.3.0）

- 巡逻只覆盖**读取 + 生成草稿**；发送与「填入回复框」都只走人工触发。
- 单店铺的页面脚本依赖 Amazon 现网 DOM（`.case-list-items` / `.case-message-view` / `.message-component`）。
  Amazon 改版会让它失效 —— 失效表现是「收件箱没有加载出来」被记成该店失败，而不是静默漏掉。
- **店铺未登录会被单独识别**：亚马逊会把收件箱跳到 `/ap/signin`，巡逻据此报
  「店铺未登录，请先在紫鸟浏览器里登录该店铺后重跑」，而不是让运营去猜是改版还是掉登录。
  （实跑时 8 家店里有 1 家就是这个状态。）
- 草稿模板是英文的；非英语买家会在草稿备注里提示，需要人工按买家语言调整。
- `lib/*.js`（宿主半）改动**必须重启 DSH** 才生效，`assets/` 刷新页面即可。

## License

MIT

# dsh-web-search-scrape

DSH（DeepSeek Harness）的**六档分级抓取式网页检索插件**。

用 Node 内置 `fetch` 直接抓取搜索引擎与社交平台的公开结果页，为 `ctx.web` 注册一个名为 `web-scrape` 的搜索 provider，并接管模型侧的 `web_search` 工具——**无需任何搜索 API key**。

## 功能

- **可切换搜索后端**：设置卡片里选 `backend`，即时生效、无需重启 ——
  - `local`（默认）：本插件的六档抓取管线；
  - `official`：复用内置 `@deepseek-ai/dsh-web-search-deepseek` 的 provider（进程内委托），端点/模型/密钥仍由官方「Web search」卡片管理。
- **六档检索深度（T1 极速 → T6 研究）**：模型可传 `tier` 参数，缺省时按查询特征自动选档。
- **双池引擎**：P0 搜索引擎池 + P1 社交平台池，按档位取前 N 个。
- **可选验证与子代理查证**：确定性启发式评级（域名信誉 + 相似度聚类），T4 以上派发 WebSearch 子代理分诊，T5/T6 可用 `curl` 打开页面核查上游来源，输出证据等级。
- **设置页卡片**：浏览器半在「设置 → 插件」注册配置卡片，配置经 `dsh-settings` 持久化。
  **卡片默认收起**（与同页其他插件卡片一致），点标题栏展开；展开状态记在
  `localStorage`（键 `web-search-scrape.card.open`），收起时会显示一行摘要
  （当前后端 / 缺省档位 / 是否有未保存修改）。

## 目录结构

```
.
├── package.json      # 包元信息（name/exports/dsh.engines/dsh.client 声明）
├── LICENSE           # MIT
├── cordis.patch.yml  # 随包补丁（dsh.bundle.patch），安装时自动应用
└── lib
    ├── index.js      # 宿主半：provider(router) + web_search 工具 + 设置命名空间
    └── client.js     # 浏览器半：设置页卡片（含 backend 选择）
```

> 本仓库直接存放可运行的 ESM 源码，无构建步骤：`lib/*.js` 即发布产物。

## 变更记录

### 1.3.0

- **新增 `allowOfficial`（默认 `false`）—— 计费硬保险**：`backend: official` 从此不再等于消费许可。
  未授权时官方路径直接抛错、**零网络请求**，误改配置不会产生账单。要用官方搜索需显式打开。
- **新增 `maxAutoTier`（随包补丁默认 `3`）**：T4–T6 会派发 LLM 子代理（按会话模型计费），
  而 `autoTier` 会被「分析/对比/趋势/报告」这类常见词抬到 T5 —— 自动档位封顶可避免静默产生
  模型费用；模型显式传 `tier` 不受上限影响。
- README 新增「计费」章节：两处成本点、各自的硬开关、实测证据，以及最省心的配置片段。

### 1.2.0

- **新增 `web_search_deep` 工具**（`deepTool`，默认开）：DSH `>= 0.1.5` 把模型侧的
  `web_search` 移到了 agent 预设平面，预设的同名工具会遮蔽本插件的注册，导致 `tier`
  传不进来、且结果被预设的 `searchMaxResults: 8` 截断。名字不同的工具不会被遮蔽，
  深度控制因此在任何预设下都可用。详见上文「为什么有两个工具」。
- **新增 `dsh.bundle.patch`**：仓库自带 `cordis.patch.yml`，安装时由 loader 自动并入
  profile 层栈 —— **不再需要手工编辑 profile 的补丁文件**。方式 B（符号链接）仍需手工应用。

### 1.1.0

- **新增 `backend` 设置**：可在「设置 → 插件」卡片里于 `local`（本地六档抓取）与 `official`（内置 DeepSeek 搜索）之间实时切换，无需重启。
- **设置卡片改为默认收起**：标题栏可点开/收起，展开状态持久化到 `localStorage`，收起时显示一行摘要。
- **修复 DSH 0.1.5-rc.2 兼容性**（1.0.0 在该版本上会直接加载失败）：
  - 设置 API 迁移到 `ctx.settings.installSection(...)`（`installSettingsSection` / `settingsNamespace` 已从 `dsh-settings` 移除）。
  - 修正 `setSource` 的 thunk 语义：旧代码把 `() => T` 当值用，导致**设置卡片改了不生效**。
  - 浏览器半：`@deepseek-ai/dsh-client-runtime` → `@deepseek-ai/dsh-client-store`。
  - 浏览器半：设置卡片注册改用 keyed slot 要求的 `key`（原 `id` 会**抛错**导致卡片不显示）。
- 新增 MIT LICENSE；`package.json` 补 `dsh.engines.dsh` 版本要求。

### 1.0.0

- 首个版本：六档分级抓取式检索。

## 为什么有两个工具：`web_search` 与 `web_search_deep`

DSH `>= 0.1.5` 把**面向模型的 `web_search` 工具挪到了 agent 预设平面**（每个预设里的
`tool-web` 行，作用域是 agent 级）。按 `dsh-scope` 的层级语义，**agent 级的同名工具会遮蔽
本插件在 profile 层注册的同名工具**。实测证据：实时工具列表里 `web_search` 的参数是
`queries`（数组），不是本插件的 `query` + `tier`。

这带来两个后果：

1. **`tier` 参数传不进来** —— 模型无法显式指定深度，只能靠查询特征自动选档，或用设置卡片里的 `defaultTier` 固定档位；
2. **结果被截到 8 条** —— `tool-web` 的 `searchMaxResults` 默认是 `8`，而 seam 会按请求的 `maxResults` 截断返回值。也就是说即便 T5/T6 抓了 50+80 条，模型最终也只看得到 8 条。

**解决方式**：本插件同时注册一个**名字不同**的工具 `web_search_deep`。名字不同就不会被遮蔽
（没有别的注册者占用该名字），并且它按本插件的配置发请求（`searchMaxResults: 130`），
所以深度控制和结果预算在任何预设下都可用，**不需要用户切换或改造预设**。

| 工具 | 注册者 | 何时生效 | 参数 | 结果上限 |
|------|--------|----------|------|----------|
| `web_search` | 预设的 `tool-web`（0.1.5+） | 总是（遮蔽本插件的同名注册） | `queries: string[]` | 8（预设配置） |
| `web_search` | 本插件 | 仅当预设**不带** web 工具时 | `query`, `tier` | 130（本插件配置） |
| `web_search_deep` | 本插件 | **总是**（名字不冲突） | `query`, `tier` | 130（本插件配置） |

三个都走同一个 provider，所以无论模型点哪一个，六档管线、消息甄别、多源验证都在生效。
不想多一个工具就把 `deepTool` 设为 `false`。

> **想要"只留一个工具"？** 见下一节的预设配方。

## 💰 计费：什么时候会花钱，怎么保证不会

抓取本身**永远免费**（只是 HTTP 抓公开结果页）。会产生费用的只有两处，两处都有硬开关：

| # | 成本点 | 计费方式 | 默认 | 硬保险 |
|---|--------|----------|------|--------|
| A | `backend: official` | 走 `{baseURL}/messages`（Anthropic 兼容 Messages API），**按 token 计费** | `local`（免费） | **`allowOfficial: false`** |
| B | 档位 T4–T6 的 WebSearch 子代理 | 派生一个 LLM 子代理，**按会话所用模型计费** | 仅显式 T4+ 触发 | **`maxAutoTier: 3`** |

### A. 官方搜索：双重开关

`allowOfficial` 默认 **false**。此时即使 `backend` 被写成 `official`，插件也会**拒绝执行并直接抛错**，
**一个请求都不会发出**：

```
backend is "official" but allowOfficial is false — refusing to call the billed
DeepSeek search API. To allow billed official searches, enable "allowOfficial"
in this plugin's settings card. To keep searching for free, set backend back to "local".
```

也就是说：`backend: official` **本身不是消费许可**。要真的用官方搜索，必须**两个都打开**
（卡片里选「官方 DeepSeek 搜索（⚠️ 按 token 计费）」+ 打开「⚠️ 允许计费 API」）。
要回到免费，把 backend 切回 `local` 即可，无需清理 `allowOfficial`。

> 实测：`allowOfficial: false` + `backend: official` → `available()` 返回 false，
> `search()` 抛 `WEB_PROVIDER_UNAVAILABLE`，官方 API 调用次数 **0**。

### B. T4–T6 子代理：自动档位可能"静默"升档

T4 起会派生一个 LLM 子代理做分诊。它的费用不在搜索 API 上，而在**你当前会话的模型**上。
麻烦的是 `autoTier` 的关键词表包含 `分析` `对比` `趋势` `报告` 这类**极常见的词**：

```
查询「对比一下这两款产品并分析趋势」  →  autoTier 选中 T5（派发子代理）
```

`maxAutoTier` 就是给自动档位设天花板。默认随包补丁给的是 **3**，即：

- 自动档位最高到 T3（全引擎 + 1 个社媒，纯抓取，**零模型费用**）；
- 模型**显式**传 `tier: 5` 仍然照做（`maxAutoTier` 只约束自动分支）；
- 想恢复原有行为（不设限）就改成 `6`。

```yaml
maxAutoTier: 3   # 1-6；3 = 自动最高到"标准"，T4-T6 只能显式调用
```

想彻底关掉子代理（连显式 T5/T6 也不派发），把 `subagentVerify` 设为 `false`。

### 最省心的配置

```yaml
backend: local          # 不碰付费搜索 API
allowOfficial: false    # 就算 backend 写错也不会请求
maxAutoTier: 3          # 自动档位不会静默买 LLM 子代理
subagentVerify: false   # 连显式 T5/T6 也不派发子代理（可选，最严格）
```

## 配方：用自定义预设做「正统替换」

如果你更想要**一个** `web_search`（而不是 `web_search` + `web_search_deep` 两个），可以做一个
自定义 agent 预设，把模型侧的搜索工具交还给本插件。这是平面上更"正统"的做法：模型侧工具
本来就归预设管，改预设即可，不需要和遮蔽机制对抗。

**代价**：只在选了该预设的会话里生效，新建会话时需要切一下预设。

### 步骤

**1)** 从官方 `standard` 复制一份到用户预设根 `${DSH_HOME:-~/.dsh}/.agent-presets/<id>/`：

```sh
mkdir -p ~/.dsh/.agent-presets/dsh-scrape
P=<dsh 安装目录>/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard
cp "$P/agent.cordis.yml" "$P/preset.yml" ~/.dsh/.agent-presets/dsh-scrape/
```

也可以在 GUI「设置 → Agent 预设」里用"复制"完成这一步。

**2)** 把复制出来的 `agent.cordis.yml` 里的 `tool-web` 行改成：

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true        # web_fetch 仍由这里提供
    search: false      # 交出 web_search —— 让本插件的（带 tier）成为唯一一个
    searchTimeoutMs: 60000
```

**3)** 改 `preset.yml` 的 `name` / `description`（可选，否则选择器里只有目录名）。

**4)** 新建会话时选这个预设。模型侧就只剩本插件的 `web_search`，**带 `tier` 参数**，
结果上限取本插件的 `searchMaxResults`（默认 130，不再是预设的 8）。

### 验证

不必先开会话，可以让宿主单独组合一遍这个预设（真实 mount，但不启动任何会话）：在 `cordis`
预设的会话里用动态 Cordis 插件注入 `agentPresets`，调用 `standingKeyFor('<预设 id>')` ——
正常返回即组合可用；抛错会给出四种失败原因之一（包无法解析 / config 非法 / 有行未激活 /
行把服务发布到了进程全局域）。

> 注意 `standingKeyFor` 是一次**真实 mount**：成功后会在该进程内驻留一个 standing
> generation 直到进程退出；失败则清理干净、不留痕迹。

### 撤销

```sh
rm -rf ~/.dsh/.agent-presets/<id>
```

再把新会话切回 `standard` 即可 —— **已经在跑的会话仍用它启动时的预设**，不受影响。

## 六档深度

| 档位 | 名称 | 耗时量级 | 引擎 | 社交 | 结果数 | 验证方式 |
|------|------|----------|------|------|--------|----------|
| T1 | 极速 | ~4s | 1 | 0 | 6 | 不验证 |
| T2 | 快速 | ~10s | 2 | 0 | 10 | 启发式评级 |
| T3 | 标准 | ~20s | 全部 | 1 | 20+10 | 启发式评级 |
| T4 | 增强 | ~60s | 全部 | 全部 | 50+80 | 子代理分诊 |
| T5 | 深度 | ~150s | 全部 | 全部 | 50+80 | 子代理 + ≤6 页核实 |
| T6 | 研究 | ~280s | 全部 | 全部 | 50+80 | 子代理 + ≤15 页多轮阅读 |

`engines` / `socials` 配置是**池**：档位按配额取前 N 项（T1=1 个引擎，T2=2 个，T3 及以上=全部）。

## 引擎池

- **P0 搜索引擎**：`duckduckgo`、`bing`、`baidu`、`google`、`yandex`
- **P1 社交平台**：`weixin`、`bilibili`、`weibo`、`x`、`zhihu`、`douyin`、`reddit`

## 安装

### 前置条件

- **DSH `>= 0.1.5-rc.2`**（见 `package.json` 的 `dsh.engines.dsh`）。本插件直接引用若干宿主包的内部 API，跨小版本可能断裂：
  - `ctx.settings.installSection(...)`（`dsh-settings`，0.1.5-rc.2 起；旧的 `installSettingsSection` / `settingsNamespace` 导出已移除）
  - `createSnapshotStore` 来自 `@deepseek-ai/dsh-client-store`（旧的 `dsh-client-runtime` 已不存在）
  - 设置卡片注册到 `settings.plugin.item` 这个 **keyed** slot，必须传 `key`（命名空间）而非 `id`
  - `DeepSeekSearchProvider` / `WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE`（`backend: official` 委托用）
- DSH 已安装，且使用 `web` profile（`~/.dsh/profiles/web`）。
- `pnpm-workspace.yaml` 建议包含 `nodeLinker: hoisted`：本插件不声明依赖（宿主包由 DSH 提供），严格布局下包解析可能失败。
- 本仓库为**公开**仓库，git 安装无需任何认证。

### 方式 A：作为依赖安装（标准方式，零配置）

```sh
dsh plugin --profile web add github:BaihaWhite/dsh-web-search-scrape
```

`dsh plugin` 是 pnpm 的包装命令：写完依赖后会**按已安装状态重整 profile 的层栈** —— 任何声明了
`dsh.bundle` 的依赖会自动加入 `dsh.profile.bundles`，而本仓库正是这样声明的：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

于是仓库自带的 [`cordis.patch.yml`](./cordis.patch.yml) 会作为一层补丁自动应用
（`web.searchProvider` 改指本插件、停用 `tool-web` 的 search、插入本插件行）——
**不需要手工编辑 profile 的 `cordis.patch.yml`**。装完重启 `dsh web` 即可。

> 已经装过的用户升级到 1.2.0+ 后同样生效：`dsh plugin --profile web update` 会重新对账层栈。

### 方式 B：本地目录 + 符号链接（开发调试）

> 注意：克隆目录**必须放在 profile 目录内**（如下），否则 Node 按真实路径解析裸导入时
> 找不到宿主包。放到 `/tmp` 之类的目录会报 `Cannot find package '@deepseek-ai/dsh-...'`。
>
> 方式 B **不会**自动应用仓库自带的补丁，需要手工把 `cordis.patch.yml` 的内容复制进
> profile 的补丁层（见下一节）。

```sh
cd ~/.dsh/profiles/web
git clone https://github.com/BaihaWhite/dsh-web-search-scrape.git web-search-scrape
ln -s ../web-search-scrape node_modules/web-search-scrape
```

符号链接让补丁里的 `name: 'web-search-scrape'` 能被解析到包目录。

### 手动安装时的补丁配置

方式 A 会自动应用，**此节仅方式 B（或想自定义）时需要**。把以下条目加进
`~/.dsh/profiles/web/cordis.patch.yml`（内容与仓库自带补丁一致）：

```yaml
# 1) web 行：searchProvider 改指本插件的 provider id
#    （补丁语义：整段替换目标行 config，故需重述全部字段）
#    本插件是该 id 的 router：真正走哪条后端由设置卡片的 backend 决定。
- id: web
  config:
    searchProvider: web-scrape

# 2) tool-web 行：停用内置 web_search，交给本插件注册同名工具
- id: tool-web
  config:
    fetch: false
    search: false
    searchTimeoutMs: 180000
    searchMaxResults: 130

# 3) web-search-deepseek：**保持启用**（不要 disabled）
#    它是 backend=official 的委托目标，也提供官方「Web search」设置卡片
#    （端点 / 模型 / 密钥）。把它 disabled 后 official 仍可跑（走默认端点 +
#    凭据），但用户将无法在界面上配置官方端点。
#    它注册的 deepseek-official provider 不会被选中——第 1 项已把
#    searchProvider 钉在 web-scrape 上，因此不会产生歧义。

# 4) 挂载本插件
- insert:
    - id: web-search-scrape
      name: 'web-search-scrape'
      config:
        backend: local          # local | official（设置卡片里可随时切换）
        engines: [duckduckgo, bing, baidu, google, yandex]
        socials: [weixin, bilibili, weibo, x, zhihu, douyin, reddit]
        verify: true
        subagentVerify: true
        defaultTier: 0
        toolBudgetMs: 300000
        searchMaxResults: 130
```

### 生效

```sh
# 预检：确认没有 Cannot find package 报错
dsh --profile web --dump-config | grep -i "cannot find"

# 重启 dsh web（页面刷新不够）
```

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `allowOfficial` | boolean | `false` | **计费硬保险**。为 false 时 `backend: official` 会被拒绝且不发请求；见上文「计费」 |
| `maxAutoTier` | number | `6`（随包补丁给 3） | 自动档位上限，只约束自动分支；显式 `tier` 不受影响 |
| `deepTool` | boolean | `true` | 是否额外注册 `web_search_deep`（名字不同、不被预设遮蔽、带 `tier`、结果上限取本插件的 `searchMaxResults`） |
| `backend` | `local` \| `official` | `local` | 搜索后端。`local` = 本插件六档抓取；`official` = 委托内置 DeepSeek 搜索。**改动即时生效**（每次搜索重新取快照） |
| `engines` | string[] | `[duckduckgo, bing, baidu, google, yandex]` | P0 搜索引擎池 |
| `socials` | string[] | `[weixin, bilibili, weibo, x, zhihu, douyin, reddit]` | P1 社交平台池 |
| `engineResults` | number | `50` | 单引擎抓取结果上限 |
| `socialResults` | number | `80` | 社交平台结果上限 |
| `socialPerSite` | number | `30` | 单社交站点结果上限 |
| `verify` | boolean | `true` | 是否启用启发式验证评级 |
| `subagentVerify` | boolean | `true` | 是否派发 WebSearch 子代理查证 |
| `subagentTimeoutMs` | number | `120000` | 子代理超时（毫秒） |
| `subagentMaxSources` | number | `60` | 交给子代理的来源上限 |
| `scrapeTimeoutMs` | number | `20000` | 抓取阶段截止时间（毫秒） |
| `toolBudgetMs` | number | `60000` | `web_search` 工具层强制超时，子代理预算据此自适应 |
| `defaultTier` | number | `0` | `0` = 自动启发式；`1`-`6` = 固定档位 |
| `searchMaxResults` | number | `130` | 每次 seam 请求的 `maxResults` |
| `timeoutMs` | number | `20000` | 单请求超时（毫秒） |
| `maxPages` | number | `130` | 抓取页数上限 |

> 档位自身拥有预算与验证模式：显式传入的 `tier` 会**覆盖**上述 `engineResults` 等字段。

## 注意事项

- `toolBudgetMs` 与工具超时相关；把工具超时改大（例如 180s）需要**重启 dsh web** 才生效。
- 抓取的是搜索引擎/社交平台的公开结果页，对方改版或限流会导致该引擎失败——插件会记录失败项并在结果里给出说明，而非静默丢弃。
- T5/T6 会启动子代理并可能执行 `curl` 打开外部页面，耗时与资源消耗显著高于 T1/T2。
- 本插件开发与验证环境：DSH `0.1.0-rc.6`，profile `~/.dsh/profiles/web`。在更高版本 DSH 上使用前建议先在测试 profile 验证。

## 卸载 / 回滚

```sh
# 方式 A 安装的：
dsh plugin --profile web remove web-search-scrape

# 方式 B 安装的：
rm ~/.dsh/profiles/web/node_modules/web-search-scrape
rm -rf ~/.dsh/profiles/web/web-search-scrape
```

随后从 `cordis.patch.yml` 中删除第 4 项 insert 段（若要恢复内置搜索，再一并删除第 1-3 项补丁），重启 `dsh web`。

## 许可证

MIT License，见 [LICENSE](LICENSE)。

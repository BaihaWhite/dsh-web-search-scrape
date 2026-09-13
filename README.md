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

## 目录结构

```
.
├── package.json      # 包元信息（name/exports/dsh.engines/dsh.client 声明）
├── LICENSE           # MIT
└── lib
    ├── index.js      # 宿主半：provider(router) + web_search 工具 + 设置命名空间
    └── client.js     # 浏览器半：设置页卡片（含 backend 选择）
```

> 本仓库直接存放可运行的 ESM 源码，无构建步骤：`lib/*.js` 即发布产物。

## 变更记录

### 1.1.0

- **新增 `backend` 设置**：可在「设置 → 插件」卡片里于 `local`（本地六档抓取）与 `official`（内置 DeepSeek 搜索）之间实时切换，无需重启。
- **修复 DSH 0.1.5-rc.2 兼容性**（1.0.0 在该版本上会直接加载失败）：
  - 设置 API 迁移到 `ctx.settings.installSection(...)`（`installSettingsSection` / `settingsNamespace` 已从 `dsh-settings` 移除）。
  - 修正 `setSource` 的 thunk 语义：旧代码把 `() => T` 当值用，导致**设置卡片改了不生效**。
  - 浏览器半：`@deepseek-ai/dsh-client-runtime` → `@deepseek-ai/dsh-client-store`。
  - 浏览器半：设置卡片注册改用 keyed slot 要求的 `key`（原 `id` 会**抛错**导致卡片不显示）。
- 新增 MIT LICENSE；`package.json` 补 `dsh.engines.dsh` 版本要求。

### 1.0.0

- 首个版本：六档分级抓取式检索。

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

### 方式 A：作为 git 依赖安装（标准方式）

```sh
dsh plugin --profile web add github:BaihaWhite/dsh-web-search-scrape
```

`dsh plugin` 是 pnpm 的包装命令，等价于在该 profile 下执行 `pnpm add`，会把本包写入 `package.json` 依赖并安装到 `node_modules`。

### 方式 B：本地目录 + 符号链接

> 注意：克隆目录**必须放在 profile 目录内**（如下），否则 Node 按真实路径解析裸导入时
> 找不到宿主包。放到 `/tmp` 之类的目录会报 `Cannot find package '@deepseek-ai/dsh-...'`。

```sh
cd ~/.dsh/profiles/web
git clone https://github.com/BaihaWhite/dsh-web-search-scrape.git web-search-scrape
ln -s ../web-search-scrape node_modules/web-search-scrape
```

符号链接让 `cordis.patch.yml` 里的 `name: 'web-search-scrape'` 能被解析到包目录。

### 必需的补丁配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 中加入/确认以下条目：

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

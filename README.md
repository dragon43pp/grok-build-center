<div align="center">
  <img src="assets/banner.svg" alt="SessionDeck" width="100%">
</div>

<h1 align="center">SessionDeck</h1>

<p align="center">
  <b>你的 AI CLI 会话甲板</b> —— 一屏看清所有会话，一键找回三个月前那场，随手可查，飞书里也能管。
</p>

<p align="center">
  <code>grok</code> · <code>codex</code> · <code>claude</code> · <code>opencode</code> · <code>kimi</code> · <code>pi</code> · <code>gemini</code>
</p>

---

## 它解决什么

你机器上躺着几百场可恢复的会话，但**没有任何一个地方能一眼看全**：

- 哪场正在跑、哪场**卡在等你点确认**、哪场已经炸了
- 昨天那场改的是哪个目录、说了什么、能不能接着跑
- 三个月前那场是怎么把那个 bug 修掉的

各家 CLI 各存各的（`~/.codex`、`~/.grok`、`~/.claude`…），格式互不认识，
跨 CLI 检索基本靠 `grep` 撞运气。SessionDeck 把这些统一成一张表、一套状态、一个入口。

### 状态灯：颜色即状态

<div align="center">
  <img src="assets/status-lights.svg" alt="status lights" width="640">
</div>

**珊瑚色 `#FF6B4A` 是全场唯一「要你动手」的信号。** 它出现的时候，就是你现在最该去看的那一场。

状态怎么来的，可信度不一样 —— 这点不藏着：

| 状态 | 来源 | 可信度 |
| --- | --- | --- |
| 🟠 等你确认 / 🔴 报错 | CLI 的 hook 主动上报 | 最准，但要配 hook |
| 🟠 等你确认 | **HRack 事件流里的 `blocked`** | 同样准，且**不用配 hook** |
| 🟢 在跑 / ⚪ 空闲 | 扫进程表，按 (CLI, 目录) 匹配 | 能确定「活着」，不知道它在等什么 |
| · 已结束 | 会话文件的最后活动时间 | 只反映时间 |

> **诚实说明**：不配 hook、也不走 HRack，面板上就永远不会有橙色的「等你确认」。
> 那个信息只有 CLI 自己知道，别指望从文件 mtime 猜出来 ——
> **猜出来的东西会让你在关键时刻判断错。**

---

## 数据流

<div align="center">
  <img src="assets/architecture.svg" alt="architecture" width="880">
</div>

四个数据源合并成一张快照，**状态优先级：hook > HRack > 进程 > 文件 mtime**。
越靠前越可信，不会互相覆盖。

---

## HRack 通道：不用配 hook 就有「等你确认」

[HRack](https://github.com/) 是桌面上那个多 CLI 会话管理器，它自己**已经在记**哪场卡住了：

```
%APPDATA%\HRack\events\events.jsonl
  session_start  detail = 工作目录
  tool_call      正在干活
  blocked        ← 卡在等你批准 / 等你回答
  approved       放行了
  completed      一轮结束
  session_exit   进程退了
```

所以只要是 **HRack 拉起的会话**，接上这个通道就有橙色的「等你确认」—— **不用给任何 CLI 配 hook**。
上面那句「不配 hook 就没有橙色」，只适用于你在系统终端里手动开的会话。

```cmd
python -m feishu_hub.hrack
```

```
事件流水: OK  C:\Users\admin\AppData\Roaming\HRack\events\events.jsonl
Bridge   : 已连接  \\.\pipe\hrack-bridge-admin

HRack 会话 5 场：
  needs-you  grok      造书成剧   tools=221   0 分钟前
```

### 还能反向操作（Bridge）

HRack 开了一条**命名管道** `\\.\pipe\hrack-bridge-<用户名>`，token 在 `%APPDATA%\HRack\bridge.token`。
接上之后就不只是「看」了：

| 操作 | 走的方法 | 效果 |
| --- | --- | --- |
| **批准 / 拒绝** | `session.approve` / `session.deny` | 当场放行那场卡住的会话（要 `hrack_approve=true`） |
| **投喂** | `session.send` | 把一句话**塞进正在跑的那一场**，不是另起进程 |

「投喂」跟无头续跑是**两条不同的路**，别混：

| | 无头续跑 | 投喂（Bridge） |
| --- | --- | --- |
| 怎么跑 | `remote.py` 另起一个无头进程 | 直接写进 HRack 里活着的那一场 |
| 上下文 | 重新加载整段历史，大会话要几分钟 | **连续的**，TUI 里能看到这句话 |
| 适用 | 所有 CLI | HRack 里跑着的 OpenCode 会话 |
| 覆盖范围 | 另起炉灶，跟 TUI 那场互不相干 | **同一场会话** |

> **HRack 那边的边界**：`sessions.list` 在 HRack 里是**按 `adapterId == 'opencode'` 过滤**的，
> 所以 grok / codex / claude 的会话拿不到反向操作能力 —— 不是本项目的限制。
> 事件流那条路不受影响，六个 adapter 全覆盖。

**信任开关默认关着**：`hrack_approve: false`。
开着 = 飞书那头点一下就能让你的机器继续执行工具。跟 `remote_auto_approve` 是同一类问题，想清楚再开。
关着的时候卡片上干脆不摆那两个按钮 —— 摆一个点了只会弹「未开启」的，更烦。

**HRack 没开怎么办**：什么都不用做。事件流读不到就静默降级，Bridge 探测到管道不存在也就一句
`HRack 未运行`，面板照常工作。

---

## 快速开始

```cmd
git clone <this-repo> sessiondeck && cd sessiondeck
pip install -r requirements.txt

python tools\setup.py        :: 向导：验凭证 → 建多维表格 → 拿 open_id → 写 config.json
run.cmd                      :: 启动
```

向导会把所有手工活做掉：**自动建好 15 列的多维表格**，你不用手动建列。
前提是先有一个飞书自建应用 —— 那 7 步在开发者后台，脚本代替不了，见下面「第一步」。

### 不想连飞书？先看本机

飞书是**可选的外挂**，不是前提。这几条全离线：

```cmd
run.cmd --print              :: 本机状态表格
run.cmd --bitable-preview    :: 看要写进多维表格的行（不联网）
run.cmd --card-preview       :: 打印卡片 JSON 和体积
python tools\card_preview.py :: 生成 card-preview.html，浏览器打开，按钮能点
python tools\smoke_test.py   :: 203 项离线自检，不联网不建应用
python -m feishu_hub.hrack   :: 看 HRack 通道读到了什么
```

`card-preview.html` 渲染的是 `cards.build_panel()` 的**真实输出**，不是照着截图重画的。
所以先在这里把「长什么样、点了对不对」确认掉，再去配开发者后台 ——
之后真机上再出问题，就能确定是后台配置的锅，不是代码的锅。

---

## 三个界面，各管一段

| | **终端 / `--print`** | **飞书常驻卡片** | **飞书多维表格** |
| --- | --- | --- | --- |
| 定位 | 本机一眼看 | 手机上看 + 当场动手 | 完整清单 |
| 放什么 | 全部会话 | 最要紧的几条 | 全部会话，15 列 |
| 能干什么 | 看状态、看目录 | 筛选 / 详情 / 打开 / 投喂 | 原生筛选 / 排序 / 搜索 / 分组，**可分享** |
| 翻页 | 一屏 | 一页 10 条 | 无限滚 |

几百场会话在卡片上要翻几十页，手机上点到手酸。所以**表格才是「看全部」的地方**，
卡片负责「现在哪几件要紧事 + 一键回到现场」。**两个都免费。**

### 卡片上能干什么

| 操作 | 效果 |
| --- | --- |
| 筛选（活跃 / 等你确认 / 各家 CLI / 全部） | 换筛选，原地刷新 |
| **详情** | 另发一张卡：这场会话的**最近 10 轮对话正文** + 输入框，可以直接发指令让它继续 |
| **打开** | 用 Windows Terminal 在该会话的目录里执行 `codex resume <id>` 之类的恢复命令 |
| ‹ 上一页 / 下一页 › | 翻页，每页 10 条 |
| ⟳ 刷新 | 后台重扫（约 5 秒），扫完自动 PATCH 回来 |
| 批准 / 拒绝 | 放行卡住的 OpenCode 会话（要 `hrack_approve=true`） |

---

## 第一步：建飞书应用（可选）

> 必须是**企业自建应用**。个人版飞书账号也能建，但要有企业/团队空间。

### 最短路径

后台一共要动的只有 **2 个开关**，都在同一页：

| 页面 | 要做的 | 必需？ |
| --- | --- | --- |
| **事件与回调** → 事件配置 | 订阅方式选 **使用长连接接收事件** | ✅ 必需 |
| **事件与回调** → 回调配置 | 订阅方式选 **使用长连接接收回调** | ✅ 必需 |
| 权限管理 → IM | `im:message` | ✅ 必需 |
| 应用发布 → 可用范围 | 把自己加进去 + 发布版本 | ✅ 必需 |
| 权限管理 → 多维表格 | `bitable:app` 一个 + 加 Base 协作者 | ⬜ 可选 |

这两个**长连接开关是后台独有的设置，没有 API 能代开**，只能手动点。

### 1. 创建应用

[open.feishu.cn/app](https://open.feishu.cn/app) → **创建企业自建应用** → 填名字和图标。

### 2. 加机器人能力

左侧 **添加应用能力** → **机器人** → 启用。
没有这一步，后面所有接口都会报 `230006 Bot ability is not activated`。

### 3. 开权限

#### 3a. IM（卡片面板必需）

| 权限 | Scope | 用途 |
| --- | --- | --- |
| 获取与发送单聊、群组消息 | `im:message` | 收消息 + 发卡片 + 更新卡片（**开这一个就够**） |
| 以应用的身份发消息 | `im:message:send_as_bot` | 同上，官方列的可选之一 |

> 发送和更新卡片的接口文档都是「开启**任一**权限即可」，列表里都包含 `im:message`。
> 所以**只开 `im:message` 就够用**，不用纠结「更新消息」那个权限叫什么 id。

**怎么确认自己开没开**：不用猜，跑一条命令就知道 ——

```cmd
python tools\probe_im.py
```

它会用应用身份真发一条消息出去。成功 = `app_secret` + IM 权限 + 可用范围 + 用户可达四件事同时成立。

| 错误码 | 真实原因 |
| --- | --- |
| `99991672 app_scope_not_applied` | 应用缺 IM 权限 |
| `230013 Bot has NO availability to this user` | 可用范围没配（第 5 步没做） |
| `99992351 invalid open_id` | `receive_id` 填错了 |

#### 3b. 多维表格（可选）

> **只想先跑起来可以整段跳过。** 不开这个，卡片面板照常工作，只是 `hub.py` 启动时会打印一行
> `[warn] 多维表格初始化失败，跳过同步：...`。

**加一个 `bitable:app` 就够了**（控制台里叫「查看、评论、编辑和管理多维表格」）。
`bitable.py` 走的是 `lark-oapi` 的 **bitable v1** 接口，这一套就是老的合并权限模型。

权限没开时，`hub.py` 会直接把要申请的链接打出来（**点它比自己去翻菜单快**）：

```
https://open.feishu.cn/app/<你的app_id>/auth?q=bitable:app:readonly,bitable:app,base:record:retrieve&token_type=tenant
```

> **别被 `base:*` 那套名字绕晕**：那是 `lark-cli` 走的**新版 Base 接口**用的细粒度权限名。
> 两条路的权限名不一样，是因为**接口版本不一样**，不是飞书在耍人。

**外加一步（容易漏）**：应用身份要读写**你个人拥有**的多维表格，还得把这个应用**加进那张 Base 的协作者**
（打开 Base → 右上角 **分享** → 添加协作者 → 搜应用名 → 给「可编辑」）。不给的话权限开全了也照样 403。

可以用 **批量导入** 直接粘（IM + 多维表格）：

```json
{
  "scopes": {
    "tenant": ["im:message", "im:message:send_as_bot", "bitable:app"],
    "user": []
  }
}
```

### 4. 两处都要选「长连接」

最容易漏的地方 —— **事件配置**和**回调配置**是两个独立页面，都要选长连接：

| 页面 | 设置 |
| --- | --- |
| **事件与回调** → 事件配置 | 订阅方式选 **使用长连接接收事件**；添加事件 **接收消息 `im.message.receive_v1`** |
| **事件与回调** → 回调配置 | 订阅方式选 **使用长连接接收回调**；添加回调 **卡片回传交互 `card.action.trigger`** |

⚠️ 回调要加**新版** `card.action.trigger`，**不要**用已废弃的 `card.action.trigger_v1`。
两个都加的话飞书会发两次请求，只响应一次也算成功，但建议只留新版。

> 用长连接就不需要填任何 URL。**不用公网 IP、不用服务器** —— 事件和回调都是出站连接。

### 5. 发布 + 配可用范围（必须做，不然必踩 230013）

左侧 **应用发布** → **版本管理与发布** → **创建版本** → 在 **可用范围** 里把自己加进去 → 保存 → **发布**。

> 不做这一步，发消息会报 `230013 Bot has NO availability to this user`。
> 这个错误码看起来像权限问题，其实是「可用范围」没配 —— 排查时会绕很久。
> **改过权限之后要重新创建版本并发布**，只加权限不重发版本不生效。

### 6. 交给向导

```cmd
copy config.json.example config.json
python tools\setup.py
```

向导会依次问 app_id / app_secret，真调一次接口验证，然后建多维表格、拿 open_id、写配置。
拿 open_id 时它会让你给机器人发一条消息，脚本自己接住 —— 用的是 `im.message.receive_v1` 事件，
跟面板本身要的权限是同一套，不用额外申请。

---

## 第二步：跑起来

```cmd
run.cmd
```

看到这些就对了：

```
[ok] 扫到 343 场会话，存活进程 2
[ok] 多维表格已就绪 table_id=tblXXXX
[bitable] 新增 343 · 更新 0 · 删除 0 · 未变 0
[ok] hook 端点监听 http://127.0.0.1:8799/hook
[ok] 面板已发送并置顶 message_id=om_xxxxx
[ok] 建立飞书长连接（事件 + 卡片回调都走这里，无需公网 IP）...
```

飞书里会出现一张卡片并自动置顶，同时多维表格里有了 343 行。之后**每 60 秒增量更新**。

### Windows：开始菜单就一个入口

「开始菜单 → **SessionDeck**」，点它就行 —— **不用你判断该走哪条路**：

```
config.json 没配好  →  体检模式（离线，不需要任何配置）
                       HRack 通道读到什么 + 会话清单 + 203 项自检
config.json 配好了  →  启动飞书面板，飞书里发一张常驻卡片并置顶（窗口别关）
```

判断是 `tools/config_ready.py` 读 `config.json` 做的，不是问你。
想强制走某一种：`start.cmd --check` / `start.cmd --panel`。
重装 / 卸载：`python tools\make_start_menu.py`（`--remove` 卸载）。

> **改 `.cmd` 之前必须知道的一件事**：这些文件**只能写 ASCII**，中文一律交给 Python 打印
> （见 `tools/banner.py`）。原因是两头堵死：存 UTF-8 → cmd 按 GBK 解析，中文全变乱码
> （本机 ACP 就是 936）；存 GBK → 脚本开头 `chcp 65001` 一执行，echo 出来的 GBK 字节又是乱码。
> 顺带两个一起踩会死得更难看：**`.cmd` 必须是 CRLF**，LF 会让 cmd 把行切碎，
> 报一堆「不是内部或外部命令」。

---

## 远程续跑：在飞书里把任务接着做下去

问题很实际：手机上点「打开」只会**在本机**弹一个终端，飞书这头看不到后续，也接不上手。
所以加了「详情」这条路径：

```
面板 → 点「详情」→ 一张新卡：会话正文 + 输入框 → 写一句话提交
    → 本机无头续跑这一场 → 结果回传成一张新卡
```

**它不是远程控制终端。** 那几家 CLI 都是全屏 TUI，把 TUI 流到飞书既没法交互也看不清。
但它们都提供**无头单轮模式**（吃一个 prompt、结果打 stdout、退出），
所以「继续任务」的正确形态是**远程投喂一轮**：不碰 PTY，没有窗口尺寸、转义序列、交互式确认这一堆无底洞。

各家的实际命令（`remote.py` 里按这个拼 argv）：

| CLI | 无头续跑 |
| --- | --- |
| grok | `grok --cwd <dir> -r <sid> -p "<prompt>"` |
| codex | `codex exec resume <sid> "<prompt>" --skip-git-repo-check` |
| claude | `claude -p --resume <sid> "<prompt>"` |
| opencode | `opencode run --session <sid> "<prompt>"` |
| gemini | `gemini -p --resume <sid> "<prompt>"` |
| kimi / pi | `<exe> -p --session <sid> "<prompt>"` |

> **`codex` 那个 `--skip-git-repo-check` 不能省。** 不加的话，只要会话目录不是 git 仓库，
> codex 会 **1 秒内直接退出**：`Not inside a trusted directory and --skip-git-repo-check was not specified.`
> —— 我们是回到一场**已存在**的会话，要求它是 git 仓库毫无道理。

> **子进程的 stdin 一定要关掉（`stdin=DEVNULL`）。** 这个坑最阴：不关的话子进程继承我们的 stdin 并
> **等键盘输入**，`grok -r ... -p ...` 会**零输出挂死**，直到超时才炸。
> 看起来就像「grok 不支持无头续跑」。关掉之后同一个命令 19 秒正常返回。
> `smoke_test.py` 里有一条专门钉这个的用例。

**会话正文从哪读**（`remote.read_transcript()`，各家存储格式都不一样）：

| CLI | 位置 | 正文在哪 |
| --- | --- | --- |
| grok | `~/.grok/sessions/<esc-cwd>/<sid>/chat_history.jsonl` | 每行 `{"type":"user"\|"assistant","content":"…"}` |
| codex | `~/.codex/thread_history_1.sqlite` → `thread_items` | **`userMessage` 在 `content[]`，`agentMessage` 在顶层 `text`** |
| claude | `~/.claude/projects/*/<sid>.jsonl` | `message.content[]`，块类型 `text` |
| opencode | `~/.local/share/opencode/opencode.db` | `message.data.role` + `part.data.text` |

> codex 那个坑值得单说：只看 `content` 的话，**AI 的回复会全部读成空** ——
> 表现是「只有你说话，AI 从没回过」。因为 `agentMessage` 的正文在顶层 `text` 字段。

**四个必须知道的约束**：

1. **提交后要等一会儿。** 回调预算只有 3 秒，续跑动辄几分钟 ——
   所以是收到就立刻回你一句「正在本机执行」，跑完再单独发一张结果卡。
   结果卡上会写**实际耗时**，你就能分辨「等这么久是正常的」还是「这次特别慢」。
2. **会话越大，恢复越慢 —— 而且不是线性的。** 实测：56 KB 的 grok 会话首次续跑 **19 秒**；
   1.5 MB 的 **600 秒仍没回来，零输出**。所以详情卡会按体量提前给提示（`remote.size_hint()`）：
   超 400 KB 说「可能要几分钟」，超 1 MB 说「可能要十几分钟，别在这儿等」。
   **大会话建议直接在电脑上打开**，这条路是给「随手接一句话」用的。
3. **默认不自动批准工具执行**（`remote_auto_approve: false`）。开着的话飞书那头就能在本机自动批准改文件、
   跑命令 —— **想清楚再开**。关着也能用，只是只能对话、不能动文件。
4. **结果会被截断。** 卡片上限 30 KB，超了只回前 20 KB（按**字节**算，中文一个字 3 字节）。

> **如果续跑失败，先看是不是模型/额度问题，别先怀疑这条路。**
> 实测过一次：codex **新会话**也失败，报 `404 Not Found: Auto 路由池没有支持该模型的可用分组`。
> 那就是 provider 配置问题 —— 链路已经走到「把 prompt 交给模型」这一步了。
> 判断方法：拿同一个 CLI 开一场**新会话**试试，新会话也挂就是环境问题。

---

## 第三步：配 hook（可选，但强烈建议）

不配 hook 就**没有「等你确认」**（HRack 拉起的会话除外）。配了之后，CLI 卡在等你点确认时会：

1. 面板上那一条变成橙色 🟠 并排到最前面，多维表格里状态同步变成「等你确认」
2. 飞书主动推一条「有会话在等你」（同一个会话 5 分钟内只推一次，不刷屏）

CLI 的 hook 里调：

```cmd
python tools\report.py --cli codex --status needs-you --note "要删掉 3 个文件，确认？"
python tools\report.py --cli grok  --status done
python tools\report.py --cli claude --status error --note "构建失败"
```

`--cli` 不给会从环境变量猜。`--sid` 不给就按当前目录匹配。
**这个脚本永远退出码 0** —— hook 挂在 CLI 主流程上，这里报错绝不能把你的会话搞崩。

各家 CLI 的 hook 配置位置不同，见各自的文档；本质就是在「需要用户确认」和「任务结束」时执行上面这行命令。

---

## 复用：别人怎么拿去用

这个工具是**给别人用的**，不是一次性的。所以：

- **一条命令装好**：`python tools/setup.py` 建表、拿 id、写配置，不用读文档猜
- **零硬编码**：会话库路径全走 `~` 和 `%APPDATA%`，没有写死任何本机路径
- **配置外置**：密钥和 id 全在 `config.json`（已在 `.gitignore` 里），换人只换这个文件
- **多维表格自动建**：15 列的 schema 在 `bitable.py` 里声明，脚本自动建好
- **状态文件可重建**：`bitable-state.json` 丢了会从表里读回已有行，不会插双份

```cmd
git init && git add . && git commit -m "SessionDeck"
```

对方只要：建自己的飞书应用 → `pip install -r requirements.txt` → `python tools\setup.py` → `run.cmd`。

### 换机器 / 多人共用一张表

`bitable-state.json` 是「会话 → 记录行」的本地索引。换机器时它不在，
但**不会把表插成双份** —— 启动时会自动读回表里已有行（`rebuild_index()`）。

多人共用一张表的话，各人的会话 id 不冲突，但**同一个 Base 会被多台机器同时写**。
建议一人一张表，或者给「项目目录」加个筛选视图区分。

### 两条路：应用身份 vs 用户身份

多维表格的同步有两条技术路线，**代价完全不同**，值得先想清楚再动手。

| | 应用身份（`bitable.py`） | 用户身份（`export_larkcli.py`） |
| --- | --- | --- |
| 走什么 | `lark-oapi` + `app_id`/`app_secret` | `lark-cli` 子进程 + OAuth 令牌 |
| 要配后台吗 | **要**：`bitable:app` + 发布版本 + 加 Base 协作者 | **不用**：扫码授权时 `base:*` 已经拿到 |
| 表归谁 | 应用 | 你（所以你能在飞书里打开） |
| 依赖 | 纯 Python | 需要 Node + `@larksuite/cli` |
| 适合谁 | 想做成标准应用分发给别人 | 自己用 / 想立刻跑起来 |

**现状**：两条都实现好了，各跑各的。`hub.py` 里挂的是**应用身份**，卡片刷新的同时表格也跟着更新；
`tools/export_larkcli.py` 走**用户身份**，一条命令把快照推上去，不需要任何后台配置。

**没配权限会怎样**：不会崩溃。`init_bitable()` 捕获异常后只打印一行
`[warn] 多维表格初始化失败，跳过同步`，卡片面板照常工作 —— 这点是刻意设计的，
「看会话状态」和「同步表格」不该互相拖累。

---

## 目录结构

```
sessiondeck/
├─ run.cmd                    一键启动
├─ start.cmd                  Windows 开始菜单入口（自动判断体检 / 面板）
├─ config.json.example        配置模板（复制成 config.json）
├─ requirements.txt
├─ .gitignore
├─ assets/                    品牌资产：SVG 自适应明暗 + prompts.json（gpt-image-2 出图）
├─ docs/brand.md              品牌规范（改视觉前先读）
├─ feishu_hub/
│  ├─ scan.py                 扫本机各家 CLI 的会话库 → 统一记录
│  ├─ procs.py                扫存活进程，按 (CLI, 目录) 匹配
│  ├─ hrack.py                ★ HRack 通道：事件流 + Bridge 命名管道
│  ├─ state.py                历史 + 进程 + HRack + hook 四源合并成统一快照
│  ├─ cards.py                飞书卡片 JSON 2.0 构造
│  ├─ bitable.py              多维表格：建表 / 增量同步 / 索引重建
│  ├─ feishu.py               发卡片 / PATCH 卡片 / 长连接
│  ├─ launch.py               恢复会话（Windows Terminal）+ 参数校验
│  ├─ remote.py               无头续跑 + 会话正文读取
│  └─ hub.py                  主程序：面板发布、回调分发、hook 端点、后台刷新
└─ tools/
   ├─ setup.py                一键安装向导（建表 / 拿 id / 写配置）
   ├─ smoke_test.py           203 项离线冒烟测试，不联网不建应用
   ├─ card_preview.py         渲染卡片为可点的 HTML
   ├─ gen_assets.py           用 gpt-image-2 批量出视觉资产
   ├─ whoami.py               拿 open_id / chat_id
   ├─ report.py               CLI hook 上报器（只用标准库）
   ├─ make_start_menu.py      装 / 卸 Windows 开始菜单入口
   └─ offline_pip.py          pip 被代理卡住时的离线装法
```

---

## 自检

```cmd
python tools\smoke_test.py
```

**203 项检查，不联网、不建飞书应用**，把整条链路跑一遍：

- 快照 / 卡片发布 / 筛选分页 / 卡片回调 / hook 端点 / 参数校验
- **HRack 通道**：6 种事件、状态迁移、增量读、压缩重写后重读、坏行跳过、快照合并优先级、僵尸进程
- **多维表格同步的幂等性** —— 这块写错会把 343 行反复插成双份，而且不报错，
  只会在表里慢慢堆垃圾。所以单独测了：原样重同步 0 新增 0 更新、只推变化行、
  会话消失删行、本地索引丢了从表里读回不重插、超批量上限自动分批

先把代码逻辑钉死，再去连真飞书 —— 这样出问题一定是后台配置的锅。

---

## 飞书的硬约束（写代码时必须记住的）

都是官方文档里明确的，踩过才知道：

| 约束 | 值 | 踩了会怎样 |
| --- | --- | --- |
| 卡片回调响应时限 | **3 秒** | 超时客户端提示「请求错误」，用户以为点了没反应 |
| `card.type` 合法值 | 只有 `raw` / `template` | 写成别的 → 卡片渲染失败 |
| `card.data` 类型 | **JSON 对象**，不是字符串 | 传字符串 → 解析失败 |
| 卡片体积 | ≤ 30 KB | 超了报 `230025` |
| 卡片可更新窗口 | 发送后 **14 天** | 超了报 `230031` |
| 单条消息更新频控 | **5 QPS** | 超了报 `230020` |
| `config.update_multi` | 更新**前后**都得是 `true` | 否则 PATCH 失败 |
| 可用范围 | 用户必须在应用的可用范围内 | 报 `230013`，看着像权限问题其实是这个 |
| 卡片交互有效期 | 30 天 | 超了用户点不动 |
| 多维表格日期字段 | **毫秒**时间戳（13 位） | 传秒会变成 1970 年 |
| 多维表格单选字段 | 值必须在预设选项里 | 写入不存在的选项直接报错（所以未知 CLI 映射到「其他」） |
| 多维表格批量接口 | 单次 500 条 | 本项目按 200 切 |

### 两个性能陷阱（本项目已经绕开了）

1. **一次全量重扫约 5 秒**（1.2 GB 的 Codex 库 + 进程表）。
   所以 hook 端点收到请求后**立刻回 200**，重扫丢给后台线程 ——
   否则 CLI 每次上报都要等 5 秒，拖慢的是你正在敲的终端。
2. **卡片回调只有 3 秒预算**，比一次重扫还短。
   所以回调里只改状态、用缓存出卡立刻返回，真正的重扫交给后台，扫完再 PATCH 回来。
   用户点「刷新」时先看到 toast「正在刷新，几秒后自动更新」，而不是干等。

后台刷新用 `threading.Event` 做合并：一波突发上报（比如一次任务结束连报 3 条）只会触发一次重扫。
多维表格同步也走同一个后台线程，并且**只推变化过的行** —— 稳态下每轮 0～3 行，不是每轮重推 343 行。

---

## 排错

| 现象 | 原因 |
| --- | --- |
| `230006 Bot ability is not activated` | 没加机器人能力 |
| `230013 Bot has NO availability to this user` | 没配可用范围 / 没发布版本 |
| `230027 Lack of necessary permissions` | 权限没开，或开了没重新发布版本 |
| 建多维表格失败 | 没开 `bitable:app`，或开了没重新发布版本 |
| 多维表格里日期是 1970 年 | 传了秒，要毫秒 |
| 续跑**零输出**卡到超时 | 子进程没关 stdin（`stdin=DEVNULL`）—— 已修，`smoke_test` 有专测 |
| 续跑跑了很久没反应 | 会话太大。1.5 MB 历史的会话实测 600 秒没回来，属于已知限制 |
| codex 续跑秒退、报 `Not inside a trusted directory` | 少了 `--skip-git-repo-check` —— 已修 |
| codex 报 `404 … 路由池没有支持该模型的可用分组` | provider 问题，不是续跑链路。拿**新会话**复测即可确认 |
| `230025` 消息体超限 | 卡片超 30 KB（本项目每页 10 条，实测 3–11 KB） |
| `230031` | 卡片发出超过 14 天了，重发一张 |
| `230011 The message is recalled` | 卡片被撤回了，删掉 `panel.json` 重跑 |
| 点了按钮没反应 | 回调配置没选长连接，或加了旧版 `card.action.trigger_v1` |
| 面板不更新 | 看日志有没有 `[warn]`；单条消息 5 QPS 限流 |
| 日志里一直没反应 | 确认**两处**都选了长连接（事件配置 + 回调配置） |
| `report.py` 报 502 Bad Gateway | 本机回环走了系统代理。`report.py` 已经显式绕开代理了；自己写脚本的话记得 `ProxyHandler({})` |
| 卡片渲染成空白 | 回包的 `card.type` 必须是 `raw`，`data` 必须是**对象**不是字符串 |

状态文件：`panel.json`（面板 message_id / 当前筛选）、`bitable-state.json`（行索引）。
想强制重发面板就删 `panel.json`；想重建多维表格索引就删 `bitable-state.json`（不会插双份）。

### 不用问用户，直接读出后台配了什么

「后台到底配没配」不用靠猜、也不用让用户去截图。飞书有接口能读回来
（应用身份 + `application:application:self_manage`）：

```bash
# 应用信息：回调配置 + 全部已配权限
lark-cli api GET /open-apis/application/v6/applications/<app_id> \
  --params '{"lang":"zh_cn"}' --as bot

# 版本详情：事件订阅 + 可用范围
lark-cli api GET /open-apis/application/v6/applications/<app_id>/app_versions/<online_version_id> \
  --params '{"lang":"zh_cn"}' --as bot
```

两个字段是答案：

```jsonc
// applications/<app_id> → data.app.callback_info
"callback_info": { "callback_type": "websocket",          // ← 回调配置选了长连接
                   "subscribed_callbacks": ["card.action.trigger"] }

// app_versions/<vid> → data.app_version.event_infos
"event_infos": [ { "event_type": "im.message.receive_v1", ... } ]   // ← 事件订阅
```

> **坑**：在 Git Bash 里跑 `lark-cli api GET /open-apis/...`，路径会被 **MSYS 转换成 Windows 路径**
> → `/open-apis/C:/Users/.../open-apis/...` → 假 404。加 `MSYS_NO_PATHCONV=1`，
> 或者用 typed 域命令（`lark-cli base +table-list` 那种，走 `--flag` 不裸传路径）。

---

## 已知没做的

- **只有本机能跑**：`scan.py` 读的是本机 CLI 的会话库，不是跨机器的。
- **手机端不能发起新会话**，只能看状态 + 打开已有会话（打开动作是在本机执行的）。
  多维表格里的「恢复命令」也只能复制，不能点击执行 —— Bitable 的自动化跑在飞书云上，碰不到你的机器。
- **远程续跑是「投喂一轮」，不是终端**。看不到中间过程，也没有进度条，只有跑完（或失败）后的一张结果卡。
  想要流式回传得改成长连接推送中间态，没做。
- **续跑跑的是「本机终端里那场会话」之外的另一条路径**（Bridge 投喂除外）。
  TUI 里正在跑的那场和飞书发起的无头那一轮是两回事 —— 想让它们同步，只能二选一。
- **大会话续跑会超时，没有降级方案**。实测 1.5 MB 历史的会话 600 秒仍没回来，
  超过 `remote_timeout`（默认 900 秒）就报失败。没做「只带最近 N 轮去续跑」这类绕法 ——
  那样会改变会话上下文，风险更大。
- **codex 续跑用的是 codex 自己的默认模型**，不是会话当初的模型。
  `codex exec resume` 没有 `-m` 参数，只能 `-c model="..."`，所以没做成自动跟随。
- **群公告 API 不存在**，所以没法把面板自动放进群公告，只能手动置顶。
- **卡片表格组件不支持放按钮**，所以会话列表用的是 `column_set` 一行行拼，没用 `table`。
- **多维表格不能反向操作**（在表里改状态不会同步回本机）—— 它是只读视图，不是控制台。

---

## 设计

视觉规范和出图流程在 [`docs/brand.md`](docs/brand.md)。一句话版：

- **深色优先**（这是终端工具），底 `#0E1116`，面板 `#161B23`，主文字 `#E6E9EF`
- **状态灯五色**，珊瑚 `#FF6B4A` 是唯一「要你动手」的信号，不要加第六种颜色
- **机器给的东西一律等宽字体**（路径、时长、状态名、命令），这是区分「我写的」和「它跑出来的」最快的办法
- SVG 里用了 `@media (prefers-color-scheme)`，GitHub 上跟着系统明暗自动切

出图（gpt-image-2）：

```bash
python tools/gen_assets.py            # 全量
python tools/gen_assets.py --list     # 看有哪些
python tools/gen_assets.py app-icon   # 单个
```

提示词在 `assets/prompts.json`，`style` 字段是公共前缀，改风格只改那里。

---

## License

MIT

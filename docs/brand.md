# SessionDeck 品牌规范

> 一页看完。改任何视觉之前先读这个。

## 名字

**SessionDeck** —— 会话甲板。
「甲板」= 一块插满会话插槽的控制台面板，每根插槽下面一颗状态灯。
不是「dashboard」，是能下手去按的那块板子。

小写连写：`sessiondeck`。仓库名：`sessiondeck`。包名：`feishu_hub`（历史原因，暂不改）。

## 为什么长这样

产品本质是**看状态 + 找回历史**，所以视觉全部围绕两件事：

1. **插槽** —— 一排等宽的横条，代表并列的会话。
2. **状态灯** —— 每个插槽尾部一颗圆点，颜色即状态。

logo 就是这两件事的最小表达，不画机器人、不画大脑、不画闪电。

## 色板

### 底与字

| 用途 | 变量 | 深色 | 浅色 |
| --- | --- | --- | --- |
| 背景 | `--bg` | `#0E1116` | `#F4F6FA` |
| 面板 | `--plate` | `#161B23` | `#FFFFFF` |
| 分隔线 | `--hair` | `#2A313C` | `#E2E7EF` |
| 主文字 | `--ink` | `#E6E9EF` | `#14181F` |
| 次文字 | `--dim` | `#8B93A1` | `#5E6775` |

默认走**深色**。这是终端工具，用户的眼睛本来就活在深色终端里。

### 状态灯（不要改，不要加）

| 状态 | 色值 | 含义 |
| --- | --- | --- |
| `working` | `#F5A623` 琥珀 | 正在输出 |
| `needs-you` | `#FF6B4A` 珊瑚 | 卡住等你确认 |
| `done` | `#34D399` 薄荷 | 跑完了 |
| `error` | `#F0524B` 绛红 | 炸了 |
| `idle` | `#6B7484` 石板灰 | 活着但没动静 |
| `exited` | `#4C9AFF` 天蓝 | 已退出，历史可捞 |

珊瑚色是全场唯一「要你动手」的信号，UI 里出现就该是最扎眼的一个。

### 强调色

`#F5A623` 琥珀 —— 品牌色，同时是 `working`。刻意复用：这个产品大部分时间你的会话都在跑。

## 字体

- 标题 / 正文：`ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`
- 数据 / 路径 / 状态名：`ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`

规则：**凡是机器给的东西（路径、时长、状态名、命令）一律等宽。** 这是区分「我写的」和「它跑出来的」最快的办法。

## 资产

| 文件 | 用途 |
| --- | --- |
| `assets/sessiondeck-mark.svg` | 图标（48×48，自适应明暗） |
| `assets/sessiondeck-logo.svg` | 横版 lockup |
| `assets/banner.svg` | README 顶部主视觉 1280×420 |
| `assets/status-lights.svg` | 状态灯图例 |
| `assets/architecture.svg` | 数据流图 |
| `assets/generated/*.png` | gpt-image-2 出的位图（不进 git，见 `.gitignore`） |

SVG 里用了 `@media (prefers-color-scheme)`，GitHub 上会跟着系统的明暗自动切。别把这个删了。

## 出图（gpt-image-2）

```bash
python tools/gen_assets.py            # 全量
python tools/gen_assets.py --list     # 看有哪些
python tools/gen_assets.py app-icon   # 单个
```

提示词在 `assets/prompts.json`，`style` 字段是公共前缀，改风格只改那里。
没登录 l0veyou.com 时会明确报错，不会静默出废图。

## 不能做的事

- 不要给状态灯加第五种颜色。要加状态先复用现有色 + 改形状（空心/环）。
- 不要用紫色渐变。这是终端工具，不是 AI 营销页。
- 不要在 logo 上加文字以外的装饰元素。
- 不要在浅色背景上用 `#F5A623` 做正文色（对比度不够），浅色模式用 `#B9760A`。
